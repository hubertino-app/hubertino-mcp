import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  COUNTRIES,
  MAX_LOCATIONS,
  MAX_PAIRS,
  MAX_RESULTS_LIMIT,
  MAX_SEARCH_TERMS,
  MAX_TERM_LENGTH,
  RESULTS_MAX_LIMIT,
} from "../src/schema.js";

/**
 * Opt-in drift check against a local checkout of the Hubertino app:
 *   HUBERTINO_APP_DIR=/path/to/hubertino/app npm test
 * Skipped when the variable is unset (e.g. in this repo's CI).
 */
const appDir = process.env.HUBERTINO_APP_DIR;
const skip = !appDir ? "set HUBERTINO_APP_DIR to compare with the app source" : false;

function read(rel: string): string {
  const path = join(appDir!, rel);
  assert.ok(existsSync(path), `${path} exists`);
  return readFileSync(path, "utf8");
}

function constant(src: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([\\d_]+);`).exec(src);
  assert.ok(m, `${name} is declared`);
  return Number(m[1]!.replace(/_/g, ""));
}

describe("API drift check (app source)", { skip }, () => {
  it("scrapeInputSchema limits match", () => {
    const src = read("src/lib/validation.ts");
    assert.equal(constant(src, "MAX_SEARCH_TERMS"), MAX_SEARCH_TERMS);
    assert.equal(constant(src, "MAX_LOCATIONS"), MAX_LOCATIONS);
    assert.equal(constant(src, "MAX_RESULTS_LIMIT"), MAX_RESULTS_LIMIT);
    assert.equal(constant(src, "MAX_PAIRS"), MAX_PAIRS);
    assert.match(src, new RegExp(`z\\.string\\(\\)\\.trim\\(\\)\\.min\\(1\\)\\.max\\(${MAX_TERM_LENGTH}\\)`));
    assert.match(src, /enrichLinks: z\.boolean\(\)\.default\(true\)/);
    assert.match(src, /enrichWebsite: z\.boolean\(\)\.default\(true\)/);
    assert.match(src, /country: z\.enum\(countryCodes\)\.optional\(\)/);
  });

  it("country codes match", () => {
    const src = read("src/lib/validation.ts");
    const block = src.slice(src.indexOf("export const COUNTRIES"), src.indexOf("] as const;"));
    const codes = [...block.matchAll(/code: "([a-z]{2})"/g)].map((m) => m[1]);
    assert.deepEqual(codes, COUNTRIES.map((c) => c.code));
  });

  it("results page cap and scrape rate limit match", () => {
    const results = read("src/app/api/v1/scrapes/[id]/results/route.ts");
    assert.equal(constant(results.replace(/^const /gm, "export const "), "MAX_LIMIT"), RESULTS_MAX_LIMIT);
    const limits = read("src/lib/rate-limit.ts");
    assert.match(limits, /jobCreate: \{ limit: 12, windowMs: 5 \* 60 \* 1000 \}/);
  });

  it("the v1 routes this server calls exist", () => {
    read("src/app/api/v1/scrapes/route.ts");
    read("src/app/api/v1/scrapes/[id]/route.ts");
    read("src/app/api/v1/scrapes/[id]/results/route.ts");
    const exp = read("src/app/api/v1/scrapes/[id]/export/route.ts");
    assert.match(exp, /format !== "xlsx" && format !== "csv"/);
  });
});
