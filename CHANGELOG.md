# Changelog

## 0.1.0 (unreleased)

- First version. Six tools (`start_scrape`, `get_scrape`, `wait_for_scrape`, `list_scrapes`, `get_results`, `download_export`) and one prompt (`build_lead_list`). They wrap Hubertino's authenticated `/api/v1` over stdio.
- `start_scrape` takes the same inputs and limits as the API's `scrapeInputSchema`.
- Tool errors give a clear next step for 400, 401, 402, 403, 404, 409, 410, 429 and 5xx responses, for network failures and for a missing API key.
- Adds metadata for the official MCP Registry (`server.json`), MCPB (`manifest.json`), Smithery (`smithery.yaml`) and Glama (`glama.json`, `Dockerfile`).
