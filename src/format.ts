import type { ResultsPage, Scrape } from "./client.js";

/** Statuses after which a scrape will not change any more. */
export const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Columns dropped from rows in "compact" mode: long, duplicated or
 * machine-only fields that cost context without helping build a lead list.
 * `detail: "full"` (or an explicit `fields` list) returns them.
 */
export const COMPACT_OMIT = new Set([
  "query",
  "domain",
  "street",
  "state_code",
  "country",
  "latitude",
  "longitude",
  "plus_code",
  "price_range",
  "service_options",
  "working_hours",
  "working_hours_csv",
  "order_links",
  "reservation_links",
  "menu_link",
  "google_id",
  "cid",
  "kgmid",
]);

/** Longest string value kept in compact mode before it is cut with an ellipsis. */
export const COMPACT_MAX_STRING = 300;

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

export interface RowShapeOptions {
  /** Keep only these columns (in this order). Takes precedence over `detail`. */
  fields?: string[];
  detail: "compact" | "full";
}

/** Project one result row: drop empty values, apply `fields` or compact rules. */
export function shapeRow(row: Record<string, unknown>, opts: RowShapeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = opts.fields && opts.fields.length > 0 ? opts.fields : Object.keys(row);
  for (const key of keys) {
    const value = row[key];
    if (isEmpty(value)) continue;
    if (!opts.fields?.length && opts.detail === "compact" && COMPACT_OMIT.has(key)) continue;
    if (opts.detail === "compact" && typeof value === "string" && value.length > COMPACT_MAX_STRING) {
      out[key] = `${value.slice(0, COMPACT_MAX_STRING - 1)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function hasEmail(row: Record<string, unknown>): boolean {
  const email = row.email;
  return typeof email === "string" && email.includes("@");
}

/** Compact, model-friendly view of a scrape. */
export function summarizeScrape(scrape: Scrape, opts: { includeSearches?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: scrape.id,
    kind: scrape.kind,
    status: scrape.status,
    title: scrape.title,
  };
  if (scrape.kind === "reviews") {
    out.placesCount = scrape.placesCount;
    out.maxReviews = scrape.maxReviews;
    if (scrape.sourceJobId) out.sourceScrapeId = scrape.sourceJobId;
  } else {
    out.categories = scrape.categories;
    out.locations = scrape.locations;
    out.maxResults = scrape.maxResults;
    out.country = scrape.country;
    out.enrichWebsite = scrape.enrichWebsite;
    out.enrichLinks = scrape.enrichLinks;
  }
  out.resultCount = scrape.resultCount;
  out.creditsReserved = scrape.creditsReserved;
  out.creditsCharged = scrape.creditsCharged;
  if (scrape.progress) out.progress = scrape.progress;
  if (scrape.reviewsProgress) out.progress = scrape.reviewsProgress;
  if (scrape.coverage) out.coverage = scrape.coverage;
  if (scrape.error) out.error = scrape.error;
  out.createdAt = scrape.createdAt;
  if (scrape.finishedAt) out.finishedAt = scrape.finishedAt;
  if (opts.includeSearches && scrape.searches) out.searches = scrape.searches;
  else if (scrape.searches && scrape.searches.length > 0) out.searchesCount = scrape.searches.length;
  out.next = nextStep(scrape);
  return out;
}

/** One-line list entry for list_scrapes. */
export function listEntry(scrape: Scrape): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: scrape.id,
    kind: scrape.kind,
    status: scrape.status,
    title: scrape.title,
    resultCount: scrape.resultCount,
    creditsCharged: scrape.creditsCharged,
    createdAt: scrape.createdAt,
  };
  if (scrape.finishedAt) out.finishedAt = scrape.finishedAt;
  if (scrape.error) out.error = scrape.error;
  return out;
}

/** What the model should do after seeing this scrape. */
export function nextStep(scrape: Scrape): string {
  switch (scrape.status) {
    case "queued":
    case "running":
      return (
        "Still working. Call wait_for_scrape (or get_scrape every 10-30 s) until status is done. " +
        "Rows found so far can already be read with get_results (they are marked partial)."
      );
    case "done":
      return scrape.resultCount > 0
        ? `Finished with ${scrape.resultCount} rows. Read them with get_results (paged) or save a spreadsheet with download_export.`
        : "Finished, but no businesses were found. Try broader categories, other spellings or more/other locations.";
    case "error":
      return "The scrape failed and its reserved credits were refunded. It is usually safe to start it again.";
    case "cancelled":
      return "The scrape was cancelled.";
    default:
      return "Check the status again with get_scrape.";
  }
}

/** Short explanation of the credit reservation for a freshly started scrape. */
export function reservationNote(scrape: Scrape, worstCase: number): string {
  const reserved = scrape.creditsReserved;
  const base =
    `Reserved ${reserved.toLocaleString("en-US")} credits (1 credit = 1 business delivered). ` +
    `Only delivered rows are charged when it finishes; the rest is refunded automatically.`;
  if (reserved < worstCase) {
    return (
      `${base} The worst case was ${worstCase.toLocaleString("en-US")} credits but the balance was lower, ` +
      `so the scrape will stop after ${reserved.toLocaleString("en-US")} businesses.`
    );
  }
  return base;
}

export interface ShapedResults {
  scrapeId: string;
  status: string;
  partial: boolean;
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  coverage: ResultsPage["coverage"];
  columns: string[];
  rows: Record<string, unknown>[];
  filteredOut?: number;
  unknownFields?: string[];
  note?: string;
}

export function shapeResults(
  scrapeId: string,
  page: ResultsPage,
  req: { offset: number; limit: number; fields?: string[]; detail: "compact" | "full"; withEmailOnly: boolean },
): ShapedResults {
  const fetched = page.rows.length;
  const kept = req.withEmailOnly ? page.rows.filter(hasEmail) : page.rows;
  const rows = kept.map((r) => shapeRow(r, { fields: req.fields, detail: req.detail }));
  const hasMore = page.hasMore ?? req.offset + fetched < page.count;

  const columnSet = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) columnSet.add(k);

  const out: ShapedResults = {
    scrapeId,
    status: page.status,
    partial: page.partial,
    total: page.count,
    offset: req.offset,
    limit: req.limit,
    returned: rows.length,
    hasMore,
    nextOffset: hasMore ? req.offset + fetched : null,
    coverage: page.coverage,
    columns: [...columnSet],
    rows,
  };
  if (req.withEmailOnly) out.filteredOut = fetched - kept.length;
  if (req.fields?.length && page.columns?.length) {
    const known = new Set([...page.columns, "_status"]);
    const unknown = req.fields.filter((f) => !known.has(f));
    if (unknown.length) out.unknownFields = unknown;
  }
  const notes: string[] = [];
  if (page.partial) notes.push("The scrape is still running: more rows may appear and some rows are not fully enriched yet (_status).");
  if (req.withEmailOnly) notes.push("withEmailOnly filters inside this page; keep paging with nextOffset to scan the rest.");
  if (notes.length) out.note = notes.join(" ");
  return out;
}
