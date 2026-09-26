# Publishing hubertino-mcp

This file lists every manual step for publishing the server. Nothing here has been published yet. Work through the steps in order: later steps link to the GitHub repo and the npm package, so those have to exist first.

Tool versions and directory rules were checked on **2026-09-24**:

- `@modelcontextprotocol/sdk` 1.30.1
- MCP Registry schema `2025-12-11`
- `@anthropic-ai/mcpb` 2.1.2
- `@smithery/cli` 4.11.1

---

## 0. Decide the namespace and replace the placeholders

The official MCP Registry ties a server name to a proven identity:

| Option | Server name (`mcpName`) | How you prove it |
| --- | --- | --- |
| **A. GitHub** (default in this repo) | `io.github.<owner>/hubertino-mcp` | `mcp-publisher login github`. `<owner>` is your GitHub username, or an org where you are an **Owner**. |
| **B. Domain** (brand-owned, recommended long term) | `com.hubertino/mcp-server` | `mcp-publisher login dns`, using a TXT record on the `hubertino.com` apex (DNS is managed in Cloudflare). |

**Done (2026-09-26):** option A is wired in. The placeholders are replaced with the GitHub org `hubertino-app`, so the server name is `io.github.hubertino-app/hubertino-mcp`. `glama.json` lists the user account `hubertino-com` instead, because Glama listings are claimed by a GitHub user, not an org.

With option B, also set `"mcpName": "com.hubertino/mcp-server"` in `package.json` and `"name": "com.hubertino/mcp-server"` in `server.json`. Keep the GitHub URLs, because they still point at the source.

Then check that everything still agrees. `test/metadata.test.ts` fails if the name, version, package id or env vars drift apart:

```bash
npm ci && npm run build && npm test
```

Commit the change on `main`.

> `mcpName` must be in `package.json` **before** you publish to npm. The registry reads it from the published npm package to confirm that you own it.

## 1. GitHub repository

1. Create a **public** repo `hubertino-app/hubertino-mcp` on GitHub. Leave it empty: no README or license.
2. Push:
   ```bash
   git remote add origin https://github.com/hubertino-app/hubertino-mcp.git
   git push -u origin main
   ```
3. Set the description to "MCP server for Hubertino: Google Maps business leads (phones, websites, emails, socials)", the website to `https://hubertino.com/docs`, and these topics: `mcp`, `mcp-server`, `model-context-protocol`, `google-maps`, `google-maps-scraper`, `lead-generation`.
4. CI (`.github/workflows/ci.yml`) runs build and tests on Node 20, 22 and 24. Check that the first run is green. Node 20 was not tested locally, because only Node 26 is installed here.

## 2. npm (`@hubertino/mcp-server`)

1. `npm login`, with 2FA enabled on the account.
2. The `@hubertino` scope must belong to you. Check `https://www.npmjs.com/org/hubertino`. If it doesn't exist, create a free org called `hubertino` at npmjs.com → **Add Organization**. If the name is taken by someone else, rename the package (for example to `hubertino-mcp`) in `package.json`, `server.json` (`packages[0].identifier`) and every `npx -y @hubertino/mcp-server` in `README.md`.
3. Dry run first, then publish. `prepack` builds and `prepublishOnly` runs the tests:
   ```bash
   npm pack --dry-run          # expect dist/*.js, README.md, LICENSE, package.json
   npm publish --access public
   ```
4. Verify:
   ```bash
   npm view @hubertino/mcp-server version mcpName
   npx -y @hubertino/mcp-server --version
   ```
5. Optional live check with a real key (read-only; lists your scrapes):
   ```bash
   HUBERTINO_API_KEY=hub_live_... npm run smoke
   ```
   For a full end-to-end check, run a tiny scrape from Claude or Cursor (`maxResults: 5` costs at most 5 credits).

## 3. Official MCP Registry (registry.modelcontextprotocol.io)

1. Install the publisher CLI:
   ```bash
   brew install mcp-publisher
   # or:
   curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
   ```
2. Log in. Option A:
   ```bash
   mcp-publisher login github      # device flow: open github.com/login/device and enter the code
   ```
   Option B (domain). macOS's built-in LibreSSL can't do Ed25519, so use OpenSSL 3 (`brew install openssl@3`, then `/opt/homebrew/opt/openssl@3/bin/openssl`):
   ```bash
   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
   $OPENSSL genpkey -algorithm Ed25519 -out key.pem          # keep key.pem secret, outside the repo
   PUBLIC_KEY="$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   echo "hubertino.com. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
   # add that TXT record at the APEX of hubertino.com in Cloudflare (not under a subdomain), wait for it to propagate, then:
   PRIVATE_KEY="$($OPENSSL pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
   mcp-publisher login dns --domain hubertino.com --private-key "${PRIVATE_KEY}"
   ```
3. Publish from the repo root. It reads `server.json`, and npm must already have this version:
   ```bash
   mcp-publisher publish
   ```
4. Verify:
   ```bash
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=hubertino"
   ```

`server.json` was validated against the official `2025-12-11` schema on 2026-09-24. The description is 85 characters, under the 100-character limit.

## 4. Glama (glama.ai/mcp/servers)

Glama indexes GitHub repos, runs servers in Docker to inspect their tools, and gives them a score. The awesome-mcp-servers list shows that score badge next to each entry.

1. Make sure `glama.json` lists your GitHub username in `maintainers` and is pushed. Its schema is `https://glama.ai/mcp/schemas/server.json`.
2. Go to https://glama.ai/mcp/servers, choose **Add Server**, and submit `https://github.com/hubertino-app/hubertino-mcp`.
3. Sign in to Glama with the GitHub account named in `glama.json` and **claim** the listing.
4. In the listing's admin, keep the provided `Dockerfile`. The server starts and lists its tools without an API key, so inspection doesn't need a secret. Don't put a real key into Glama.
5. Check that the listing shows all 6 tools and the `build_lead_list` prompt.

## 5. Smithery (smithery.ai)

Smithery now takes local stdio servers as **MCP Bundles (.mcpb)**. `smithery.yaml` stays in the repo for the older repo-based flow and for directories that read it.

```bash
npm run bundle                                   # builds ./hubertino-mcp.mcpb (validated by mcpb)
npx -y @smithery/cli@latest auth login
npx -y @smithery/cli@latest mcp publish ./hubertino-mcp.mcpb -n <smithery-namespace>/hubertino
```

Alternatively, use the web flow at https://smithery.ai/new. Settings come from `manifest.json` → `user_config`: API key (required, secret), API URL, and export folder. Don't upload a real key.

The same `hubertino-mcp.mcpb` can be attached to a GitHub Release. Claude Desktop users can then install it in one click.

## 6. mcp.so

1. Open https://mcp.so/submit.
2. Type: **Server**. Repository URL: `https://github.com/hubertino-app/hubertino-mcp`. Name: `Hubertino`.
3. Submit to the free review queue. On 2026-09-24 the page also offered a paid ($39, one-time) option that skips review. It isn't needed.

## 7. awesome-mcp-servers (github.com/punkpeye/awesome-mcp-servers)

Do this **after** Glama has indexed the repo, because entries in the list carry the Glama score badge.

1. Fork the repo and edit `README.md`.
2. Add the line below to **🔎 Search & Data Extraction** (the section where other scraper servers are listed). `CONTRIBUTING.md` asks for alphabetical order within a section.
   Legend: 📇 TypeScript, ☁️ talks to a cloud API, 🍎 🪟 🐧 macOS/Windows/Linux.

   ```markdown
   - [hubertino-app/hubertino-mcp](https://github.com/hubertino-app/hubertino-mcp) [![hubertino-app/hubertino-mcp MCP server](https://glama.ai/mcp/servers/hubertino-app/hubertino-mcp/badges/score.svg)](https://glama.ai/mcp/servers/hubertino-app/hubertino-mcp) 📇 ☁️ 🍎 🪟 🐧 - Google Maps lead scraper via Hubertino: scrape business types × locations, track progress, read leads (phone, website, email from the business's own site, socials, rating) or save CSV/XLSX. Uses a Hubertino API key and credits. `npx -y @hubertino/mcp-server`
   ```
3. Open a PR titled `Add Hubertino (Google Maps leads) MCP server`, and in the body say that it wraps Hubertino's authenticated REST API.

## 8. Releasing a new version

1. Bump the same version in `package.json`, `src/version.ts`, `server.json` (`version` **and** `packages[0].version`) and `manifest.json`. `npm test` fails if any of them differ.
2. Add an entry to `CHANGELOG.md`, commit and tag it (`git tag v0.1.1`), then push with `--tags`.
3. Run `npm publish --access public`, then `mcp-publisher publish`.
4. Run `npm run bundle` and upload the new `.mcpb` to Smithery (step 5) and to the GitHub Release. Glama and mcp.so pick up changes from GitHub.

## 9. Before each release: keep the API mirror honest

`start_scrape` mirrors `scrapeInputSchema` from the app. The mirrored parts are the limits 1,000 / 10,000 / 500 / 2,000 / 120 characters, the 32 country codes and the `enrich*` defaults. Before each release, run:

```bash
HUBERTINO_APP_DIR=../../app npm test
```

The drift suite reads the app's `validation.ts`, the results route and the rate limiter, and fails if they changed.
