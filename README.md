# mcp-bench

Run the same tool calls against several MCP servers and record what each one returned: success rate, latency, payload size, item and field counts, and the raw error when it failed. One fixture file describes the servers and the tasks, one command runs them, one command turns the results into a markdown table.

It exists because MCP catalogs describe servers and nobody measures them. The fixtures in this repo are the ones behind a series of "Zillow MCP servers compared" articles. Swap the query, add a server, rerun.

## Install

```bash
git clone https://github.com/HasData/mcp-bench.git
cd mcp-bench
npm install
cp .env.example .env   # add the keys you have; fixtures reference them as $NAME
```

Node 20 or newer. Local servers in the fixtures are started with `npx` or `uvx`, so have those on the PATH if you run them.

## Use

```bash
node mcp-bench.mjs probe zillow                 # connect to every server, list its tools, write tools/zillow/*.json
node mcp-bench.mjs run zillow --runs 3          # call every task 3 times, write results/zillow/*.json
node mcp-bench.mjs report zillow                # write report-zillow.md
```

Flags: `--only id1,id2` restricts to some servers, `--timeout ms` sets the per-call timeout (default 90 s), `--runs N` sets calls per task (default 5). `MCP_BENCH_DIR` moves the fixtures, tools and results folders somewhere else.

## Fixture format

```json
{
  "target": "zillow",
  "servers": [
    {
      "id": "hasdata",
      "transport": "http",
      "url": "https://mcp.hasdata.com/api/mcp?apis=zillow",
      "headers": { "x-api-key": "$HASDATA_API_KEY" },
      "tasks": [
        { "name": "search", "tool": "hasdata_zillow_listing_getRealEstateListings", "args": { "keyword": "Austin, TX", "type": "forSale" } }
      ]
    },
    {
      "id": "apillow",
      "transport": "stdio",
      "command": "uvx",
      "args": ["--with", "mcp<2", "apillow-mcp"],
      "env": { "APILLOW_API_KEY": "$APILLOW_API_KEY" },
      "tasks": [
        { "name": "search", "tool": "search_properties", "args": { "query": "Austin TX", "type": "for_sale" } }
      ]
    }
  ]
}
```

`transport` is `http` (streamable HTTP), `sse`, or `stdio`. `$NAME` anywhere in `url`, `headers` or `env` is replaced from the environment. A task may carry a `chain` with a second tool call whose arguments take values from the first result by path, for actor-style servers that return a run id and expect you to fetch the dataset:

```json
{ "name": "search", "tool": "maxcopell--zillow-scraper", "args": { "...": "..." },
  "chain": { "tool": "get-dataset-items", "args": { "datasetId": "$.storages.datasets.default.id", "limit": 40 } } }
```

## What counts as a failure

A call is a failure when the server returns `isError`, when the body is an error envelope such as `{"error": "quota exceeded"}` even with a 200, when the body is under 50 bytes or an empty JSON list, when a non-JSON body is short and mentions an error, a rate limit, a captcha or a redirect, or when the call times out. Latency in the report is the median over successful calls only. Item and field counts come from the first array of objects found in the JSON, so they are a shape check, not a schema.

## What it does not do

It does not judge data quality, and three or five calls are a spot check for stability and payload shape, not a load test. Run it from where your agent will run. A server that is fine from a laptop may be blocked from a datacenter, and the other way round.

## Published runs

- Zillow, four scenarios, September 2026: https://gist.github.com/sergey-ermakovich/3c433761712b73692c8900aea1092418

## Fixtures in this repo

`zillow.json` (Austin for-sale search and one property record), `zillow-rent-denver.json`, `zillow-sold-phoenix.json`, `zillow-zip-33139.json`, plus `google-serp.json`, `duckduckgo.json`, `youtube.json`, `airbnb.json`, `instagram.json` from the same series. Vendor keys go in `.env`. Several servers are in the fixtures because they are listed in catalogs, and stay in even though they did not start or returned nothing, because that is a result too.

MIT. Maintained by [HasData](https://hasdata.com).
