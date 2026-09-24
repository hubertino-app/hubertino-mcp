import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HubertinoApiError, HubertinoClient, parseFilename } from "../src/client.js";
import { API_KEY, API_URL, json, makeClient, makeScrape, mockFetch } from "./helpers.js";

describe("HubertinoClient request mapping", () => {
  it("POSTs /api/v1/scrapes with Bearer auth and the scrapeInputSchema body", async () => {
    const scrape = makeScrape();
    const { fetch, calls } = mockFetch(json(201, { scrape }));
    const result = await makeClient(fetch).createScrape({
      categories: ["dentist"],
      locations: ["Austin, TX, United States"],
      maxResults: 50,
      country: "us",
      enrichLinks: true,
      enrichWebsite: false,
    });

    assert.deepEqual(result, scrape);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, `${API_URL}/api/v1/scrapes`);
    assert.equal(call.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.headers.accept, "application/json");
    assert.equal(call.headers["user-agent"], "hubertino-mcp/test");
    assert.deepEqual(call.body, {
      categories: ["dentist"],
      locations: ["Austin, TX, United States"],
      maxResults: 50,
      country: "us",
      enrichLinks: true,
      enrichWebsite: false,
    });
  });

  it("omits country when it is not given so the API infers it", async () => {
    const { fetch, calls } = mockFetch(json(201, { scrape: makeScrape() }));
    await makeClient(fetch).createScrape({
      categories: ["plumber"],
      locations: ["Leeds, United Kingdom"],
      maxResults: 10,
      enrichLinks: true,
      enrichWebsite: true,
    });
    assert.equal(Object.hasOwn(calls[0]!.body as object, "country"), false);
  });

  it("GETs /api/v1/scrapes for the list", async () => {
    const { fetch, calls } = mockFetch(json(200, { scrapes: [makeScrape(), makeScrape({ id: "b" })] }));
    const list = await makeClient(fetch).listScrapes();
    assert.equal(list.length, 2);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes`);
    assert.equal(calls[0]!.body, undefined);
    assert.equal(calls[0]!.headers["content-type"], undefined);
  });

  it("GETs /api/v1/scrapes/{id} with the id URL-encoded", async () => {
    const { fetch, calls } = mockFetch(json(200, { scrape: makeScrape() }));
    await makeClient(fetch).getScrape(" abc/../def ");
    assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abc%2F..%2Fdef`);
  });

  it("GETs /results with offset and limit query params", async () => {
    const page = { status: "done", partial: false, count: 3, updated: 3, coverage: null, columns: ["name"], rows: [], offset: 2, limit: 1, hasMore: false };
    const { fetch, calls } = mockFetch(json(200, page));
    const res = await makeClient(fetch).getResults("abc", { offset: 2, limit: 1 });
    assert.deepEqual(res, page);
    assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abc/results?offset=2&limit=1`);
  });

  it("GETs /export?format= and exposes the file stream and filename", async () => {
    const { fetch, calls } = mockFetch(
      () =>
        new Response("name,phone\nAcme,123\n", {
          status: 200,
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="hubertino-6f1c2a9e.csv"',
          },
        }),
    );
    const dl = await makeClient(fetch).exportScrape("abc", "csv");
    assert.equal(calls[0]!.url, `${API_URL}/api/v1/scrapes/abc/export?format=csv`);
    assert.equal(calls[0]!.headers.accept, "*/*");
    assert.equal(dl.filename, "hubertino-6f1c2a9e.csv");
    assert.equal(dl.contentType, "text/csv");
    assert.equal(await new Response(dl.body).text(), "name,phone\nAcme,123\n");
    dl.release();
  });

  it("does not call the API when no key is configured", async () => {
    const { fetch, calls } = mockFetch(json(200, { scrapes: [] }));
    await assert.rejects(makeClient(fetch, null).listScrapes(), (err: unknown) => {
      assert.ok(err instanceof HubertinoApiError);
      assert.equal(err.status, 0);
      assert.match(err.message, /HUBERTINO_API_KEY is not set/);
      assert.match(err.message, /dashboard\/settings/);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("HubertinoClient error mapping", () => {
  const cases: Array<[number, string, RegExp]> = [
    [400, "maxResults: Too big: expected number to be <=500", /invalid \(400\).*maxResults/],
    [401, "Invalid or missing API key. Pass it as `Authorization: Bearer hub_live_…`.", /API key \(401\).*hub_live_.*dashboard\/settings/],
    [402, "You're out of credits — top up to start another scrape.", /Not enough Hubertino credits \(402\).*out of credits.*dashboard\/billing/],
    [403, "Verify your email address to start scraping — check your inbox.", /refused the request \(403\).*Verify your email/],
    [404, "Job not found.", /Not found \(404\).*list_scrapes/],
    [409, "The job has not finished yet.", /Not ready yet \(409\).*wait_for_scrape/],
    [410, "The results for this job are no longer stored.", /no longer stored \(410\)/],
    [429, "Rate limit exceeded — retry in a few minutes.", /Rate limited \(429\).*12 new scrapes per 5 minutes/],
    [503, "Results are temporarily unavailable — please retry.", /temporarily unavailable \(503\)/],
  ];
  for (const [status, apiMessage, pattern] of cases) {
    it(`maps ${status} to a clear, actionable message`, async () => {
      const { fetch } = mockFetch(json(status, { error: apiMessage }));
      await assert.rejects(makeClient(fetch).getScrape("abc"), (err: unknown) => {
        assert.ok(err instanceof HubertinoApiError);
        assert.equal(err.status, status);
        assert.equal(err.apiMessage, apiMessage);
        assert.match(err.message, pattern);
        assert.ok(!err.message.includes(API_KEY), "never echoes the API key");
        assert.equal(err.retryable, status >= 500, "only 5xx is retryable");
        return true;
      });
    });
  }

  it("uses Retry-After on 429 when the API sends it", async () => {
    const { fetch } = mockFetch(json(429, { error: "Rate limit exceeded" }, { "retry-after": "120" }));
    await assert.rejects(makeClient(fetch).listScrapes(), /Retry after 120 seconds/);
  });

  it("does not echo non-JSON error bodies (e.g. proxy HTML)", async () => {
    const { fetch } = mockFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    await assert.rejects(makeClient(fetch).listScrapes(), (err: unknown) => {
      assert.ok(err instanceof HubertinoApiError);
      assert.equal(err.status, 502);
      assert.equal(err.apiMessage, null);
      assert.ok(!err.message.includes("<html>"));
      return true;
    });
  });

  it("reports network failures with the API URL", async () => {
    const fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND hubertino.test") });
    };
    await assert.rejects(makeClient(fetch).listScrapes(), /Could not reach Hubertino at https:\/\/hubertino\.test: getaddrinfo ENOTFOUND/);
  });

  it("times out slow requests", async () => {
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const client = new HubertinoClient({ apiUrl: API_URL, apiKey: API_KEY, fetch, timeoutMs: 20 });
    await assert.rejects(client.listScrapes(), /did not answer within/);
  });

  it("rejects a 2xx payload without the expected field", async () => {
    const { fetch } = mockFetch(json(200, { nope: true }));
    await assert.rejects(makeClient(fetch).getScrape("abc"), /missing "scrape"/);
  });
});

describe("parseFilename", () => {
  it("reads quoted, unquoted and RFC 5987 names and strips paths", () => {
    assert.equal(parseFilename('attachment; filename="hubertino-1234abcd.xlsx"'), "hubertino-1234abcd.xlsx");
    assert.equal(parseFilename("attachment; filename=leads.csv"), "leads.csv");
    assert.equal(parseFilename("attachment; filename*=UTF-8''my%20leads.csv"), "my_leads.csv");
    assert.equal(parseFilename('attachment; filename="../../etc/passwd"'), "passwd");
    assert.equal(parseFilename(null), null);
  });
});
