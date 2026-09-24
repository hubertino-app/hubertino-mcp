import type { StartScrapeInput } from "./schema.js";

/** Thin, typed client for Hubertino's authenticated public REST API (`/api/v1`). */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ScrapeStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ScrapeProgress {
  stage: string;
  stageLabel: string;
  pairsDone: number;
  pairsTotal: number;
  found: number;
  extracted: number;
  updated: number;
  percent: number;
}

export interface ReviewsProgress {
  stage: string;
  stageLabel: string;
  placesDone: number;
  placesTotal: number;
  reviews: number;
  updated: number;
  percent: number;
}

/** Counts of delivered rows that carry each field, e.g. `{ total: 80, email: 41 }`. */
export interface Coverage {
  total: number;
  [field: string]: number;
}

/** A scrape as returned by `/api/v1/scrapes` and `/api/v1/scrapes/{id}`. */
export interface Scrape {
  id: string;
  kind: "scrape" | "reviews";
  status: ScrapeStatus;
  title: string;
  categories: string[];
  locations: string[];
  maxResults: number;
  country: string;
  enrichLinks: boolean;
  enrichWebsite: boolean;
  placesCount?: number;
  maxReviews?: number;
  sourceJobId?: string | null;
  creditsReserved: number;
  creditsCharged: number | null;
  resultCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  progress?: ScrapeProgress;
  reviewsProgress?: ReviewsProgress;
  coverage?: Coverage | null;
  searches?: { query: string; url: string; results: number | null }[];
}

/** One page of `/api/v1/scrapes/{id}/results`. */
export interface ResultsPage {
  status: ScrapeStatus;
  partial: boolean;
  /** Total rows available, not the size of this page. */
  count: number;
  updated: number;
  coverage: Coverage | null;
  columns: string[];
  rows: Record<string, unknown>[];
  offset?: number;
  limit?: number;
  hasMore?: boolean;
}

export type ExportFormat = "xlsx" | "csv";

export interface ExportDownload {
  body: ReadableStream<Uint8Array>;
  /** File name suggested by the API's content-disposition header, if any. */
  filename: string | null;
  contentType: string;
  /** Byte length when the API sent one. */
  contentLength: number | null;
  /** Clears the download timeout; call after the body has been consumed. */
  release: () => void;
}

/** An API call failed. `message` is written for the model/user to act on. */
export class HubertinoApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for configuration and network problems. */
    readonly status: number,
    /** The API's own `error` string, when it sent one. */
    readonly apiMessage: string | null = null,
  ) {
    super(message);
    this.name = "HubertinoApiError";
  }
}

export interface ClientOptions {
  apiUrl: string;
  apiKey: string | null;
  fetch?: FetchLike;
  userAgent?: string;
  /** Per-request timeout for JSON calls (ms). */
  timeoutMs?: number;
  /** Timeout for export downloads (ms). */
  exportTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 180_000;

export class HubertinoClient {
  readonly apiUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly exportTimeoutMs: number;

  constructor(opts: ClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.userAgent = opts.userAgent ?? "hubertino-mcp";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exportTimeoutMs = opts.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  }

  /** `POST /api/v1/scrapes` — start a scrape. Reserves credits. */
  async createScrape(input: StartScrapeInput, signal?: AbortSignal): Promise<Scrape> {
    const body: Record<string, unknown> = {
      categories: input.categories,
      locations: input.locations,
      maxResults: input.maxResults,
      enrichLinks: input.enrichLinks,
      enrichWebsite: input.enrichWebsite,
    };
    if (input.country !== undefined) body.country = input.country;
    const res = await this.json<{ scrape: Scrape }>("POST", "/scrapes", { body, signal });
    return expectField(res, "scrape");
  }

  /** `GET /api/v1/scrapes` — the account's 200 most recent scrapes, newest first. */
  async listScrapes(signal?: AbortSignal): Promise<Scrape[]> {
    const res = await this.json<{ scrapes: Scrape[] }>("GET", "/scrapes", { signal });
    return expectField(res, "scrapes");
  }

  /** `GET /api/v1/scrapes/{id}` — one scrape with live status and progress. */
  async getScrape(id: string, signal?: AbortSignal): Promise<Scrape> {
    const res = await this.json<{ scrape: Scrape }>("GET", `/scrapes/${encodeId(id)}`, { signal });
    return expectField(res, "scrape");
  }

  /** `GET /api/v1/scrapes/{id}/results?offset=&limit=` — one page of rows. */
  async getResults(
    id: string,
    page: { offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ResultsPage> {
    const qs = new URLSearchParams();
    if (page.offset !== undefined) qs.set("offset", String(page.offset));
    if (page.limit !== undefined) qs.set("limit", String(page.limit));
    const query = qs.toString();
    const res = await this.json<ResultsPage>(
      "GET",
      `/scrapes/${encodeId(id)}/results${query ? `?${query}` : ""}`,
      { signal },
    );
    if (!res || !Array.isArray(res.rows)) {
      throw new HubertinoApiError("Hubertino returned an unexpected results payload (no rows array).", 502);
    }
    return res;
  }

  /**
   * `GET /api/v1/scrapes/{id}/export?format=` — the finished scrape as a file.
   * The caller must consume `body` and then call `release()`.
   */
  async exportScrape(id: string, format: ExportFormat, signal?: AbortSignal): Promise<ExportDownload> {
    const { res, cleanup } = await this.request("GET", `/scrapes/${encodeId(id)}/export?format=${format}`, {
      signal,
      timeoutMs: this.exportTimeoutMs,
      accept: "*/*",
    });
    if (!res.body) {
      cleanup();
      throw new HubertinoApiError("Hubertino returned an empty export.", 502);
    }
    const length = Number(res.headers.get("content-length"));
    return {
      body: res.body,
      filename: parseFilename(res.headers.get("content-disposition")),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      contentLength: Number.isFinite(length) && length > 0 ? length : null,
      release: cleanup,
    };
  }

  /* ------------------------------------------------------------------ */

  private async json<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const { res, cleanup } = await this.request(method, path, { ...opts, accept: "application/json" });
    try {
      return (await res.json()) as T;
    } catch {
      throw new HubertinoApiError(
        `Hubertino returned a response that is not JSON (HTTP ${res.status}). Check that HUBERTINO_API_URL points at the Hubertino app (${this.apiUrl}).`,
        502,
      );
    } finally {
      cleanup();
    }
  }

  /** Perform an authenticated request; resolve only for 2xx, else throw a HubertinoApiError. */
  private async request(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; accept: string },
  ): Promise<{ res: Response; cleanup: () => void }> {
    if (!this.apiKey) {
      throw new HubertinoApiError(
        `HUBERTINO_API_KEY is not set. Create an API key at ${this.apiUrl}/dashboard/settings (it starts with hub_live_), ` +
          `add it to the "env" block of this MCP server's configuration, then restart the MCP client.`,
        0,
      );
    }
    const url = `${this.apiUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: opts.accept,
      "user-agent": this.userAgent,
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(opts.body);
    }

    const { signal, cleanup } = withTimeout(opts.timeoutMs ?? this.timeoutMs, opts.signal);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: payload, signal, redirect: "follow" });
    } catch (err) {
      cleanup();
      if (opts.signal?.aborted) {
        throw new HubertinoApiError("The request was cancelled.", 0);
      }
      if (signal.aborted) {
        throw new HubertinoApiError(
          `Hubertino did not answer within ${Math.round((opts.timeoutMs ?? this.timeoutMs) / 1000)}s (${method} /api/v1${stripQuery(path)}). Retry in a moment.`,
          0,
        );
      }
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new HubertinoApiError(`Could not reach Hubertino at ${this.apiUrl}: ${reason}`, 0);
    }
    // On success the timeout stays armed while the caller reads the body;
    // the caller releases it with cleanup().
    if (res.ok) return { res, cleanup };
    cleanup();
    const apiMessage = await readErrorMessage(res);
    throw new HubertinoApiError(
      describeHttpError(res.status, apiMessage, this.apiUrl, res.headers.get("retry-after")),
      res.status,
      apiMessage,
    );
  }
}

/** Turn an HTTP failure into a message that tells the model what to do next. */
export function describeHttpError(
  status: number,
  apiMessage: string | null,
  apiUrl: string,
  retryAfter: string | null = null,
): string {
  const said = apiMessage ? ` Hubertino said: "${apiMessage}"` : "";
  switch (status) {
    case 400:
      return `Hubertino rejected the request as invalid (400).${said} Fix the named field and try again.`;
    case 401:
      return (
        `Hubertino did not accept the API key (401).${said} Check HUBERTINO_API_KEY in this MCP server's configuration: ` +
        `keys start with hub_live_ and are shown once when created. Create or rotate one at ${apiUrl}/dashboard/settings.`
      );
    case 402:
      return (
        `Not enough Hubertino credits (402).${said} Nothing was charged. 1 credit = 1 business delivered; ` +
        `top up or upgrade at ${apiUrl}/dashboard/billing (plans: ${apiUrl}/pricing), then start the scrape again.`
      );
    case 403:
      return `Hubertino refused the request (403).${said}`;
    case 404:
      return (
        `Not found (404).${said} Check the scrape id with list_scrapes: an API key only sees scrapes of its own account.`
      );
    case 409:
      return `Not ready yet (409).${said} Use wait_for_scrape or get_scrape until status is "done", then retry.`;
    case 410:
      return `The results are no longer stored (410).${said} Start a new scrape to collect fresh data.`;
    case 429: {
      const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : " Wait a few minutes before starting another scrape.";
      return (
        `Rate limited (429).${said} Hubertino allows 12 new scrapes per 5 minutes per account.${wait} ` +
        `Reading status, results and exports is not affected.`
      );
    }
    default:
      if (status >= 500) {
        return `Hubertino is temporarily unavailable (${status}).${said} No action is needed from the user; retry in a minute.`;
      }
      return `Hubertino API error (${status}).${said}`;
  }
}

async function readErrorMessage(res: Response): Promise<string | null> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error.slice(0, 500);
    }
  } catch {
    // Not JSON (e.g. a proxy error page) — don't echo HTML back to the model.
  }
  return null;
}

function expectField<T, K extends keyof T>(res: T, key: K): T[K] {
  if (!res || typeof res !== "object" || res[key] === undefined || res[key] === null) {
    throw new HubertinoApiError(`Hubertino returned an unexpected payload (missing "${String(key)}").`, 502);
  }
  return res[key];
}

function encodeId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw new HubertinoApiError("A scrape id is required.", 400);
  return encodeURIComponent(trimmed);
}

function stripQuery(path: string): string {
  const i = path.indexOf("?");
  return i === -1 ? path : path.slice(0, i);
}

/** `attachment; filename="hubertino-6f1c1234.csv"` → `hubertino-6f1c1234.csv`. */
export function parseFilename(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  let raw = star?.[1] ?? plain?.[1];
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep as-is
  }
  const base = raw.split(/[\\/]/).pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return safe || null;
}

/** An AbortSignal that fires on timeout or when `parent` aborts. */
function withTimeout(ms: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  const onAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}
