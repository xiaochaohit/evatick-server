from __future__ import annotations

import json
import socket
import time
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from market_cli import __version__
from market_cli.supervisor import InvocationError


SERVER_COMMANDS = {
    ("stock", "instruments"),
    ("stock", "quotes"),
    ("stock", "bars"),
    ("index", "instruments"),
    ("index", "quotes"),
    ("index", "bars"),
    ("index", "constituents"),
}


def _date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value)
    if len(text) == 8 and text.isdigit():
        return datetime.strptime(text, "%Y%m%d").date().isoformat()
    return text


class MarketHttpClient:
    def __init__(self, base_url: str, timeout: float, retries: int) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise InvocationError(
                "INVALID_SERVER_URL",
                "server URL must start with http:// or https://",
                False,
            )
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None if payload is None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode()
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "User-Agent": f"market-cli/{__version__}",
                **({"Content-Type": "application/json"} if body else {}),
            },
        )
        started = time.monotonic()
        for attempt in range(self.retries + 1):
            remaining = self.timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise InvocationError(
                    "TIMEOUT",
                    f"server call exceeded the {self.timeout:g} second total timeout",
                    True,
                )
            try:
                with urlopen(request, timeout=remaining) as response:
                    parsed = json.loads(response.read())
                    if not isinstance(parsed, dict):
                        raise InvocationError(
                            "INVALID_SERVER_RESPONSE",
                            "server returned a non-object JSON response",
                            False,
                        )
                    return parsed
            except HTTPError as error:
                try:
                    problem = json.loads(error.read())
                except (json.JSONDecodeError, UnicodeDecodeError):
                    problem = {}
                retryable = bool(problem.get("retryable")) or error.code in {
                    429, 502, 503, 504
                }
                if retryable and attempt < self.retries:
                    time.sleep(min(0.25 * (2**attempt), remaining))
                    continue
                raise InvocationError(
                    str(problem.get("code", "HTTP_ERROR")),
                    str(problem.get("detail", f"server returned HTTP {error.code}")),
                    retryable,
                ) from None
            except (URLError, socket.timeout, TimeoutError):
                if attempt < self.retries:
                    time.sleep(min(0.25 * (2**attempt), remaining))
                    continue
                raise InvocationError(
                    "SERVER_UNAVAILABLE",
                    "market server is unavailable",
                    True,
                ) from None
            except json.JSONDecodeError:
                raise InvocationError(
                    "INVALID_SERVER_RESPONSE",
                    "server returned invalid JSON",
                    False,
                ) from None
        raise AssertionError("HTTP retry loop exhausted")

    def resolve(self, query: str, instrument_type: str, capability: str) -> str:
        response = self.request("POST", "/v1/instrument-resolve", {
            "query": query,
            "context": {
                "instrument_type": instrument_type,
                "capability": capability,
            },
        })
        data = response.get("data", {})
        if data.get("status") == "resolved":
            instrument_id = data.get("instrument", {}).get("instrument_id")
            if isinstance(instrument_id, str):
                return instrument_id
        code = "AMBIGUOUS_INSTRUMENT" if data.get("status") == "ambiguous" else "INSTRUMENT_NOT_FOUND"
        raise InvocationError(
            code,
            "instrument input did not resolve to one supported instrument",
            False,
        )


def _unwrap(response: dict[str, Any]) -> Any:
    if "data" not in response:
        raise InvocationError(
            "INVALID_SERVER_RESPONSE",
            "server response is missing data",
            False,
        )
    return response["data"]


def invoke_server(
    *,
    server_url: str,
    path: tuple[str, str],
    parameters: dict[str, Any],
    limit: int | None,
    timeout: float,
    retries: int,
) -> Any:
    domain, command = path
    instrument_type = "equity" if domain == "stock" else "index"
    client = MarketHttpClient(server_url, timeout, retries)

    if command == "instruments":
        items: list[Any] = []
        cursor: str | None = None
        while limit is None or len(items) < limit:
            page_limit = min(1000, (limit - len(items)) if limit is not None else 1000)
            query = urlencode({
                "instrument_type": instrument_type,
                "limit": page_limit,
                **({"cursor": cursor} if cursor else {}),
            })
            response = client.request("GET", f"/v1/instruments?{query}")
            page_items = _unwrap(response)
            if not isinstance(page_items, list):
                raise InvocationError(
                    "INVALID_SERVER_RESPONSE",
                    "instrument list data is not an array",
                    False,
                )
            items.extend(page_items)
            cursor = response.get("page", {}).get("next_cursor")
            if not cursor:
                break
        return items

    symbol = parameters.get("symbol")
    if not symbol:
        raise InvocationError(
            "MISSING_INSTRUMENT",
            f"market-cli {domain} {command} requires --symbol in server mode",
            False,
        )
    capability = {
        "quotes": "quote",
        "bars": "bars",
        "constituents": "constituents",
    }[command]
    instrument_id = client.resolve(str(symbol), instrument_type, capability)
    encoded_id = quote(instrument_id, safe="")

    if command == "quotes":
        return _unwrap(client.request("GET", f"/v1/instruments/{encoded_id}/quote"))
    if command == "constituents":
        query_values = {"as_of": _date(parameters.get("as_of"))}
        query = urlencode({key: value for key, value in query_values.items() if value})
        suffix = f"?{query}" if query else ""
        return _unwrap(client.request("GET", f"/v1/indices/{encoded_id}/constituents{suffix}"))

    period = parameters.get("period", "daily")
    interval = {"daily": "1d", "weekly": "1w", "monthly": "1mo"}.get(
        str(period), "1d"
    )
    adjustment = {"qfq": "forward", "hfq": "backward"}.get(
        str(parameters.get("adjust", "")), "none"
    )
    query_values = {
        "interval": interval,
        "start": _date(parameters.get("start_date")),
        "end": _date(parameters.get("end_date")),
        "adjustment": adjustment,
    }
    query = urlencode({key: value for key, value in query_values.items() if value})
    return _unwrap(client.request("GET", f"/v1/instruments/{encoded_id}/bars?{query}"))
