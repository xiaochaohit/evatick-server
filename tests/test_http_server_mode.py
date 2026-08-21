from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from tests.test_cli_entrypoint import run_cli


class _MarketHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, Any]] = []
    authorization_headers: list[str | None] = []

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _send(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        _MarketHandler.authorization_headers.append(self.headers.get("Authorization"))
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.requests.append(("POST", self.path, body))
        instrument_type = body.get("context", {}).get("instrument_type", "equity")
        instrument_id = (
            "cn:index:CSI:000300"
            if instrument_type == "index"
            else "cn:equity:XSHE:000001"
        )
        self._send({
            "schema": "market.instrument-resolution.v1",
            "data": {
                "status": "resolved",
                "instrument": {"instrument_id": instrument_id},
                "candidates": [],
            },
            "meta": {},
        })

    def do_GET(self) -> None:
        _MarketHandler.authorization_headers.append(self.headers.get("Authorization"))
        self.requests.append(("GET", self.path, None))
        if self.path == "/v1/health":
            self._send({"schema": "market.health.v1", "data": {"status": "ok", "providers": 1}})
        elif self.path.startswith("/v1/instrument-search"):
            self._send({
                "schema": "market.instrument-search.v1",
                "data": [{"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}],
                "page": {"next_cursor": None},
                "meta": {},
            })
        elif self.path.startswith("/v1/instruments?"):
            self._send({
                "schema": "market.instrument-list.v1",
                "data": [{"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}],
                "page": {"next_cursor": "next-page"},
                "meta": {},
            })
        elif self.path.endswith("/quote"):
            self._send({"schema": "market.quote.v1", "data": {"last": "11.11"}, "meta": {}})
        elif self.path.endswith("/constituents?as_of=2026-08-15"):
            self._send({
                "schema": "market.index-constituent-list.v1",
                "data": [{"constituent_symbol": "600000", "rank": 1}],
                "page": {"next_cursor": None},
                "meta": {},
            })
        elif "/bars?" in self.path:
            self._send({
                "schema": "market.bar-list.v1",
                "data": [
                    {"trading_date": "2026-08-14", "close": "11.11"},
                    {"trading_date": "2026-08-15", "close": "11.20"},
                ],
                "page": {"next_cursor": None},
                "meta": {},
            })
        else:
            self._send({
                "schema": "market.instrument.v1",
                "data": {"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"},
                "meta": {},
            })


class MarketServerFixture:
    def __enter__(self) -> str:
        _MarketHandler.requests = []
        _MarketHandler.authorization_headers = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _MarketHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()


def test_health_and_instrument_discovery_use_the_server_contract() -> None:
    with MarketServerFixture() as url:
        health = run_cli("--server-url", url, "health")
        listing = run_cli("--server-url", url, "instrument", "list", "--type", "equity", "--limit", "1")
        search = run_cli("--server-url", url, "instrument", "search", "--query", "平安银行", "--type", "equity")

    assert json.loads(health.stdout) == {"status": "ok", "providers": 1}
    assert json.loads(listing.stdout) == {
        "items": [{"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}],
        "next_cursor": "next-page",
    }
    assert json.loads(search.stdout) == [
        {"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}
    ]


def test_unified_configuration_supplies_base_url_and_api_key(tmp_path: Path) -> None:
    configuration = tmp_path / "config.json"
    with MarketServerFixture() as url:
        configured = run_cli(
            "--config", str(configuration), "config", "set",
            "--base-url", url, "--api-key", "mk_test_secret",
        )
        health = run_cli(
            "--config", str(configuration), "health",
            environment_overrides={"MARKET_CLI_SERVER_URL": "", "MARKET_CLI_API_KEY": ""},
        )
        shown = run_cli("--config", str(configuration), "config", "show")

    assert configured.returncode == 0
    assert json.loads(health.stdout)["status"] == "ok"
    assert _MarketHandler.authorization_headers == ["Bearer mk_test_secret"]
    assert json.loads(shown.stdout) == {
        "path": str(configuration.resolve()),
        "base_url": url,
        "api_key": "********",
    }
    assert configuration.stat().st_mode & 0o777 == 0o600
    assert json.loads(configuration.read_text()) == {
        "schema": "market.cli-config.v1",
        "base_url": url,
        "api_key": "mk_test_secret",
    }


def test_stock_commands_resolve_then_query_normalized_data() -> None:
    with MarketServerFixture() as url:
        quote = run_cli("--server-url", url, "stock", "quotes", "--symbol", "000001")
        bars = run_cli(
            "--server-url", url, "stock", "bars", "--symbol", "000001",
            "--interval", "5m", "--start", "2026-08-01", "--end", "2026-08-15",
            "--limit", "1",
        )

    assert json.loads(quote.stdout) == {"last": "11.11"}
    assert json.loads(bars.stdout) == [{"trading_date": "2026-08-14", "close": "11.11"}]
    assert ("POST", "/v1/instrument-resolve", {
        "query": "000001", "context": {"instrument_type": "equity", "capability": "bars"},
    }) in _MarketHandler.requests
    assert ("GET", "/v1/instruments/cn%3Aequity%3AXSHE%3A000001/bars?interval=5m&start=2026-08-01&end=2026-08-15&adjustment=none", None) in _MarketHandler.requests


def test_index_constituents_and_file_export_use_shared_options(tmp_path: Path) -> None:
    output = tmp_path / "bars.csv"
    with MarketServerFixture() as url:
        constituents = run_cli(
            "--server-url", url, "index", "constituents", "--symbol", "000300",
            "--as-of", "2026-08-15",
        )
        exported = run_cli(
            "--server-url", url, "index", "bars", "--symbol", "000300",
            "--limit", "1", "--output", str(output), "--format", "csv",
        )

    assert json.loads(constituents.stdout) == [{"constituent_symbol": "600000", "rank": 1}]
    assert json.loads(exported.stdout) == {"path": str(output.resolve()), "records": 1}
    assert output.read_text() == "trading_date,close\n2026-08-14,11.11\n"


def test_parquet_export_uses_the_server_contract(tmp_path: Path) -> None:
    parquet = pytest.importorskip("pyarrow.parquet")
    output = tmp_path / "bars.parquet"

    with MarketServerFixture() as url:
        exported = run_cli(
            "--server-url", url, "stock", "bars", "--symbol", "000001",
            "--limit", "1", "--output", str(output), "--format", "parquet",
        )

    assert exported.returncode == 0
    assert json.loads(exported.stdout) == {"path": str(output.resolve()), "records": 1}
    assert parquet.read_table(output).to_pylist() == [
        {"trading_date": "2026-08-14", "close": "11.11"},
    ]
