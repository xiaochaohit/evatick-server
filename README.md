# Market CLI

`market-cli` is a model-oriented command-line interface for discoverable market data. Its first data provider is the pinned AKShare 1.18.82 release. It exposes all 1,090 public data functions plus 11 stable stock, index, and calendar entry points, organized by market domain rather than provider namespace.

Command paths are the stable public interface. Provider parameters and result fields track the bound provider version and can evolve between releases.

## Install

```shell
python -m pip install .
market-cli catalog
market-cli search --query zh-a-hist
market-cli stock zh-a-hist --symbol 000001 --limit 5
```

The stable `market-cli stock bars` command uses Sina by default for daily bars and falls back to Eastmoney only when Sina has a transient network failure. Weekly and monthly bars continue to use Eastmoney. Each returned record includes `_market_cli_source` with the source actually used.

Parquet export is optional:

```shell
python -m pip install '.[parquet]'
market-cli stock zh-a-hist --symbol 000001 --output bars.parquet
```

Use `market-cli DOMAIN COMMAND --help` to inspect provider-aligned named parameters. Add `--output PATH` for JSON, JSONL, CSV, or Parquet file export; `--format` can select the format explicitly.

The accepted terminology lives in [`CONTEXT.md`](./CONTEXT.md), and architectural decisions live in [`docs/adr`](./docs/adr).

## Market Server

The first server release provides a provider-neutral HTTP boundary for mainland
A-share equities and SSE, SZSE, and CSI indices. It runs on Cordis, persists the
last successful instrument catalog in SQLite, and owns provider retry, timeout,
fallback, identifier resolution, and response normalization.

Requirements: Node.js 22.19 or newer and pnpm 11.7.0.

```shell
python -m pip install -e .
cd server
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

The server listens on `http://127.0.0.1:8765` by default. In another terminal,
point the same CLI at it:

```shell
export MARKET_CLI_SERVER_URL=http://127.0.0.1:8765
market-cli instrument search --query 平安银行 --type equity
market-cli stock bars --symbol 000001 --start-date 20260801 --limit 5
market-cli index constituents --symbol 000300 --limit 5
```

Only the published `stock` and `index` paths use the server when configured;
other provider-aligned commands continue to run locally. `--server-url` can be
used instead of the environment variable. See [`server/README.md`](./server/README.md)
for configuration, API routes, and plugin boundaries.

## Development

Market CLI requires CPython 3.11 or newer.

```shell
python -m pip install -e '.[test,parquet]'
market-cli --help
python -m pytest
```

Market data is obtained from external sources at runtime. It is provided for research and reference only and does not constitute investment advice. Users are responsible for complying with each data provider and source site's terms.
