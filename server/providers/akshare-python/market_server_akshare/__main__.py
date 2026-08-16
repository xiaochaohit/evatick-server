from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests

from .sources import SOURCE_ORDER


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


class SourcesExhausted(Exception):
    def __init__(self, errors: list[Exception]):
        super().__init__("all configured data sources failed")
        self.errors = errors


def _equity_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    provider_symbol = request["providerSymbol"]
    symbol = provider_symbol.removeprefix("sh").removeprefix("sz").removeprefix("bj")
    adjustment = {"none": "", "forward": "qfq", "backward": "hfq"}[
        request.get("adjustment", "none")
    ]
    if source == "sina":
        return _records(akshare.stock_zh_a_daily(
            symbol=provider_symbol,
            start_date=_sina_date(request.get("start"), "19700101"),
            end_date=_sina_date(request.get("end"), "20500101"),
            adjust=adjustment,
        ))
    if source == "eastmoney":
        return _records(akshare.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=_compact_date(request.get("start"), "19700101"),
            end_date=_compact_date(request.get("end"), "20500101"),
            adjust=adjustment,
            timeout=None,
        ))
    raise ValueError(f"unsupported equity bars source: {source}")


def _index_symbol(provider_symbol: str) -> str:
    symbol = provider_symbol.removeprefix("csi").removeprefix("sh").removeprefix("sz")
    if provider_symbol.startswith("sz") or symbol.startswith("399"):
        return f"sz{symbol}"
    return f"sh{symbol}"


def _filter_dates(
    records: list[dict[str, Any]], request: dict[str, Any]
) -> list[dict[str, Any]]:
    start = request.get("start")
    end = request.get("end")
    if not start and not end:
        return records
    filtered = []
    for record in records:
        value = record.get("date", record.get("日期"))
        if value is None:
            continue
        current = str(value)[:10]
        if start and current < start[:10]:
            continue
        if end and current > end[:10]:
            continue
        filtered.append(record)
    return filtered


def _index_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    if source == "sina":
        return _filter_dates(
            _records(akshare.stock_zh_index_daily(
                symbol=_index_symbol(request["providerSymbol"]),
            )),
            request,
        )
    if source == "tencent":
        return _records(akshare.stock_zh_index_daily_tx(
            symbol=_index_symbol(request["providerSymbol"]),
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    if source == "eastmoney":
        return _records(akshare.stock_zh_index_daily_em(
            symbol=request["providerSymbol"],
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    raise ValueError(f"unsupported index bars source: {source}")


def _market_data(
    akshare: Any, request: dict[str, Any]
) -> dict[str, Any]:
    instrument_type = request["instrumentType"]
    operation = request["operation"]
    key = f"{instrument_type}_{operation}"
    source_request = request
    if operation == "quote":
        today = datetime.now().date()
        source_request = {
            **request,
            "start": (today - timedelta(days=21)).isoformat(),
            "end": today.isoformat(),
            "adjustment": "none",
        }
    loader = _equity_bars if instrument_type == "equity" else _index_bars
    errors: list[Exception] = []
    for source in SOURCE_ORDER[key]:
        try:
            data = loader(akshare, source_request, source)
            if operation == "quote":
                data = sorted(
                    data,
                    key=lambda record: str(record.get("date", record.get("日期", ""))),
                )[-2:]
                if not data:
                    raise ValueError(f"{source} returned no recent quote data")
            return {"data": data, "source": source}
        except Exception as error:
            errors.append(error)
    raise SourcesExhausted(errors)


def _is_transient(error: Exception) -> bool:
    if isinstance(error, SourcesExhausted):
        return bool(error.errors) and any(_is_transient(item) for item in error.errors)
    return isinstance(error, (requests.ConnectionError, requests.Timeout)) or (
        isinstance(error, requests.HTTPError)
        and error.response is not None
        and error.response.status_code in {429, 502, 503, 504}
    )


def execute(request: dict[str, Any]) -> dict[str, Any]:
    import akshare

    operation = request["operation"]
    if operation == "list_stocks":
        return {"data": _records(akshare.stock_info_a_code_name()), "source": "akshare"}
    if operation == "list_indices":
        return {"data": _records(akshare.index_stock_info()), "source": "akshare"}
    if operation in {"bars", "quote"}:
        return _market_data(akshare, request)
    if operation == "constituents":
        symbol = request["providerSymbol"]
        for prefix in ("csi", "sh", "sz"):
            symbol = symbol.removeprefix(prefix)
        return {"data": _records(akshare.index_stock_cons(symbol=symbol)), "source": "akshare"}
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
            payload = {"ok": True, **execute(request)}
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
