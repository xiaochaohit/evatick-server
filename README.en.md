<div align="center">

# EVA Tick Server

**Normalized, readable financial data for LLMs, AI agents, and automated clients.**

[![CI](https://github.com/xiaochaohit/evatick-server/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaochaohit/evatick-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white)](package.json)

English · [简体中文](README.md)

</div>

EVA Tick Server (`evatickd`) turns fragmented, provider-specific market data into normalized, readable, versioned JSON designed for large language models and tool-using agents. It maintains a canonical instrument catalog, performs search and resolution, routes requests with timeouts and fallback, and serves the EVA CLI and other automated clients through HTTP.

The current release covers mainland China A-shares; Shanghai, Shenzhen, and CSI indices; all six mainland China futures exchanges; and exchange-scoped Binance and Coinbase cryptocurrency markets. HiThink Fuyao supplies official A-share and index catalogs, snapshots, and daily bars, while AKShare supplements minute bars, adjustment factors, and futures data; no single provider defines the product boundary.

<!-- Media slot: add a demo GIF/WebP at docs/assets/evatick-demo.webp, then uncomment the next line. -->
<!-- ![EVA Tick Server demo](docs/assets/evatick-demo.webp) -->

## Built for LLMs and AI agents

Traditional financial APIs often expose provider-specific functions, identifiers, and fields directly, making them difficult for models to understand, invoke, and combine. EVA Tick Server adds a stable semantic layer between models and data providers:

- **Understandable domain semantics** — consistent concepts such as instruments, quotes, bars, and index constituents reduce guesswork about upstream terminology.
- **Predictable structures** — versioned JSON schemas, normalized fields, and canonical instrument IDs make tool calls and result parsing more reliable.
- **Traceable results** — provenance, fetch times, partial and stale states, and warnings help models communicate uncertainty.
- **Composable discovery** — catalog, search, and resolution endpoints safely map natural language or trading codes to canonical instruments.

## Why EVA Tick Server

- **Provider-independent contracts** — clients consume stable instrument and market-data models instead of upstream functions or fields.
- **Canonical instrument identity** — stable IDs such as `cn:equity:XSHE:000001` connect trading codes, aliases, and provider identifiers.
- **Resilient query paths** — health checks, timeouts, retries, source fallback, and explicit partial or stale-result metadata are built in.
- **Local-first data operations** — SQLite stores the instrument catalog, DuckDB stores historical bars, and the admin console manages browsing and synchronization.
- **Automation-friendly** — OpenAPI is the integration source of truth, while responses carry versioned schemas, provenance metadata, and structured errors.

## Features and coverage

| Instrument | Market coverage | Quotes | Bars | Constituents |
| --- | --- | :---: | :---: | :---: |
| Equities | Mainland China A-shares | ✓ | Intraday, daily | — |
| Indices | Shanghai, Shenzhen, and CSI indices | ✓ | Intraday, daily | ✓ |
| Futures | CFFEX, SHFE, INE, CZCE, DCE, and GFEX | ✓ | Contract daily bars; unadjusted main continuous series | — |
| Cryptocurrencies | Binance and Coinbase Exchange | ✓ | Minute through monthly, depending on venue | — |

Cryptocurrency instruments are exchange-scoped, for example
`global:crypto:BINANCE:BTC-USDT` and `global:crypto:COINBASE:BTC-USDT`. The server
never falls back across these exchanges or combines their prices.

The server also provides:

- Instrument listing, details, search, and context-aware resolution
- Multi-source health checks, request timeouts, retries, and fallback
- Background daily and one-minute bar synchronization, resume support, and daily schedules
- Traceable unadjusted main continuous futures series, built per product from each day's listed contract with the greatest open interest (or volume when open interest is unavailable)
- API-key authentication and RFC 9457-style `application/problem+json` errors
- Admin login, key management, local data browsing, sync controls, and provider status

> [!NOTE]
> Data availability depends on upstream sources, trading hours, and network conditions. The current scope does not imply coverage of every global instrument or market-data capability.

## Quick start

### 1. Prerequisites

- Node.js 22.19 or later
- pnpm 11 (the repository pins 11.7.0)
- 64-bit CPython 3.11 or later
- Linux or macOS; the production example uses systemd

### 2. Install dependencies

```shell
git clone https://github.com/xiaochaohit/evatick-server.git
cd evatick-server

pnpm install --frozen-lockfile

python3 -m venv providers/akshare-python/.venv
providers/akshare-python/.venv/bin/python \
  -m pip install ./providers/akshare-python
```

### 3. Create a configuration

```shell
cp deploy/evatickd.config.example.json ./evatickd.config.json
chmod 600 ./evatickd.config.json
```

Edit `evatickd.config.json`:

1. Replace `admin.initialPassword` with a private initial password of at least eight characters.
2. Set `providers.akshare.pythonExecutable` to the absolute path of the virtual-environment Python created above.
3. Put the HiThink Fuyao API key in `HITHINK_FINANCE_API_KEY`. The configuration stores only `apiKeyEnvironment`, never the key itself. Remove `providers.hithink` when HiThink is not enabled.
4. For local development, replace the `/var/lib/evatickd/...` paths under `storage` and `admin` with paths writable by your user, such as `./data/...`.

Relative paths are resolved from the configuration file's directory. On Unix, a configuration containing `admin.initialPassword` must have mode `0600`.

On macOS, the key can remain in Keychain and be injected only when the daemon starts:

```shell
export HITHINK_FINANCE_API_KEY="$(security find-generic-password \
  -a "$USER" -s cn.evatick.provider.hithink -w)"
```

For systemd, place `HITHINK_FINANCE_API_KEY=<your-api-key>` in the mode-`0600`
file `/etc/evatickd/provider.env`. The example service reads this file without
placing it in the repository.

### 4. Start the server

```shell
bin/evatickd --config ./evatickd.config.json
```

You can also start it through pnpm:

```shell
pnpm evatickd -- --config ./evatickd.config.json
```

When ready, the daemon prints:

```json
{"schema":"eva.daemon-started.v1","url":"http://127.0.0.1:8765"}
```

### 5. Create an API key and verify the server

Open [http://127.0.0.1:8765/admin](http://127.0.0.1:8765/admin), sign in with the configured administrator credentials, and create a key on the **API Keys** page.

```shell
export EVA_API_KEY='<your-api-key>'

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  http://127.0.0.1:8765/v1/health
```

After the administrator credentials have been initialized, remove `initialPassword` from the configuration and retain the credentials file referenced by `credentialsPath`.

## Usage

All public market-data endpoints require a Bearer API key. This example searches for Ping An Bank and uses its canonical instrument ID to fetch market data. `--get --data-urlencode` avoids relying on shell- or client-specific handling of Chinese characters in URLs.

```shell
curl --get --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  --data-urlencode 'q=平安银行' \
  --data-urlencode 'instrument_type=equity' \
  http://127.0.0.1:8765/v1/instrument-search

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  'http://127.0.0.1:8765/v1/instruments/cn%3Aequity%3AXSHE%3A000001/quote'

curl --get --fail --silent --show-error \
  -H "Authorization: Bearer ${EVA_API_KEY}" \
  --data-urlencode 'interval=1d' \
  --data-urlencode 'start=2026-01-01' \
  --data-urlencode 'end=2026-01-31' \
  'http://127.0.0.1:8765/v1/instruments/cn%3Aequity%3AXSHE%3A000001/bars'
```

## HTTP API

The [OpenAPI 3.1 contract](contracts/openapi/evatick-api-v1.yaml) is the protocol source of truth for client integrations.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Report server and provider health |
| `GET` | `/v1/instruments` | List canonical instruments with cursor pagination |
| `GET` | `/v1/instruments/{instrument_id}` | Get instrument details and provider identifiers |
| `GET` | `/v1/instrument-search` | Search by name, identifier, or alias |
| `POST` | `/v1/instrument-resolve` | Resolve input to one instrument using context |
| `GET` | `/v1/instruments/{instrument_id}/quote` | Get the latest normalized quote |
| `GET` | `/v1/instruments/{instrument_id}/bars` | Get normalized OHLCV bars |
| `GET` | `/v1/indices/{instrument_id}/constituents` | Get index constituents |

Successful responses contain a versioned `schema`, normalized `data`, and provenance metadata. Failures use `application/problem+json`. Admin-only synchronization, source-health, and key-management endpoints are also described in the OpenAPI contract.

## Architecture

```text
eva CLI / HTTP clients
          │
          │ Bearer API key
          ▼
  Versioned HTTP API ───────── EVA Admin Console
          │
          ▼
Catalog · Resolution · Routing · Normalization · Sync
     │                              │
     ▼                              ▼
SQLite instrument catalog      DuckDB history store
     │
     ▼
Cordis provider plugins
     │
     ▼
HiThink Fuyao REST API · AKShare Python bridge process · public cryptocurrency REST APIs
     │
     ▼
HiThink Fuyao · Sina · Eastmoney · Tencent Finance · BaoStock · Binance · Coinbase
```

The CLI communicates with the server exclusively through HTTP and does not depend on server implementation code. Cordis manages provider-plugin lifecycles, while the Python data bridge runs in an isolated process.

### Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/evatick-server` | `evatickd` entry point and configuration loading |
| `packages/core` | Domain models, catalog contracts, and routing contracts |
| `packages/transport-http` | HTTP API, authentication, admin console, and history store |
| `packages/catalog-sqlite` | SQLite instrument-catalog implementation |
| `packages/cordis-runtime` | Cordis plugin-runtime integration |
| `packages/provider-akshare` | AKShare provider plugin |
| `packages/provider-hithink` | HiThink Fuyao REST API provider plugin |
| `packages/provider-crypto` | Public Binance and Coinbase market-data provider plugins |
| `providers/akshare-python` | Process-isolated Python data bridge |
| `contracts/openapi` | Public HTTP API contract |
| `deploy` | Configuration and systemd deployment examples |

## Configuration reference

| Section | Purpose |
| --- | --- |
| `server` | Listen address, port, timeouts, retries, and health-check interval |
| `storage` | SQLite catalog and DuckDB history-store paths |
| `admin` | Administrator account, initial password, credentials, and API-key paths |
| `providers` | Provider processes and runtime configuration |

See [`deploy/evatickd.config.example.json`](deploy/evatickd.config.example.json) for the complete example. Startup validation rejects unknown fields, out-of-range values, unsafe file permissions, and invalid Python executables.

## Admin console

The admin console is available by default at [http://127.0.0.1:8765/admin](http://127.0.0.1:8765/admin). It provides:

- Local data browsing and coverage inspection
- Manual historical-data sync, cancellation, resume, and daily schedules; futures synchronize as unadjusted main continuous series by product
- Provider health and scheduled checks
- API-key creation, reveal, copy, and revocation
- Administrator password and session management

<!-- Screenshot slot: add the admin console image at docs/assets/admin-console.png, then uncomment the next line. -->
<!-- ![EVA Admin Console](docs/assets/admin-console.png) -->

If the service listens on a public interface, terminate TLS with a trusted reverse proxy and restrict access with firewall or security-group rules. Never commit configurations, credentials, API keys, or data directories to version control.

## Development and verification

```shell
pnpm typecheck
pnpm test

providers/akshare-python/.venv/bin/python \
  -m pip install -e './providers/akshare-python[test]'
providers/akshare-python/.venv/bin/python \
  -m pytest -q providers/akshare-python/tests
```

CI runs TypeScript type checking, Node.js tests, and Python tests on every push and pull request. Keep the OpenAPI contract, implementation, and tests synchronized when changing behavior.

## Deployment

The repository includes [`deploy/evatickd.service`](deploy/evatickd.service) as a systemd starting point. The example assumes:

- Application directory: `/opt/evatick-server`
- Configuration file: `/etc/evatickd/config.json`
- Data directory: `/var/lib/evatickd`
- System user: `evatickd`

Production deployments should additionally configure TLS termination, access controls, log collection, monitoring, backups, and process resource limits.

## Contributing

Issues and pull requests are welcome. Before contributing, read [`CONTEXT.md`](CONTEXT.md) for the project's domain language, workflow, and security rules. Architecture decision records live under [`docs/adr`](docs/adr). Add tests for behavior changes and ensure that all verification commands above pass.

## License and disclaimer

This project is available under the [MIT License](LICENSE). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for third-party software and upstream data-source notices.

Market data is provided for research and reference only, without guarantees of completeness, accuracy, or timeliness. Nothing in this project constitutes investment advice.
