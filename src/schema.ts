import { z } from "zod";

/**
 * Mirror of Hubertino's public `POST /api/v1/scrapes` body (`scrapeInputSchema`
 * in the Hubertino app). Keep every limit and the country list in sync with
 * the API: validating here lets the MCP client see a precise error before a
 * request is sent, but the API stays the source of truth and re-validates.
 */

/** Google editions the API accepts for `country` (Google's `gl` code). */
export const COUNTRIES = [
  { code: "us", name: "United States" },
  { code: "gb", name: "United Kingdom" },
  { code: "ca", name: "Canada" },
  { code: "au", name: "Australia" },
  { code: "ie", name: "Ireland" },
  { code: "de", name: "Germany" },
  { code: "fr", name: "France" },
  { code: "es", name: "Spain" },
  { code: "it", name: "Italy" },
  { code: "pt", name: "Portugal" },
  { code: "nl", name: "Netherlands" },
  { code: "be", name: "Belgium" },
  { code: "at", name: "Austria" },
  { code: "ch", name: "Switzerland" },
  { code: "se", name: "Sweden" },
  { code: "no", name: "Norway" },
  { code: "dk", name: "Denmark" },
  { code: "fi", name: "Finland" },
  { code: "pl", name: "Poland" },
  { code: "cz", name: "Czechia" },
  { code: "lt", name: "Lithuania" },
  { code: "lv", name: "Latvia" },
  { code: "ee", name: "Estonia" },
  { code: "ro", name: "Romania" },
  { code: "hu", name: "Hungary" },
  { code: "gr", name: "Greece" },
  { code: "br", name: "Brazil" },
  { code: "mx", name: "Mexico" },
  { code: "jp", name: "Japan" },
  { code: "in", name: "India" },
  { code: "nz", name: "New Zealand" },
  { code: "za", name: "South Africa" },
] as const;

export type CountryCode = (typeof COUNTRIES)[number]["code"];

const COUNTRY_CODES = COUNTRIES.map((c) => c.code) as [CountryCode, ...CountryCode[]];

/** Anti-abuse ceiling on search terms per scrape (API: MAX_SEARCH_TERMS). */
export const MAX_SEARCH_TERMS = 1000;
/** Ceiling on locations per scrape (API: MAX_LOCATIONS). */
export const MAX_LOCATIONS = 10_000;
/** Max places per category × location search (API: MAX_RESULTS_LIMIT). */
export const MAX_RESULTS_LIMIT = 500;
/** Max searches (categories × locations) per scrape (API: MAX_PAIRS). */
export const MAX_PAIRS = 2000;
/** Max characters per category or location string. */
export const MAX_TERM_LENGTH = 120;

/** Page size bounds of `GET /api/v1/scrapes/{id}/results`. */
export const RESULTS_MAX_LIMIT = 5000;

const termList = (label: string, max: number, describe: string) =>
  z
    .array(z.string().trim().min(1).max(MAX_TERM_LENGTH))
    .min(1, `Add at least one ${label}.`)
    .max(max, `Up to ${max} ${label}s per scrape.`)
    .describe(describe);

/**
 * Tool input shape for `start_scrape`. Field names, types, bounds and
 * defaults match `scrapeInputSchema`; only the descriptions are added.
 */
export const startScrapeShape = {
  categories: termList(
    "category",
    MAX_SEARCH_TERMS,
    `What to search Google Maps for, one business type per item, e.g. ["dentist"], ["plumber", "HVAC contractor"]. ` +
      `Use the words a customer would type into Google Maps. 1-${MAX_SEARCH_TERMS} items, each 1-${MAX_TERM_LENGTH} characters.`,
  ),
  locations: termList(
    "location",
    MAX_LOCATIONS,
    `Where to search, one place per item: a city, region, neighbourhood or zip/postal code, e.g. ["Austin, TX, United States"], ["Vilnius, Lithuania"], ["90210, CA, USA"]. ` +
      `Include the country for the best match. Each category is searched separately in each location, so several smaller areas ` +
      `(neighbourhoods, zip codes) find more businesses than one big area. 1-${MAX_LOCATIONS} items, each 1-${MAX_TERM_LENGTH} characters. ` +
      `categories.length x locations.length must be <= ${MAX_PAIRS}.`,
  ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_LIMIT)
    .describe(
      `Maximum places to collect PER SEARCH (per category x location pair), 1-${MAX_RESULTS_LIMIT}. ` +
        `Google Maps typically returns around 100 places per search; use ${MAX_RESULTS_LIMIT} for "everything". ` +
        `This also sets the worst-case credit reservation: categories x locations x maxResults (1 credit = 1 place delivered).`,
    ),
  country: z
    .enum(COUNTRY_CODES)
    .optional()
    .describe(
      `Optional Google edition (lower-case country code) used for the search: ${COUNTRY_CODES.join(", ")}. ` +
        `When omitted, Hubertino infers it from a country named in the locations and falls back to "us".`,
    ),
  enrichLinks: z
    .boolean()
    .default(true)
    .describe("Collect social profiles and ordering/reservation links for each place. Default true, no extra credits."),
  enrichWebsite: z
    .boolean()
    .default(true)
    .describe(
      "Visit each business's own website to find a contact email (and social profiles). Default true, no extra credits. " +
        "Keep it on whenever the user wants emails.",
    ),
};

export const startScrapeSchema = z.object(startScrapeShape);
export type StartScrapeInput = z.infer<typeof startScrapeSchema>;

/**
 * The API's cross-field rule: one scrape runs at most MAX_PAIRS searches.
 * Returns an error message, or null when the input is within the limit.
 */
export function checkPairs(input: Pick<StartScrapeInput, "categories" | "locations">): string | null {
  const pairs = input.categories.length * input.locations.length;
  if (pairs <= MAX_PAIRS) return null;
  return (
    `locations: A scrape runs up to ${MAX_PAIRS.toLocaleString("en-US")} searches (categories x locations) ` +
    `and this one would run ${pairs.toLocaleString("en-US")}. Split it into smaller scrapes.`
  );
}

/** Worst-case credits a scrape reserves before the balance cap is applied. */
export function worstCaseCredits(input: Pick<StartScrapeInput, "categories" | "locations" | "maxResults">): number {
  return input.categories.length * input.locations.length * input.maxResults;
}
