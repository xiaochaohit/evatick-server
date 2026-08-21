# Market CLI

`market-cli` 0.3 is a small HTTP client for Market Server v1. It does not load
AKShare, choose data sources, run provider workers, maintain a function
registry, or cache market data locally. Those responsibilities belong to the
server and its Cordis provider plugins.

The first release supports mainland A-share equities and SSE, SZSE, and CSI
indices.

## Install the CLI

Market CLI requires CPython 3.11 or newer.

```shell
python -m pip install .
market-cli --help
market-cli version
```

The CLI reads the server address and API key from one owner-only JSON
configuration file. The default path is `~/.config/market-cli/config.json`
(`$XDG_CONFIG_HOME` and `$MARKET_CLI_CONFIG` are honored):

```shell
market-cli config set --base-url https://market.example.com --api-key 'mk_...'
market-cli config show
market-cli health
```

The file uses schema `market.cli-config.v1` and is written with mode `0600`.
`config show` redacts the key. For temporary overrides, use `--server-url`,
`--api-key`, `MARKET_CLI_SERVER_URL`, or `MARKET_CLI_API_KEY`; explicit options
take precedence over environment variables, which take precedence over the file.
The default server address remains `http://127.0.0.1:8765` when no value is set.

## Commands

```text
market-cli health
market-cli version
market-cli config set|show

market-cli instrument list|search|resolve|show
market-cli stock quotes|bars
market-cli index quotes|bars|constituents
```

Examples:

```shell
market-cli instrument search --query 平安银行 --type equity
market-cli stock quotes --symbol 000001
market-cli stock bars --symbol 000001 --start 2026-08-01 --limit 5
market-cli index constituents --symbol 000300 --limit 5
```

List data commands accept `--output`, `--format`, `--overwrite`, and `--limit`.
Supported file formats are JSON, JSONL, CSV, and optional Parquet:

```shell
python -m pip install 'market-cli[parquet]'
market-cli stock bars --symbol 000001 \
  --output bars.parquet --format parquet
```

## Run Market Server

Market Server uses Node.js, Cordis, SQLite, and an independently installed
AKShare provider environment:

```shell
cd server
python3 -m venv providers/akshare-python/.venv
providers/akshare-python/.venv/bin/python -m pip install ./providers/akshare-python
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

See [server/README.md](./server/README.md) for configuration and the provider
plugin contract. The HTTP source of truth is
[contracts/openapi/market-api-v1.yaml](./contracts/openapi/market-api-v1.yaml).

Minute bars are available for stocks and indices:

```shell
market-cli stock bars --symbol 000001 --interval 5m --start 2026-08-14 --end 2026-08-14
market-cli index bars --symbol 000300 --interval 15m --start 2026-08-14 --end 2026-08-14
```

## Development

```shell
python -m pip install -e '.[test,parquet]'
python -m pytest
cd server
pnpm test
pnpm typecheck
```

Market data is provided for research and reference only and does not constitute
investment advice. Users are responsible for complying with each provider and
source site's terms.
