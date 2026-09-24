#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HubertinoClient } from "./client.js";
import { ConfigError, DEFAULT_API_URL, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `hubertino-mcp ${VERSION}: MCP server for Hubertino (Google Maps lead scraper), stdio transport.

Usage: hubertino-mcp [--help] [--version]

Environment:
  HUBERTINO_API_KEY       Your hub_live_... API key (create one at ${DEFAULT_API_URL}/dashboard/settings). Required for tool calls.
  HUBERTINO_API_URL       API base URL (default ${DEFAULT_API_URL}).
  HUBERTINO_DOWNLOAD_DIR  Where download_export saves files (default ~/Downloads, else the temp directory).

Docs: ${DEFAULT_API_URL}/docs`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  const client = new HubertinoClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    userAgent: `hubertino-mcp/${VERSION} (+${DEFAULT_API_URL}/docs)`,
  });
  const server = createServer({ client, downloadDir: config.downloadDir });
  await server.connect(new StdioServerTransport());

  // stdout carries the MCP protocol; diagnostics go to stderr only.
  if (!config.apiKey) {
    process.stderr.write(
      "hubertino-mcp: HUBERTINO_API_KEY is not set. Tools will return an error until it is configured.\n",
    );
  }

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
  process.stderr.write(`hubertino-mcp: ${message}\n`);
  process.exit(1);
});
