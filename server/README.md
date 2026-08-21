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

The bundled `akshare` plugin uses its own process-isolated Python environment.
It does not call Market CLI. This keeps AKShare and pandas outside both the Node
process and the lightweight CLI installation.
The adapter currently derives quotes from the latest daily bars, so v1 quotes
are end-of-day observations rather than a real-time feed.

Bars support `1m`, `5m`, `15m`, `30m`, `60m`, and `1d`. Minute bars use
Asia/Shanghai timestamps, treat the upstream timestamp as the end of the bar,
and expose whether that period is complete. Available minute history is limited
by the selected upstream source.

## Run

```shell
python3 -m venv providers/akshare-python/.venv
providers/akshare-python/.venv/bin/python -m pip install ./providers/akshare-python
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

### Data source priority

For daily bars and end-of-day quotes, Market Server checks the local DuckDB
warehouse first. A local hit requires the requested date range to be inside the
recorded synchronization coverage; otherwise routing continues to the remote
provider sources below. Successful remote daily-bar responses with explicit
start and end dates are written back to DuckDB, so the same range is local on
subsequent requests. Minute bars always use remote sources.

The process-isolated Python bridge keeps an ordered source list for each
market-data type in `providers/akshare-python/market_server_akshare/sources.py`.
It uses AKShare interfaces for Sina, East Money, and Tencent, and the official
BaoStock client for BaoStock. The first working source wins and failures fall
through to the next source. Equity and index bars and quotes can therefore use
different priorities. Successful quote and bars HTTP responses expose the
selected source as `meta.sources[].upstream`.

Daily equity fallback order is Sina, East Money, Tencent, then BaoStock. Daily
index fallback order is Sina, Tencent, East Money, then BaoStock. Intraday data
remains limited to Sina and East Money because Tencent and BaoStock do not
provide the required minute-bar contract here.

Configuration uses environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MARKET_SERVER_HOST` | `127.0.0.1` | Listen host |
| `MARKET_SERVER_PORT` | `8765` | Listen port; use `0` for an ephemeral port |
| `MARKET_SERVER_CATALOG_PATH` | user data directory | SQLite catalog snapshot |
| `MARKET_SERVER_HISTORY_PATH` | user data directory | DuckDB daily-bar warehouse |
| `MARKET_SERVER_AKSHARE_PYTHON` | bundled provider venv, then `python3` | Python with `market-server-akshare` installed |
| `MARKET_SERVER_RETRY_ATTEMPTS` | `2` | Attempts per provider |
| `MARKET_SERVER_REQUEST_TIMEOUT_MS` | `30000` | Per-provider deadline |
| `MARKET_SERVER_HEALTH_CHECK_INTERVAL_SECONDS` | `60` | Provider health-check interval; use `0` to disable |
| `MARKET_SERVER_HEALTH_CHECK_TIMEOUT_MS` | `10000` | Deadline for one provider health check |
| `MARKET_SERVER_ADMIN_USERNAME` | `admin` | Initial management-console account name |
| `MARKET_SERVER_ADMIN_PASSWORD` | none | Initial password (12–256 characters); required only when the credential store does not exist |
| `MARKET_SERVER_ADMIN_CREDENTIALS_PATH` | user data directory | Password-hash credential store; created with owner-only permissions |

Before the first start, provide `MARKET_SERVER_ADMIN_PASSWORD` through the
service environment or a secret manager. The password is used only to create a
scrypt-derived credential store and is not written to logs. Later starts read
that store, so the initial-password variable can be removed. The management
console uses an HttpOnly, SameSite session cookie; keep the default loopback
host unless a trusted reverse proxy also supplies TLS and network controls.

## HTTP API

The source of truth is
[`../contracts/openapi/market-api-v1.yaml`](../contracts/openapi/market-api-v1.yaml).
The implemented routes are:

- `GET /v1/health`
- `GET /v1/data-sources`
- `POST /v1/data-sources/check`
- `PUT /v1/data-sources/schedule`
- `GET /v1/data-sync`
- `POST /v1/data-sync/runs`
- `POST /v1/data-sync/resume`
- `POST /v1/data-sync/cancel`
- `GET /v1/instruments`
- `GET /v1/instruments/{instrument_id}`
- `GET /v1/instrument-search`
- `POST /v1/instrument-resolve`
- `GET /v1/instruments/{instrument_id}/quote`
- `GET /v1/instruments/{instrument_id}/bars`
- `GET /v1/indices/{instrument_id}/constituents`

The local data-source management console is available at
`/admin/data-sources`. It independently checks each upstream, such as Sina,
East Money, and Tencent, by equity and index category. The page displays
status, latency, capabilities, and supports manual or scheduled checks.

Successful responses carry a versioned `schema`, normalized `data`, and source
metadata. List responses also carry a cursor page. Failures use
`application/problem+json`. When a provider catalog refresh fails, the latest
SQLite snapshot is returned with `meta.partial: true`, `stale: true`, and a
warning instead of silently presenting stale data as current.

The separate local synchronization console is available at `/admin/data-sync`.
It starts one background job at a time, stores normalized daily bars in DuckDB,
and reports progress, failures, coverage, and warehouse size. Re-running a sync
uses an overlap from ten days before the latest stored bar so upstream fixes are
applied without duplicating the `(instrument, date, adjustment)` primary key.
The optional per-instrument delay keeps bulk synchronization single-threaded and
rate-limited for free upstream sources.

The management console redirects unauthenticated requests to `/admin/login`.
The signed-in administrator can change the password at `/admin/password`;
changing it invalidates all other active sessions. Console-facing data-source,
sync, and local-warehouse endpoints require the same session when
authentication is configured.

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
providers/akshare-python/.venv/bin/python -m pip install -e './providers/akshare-python[test]'
providers/akshare-python/.venv/bin/python -m pytest providers/akshare-python/tests
```

## systemd deployment

The example unit in `deploy/market-server.service` runs the server as a
restricted `market-server` user from `/opt/market-cli/server`, persists the
catalog under `/var/lib/market-server`, and listens on `0.0.0.0:8765`.
Restrict public access with the cloud security group or place an authenticated
TLS reverse proxy in front of the service.
