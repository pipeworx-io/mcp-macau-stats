# @pipeworx/macau-stats

Macau (Macao SAR) official statistics — 143 headline indicators (population,
visitor arrivals, gaming revenue, CPI, unemployment, births/deaths and more)
from DSEC, the Macao Statistics and Census Service (澳門統計暨普查局 /
Direcção dos Serviços de Estatística e Censos).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

## Tools

- `macau_indicators({ query? })` — the catalogue of all 143 key indicators
  (id, name in English/中文/Portuguese, reporting frequency). Pass `query` to
  filter by keyword in any of the three languages.
- `macau_indicator({ id?, name?, periods? })` — latest value for one
  indicator by numeric id or name/keyword, plus a historical series when a
  reliable match exists in DSEC's general statistics database (see the
  ID-space note below). `periods` defaults to 24.
- `macau_gaming_revenue()` — Macau's monthly gross revenue of games of chance
  (澳門博彩毛收入) in million MOP — the same figure the gaming regulator DICJ
  publishes as an HTML table, sourced here as structured data instead.
- `macau_population()` — total resident population, quarterly.
- `macau_tourism()` — visitor arrivals, monthly.
- `macau_employment()` — unemployment rate, total employment and median
  monthly earnings in one call.

## Auth

Keyless. No registration, no API key, despite the DSEC
`/zh-MO/Service/WebService` page describing a "contact us" styled-widget
product — that copy is about the branded embed, not the raw data call used
here.

## Data sources

- `https://www.dsec.gov.mo/TimeSeriesDatabase.asmx` — DSEC's public SOAP web
  service (WSDL at `?WSDL`). Old-school ASP.NET ASMX: every SOAP operation
  also answers a plain HTTP GET (the framework's HttpGet binding), so this
  pack calls it with GET + query string and parses the XML response — no SOAP
  envelope needed.

### Traps for the next person

- **Two disjoint id spaces.** The 143 curated `KeyIndicatorID`s
  (`getKeyIndicatorList`/`getKeyIndicatorValue`) are NOT the same numbering as
  the general `IndicatorID` catalog (`getIndicatorID`/`getIndicatorByID`/
  `getIndicatorLatestNValues`) — `getIndicatorByID(15)` for KeyIndicatorID 15
  returns an empty result. There is no documented mapping table. This pack
  resolves a mapping by searching the general catalog for a description that
  matches a key indicator's own name, and only trusts the match when it
  resolves to exactly one series (an ambiguous or empty search means "no
  reliable history", not a guess) — confirmed working for "Live births" ->
  IndicatorID 9014, confirmed absent for "Gross revenue of games of chance"
  (it exists only in the curated key-indicator set, not the general catalog).
- **The curated key-indicator endpoint (`getKeyIndicatorValue`) returns only
  the LATEST value** — no period parameter, no history. Real time series
  require the general-catalog mapping above, which does not resolve for
  every indicator.
- **Chart operations (`getChart`, `getCommonChart`) return a base64-encoded
  PNG image (`ChartData`), not structured numbers** — not usable for a data
  API, so this pack does not call them.
- **Language enum values**: `English`, `TraditionalChinese`,
  `SimplifiedChinese`, `Portuguese` — NOT `Chinese` (that value 500s with a
  .NET conversion error).
- This pack supersedes any DICJ (gaming regulator) HTML-table scrape — the
  same monthly gross-gaming-revenue number is available here as clean XML.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "macau-stats": {
      "url": "https://gateway.pipeworx.io/macau-stats/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/macau-stats/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/macau_indicators \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/macau_indicators`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "macau-stats": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-macau-stats"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-macau-stats
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Macau Stats data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
