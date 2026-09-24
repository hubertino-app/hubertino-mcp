import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HubertinoClient, type FetchLike, type Scrape } from "../src/client.js";
import { createServer, type ServerDeps } from "../src/server.js";

export const API_URL = "https://hubertino.test";
export const API_KEY = "hub_live_testkey123";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch stand-in: records every call and answers from a queue of responders. */
export function mockFetch(...responders: Responder[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responders];
  const fetch: FetchLike = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error(`Unexpected fetch: ${call.method} ${call.url}`);
    return next(call);
  };
  return { fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Responder {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

export function makeScrape(overrides: Partial<Scrape> = {}): Scrape {
  return {
    id: "6f1c2a9e-1111-4222-8333-944455556666",
    kind: "scrape",
    status: "queued",
    title: "dentist — Austin, TX",
    categories: ["dentist"],
    locations: ["Austin, TX"],
    maxResults: 50,
    country: "us",
    enrichLinks: true,
    enrichWebsite: true,
    creditsReserved: 50,
    creditsCharged: null,
    resultCount: 0,
    error: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

export function makeClient(fetch: FetchLike, apiKey: string | null = API_KEY): HubertinoClient {
  return new HubertinoClient({ apiUrl: API_URL, apiKey, fetch, userAgent: "hubertino-mcp/test" });
}

/** Connect an in-memory MCP client to a server built around a mocked fetch. */
export async function connect(
  fetch: FetchLike,
  extra: Partial<Omit<ServerDeps, "client">> & { apiKey?: string | null } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer({
    client: makeClient(fetch, extra.apiKey === undefined ? API_KEY : extra.apiKey),
    downloadDir: extra.downloadDir ?? null,
    sleep: extra.sleep ?? (async () => {}),
    now: extra.now,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: CallToolResult; text: string; data: any }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  let data: any = undefined;
  try {
    data = JSON.parse(text);
  } catch {
    // error results are plain text
  }
  return { result, text, data };
}
