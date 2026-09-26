# Hubertino MCP server: Google Maps leads for Claude, Cursor and other AI agents

`@hubertino/mcp-server` connects any [Model Context Protocol](https://modelcontextprotocol.io) client (Claude Desktop, Claude Code, Cursor, VS Code, ...) to [Hubertino](https://hubertino.com), a Google Maps lead scraper. Ask your assistant for "dentists in Austin with emails". It starts a scrape, waits for it to finish, and gives you the leads as a table or as a CSV/XLSX file.

It wraps Hubertino's authenticated public REST API ([docs](https://hubertino.com/docs)) and uses your own API key and credits.

## What you get

Each lead is one Google Maps business. Only fields that have a value are returned:

- **Contact:** name, category, phone, website, and an **email** found on the business's own website (`enrichWebsite`).
- **Social profiles:** Facebook, Instagram, LinkedIn, X, YouTube (`enrichLinks`).
- **Location:** address, city, state, postal code, country code, and a Google Maps link / place id.
- **Reputation:** rating, review count, business status.
- **Extra fields (left out of compact results to save context):** coordinates, opening hours, price range, service options, and order/reservation/menu links. Get them with `get_results` `detail: "full"`, or in the `download_export` file.

## Tools

| Tool | What it does | API call |
| --- | --- | --- |
| `start_scrape` | Starts a scrape for `categories` × `locations`. **Uses credits.** | `POST /api/v1/scrapes` |
| `get_scrape` | Returns status, progress, credits reserved and charged, and how many rows have an email, phone, etc. | `GET /api/v1/scrapes/{id}` |
| `wait_for_scrape` | Polls until the scrape is done or a timeout (default 50 s) passes. Sends progress notifications. | `GET /api/v1/scrapes/{id}` |
| `list_scrapes` | Lists your recent scrapes, optionally filtered by status. | `GET /api/v1/scrapes` |
| `get_results` | Returns lead rows as compact JSON, paged. Options: `withEmailOnly`, `fields`, `detail`. | `GET /api/v1/scrapes/{id}/results` |
| `download_export` | Saves a finished scrape as `.xlsx` or `.csv` on your computer. | `GET /api/v1/scrapes/{id}/export` |

There is also one prompt, `build_lead_list`, which runs the whole workflow for a business type and area.

`start_scrape` takes the same inputs and limits as the API:

| Input | Type | Notes |
| --- | --- | --- |
| `categories` | string[] | Required. What to search for, e.g. `["dentist"]`. 1–1,000 items, 1–120 characters each. |
| `locations` | string[] | Required. Cities, regions or zip codes. Include the country, e.g. `"Austin, TX, United States"`. 1–10,000 items. |
| `maxResults` | integer | Required. Max places **per search** (per category × location pair), 1–500. |
| `country` | string | Optional Google edition code (`us`, `gb`, `de`, `lt`, ... 32 codes). If omitted, it is inferred from the locations. |
| `enrichWebsite` | boolean | Default `true`. Visits each business website to find an email. No extra credits. |
| `enrichLinks` | boolean | Default `true`. Collects social profiles and order/reservation links. No extra credits. |

One scrape runs at most 2,000 searches (`categories.length × locations.length`).

## Requirements

- Node.js 20 or newer (`npx` must be on the PATH your MCP client uses).
- A Hubertino account and an API key. New accounts get 100 free credits, and the API is included on every plan, including the free one.
  1. Sign up at [hubertino.com](https://hubertino.com/register).
  2. Open **Settings** ([/dashboard/settings](https://hubertino.com/dashboard/settings)) and create an API key. It starts with `hub_live_` and is shown only once, so copy it straight away.

## Install

Every client needs the same thing: run `npx -y @hubertino/mcp-server` with `HUBERTINO_API_KEY` set in its environment. Replace `hub_live_your_key_here` with your key.

### Claude Desktop

Open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`, which lives at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Add:

```json
{
  "mcpServers": {
    "hubertino": {
      "command": "npx",
      "args": ["-y", "@hubertino/mcp-server"],
      "env": {
        "HUBERTINO_API_KEY": "hub_live_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. The Hubertino tools then show up in the tools menu.

A one-click bundle (`hubertino-mcp.mcpb`) can be built with `npm run bundle` and opened in Claude Desktop. It asks for the key in a form, so you don't edit any JSON.

### Claude Code

```bash
claude mcp add hubertino -e HUBERTINO_API_KEY=hub_live_your_key_here -- npx -y @hubertino/mcp-server
```

Add `--scope user` to make it available in every project. Run `claude mcp list` to check that it's connected.

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or to `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "hubertino": {
      "command": "npx",
      "args": ["-y", "@hubertino/mcp-server"],
      "env": {
        "HUBERTINO_API_KEY": "hub_live_your_key_here"
      }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

Add this to `.vscode/mcp.json`. VS Code prompts for the key and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "hubertino-key", "description": "Hubertino API key (hub_live_...)", "password": true }
  ],
  "servers": {
    "hubertino": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hubertino/mcp-server"],
      "env": { "HUBERTINO_API_KEY": "${input:hubertino-key}" }
    }
  }
}
```

### Other clients / from source

Any MCP client that can launch a stdio server works. To run from a checkout:

```bash
git clone https://github.com/hubertino-app/hubertino-mcp.git
cd hubertino-mcp && npm install && npm run build
# then point your client at:  node /absolute/path/to/hubertino-mcp/dist/index.js
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `HUBERTINO_API_KEY` | yes | none | Your `hub_live_...` key. If it is missing, the server still starts and each tool explains how to set it. |
| `HUBERTINO_API_URL` | no | `https://hubertino.com` | API base URL. `https://hubertino.com/api/v1` works too. Only `https://` is accepted, except for `localhost`. |
| `HUBERTINO_DOWNLOAD_DIR` | no | `~/Downloads`, else the temp dir | Where `download_export` saves files. |

## Example prompts

- "Find dentists in Austin, TX with emails. 100 per search is enough."
- "Build a list of plumbers and electricians in Leeds and York, UK, then save it as a CSV."
- "Scrape roofing contractors in these zip codes: 78701, 78702, 78703. Show only the ones with an email and a website."
- "How is my last scrape doing?"
- "Show me page 2 of the results from my cafe scrape: name, phone and Instagram only."
- "Which of my finished scrapes had the most results? Download it as Excel."

A typical run looks like this:

```text
start_scrape     {"categories":["dentist"],"locations":["Austin, TX, United States"],"maxResults":100}
  -> {"id":"6f1c…","status":"queued","credits":"Reserved 100 credits … the rest is refunded automatically.", …}
wait_for_scrape  {"scrapeId":"6f1c…"}
  -> {"status":"done","resultCount":…,"creditsCharged":…,"coverage":{"total":…,"email":…}, …}
get_results      {"scrapeId":"6f1c…","withEmailOnly":true,"limit":50}
  -> {"total":…,"returned":…,"hasMore":true,"nextOffset":50,"rows":[{"name":"…","phone":"…","email":"…"}, …]}
download_export  {"scrapeId":"6f1c…","format":"csv"}
  -> {"path":"/Users/you/Downloads/hubertino-6f1c….csv","bytes":…}
```

## Credits, limits and errors

- **1 credit = 1 business delivered.** When a scrape starts, Hubertino reserves `categories × locations × maxResults` credits, capped at your balance. When it finishes, you are charged only for rows actually delivered and the rest is refunded. If your balance is below the worst case, the scrape still runs but stops once the balance is used up. See [pricing](https://hubertino.com/pricing).
- **Speed:** a scrape takes minutes. Rows can be read while it runs (`partial: true`). Each row's `_status` goes `found → extracted → enriched`.
- **Rate limit:** 12 new scrapes per 5 minutes per account. Status, results and export calls are not rate limited.
- **Page size:** `get_results` reads up to 1,000 rows per call (default 50). To protect the model's context window, a page that would not fit in one tool response (about 50,000 characters) is cut short with `trimmed: true`; keep paging from `nextOffset`, ask for fewer columns with `fields`, or use `download_export` to get everything.
- **Long scrapes:** `get_scrape` and `wait_for_scrape` echo at most 25 categories/locations and add `categoriesTotal` / `locationsTotal` for longer lists. `wait_for_scrape` never runs more than about 8 s past its `timeoutSeconds`, even when the API answers slowly.
- **Export:** only available once status is `done`.

Errors come back as tool errors with a next step, so the assistant can recover or tell you what to do:

| HTTP | Meaning | What the tool says |
| --- | --- | --- |
| 400 | Invalid input | The API's message naming the bad field |
| 401 | Missing/invalid key | Check `HUBERTINO_API_KEY`; create or rotate one in Settings |
| 402 | Not enough credits | Nothing was charged; top up at /dashboard/billing |
| 403 | Refused (e.g. email not verified) | The API's message |
| 404 | Unknown scrape id | Check the id with `list_scrapes` |
| 409 | Not finished yet | Wait with `wait_for_scrape`, then retry |
| 410 | Results no longer stored | Start a new scrape |
| 429 | Rate limited | Wait a few minutes before starting another scrape |
| 5xx | Temporarily unavailable | Retry in a minute |
| timeout / network | No answer from Hubertino | Retry shortly |

If starting a scrape fails with a timeout, network error or 5xx, the scrape may still have been created. `start_scrape` then says to check `list_scrapes` before starting it again, so the same scrape is not run and charged twice.

## Security and privacy

- Your API key stays in your MCP client's config and is sent only as a Bearer header to the Hubertino API over HTTPS. The server never logs it or returns it in a response. Don't paste your key into the chat.
- The server calls only the authenticated `/api/v1` endpoints listed above. It makes no other network calls and does no scraping itself.
- `download_export` writes only `hubertino-<scrape id prefix>.csv` / `.xlsx` files into the chosen folder and never overwrites an existing file.
- Use lead data lawfully. Follow the privacy and anti-spam rules that apply to you and to the people you contact (for example GDPR, PECR, CAN-SPAM).

## Development

```bash
npm install
npm run build        # compile to dist/
npm test             # type-check and run the node:test suites (mocked fetch; no network)
npm run smoke        # spawn dist/index.js over stdio and list tools (set HUBERTINO_API_KEY for a live read-only call)
npm run bundle       # build hubertino-mcp.mcpb (Claude Desktop / Smithery bundle)

# optional: compare mirrored limits with a local checkout of the Hubertino app
HUBERTINO_APP_DIR=/path/to/hubertino/app npm test
```

Publishing steps are in [PUBLISHING.md](PUBLISHING.md).

## Links

- API docs: https://hubertino.com/docs
- Pricing: https://hubertino.com/pricing
- Google Maps scraper: https://hubertino.com/google-maps-scraper
- Affiliate program (25% recurring): https://hubertino.com/partners

## License

MIT © Hubertino MB
