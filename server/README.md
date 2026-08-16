# Market Server v1

Market Server is the provider-independent runtime behind Market CLI. Version 1
supports mainland A-share equities and indices published by SSE, SZSE, and CSI.
Equities and indices share one canonical instrument catalog and remain distinct
instrument types.

## Runtime layers

```text
CLI / other HTTP clients
        |
Fastify HTTP transport + versioned JSON contracts
        |
catalog, search, resolution, routing, normalization
        |
Cordis provider registry + lifecycle
        |
one or more InstrumentProvider plugins
        |
AKShare / future market-specific sources
```

Cordis owns plugin registration and disposal. The core package contains no
AKShare names or response fields. A provider declares its instruments,
identifiers, and capabilities; routing retries transient failures and can fall
back to another provider that declares the same canonical instrument and
capability.

The bundled `market-cli-akshare` plugin is a process-isolated adapter around the
installed Python CLI. That keeps AKShare and pandas outside the Node process.
The adapter currently derives quotes from the latest daily bars, so v1 quotes
are end-of-day observations rather than a real-time feed.

## Run

```shell
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Configuration uses environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARKET_SERVER_HOST` | `127.0.0.1` | Listen host |
| `MARKET_SERVER_PORT` | `8765` | Listen port; use `0` for an ephemeral port |
| `MARKET_SERVER_CATALOG_PATH` | user data directory | SQLite catalog snapshot |
| `MARKET_SERVER_MARKET_CLI` | `market-cli` | Python CLI executable |
| `MARKET_SERVER_RETRY_ATTEMPTS` | `2` | Attempts per provider |
| `MARKET_SERVER_REQUEST_TIMEOUT_MS` | `30000` | Per-provider deadline |

Keep the default loopback host unless a trusted reverse proxy supplies network
authentication and TLS. The v1 process does not implement public-internet
authentication.

## HTTP API

The source of truth is
[`../contracts/openapi/market-api-v1.yaml`](../contracts/openapi/market-api-v1.yaml).
The implemented routes are:

- `GET /v1/health`
- `GET /v1/instruments`
- `GET /v1/instruments/{instrument_id}`
- `GET /v1/instrument-search`
- `POST /v1/instrument-resolve`
- `GET /v1/instruments/{instrument_id}/quote`
- `GET /v1/instruments/{instrument_id}/bars`
- `GET /v1/indices/{instrument_id}/constituents`

Successful responses carry a versioned `schema`, normalized `data`, and source
metadata. List responses also carry a cursor page. Failures use
`application/problem+json`. When a provider catalog refresh fails, the latest
SQLite snapshot is returned with `meta.partial: true`, `stale: true`, and a
warning instead of silently presenting stale data as current.

## Provider plugin contract

Implement `InstrumentProvider` from `@market-cli/core`, then mount it with
`server.mountProvider(provider)`. A plugin must provide:

- a stable provider ID;
- `listInstruments(signal)` with provider symbols and declared capabilities;
- any supported `getQuote`, `getBars`, or `getConstituents` methods;
- `ProviderError` classifications that state whether retry is safe.

Provider values are normalized before they cross HTTP. Provider-specific
parameters and fields never become canonical IDs or API fields.

## Verify

```shell
pnpm test
pnpm typecheck
cd ..
.venv/bin/python -m pytest
```
