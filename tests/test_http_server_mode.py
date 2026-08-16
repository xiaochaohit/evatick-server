from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from tests.test_cli_entrypoint import run_cli


class _MarketHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, Any]] = []

    def log_message(self, format: str, *args: object) -> None:
        pass

    def _send(self, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self.requests.append(("POST", self.path, body))
        self._send({
            "schema": "market.instrument-resolution.v1",
            "data": {
                "status": "resolved",
                "instrument": {"instrument_id": "cn:equity:XSHE:000001"},
                "candidates": [],
            },
            "meta": {},
        })

    def do_GET(self) -> None:
        self.requests.append(("GET", self.path, None))
        if self.path.startswith("/v1/instrument-search"):
            self._send({
                "schema": "market.instrument-search.v1",
                "data": [{"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}],
                "page": {"next_cursor": None},
                "meta": {},
            })
            return
        self._send({
            "schema": "market.bar-list.v1",
            "data": [{"instrument_id": "cn:equity:XSHE:000001", "close": "11.11"}],
            "page": {"next_cursor": None},
            "meta": {},
        })


def test_stable_stock_bars_uses_http_server_when_configured(monkeypatch) -> None:
    _MarketHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MarketHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("MARKET_CLI_SERVER_URL", f"http://127.0.0.1:{server.server_port}")
    try:
        result = run_cli(
            "stock", "bars", "--symbol", "000001",
            "--start-date", "20260801", "--end-date", "20260815",
        )
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    assert result.returncode == 0
    assert json.loads(result.stdout) == [
        {"instrument_id": "cn:equity:XSHE:000001", "close": "11.11"}
    ]
    assert _MarketHandler.requests == [
        ("POST", "/v1/instrument-resolve", {
            "query": "000001", "context": {"instrument_type": "equity", "capability": "bars"},
        }),
        ("GET", "/v1/instruments/cn%3Aequity%3AXSHE%3A000001/bars?interval=1d&start=2026-08-01&end=2026-08-15&adjustment=none", None),
    ]


def test_instrument_search_exposes_server_catalog(monkeypatch) -> None:
    _MarketHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MarketHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = run_cli(
            "--server-url", f"http://127.0.0.1:{server.server_port}",
            "instrument", "search", "--query", "平安银行", "--type", "equity",
        )
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    assert result.returncode == 0
    assert json.loads(result.stdout) == [
        {"instrument_id": "cn:equity:XSHE:000001", "name": "平安银行"}
    ]
    assert _MarketHandler.requests == [
        ("GET", "/v1/instrument-search?q=%E5%B9%B3%E5%AE%89%E9%93%B6%E8%A1%8C&instrument_type=equity&limit=20", None)
    ]
