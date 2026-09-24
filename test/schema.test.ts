import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_API_URL, loadConfig, normalizeApiUrl } from "../src/config.js";
import {
  checkPairs,
  COUNTRIES,
  MAX_LOCATIONS,
  MAX_PAIRS,
  MAX_RESULTS_LIMIT,
  MAX_SEARCH_TERMS,
  startScrapeSchema,
  worstCaseCredits,
} from "../src/schema.js";

const base = { categories: ["dentist"], locations: ["Austin, TX"], maxResults: 50 };

describe("start_scrape schema mirrors the API's scrapeInputSchema", () => {
  it("keeps the API limits", () => {
    assert.equal(MAX_SEARCH_TERMS, 1000);
    assert.equal(MAX_LOCATIONS, 10_000);
    assert.equal(MAX_RESULTS_LIMIT, 500);
    assert.equal(MAX_PAIRS, 2000);
    assert.equal(COUNTRIES.length, 32);
  });

  it("defaults enrichLinks and enrichWebsite to true and leaves country unset", () => {
    const parsed = startScrapeSchema.parse(base);
    assert.equal(parsed.enrichLinks, true);
    assert.equal(parsed.enrichWebsite, true);
    assert.equal(parsed.country, undefined);
  });

  it("trims terms and rejects empty or over-long ones", () => {
    assert.deepEqual(startScrapeSchema.parse({ ...base, categories: ["  dentist "] }).categories, ["dentist"]);
    assert.equal(startScrapeSchema.safeParse({ ...base, categories: ["   "] }).success, false);
    assert.equal(startScrapeSchema.safeParse({ ...base, categories: [] }).success, false);
    assert.equal(startScrapeSchema.safeParse({ ...base, locations: ["x".repeat(121)] }).success, false);
    assert.equal(startScrapeSchema.safeParse({ ...base, locations: ["x".repeat(120)] }).success, true);
  });

  it("bounds maxResults to integers 1..500", () => {
    for (const bad of [0, 501, 1.5, -1]) {
      assert.equal(startScrapeSchema.safeParse({ ...base, maxResults: bad }).success, false, `maxResults ${bad}`);
    }
    for (const good of [1, 100, 500]) {
      assert.equal(startScrapeSchema.safeParse({ ...base, maxResults: good }).success, true, `maxResults ${good}`);
    }
    assert.equal(startScrapeSchema.safeParse({ categories: ["a"], locations: ["b"] }).success, false, "maxResults is required");
  });

  it("caps list sizes", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(startScrapeSchema.safeParse({ ...base, categories: many(1001) }).success, false);
    assert.equal(startScrapeSchema.safeParse({ ...base, locations: many(10_001) }).success, false);
  });

  it("only accepts the API's country codes", () => {
    assert.equal(startScrapeSchema.safeParse({ ...base, country: "lt" }).success, true);
    assert.equal(startScrapeSchema.safeParse({ ...base, country: "US" }).success, false);
    assert.equal(startScrapeSchema.safeParse({ ...base, country: "cn" }).success, false);
  });

  it("enforces categories x locations <= 2000 like the API refine", () => {
    const locs = (n: number) => Array.from({ length: n }, (_, i) => `City ${i}`);
    assert.equal(checkPairs({ categories: ["a", "b"], locations: locs(1000) }), null);
    const msg = checkPairs({ categories: ["a", "b", "c"], locations: locs(1000) });
    assert.match(msg ?? "", /up to 2,000 searches.*3,000/);
  });

  it("computes the worst-case reservation", () => {
    assert.equal(worstCaseCredits({ categories: ["a", "b"], locations: ["x", "y", "z"], maxResults: 100 }), 600);
  });
});

describe("config", () => {
  it("defaults to https://hubertino.com", () => {
    assert.equal(normalizeApiUrl(undefined), DEFAULT_API_URL);
    assert.equal(normalizeApiUrl("  "), DEFAULT_API_URL);
  });

  it("strips trailing slashes and a trailing /api/v1", () => {
    assert.equal(normalizeApiUrl("https://hubertino.com/"), "https://hubertino.com");
    assert.equal(normalizeApiUrl("https://hubertino.com/api/v1/"), "https://hubertino.com");
    assert.equal(normalizeApiUrl("https://example.com/hub/api/v1"), "https://example.com/hub");
  });

  it("allows plain http only for localhost", () => {
    assert.equal(normalizeApiUrl("http://localhost:3000"), "http://localhost:3000");
    assert.equal(normalizeApiUrl("http://127.0.0.1:3000/api/v1"), "http://127.0.0.1:3000");
    assert.throws(() => normalizeApiUrl("http://hubertino.com"), ConfigError);
    assert.throws(() => normalizeApiUrl("ftp://hubertino.com"), ConfigError);
    assert.throws(() => normalizeApiUrl("not a url"), ConfigError);
    assert.throws(() => normalizeApiUrl("https://user:pass@hubertino.com"), ConfigError);
  });

  it("reads the key and download dir from the environment", () => {
    const cfg = loadConfig({ HUBERTINO_API_KEY: " hub_live_x ", HUBERTINO_DOWNLOAD_DIR: "/tmp/leads" });
    assert.deepEqual(cfg, { apiUrl: DEFAULT_API_URL, apiKey: "hub_live_x", downloadDir: "/tmp/leads" });
    assert.equal(loadConfig({}).apiKey, null);
  });
});
