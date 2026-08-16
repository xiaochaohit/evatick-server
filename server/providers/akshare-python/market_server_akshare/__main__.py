from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests


def _records(value: Any) -> list[dict[str, Any]]:
    if hasattr(value, "to_dict"):
        value = value.to_dict(orient="records")
    normalized = _json_value(value)
    if not isinstance(normalized, list) or not all(
        isinstance(record, dict) for record in normalized
    ):
        raise TypeError("AKShare result must be a record sequence")
    return normalized


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if hasattr(value, "item"):
        return _json_value(value.item())
    raise TypeError(f"unsupported AKShare value: {type(value).__name__}")


def _compact_date(value: str | None, fallback: str) -> str:
    return (value or fallback).replace("-", "")[:8]


def _sina_date(value: str | None, fallback: str) -> str:
    compact = _compact_date(value, fallback)
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:]}"


def _stock_bars(akshare: Any, request: dict[str, Any]) -> list[dict[str, Any]]:
    provider_symbol = request["providerSymbol"]
    symbol = provider_symbol.removeprefix("sh").removeprefix("sz").removeprefix("bj")
    adjustment = {"none": "", "forward": "qfq", "backward": "hfq"}[
        request.get("adjustment", "none")
    ]
    try:
        return _records(akshare.stock_zh_a_daily(
            symbol=provider_symbol,
            start_date=_sina_date(request.get("start"), "19700101"),
            end_date=_sina_date(request.get("end"), "20500101"),
            adjust=adjustment,
        ))
    except Exception as error:
        if not _is_transient(error):
            raise
    return _records(akshare.stock_zh_a_hist(
        symbol=symbol,
        period="daily",
        start_date=_compact_date(request.get("start"), "19700101"),
        end_date=_compact_date(request.get("end"), "20500101"),
        adjust=adjustment,
        timeout=None,
    ))


def _is_transient(error: Exception) -> bool:
    return isinstance(error, (requests.ConnectionError, requests.Timeout)) or (
        isinstance(error, requests.HTTPError)
        and error.response is not None
        and error.response.status_code in {429, 502, 503, 504}
    )


def execute(request: dict[str, Any]) -> list[dict[str, Any]]:
    import akshare

    operation = request["operation"]
    if operation == "list_stocks":
        return _records(akshare.stock_info_a_code_name())
    if operation == "list_indices":
        return _records(akshare.index_stock_info())
    if operation == "bars" and request["instrumentType"] == "equity":
        return _stock_bars(akshare, request)
    if operation == "bars":
        return _records(akshare.stock_zh_index_daily_em(
            symbol=request["providerSymbol"],
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    if operation == "constituents":
        symbol = request["providerSymbol"]
        for prefix in ("csi", "sh", "sz"):
            symbol = symbol.removeprefix(prefix)
        return _records(akshare.index_stock_cons(symbol=symbol))
    raise ValueError(f"unsupported operation: {operation}")


def _error_payload(error: Exception) -> dict[str, Any]:
    if _is_transient(error):
        return {"ok": False, "error": {
            "code": "PROVIDER_NETWORK_ERROR",
            "message": "AKShare network request failed",
            "retryable": True,
        }}
    return {"ok": False, "error": {
        "code": "PROVIDER_ERROR",
        "message": "AKShare provider call failed",
        "retryable": False,
    }}


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()
    request = json.loads(arguments.request.read_text(encoding="utf-8"))
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            payload = {"ok": True, "data": execute(request)}
    except Exception as error:  # provider process boundary
        payload = _error_payload(error)
    temporary = arguments.result.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, arguments.result)


if __name__ == "__main__":
    main()
