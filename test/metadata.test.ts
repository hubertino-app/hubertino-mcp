import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { VERSION } from "../src/version.js";

// Compiled to .test-build/test/, so the repo root is two levels up.
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string) => readFileSync(root + file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));

const pkg = readJson("package.json");
const server = readJson("server.json");
const manifest = readJson("manifest.json");

describe("publishing metadata stays consistent", () => {
  it("uses one version everywhere", () => {
    assert.equal(VERSION, pkg.version, "src/version.ts matches package.json");
    assert.equal(server.version, pkg.version, "server.json version");
    assert.equal(server.packages[0].version, pkg.version, "server.json package version");
    assert.equal(manifest.version, pkg.version, "manifest.json version");
  });

  it("links the npm package to the MCP Registry entry", () => {
    assert.equal(server.name, pkg.mcpName, "server.json name must equal package.json mcpName");
    assert.equal(server.packages[0].registryType, "npm");
    assert.equal(server.packages[0].identifier, pkg.name);
    assert.equal(server.packages[0].transport.type, "stdio");
    assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.ok(server.description.length <= 100, "registry description max 100 chars");
  });

  it("declares the env vars the server reads", () => {
    const names = server.packages[0].environmentVariables.map((e: { name: string }) => e.name).sort();
    assert.deepEqual(names, ["HUBERTINO_API_KEY", "HUBERTINO_API_URL", "HUBERTINO_DOWNLOAD_DIR"]);
    const key = server.packages[0].environmentVariables.find((e: { name: string }) => e.name === "HUBERTINO_API_KEY");
    assert.equal(key.isRequired, true);
    assert.equal(key.isSecret, true);
    assert.deepEqual(Object.keys(manifest.server.mcp_config.env).sort(), names);
    assert.match(read("smithery.yaml"), /HUBERTINO_API_KEY/);
  });

  it("lists the same tools in manifest.json as the server registers", () => {
    assert.deepEqual(
      manifest.tools.map((t: { name: string }) => t.name).sort(),
      ["download_export", "get_results", "get_scrape", "list_scrapes", "start_scrape", "wait_for_scrape"],
    );
  });

  it("ships a runnable bin", () => {
    assert.equal(pkg.bin["hubertino-mcp"], "dist/index.js");
    assert.equal(manifest.server.entry_point, "dist/index.js");
    assert.ok(read("src/index.ts").startsWith("#!/usr/bin/env node"));
  });
});
