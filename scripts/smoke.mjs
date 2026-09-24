#!/usr/bin/env node
// Spawn the built server over stdio like an MCP client would, list its tools
// and, when HUBERTINO_API_KEY is set, make one read-only call (list_scrapes).
// Usage: npm run build && HUBERTINO_API_KEY=hub_live_... node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { ...process.env };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "hubertino-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const info = client.getServerVersion();
console.log(`server: ${info?.name} ${info?.version}`);
const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
const { prompts } = await client.listPrompts();
console.log(`prompts: ${prompts.map((p) => p.name).join(", ")}`);

const result = await client.callTool({ name: "list_scrapes", arguments: { limit: 3 } });
const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
console.log(`list_scrapes ${result.isError ? "error" : "ok"}: ${text.slice(0, 600)}`);

await client.close();
