from __future__ import annotations

import json
import socket
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from market_cli import __version__


class InvocationError(Exception):
    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


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
