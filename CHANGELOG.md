# Changelog

## 0.1.0 (unreleased)

- First version. Six tools (`start_scrape`, `get_scrape`, `wait_for_scrape`, `list_scrapes`, `get_results`, `download_export`) and one prompt (`build_lead_list`). They wrap Hubertino's authenticated `/api/v1` over stdio.
- `start_scrape` takes the same inputs and limits as the API's `scrapeInputSchema`.
- Tool errors give a clear next step for 400, 401, 402, 403, 404, 409, 410, 429 and 5xx responses, for network failures and for a missing API key.
- `get_results` defaults to 50 rows and cuts a page short (`trimmed: true`, exact `nextOffset`) when it would exceed about 50,000 characters, so large pages don't overflow MCP client output limits.
- `get_scrape` / `wait_for_scrape` show at most 25 categories/locations (plus `categoriesTotal` / `locationsTotal`). `wait_for_scrape` bounds each status check by its deadline, so a slow API doesn't push the call past the ~60 s client timeout.
- `start_scrape` tells the assistant to check `list_scrapes` before retrying after a timeout, network error or 5xx, so an ambiguous failure doesn't lead to a duplicate, double-charged scrape.
- Adds metadata for the official MCP Registry (`server.json`), MCPB (`manifest.json`), Smithery (`smithery.yaml`) and Glama (`glama.json`, `Dockerfile`).
