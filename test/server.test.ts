import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FetchLike } from "../src/client.js";
import { callTool, connect, json, makeScrape, mockFetch, API_URL } from "./helpers.js";

const EXPECTED_TOOLS = [
  "download_export",
  "get_results",
  "get_scrape",
  "list_scrapes",
  "start_scrape",
  "wait_for_scrape",
];

describe("tool listing", () => {
  it("exposes the six tools with descriptions, annotations and schemas", async () => {
    const { fetch } = mockFetch();
    const { client, close } = await connect(fetch);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
      for (const tool of tools) {
        assert.ok((tool.description ?? "").length > 80, `${tool.name} has a useful description`);
        assert.ok(tool.annotations, `${tool.name} has annotations`);
      }
      const start = tools.find((t) => t.name === "start_scrape")!;
      const props = start.inputSchema.properties as Record<string, any>;
      assert.deepEqual(Object.keys(props).sort(), [
        "categories",
        "country",
        "enrichLinks",
        "enrichWebsite",
        "locations",
        "maxResults",
      ]);
      assert.deepEqual([...(start.inputSchema.required ?? [])].sort(), ["categories", "locations", "maxResults"]);
      assert.equal(props.maxResults.maximum, 500);
      assert.equal(props.maxResults.minimum, 1);
      assert.equal(props.categories.maxItems, 1000);
      assert.equal(props.locations.maxItems, 10000);
      assert.equal(props.country.enum.length, 32);
      assert.equal(props.enrichWebsite.default, true);
      assert.equal(start.annotations?.readOnlyHint, false);

      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map((p) => p.name), ["build_lead_list"]);
    } finally {
      await close();
    }
  });
});

describe("start_scrape", () => {
  it("posts the validated input and explains the reservation", async () => {
    const scrape = makeScrape({ creditsReserved: 200 });
    const { fetch, calls } = mockFetch(json(201, { scrape }));
    const { client, close } = await connect(fetch);
    try {
      const { result, data } = await callTool(client, "start_scrape", {
        categories: [" dentist ", "orthodontist"],
        locations: ["Austin, TX, United States"],
        maxResults: 100,
      });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes`);
      assert.deepEqual(calls[0]!.body, {
        categories: ["dentist", "orthodontist"],
        locations: ["Austin, TX, United States"],
        maxResults: 100,
        enrichLinks: true,
        enrichWebsite: true,
      });
      assert.equal(data.id, scrape.id);
      assert.equal(data.status, "queued");
      assert.equal(data.searchCount, 2);
      assert.match(data.credits, /Reserved 200 credits/);
      assert.match(data.credits, /refunded automatically/);
      assert.doesNotMatch(data.credits, /worst case/);
      assert.match(data.next, /wait_for_scrape/);
    } finally {
      await close();
    }
  });

  it("notes when the reservation was capped at the balance", async () => {
    const { fetch } = mockFetch(json(201, { scrape: makeScrape({ creditsReserved: 100 }) }));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "start_scrape", {
        categories: ["plumber"],
        locations: ["Leeds, United Kingdom", "York, United Kingdom"],
        maxResults: 500,
        country: "gb",
      });
      assert.match(data.credits, /worst case was 1,000 credits/);
      assert.match(data.credits, /stop after 100 businesses/);
    } finally {
      await close();
    }
  });

  it("rejects more than 2,000 searches without calling the API", async () => {
    const { fetch, calls } = mockFetch(json(201, { scrape: makeScrape() }));
    const { client, close } = await connect(fetch);
    try {
      const locations = Array.from({ length: 1001 }, (_, i) => `Zip ${10000 + i}`);
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist", "orthodontist"],
        locations,
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /up to 2,000 searches/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });

  it("rejects out-of-range input before calling the API", async () => {
    const { fetch, calls } = mockFetch(json(201, { scrape: makeScrape() }));
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 501,
      });
      assert.equal(result.isError, true);
      assert.match(text, /maxResults/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });

  it("surfaces 402 insufficient credits as a tool error", async () => {
    const { fetch } = mockFetch(json(402, { error: "You're out of credits — top up to start another scrape." }));
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /Not enough Hubertino credits \(402\)/);
      assert.match(text, /https:\/\/hubertino\.test\/dashboard\/billing/);
    } finally {
      await close();
    }
  });

  it("surfaces 429 rate limits as a tool error", async () => {
    const { fetch } = mockFetch(json(429, { error: "Rate limit exceeded — retry in a few minutes." }));
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /Rate limited \(429\)/);
    } finally {
      await close();
    }
  });

  it("warns against a blind retry when a start request fails ambiguously", async () => {
    const { fetch } = mockFetch(
      () => new Response("<html>Gateway time-out</html>", { status: 524, headers: { "content-type": "text/html" } }),
    );
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /temporarily unavailable \(524\)/);
      assert.match(text, /may still have been created/);
      assert.match(text, /list_scrapes/);
    } finally {
      await close();
    }
  });

  it("does not add the duplicate warning when the API says no credits were used", async () => {
    const { fetch } = mockFetch(
      json(503, {
        error: "The scraping engine is temporarily unavailable. No credits were used — please try again in a minute.",
      }),
    );
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /No credits were used/);
      assert.doesNotMatch(text, /may still have been created/);
    } finally {
      await close();
    }
  });

  it("explains a missing API key without calling the API", async () => {
    const { fetch, calls } = mockFetch(json(201, { scrape: makeScrape() }));
    const { client, close } = await connect(fetch, { apiKey: null });
    try {
      const { result, text } = await callTool(client, "start_scrape", {
        categories: ["dentist"],
        locations: ["Austin"],
        maxResults: 10,
      });
      assert.equal(result.isError, true);
      assert.match(text, /HUBERTINO_API_KEY is not set/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });
});

describe("get_scrape / wait_for_scrape / list_scrapes", () => {
  it("get_scrape returns status, progress, credits and coverage", async () => {
    const scrape = makeScrape({
      status: "running",
      resultCount: 40,
      progress: { stage: "details", stageLabel: "Extracting place details", pairsDone: 1, pairsTotal: 1, found: 80, extracted: 40, updated: 40, percent: 62 },
      coverage: { total: 40, email: 18, phone: 39 },
      searches: [{ query: "dentist Austin", url: "https://www.google.com/maps/search/dentist", results: 80 }],
    });
    const { fetch, calls } = mockFetch(json(200, { scrape }));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_scrape", { scrapeId: scrape.id });
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/${scrape.id}`);
      assert.equal(data.status, "running");
      assert.equal(data.progress.percent, 62);
      assert.equal(data.coverage.email, 18);
      assert.equal(data.creditsReserved, 50);
      assert.equal(data.searchesCount, 1);
      assert.equal(data.searches, undefined);

      const withSearches = await callTool(client, "get_scrape", { scrapeId: scrape.id, includeSearches: true });
      assert.equal(withSearches.data.searches.length, 1);
    } finally {
      await close();
    }
  });

  it("wait_for_scrape polls until the scrape is done", async () => {
    const id = makeScrape().id;
    const { fetch, calls } = mockFetch(
      json(200, { scrape: makeScrape({ status: "queued" }) }),
      json(200, { scrape: makeScrape({ status: "running" }) }),
      json(200, { scrape: makeScrape({ status: "done", resultCount: 73, creditsCharged: 73, finishedAt: "2026-09-24T10:05:00.000Z" }) }),
    );
    const sleeps: number[] = [];
    const { client, close } = await connect(fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    try {
      const { data } = await callTool(client, "wait_for_scrape", { scrapeId: id, pollIntervalSeconds: 3 });
      assert.equal(calls.length, 3);
      assert.deepEqual(sleeps, [3000, 3000]);
      assert.equal(data.status, "done");
      assert.equal(data.creditsCharged, 73);
      assert.equal(data.waited, undefined);
      assert.match(data.next, /get_results/);
    } finally {
      await close();
    }
  });

  it("wait_for_scrape returns the current status when the timeout passes", async () => {
    let clock = 0;
    const { fetch, calls } = mockFetch(json(200, { scrape: makeScrape({ status: "running" }) }));
    const { client, close } = await connect(fetch, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    try {
      const { data } = await callTool(client, "wait_for_scrape", {
        scrapeId: "abc",
        timeoutSeconds: 12,
        pollIntervalSeconds: 5,
      });
      assert.equal(calls.length, 4); // t=0, 5, 10, 12
      assert.equal(data.status, "running");
      assert.match(data.waited, /Still running after 12s/);
    } finally {
      await close();
    }
  });

  it("wait_for_scrape bounds a slow status check by its deadline", async () => {
    let clock = 0;
    let n = 0;
    const fetch: FetchLike = (_url, init) => {
      n++;
      if (n === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ scrape: makeScrape({ status: "running", resultCount: 12 }) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      // The API hangs; only the client's timeout ends this request.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const { client, close } = await connect(fetch, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      waitGraceMs: 50,
    });
    try {
      const started = Date.now();
      const { data, result } = await callTool(client, "wait_for_scrape", {
        scrapeId: "abc",
        timeoutSeconds: 5,
        pollIntervalSeconds: 5,
      });
      assert.ok(Date.now() - started < 5_000, "the hanging check was cut off at deadline + grace");
      assert.equal(result.isError, undefined);
      assert.equal(n, 2);
      assert.equal(data.status, "running", "reports the last good status");
      assert.equal(data.resultCount, 12);
      assert.match(data.waited, /Still running/);
    } finally {
      await close();
    }
  });

  it("get_scrape shortens very long location lists", async () => {
    const locations = Array.from({ length: 2000 }, (_, i) => `${78000 + i}, TX, United States`);
    const { fetch } = mockFetch(json(200, { scrape: makeScrape({ status: "running", locations }) }));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_scrape", { scrapeId: "abc" });
      assert.equal(data.locations.length, 25);
      assert.equal(data.locationsTotal, 2000);
      assert.deepEqual(data.categories, ["dentist"]);
      assert.equal(data.categoriesTotal, undefined);
    } finally {
      await close();
    }
  });

  it("wait_for_scrape reports progress when the client sends a progress token", async () => {
    const { fetch } = mockFetch(
      json(200, { scrape: makeScrape({ status: "running", progress: { stage: "discovering", stageLabel: "Searching Google Maps", pairsDone: 0, pairsTotal: 1, found: 0, extracted: 0, updated: 0, percent: 5 } }) }),
      json(200, { scrape: makeScrape({ status: "done", resultCount: 3 }) }),
    );
    const { client, close } = await connect(fetch);
    try {
      const seen: Array<{ progress: number; total?: number; message?: string }> = [];
      await client.callTool(
        { name: "wait_for_scrape", arguments: { scrapeId: "abc" } },
        undefined,
        { onprogress: (p) => seen.push(p) },
      );
      assert.deepEqual(
        seen.map((p) => p.progress),
        [5, 100],
      );
      assert.match(seen[0]!.message ?? "", /Searching Google Maps/);
    } finally {
      await close();
    }
  });

  it("wait_for_scrape rides out a transient 503 but stops on a 404", async () => {
    const { fetch, calls } = mockFetch(
      json(200, { scrape: makeScrape({ status: "running" }) }),
      json(503, { error: "The scraping engine is temporarily unavailable." }),
      json(200, { scrape: makeScrape({ status: "done", resultCount: 9 }) }),
    );
    const { client, close } = await connect(fetch);
    try {
      const { data, result } = await callTool(client, "wait_for_scrape", { scrapeId: "abc" });
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 3);
      assert.equal(data.status, "done");
    } finally {
      await close();
    }

    const notFound = mockFetch(json(404, { error: "Job not found." }));
    const second = await connect(notFound.fetch);
    try {
      const { result, text } = await callTool(second.client, "wait_for_scrape", { scrapeId: "nope" });
      assert.equal(result.isError, true);
      assert.match(text, /Not found \(404\)/);
      assert.equal(notFound.calls.length, 1);
    } finally {
      await second.close();
    }
  });

  it("wait_for_scrape does not retry a missing API key", async () => {
    const { fetch, calls } = mockFetch(json(200, { scrape: makeScrape() }));
    const { client, close } = await connect(fetch, { apiKey: null });
    try {
      const { result, text } = await callTool(client, "wait_for_scrape", { scrapeId: "abc" });
      assert.equal(result.isError, true);
      assert.match(text, /HUBERTINO_API_KEY is not set/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });

  it("list_scrapes filters by status and limits the list", async () => {
    const scrapes = [
      makeScrape({ id: "a", status: "done", resultCount: 10 }),
      makeScrape({ id: "b", status: "running" }),
      makeScrape({ id: "c", status: "done", resultCount: 5 }),
      makeScrape({ id: "d", status: "error", error: "The scrape could not be completed." }),
    ];
    const { fetch, calls } = mockFetch(json(200, { scrapes }));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "list_scrapes", { status: "done", limit: 1 });
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes`);
      assert.equal(data.total, 2);
      assert.equal(data.returned, 1);
      assert.deepEqual(data.scrapes.map((s: { id: string }) => s.id), ["a"]);
      assert.equal(data.scrapes[0].categories, undefined, "list entries stay compact");

      const all = await callTool(client, "list_scrapes", {});
      assert.equal(all.data.total, 4);
      assert.equal(all.data.scrapes[3].error, "The scrape could not be completed.");
    } finally {
      await close();
    }
  });
});

describe("get_results", () => {
  const rows = [
    {
      query: "dentist Austin, TX",
      name: "Bright Smiles",
      category: "Dentist",
      phone: "+1 512-555-0100",
      email: "hello@brightsmiles.example",
      website: "https://brightsmiles.example",
      domain: "brightsmiles.example",
      city: "Austin",
      latitude: 30.2,
      longitude: -97.7,
      working_hours: '{"Monday":"9 AM–5 PM"}',
      rating: 4.8,
      reviews: 210,
      company_facebook: "",
      _status: "enriched",
    },
    { name: "No Email Dental", phone: "+1 512-555-0101", city: "Austin", email: null, _status: "extracted" },
  ];
  const page = (extra: Record<string, unknown> = {}) => ({
    status: "done",
    partial: false,
    count: 250,
    updated: 250,
    coverage: { total: 250, email: 120 },
    columns: ["query", "name", "category", "phone", "email", "website", "domain", "city", "latitude", "longitude", "working_hours", "rating", "reviews", "company_facebook"],
    rows,
    offset: 100,
    limit: 2,
    hasMore: true,
    ...extra,
  });

  it("maps paging to offset/limit and returns compact rows with nextOffset", async () => {
    const { fetch, calls } = mockFetch(json(200, page()));
    const { client, close } = await connect(fetch);
    try {
      const { data, text } = await callTool(client, "get_results", { scrapeId: "abc", offset: 100, limit: 2 });
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abc/results?offset=100&limit=2`);
      assert.ok(!text.includes("\n"), "results JSON is not pretty-printed");
      assert.equal(data.total, 250);
      assert.equal(data.returned, 2);
      assert.equal(data.hasMore, true);
      assert.equal(data.nextOffset, 102);
      assert.deepEqual(data.rows[0], {
        name: "Bright Smiles",
        category: "Dentist",
        phone: "+1 512-555-0100",
        email: "hello@brightsmiles.example",
        website: "https://brightsmiles.example",
        city: "Austin",
        rating: 4.8,
        reviews: 210,
        _status: "enriched",
      });
      assert.deepEqual(data.rows[1], { name: "No Email Dental", phone: "+1 512-555-0101", city: "Austin", _status: "extracted" });
    } finally {
      await close();
    }
  });

  it("uses the tool defaults offset=0 limit=50", async () => {
    const { fetch, calls } = mockFetch(json(200, page({ offset: 0, limit: 50, hasMore: false })));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_results", { scrapeId: "abc" });
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abc/results?offset=0&limit=50`);
      assert.equal(data.nextOffset, null);
    } finally {
      await close();
    }
  });

  it("filters to rows with an email and projects requested fields", async () => {
    const { fetch } = mockFetch(json(200, page()));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_results", {
        scrapeId: "abc",
        offset: 100,
        limit: 2,
        withEmailOnly: true,
        fields: ["name", "email", "latitude", "nope"],
      });
      assert.equal(data.returned, 1);
      assert.equal(data.filteredOut, 1);
      assert.equal(data.nextOffset, 102, "paging advances over the whole page, not just kept rows");
      assert.deepEqual(data.rows, [{ name: "Bright Smiles", email: "hello@brightsmiles.example", latitude: 30.2 }]);
      assert.deepEqual(data.unknownFields, ["nope"]);
      assert.match(data.note, /withEmailOnly filters inside this page/);
    } finally {
      await close();
    }
  });

  it("returns every populated column with detail=full", async () => {
    const { fetch } = mockFetch(json(200, page()));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_results", { scrapeId: "abc", offset: 100, limit: 2, detail: "full" });
      assert.equal(data.rows[0].latitude, 30.2);
      assert.equal(data.rows[0].working_hours, '{"Monday":"9 AM–5 PM"}');
      assert.equal(data.rows[0].company_facebook, undefined, "empty strings are still dropped");
    } finally {
      await close();
    }
  });

  it("cuts a page short at the output budget and continues from the first row not returned", async () => {
    // ~1,300 characters per row: 1,000 of them would be ~1.3 MB of JSON.
    const bigRows = Array.from({ length: 1000 }, (_, i) => ({
      name: `Business ${i}`,
      email: i % 2 === 0 ? `info${i}@example.com` : null,
      location_link: `https://www.google.com/maps/place/${"x".repeat(1200)}/${i}`,
      _status: "enriched",
    }));
    const { fetch } = mockFetch(json(200, page({ rows: bigRows, count: 5000, offset: 0, limit: 1000, hasMore: true })));
    const { client, close } = await connect(fetch);
    try {
      const { text, data } = await callTool(client, "get_results", { scrapeId: "abc", limit: 1000, detail: "full" });
      assert.ok(text.length < 60_000, `response is ${text.length} chars`);
      assert.equal(data.trimmed, true);
      assert.equal(data.hasMore, true);
      assert.ok(data.returned > 10 && data.returned < 1000);
      assert.equal(data.nextOffset, data.returned, "the next page starts right after the last returned row");
      assert.equal(data.rows.at(-1).name, `Business ${data.returned - 1}`);
      assert.match(data.note, /Continue with offset/);

      // With a narrow projection the same page fits in full.
      const narrow = await callTool(client, "get_results", { scrapeId: "abc", limit: 1000, fields: ["name", "email"] });
      assert.equal(narrow.data.trimmed, undefined);
      assert.equal(narrow.data.returned, 1000);
      assert.equal(narrow.data.nextOffset, 1000);
    } finally {
      await close();
    }
  });

  it("keeps withEmailOnly paging exact when a page is cut short", async () => {
    const bigRows = Array.from({ length: 400 }, (_, i) => ({
      name: `Business ${i}`,
      email: i % 2 === 0 ? `info${i}@example.com` : null,
      location_link: `https://www.google.com/maps/place/${"x".repeat(1200)}/${i}`,
    }));
    const { fetch } = mockFetch(json(200, page({ rows: bigRows, count: 400, offset: 0, limit: 400, hasMore: false })));
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "get_results", { scrapeId: "abc", limit: 400, detail: "full", withEmailOnly: true });
      assert.equal(data.trimmed, true);
      assert.equal(data.hasMore, true, "trimmed pages always have more");
      const lastIndex = Number(String(data.rows.at(-1).name).split(" ")[1]);
      // Rows between the last returned one and nextOffset were examined and
      // filtered out; the row at nextOffset is the first one that did not fit.
      assert.ok(data.nextOffset > lastIndex);
      for (let i = lastIndex + 1; i < data.nextOffset; i++) assert.equal(bigRows[i]!.email, null);
      assert.ok(bigRows[data.nextOffset]!.email);
      assert.equal(data.filteredOut, data.nextOffset - data.returned);
    } finally {
      await close();
    }
  });

  it("caps page size at 1000", async () => {
    const { fetch, calls } = mockFetch(json(200, page()));
    const { client, close } = await connect(fetch);
    try {
      const { result } = await callTool(client, "get_results", { scrapeId: "abc", limit: 5000 });
      assert.equal(result.isError, true);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });
});

describe("download_export", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hubertino-mcp-test-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const csvResponse = () =>
    new Response("name,phone,email\nBright Smiles,+1 512-555-0100,hello@brightsmiles.example\n", {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="hubertino-6f1c2a9e.csv"',
      },
    });

  it("downloads the export into the configured directory without overwriting", async () => {
    const { fetch, calls } = mockFetch(csvResponse);
    const { client, close } = await connect(fetch, { downloadDir: dir });
    try {
      await writeFile(join(dir, "hubertino-6f1c2a9e.csv"), "existing");
      const { data, result } = await callTool(client, "download_export", { scrapeId: "6f1c2a9e-1111", format: "csv" });
      assert.equal(result.isError, undefined);
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/6f1c2a9e-1111/export?format=csv`);
      assert.equal(data.path, join(dir, "hubertino-6f1c2a9e-1.csv"));
      assert.equal(await readFile(join(dir, "hubertino-6f1c2a9e.csv"), "utf8"), "existing");
      const saved = await readFile(data.path, "utf8");
      assert.match(saved, /Bright Smiles/);
      assert.equal(data.bytes, Buffer.byteLength(saved));
    } finally {
      await close();
    }
  });

  it("defaults to xlsx and honours an explicit absolute directory", async () => {
    const sub = join(dir, "nested", "exports");
    const { fetch, calls } = mockFetch(
      () => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { "content-type": "application/octet-stream" } }),
    );
    const { client, close } = await connect(fetch);
    try {
      const { data } = await callTool(client, "download_export", { scrapeId: "abcdef12-3456", directory: sub });
      assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abcdef12-3456/export?format=xlsx`);
      assert.equal(data.path, join(sub, "hubertino-abcdef12.xlsx"));
      assert.deepEqual([...(await readFile(data.path))], [80, 75, 3, 4]);
      assert.deepEqual(await readdir(sub), ["hubertino-abcdef12.xlsx"]);
    } finally {
      await close();
    }
  });

  it("rejects a relative directory", async () => {
    const { fetch, calls } = mockFetch(csvResponse);
    const { client, close } = await connect(fetch);
    try {
      const { result, text } = await callTool(client, "download_export", { scrapeId: "abc", directory: "exports" });
      assert.equal(result.isError, true);
      assert.match(text, /absolute path/);
      assert.equal(calls.length, 0);
    } finally {
      await close();
    }
  });

  it("explains a 409 when the scrape has not finished", async () => {
    const { fetch } = mockFetch(json(409, { error: "The job has not finished yet." }));
    const { client, close } = await connect(fetch, { downloadDir: dir });
    try {
      const { result, text } = await callTool(client, "download_export", { scrapeId: "abc" });
      assert.equal(result.isError, true);
      assert.match(text, /Not ready yet \(409\).*has not finished yet/);
    } finally {
      await close();
    }
  });
});
