import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HubertinoApiError, type HubertinoClient, type Scrape } from "./client.js";
import { resolveDownloadDir, saveStream } from "./download.js";
import {
  isTerminal,
  listEntry,
  reservationNote,
  shapeResults,
  summarizeScrape,
} from "./format.js";
import { checkPairs, MAX_PAIRS, MAX_RESULTS_LIMIT, startScrapeShape, worstCaseCredits } from "./schema.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "hubertino-mcp";

/** Most rows get_results returns per call (the API allows 5,000; model context is the real limit). */
export const RESULTS_TOOL_MAX_LIMIT = 1000;
export const RESULTS_TOOL_DEFAULT_LIMIT = 100;

export const SERVER_INSTRUCTIONS = `Hubertino scrapes Google Maps for business leads: name, category, phone, website, address, rating, reviews, social profiles and, when enrichWebsite is on, contact emails found on each business's own website.

Typical workflow for a request like "find dentists in Austin with emails":
1. start_scrape with categories ["dentist"], locations ["Austin, TX, United States"], a maxResults per search (Google Maps typically returns about 100 places per search, max ${MAX_RESULTS_LIMIT}) and enrichWebsite true.
2. wait_for_scrape (repeat while it reports still running) or poll get_scrape. Scrapes usually take minutes.
3. get_results to read rows page by page (withEmailOnly filters to rows that have an email), or download_export to save a CSV/XLSX file for the user.

Billing: 1 credit = 1 business delivered. Starting a scrape reserves categories x locations x maxResults credits (capped at the balance); only delivered rows are charged and the rest is refunded. Confirm with the user before large scrapes. One scrape runs at most ${MAX_PAIRS} searches (categories x locations). Starting scrapes is limited to 12 per 5 minutes per account; reads are not rate limited.

Use the scraped data lawfully: respect privacy and anti-spam rules (for example GDPR, CAN-SPAM) in the user's and the recipients' jurisdictions.`;

export interface ServerDeps {
  client: HubertinoClient;
  downloadDir: string | null;
  /** Injected for tests; defaults to real timers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const scrapeId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("The scrape id returned by start_scrape or list_scrapes (a UUID).");

export function createServer(deps: ServerDeps): McpServer {
  const { client } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "Hubertino: Google Maps leads",
      version: VERSION,
      websiteUrl: "https://hubertino.com",
      description: "Scrape Google Maps business leads (phones, websites, emails, socials) with Hubertino.",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /* ------------------------------- start_scrape ------------------------------- */
  server.registerTool(
    "start_scrape",
    {
      title: "Start a Google Maps lead scrape",
      description:
        "Start a Hubertino scrape that searches Google Maps for businesses and returns them as lead rows " +
        "(name, category, phone, website, email, address, rating, reviews, social profiles). " +
        "Use it for requests like \"find dentists in Austin with emails\" or \"build a list of plumbers in Leeds\". " +
        "Every category is searched in every location: categories x locations searches, max " +
        `${MAX_PAIRS} per scrape. ` +
        "COSTS CREDITS: it reserves categories x locations x maxResults credits up front (capped at the balance), " +
        "charges 1 credit per business actually delivered and refunds the rest. Confirm with the user before large scrapes. " +
        "Returns the scrape id immediately (status queued); then call wait_for_scrape, then get_results or download_export. " +
        "Limited to 12 new scrapes per 5 minutes per account.",
      inputSchema: startScrapeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) =>
      run(async () => {
        const pairsError = checkPairs(input);
        if (pairsError) return fail(pairsError);
        const scrape = await client.createScrape(input, extra.signal);
        return ok({
          ...summarizeScrape(scrape),
          searchCount: input.categories.length * input.locations.length,
          credits: reservationNote(scrape, worstCaseCredits(input)),
        });
      }),
  );

  /* -------------------------------- get_scrape -------------------------------- */
  server.registerTool(
    "get_scrape",
    {
      title: "Get scrape status",
      description:
        "Get one scrape's live status (queued, running, done, error), progress (stage, percent, searches done, places found/extracted), " +
        "resultCount, credits reserved/charged, and coverage (how many delivered rows have an email, phone, website, socials...). " +
        "Use it to check on a scrape without waiting; use wait_for_scrape to block until it finishes.",
      inputSchema: {
        scrapeId,
        includeSearches: z
          .boolean()
          .default(false)
          .describe("Also return the individual Google Maps searches (query, URL, result count). Can be long."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scrapeId: id, includeSearches }, extra) =>
      run(async () => ok(summarizeScrape(await client.getScrape(id, extra.signal), { includeSearches }))),
  );

  /* ------------------------------ wait_for_scrape ----------------------------- */
  server.registerTool(
    "wait_for_scrape",
    {
      title: "Wait for a scrape to finish",
      description:
        "Poll a scrape until it is done (or failed), or until timeoutSeconds passes, then return its status like get_scrape. " +
        "If it is still running when the time is up, just call wait_for_scrape again. " +
        "Sends MCP progress notifications when the client asks for them. " +
        "Many MCP clients abort a tool call after about 60 seconds, so keep the default timeout unless you know yours allows more.",
      inputSchema: {
        scrapeId,
        timeoutSeconds: z
          .number()
          .int()
          .min(5)
          .max(600)
          .default(50)
          .describe("How long to wait before returning the current status (5-600, default 50)."),
        pollIntervalSeconds: z
          .number()
          .int()
          .min(2)
          .max(60)
          .default(5)
          .describe("Seconds between status checks (2-60, default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scrapeId: id, timeoutSeconds, pollIntervalSeconds }, extra) =>
      run(async () => {
        const deadline = now() + timeoutSeconds * 1000;
        const progressToken = extra._meta?.progressToken;
        let lastProgress = -1;
        let scrape: Scrape | undefined;
        for (;;) {
          try {
            scrape = await client.getScrape(id, extra.signal);
          } catch (err) {
            // Ride out brief outages (network, timeouts, 5xx) until the deadline;
            // anything else (401, 404, ...) is final.
            const transient = err instanceof HubertinoApiError && err.retryable;
            const remaining = deadline - now();
            if (!transient || remaining <= 0 || extra.signal.aborted) {
              if (scrape && transient) break; // report the last good status instead
              throw err;
            }
            await sleep(Math.min(pollIntervalSeconds * 1000, remaining), extra.signal);
            continue;
          }
          if (progressToken !== undefined) {
            const percent = isTerminal(scrape.status)
              ? 100
              : (scrape.progress?.percent ?? scrape.reviewsProgress?.percent ?? 0);
            if (percent > lastProgress) {
              lastProgress = percent;
              const label = scrape.progress?.stageLabel ?? scrape.reviewsProgress?.stageLabel ?? scrape.status;
              await extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: percent, total: 100, message: `${label} (${scrape.resultCount} rows)` },
                })
                .catch(() => {});
            }
          }
          if (isTerminal(scrape.status)) break;
          const remaining = deadline - now();
          if (remaining <= 0) break;
          await sleep(Math.min(pollIntervalSeconds * 1000, remaining), extra.signal);
          if (extra.signal.aborted) break;
        }
        if (!scrape) return fail("Could not read the scrape status. Try get_scrape.");
        const summary = summarizeScrape(scrape);
        if (!isTerminal(scrape.status)) {
          summary.waited = `Still ${scrape.status} after ${timeoutSeconds}s. Call wait_for_scrape again to keep waiting.`;
        }
        return ok(summary);
      }),
  );

  /* ------------------------------- list_scrapes ------------------------------- */
  server.registerTool(
    "list_scrapes",
    {
      title: "List scrapes",
      description:
        "List this account's most recent scrapes, newest first (the API keeps the latest 200): id, title, status, resultCount, " +
        "credits charged and dates. Use it to find a scrape id or to reuse a finished scrape instead of paying for the same search again.",
      inputSchema: {
        status: z
          .enum(["queued", "running", "done", "error", "cancelled"])
          .optional()
          .describe("Only return scrapes with this status."),
        limit: z.number().int().min(1).max(200).default(20).describe("How many scrapes to return (1-200, default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, limit }, extra) =>
      run(async () => {
        const all = await client.listScrapes(extra.signal);
        const matching = status ? all.filter((s) => s.status === status) : all;
        return ok({
          total: matching.length,
          returned: Math.min(limit, matching.length),
          scrapes: matching.slice(0, limit).map(listEntry),
        });
      }),
  );

  /* ------------------------------- get_results -------------------------------- */
  server.registerTool(
    "get_results",
    {
      title: "Get scrape results (lead rows)",
      description:
        "Read a scrape's rows as compact JSON, one page at a time. Works while the scrape is running (partial rows) and after it is done. " +
        "Each row is one business with only its populated fields, e.g. name, category, phone, email, website, address, city, state, " +
        "postal_code, country_code, rating, reviews, business_status, company_facebook/instagram/linkedin/x/youtube, location_link, " +
        "place_id and _status (found -> extracted -> enriched). Page with offset/nextOffset until hasMore is false. " +
        "For a spreadsheet of every row use download_export instead of paging through thousands of rows.",
      inputSchema: {
        scrapeId,
        offset: z.number().int().min(0).default(0).describe("Rows to skip (default 0). Use nextOffset from the previous page."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(RESULTS_TOOL_MAX_LIMIT)
          .default(RESULTS_TOOL_DEFAULT_LIMIT)
          .describe(`Rows per page (1-${RESULTS_TOOL_MAX_LIMIT}, default ${RESULTS_TOOL_DEFAULT_LIMIT}).`),
        fields: z
          .array(z.string().trim().min(1).max(64))
          .max(60)
          .optional()
          .describe(
            'Only return these columns, e.g. ["name","email","phone","website"]. Overrides detail. ' +
              "Available columns include query, name, category, phone, email, website, domain, company_facebook, company_instagram, " +
              "company_x, company_youtube, company_linkedin, address, street, city, state, state_code, postal_code, country, country_code, " +
              "latitude, longitude, plus_code, rating, reviews, business_status, price_range, service_options, working_hours, " +
              "order_links, reservation_links, menu_link, location_link, place_id, google_id, cid, kgmid, _status.",
          ),
        detail: z
          .enum(["compact", "full"])
          .default("compact")
          .describe(
            "compact (default) drops long or duplicate columns (coordinates, opening hours, internal ids, links to order/reserve) " +
              "and shortens very long text; full returns every populated column.",
          ),
        withEmailOnly: z
          .boolean()
          .default(false)
          .describe("Only return rows that have an email address. Filters within the requested page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ scrapeId: id, offset, limit, fields, detail, withEmailOnly }, extra) =>
      run(async () => {
        const page = await client.getResults(id, { offset, limit }, extra.signal);
        return ok(shapeResults(id, page, { offset, limit, fields, detail, withEmailOnly }), false);
      }),
  );

  /* ------------------------------ download_export ----------------------------- */
  server.registerTool(
    "download_export",
    {
      title: "Download scrape as CSV/XLSX",
      description:
        "Save a finished scrape as a spreadsheet file on this computer and return its path. " +
        "The API serves the file itself (authenticated), so this tool downloads it rather than returning a link. " +
        "Only works once the scrape status is done. The file uses the full column layout (every column, blanks where unknown). " +
        "Files are never overwritten: an existing name gets a -1, -2... suffix.",
      inputSchema: {
        scrapeId,
        format: z.enum(["xlsx", "csv"]).default("xlsx").describe("xlsx (default, Excel/Google Sheets) or csv."),
        directory: z
          .string()
          .trim()
          .min(1)
          .max(1024)
          .optional()
          .describe(
            "Absolute directory to save into. Defaults to HUBERTINO_DOWNLOAD_DIR, else ~/Downloads, else the system temp directory.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ scrapeId: id, format, directory }, extra) =>
      run(async () => {
        let dir: string;
        try {
          dir = resolveDownloadDir(directory, deps.downloadDir);
        } catch (err) {
          return fail((err as Error).message);
        }
        const download = await client.exportScrape(id, format, extra.signal);
        let saved: { path: string; bytes: number };
        try {
          const fallback = `hubertino-${id.trim().slice(0, 8).replace(/[^A-Za-z0-9-]/g, "")}.${format}`;
          const name = download.filename && download.filename.endsWith(`.${format}`) ? download.filename : fallback;
          saved = await saveStream(download.body, dir, name);
        } finally {
          download.release();
        }
        return ok({
          scrapeId: id,
          format,
          path: saved.path,
          bytes: saved.bytes,
          next: `Saved. Tell the user the file is at ${saved.path}.`,
        });
      }),
  );

  /* ---------------------------------- prompt ---------------------------------- */
  server.registerPrompt(
    "build_lead_list",
    {
      title: "Build a lead list from Google Maps",
      description: "Guided workflow: scrape a business type in an area, wait, and return the leads (optionally only those with emails).",
      argsSchema: {
        business: z.string().describe('What to search for, e.g. "dentist" or "roofing contractor".'),
        area: z.string().describe('Where, e.g. "Austin, TX, United States" or several areas separated by ";".'),
        emailsOnly: z.string().optional().describe('"yes" to keep only businesses with an email address.'),
      },
    },
    ({ business, area, emailsOnly }) => {
      const locations = area
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      const wantEmails = /^(y|yes|true|1)$/i.test((emailsOnly ?? "").trim());
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Build me a lead list of "${business}" businesses in ${locations.map((l) => `"${l}"`).join(", ")} using Hubertino.\n` +
                `1. Call start_scrape with categories ["${business}"], these locations, maxResults 100 and enrichWebsite true. ` +
                `Tell me how many credits it reserved.\n` +
                `2. Call wait_for_scrape until the status is done.\n` +
                `3. Call get_results${wantEmails ? " with withEmailOnly true" : ""} and show the leads as a table ` +
                `(name, phone, email, website, city, rating).\n` +
                `4. Offer to save the full list with download_export.`,
            },
          },
        ],
      };
    },
  );

  return server;
}

/* --------------------------------- helpers --------------------------------- */

function ok(payload: unknown, pretty = true): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, pretty ? 2 : undefined) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HubertinoApiError) return fail(err.message);
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Unexpected error in hubertino-mcp: ${message}`);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
