from __future__ import annotations

import importlib
import io
import json
import math
import os
import sys
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, TextIO
from zoneinfo import ZoneInfo


SOURCE = "amazingdata"
INTERVAL_PERIODS = {
    "1m": "min1",
    "5m": "min5",
    "15m": "min15",
    "30m": "min30",
    "60m": "min60",
    "1d": "day",
    "1w": "week",
    "1mo": "month",
}
SHANGHAI = ZoneInfo("Asia/Shanghai")


class BridgeError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise BridgeError("MISSING_CONFIGURATION", f"required environment variable is missing: {name}")
    return value


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _json_value(item())
        except (TypeError, ValueError):
            pass
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except (TypeError, ValueError):
            pass
    if hasattr(value, "__dict__"):
        return {
            key: _json_value(item)
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return str(value)


def _records(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [dict(_json_value(item)) if isinstance(item, dict) else _json_value(item) for item in value]
    if isinstance(value, dict):
        if {"index", "columns", "data"}.issubset(value):
            columns = [str(item) for item in value["columns"]]
            return [
                {"date": _json_value(index), **dict(zip(columns, map(_json_value, row), strict=False))}
                for index, row in zip(value["index"], value["data"], strict=False)
            ]
        return [dict(_json_value(value))]
    reset_index = getattr(value, "reset_index", None)
    if callable(reset_index):
        value = reset_index()
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        rows = to_dict(orient="records")
        return [dict(_json_value(row)) for row in rows]
    converted = _json_value(value)
    return [converted] if isinstance(converted, dict) else []


def _sdk_call(function: Any, *args: Any, **kwargs: Any) -> Any:
    # AmazingData writes login tokens and progress messages to stdout. The
    # sidecar owns stdout as its NDJSON protocol, so provider output must never
    # be allowed to corrupt the stream or leak session credentials to callers.
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        return function(*args, **kwargs)


def _symbol_records(value: Any, provider_symbol: str) -> list[dict[str, Any]]:
    if not isinstance(value, dict):
        return []
    if provider_symbol in value:
        return _records(value[provider_symbol])
    for nested in value.values():
        rows = _symbol_records(nested, provider_symbol)
        if rows:
            return rows
    return []


def _date_value(value: str | None, fallback: date) -> date:
    if value is None:
        return fallback
    if not isinstance(value, str):
        raise BridgeError("INVALID_DATE", "date must use YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise BridgeError("INVALID_DATE", "date must use YYYY-MM-DD") from error


def _date_number(value: date) -> int:
    return int(value.strftime("%Y%m%d"))


def _date_windows(start: date, end: date, maximum_days: int):
    if start > end:
        raise BridgeError("INVALID_DATE_RANGE", "start date must not follow end date")
    cursor = start
    while cursor <= end:
        window_end = min(cursor + timedelta(days=maximum_days - 1), end)
        yield cursor, window_end
        cursor = window_end + timedelta(days=1)


def _today_in_shanghai() -> date:
    return datetime.now(SHANGHAI).date()


class AmazingDataSession:
    def __init__(self, sdk: Any) -> None:
        self.sdk = sdk
        self.username = _required_environment("AMAZINGDATA_USERNAME")
        password = _required_environment("AMAZINGDATA_PASSWORD")
        host = _required_environment("AMAZINGDATA_HOST")
        try:
            port = int(_required_environment("AMAZINGDATA_PORT"))
        except ValueError as error:
            raise BridgeError("INVALID_CONFIGURATION", "AMAZINGDATA_PORT must be an integer") from error
        self.cache_path = Path(_required_environment("AMAZINGDATA_CACHE_PATH")).resolve()
        self.cache_path.mkdir(parents=True, exist_ok=True)
        self.cache_directory = f"{self.cache_path}{os.sep}"
        try:
            _sdk_call(sdk.login, username=self.username, password=password, host=host, port=port)
        except Exception as error:
            raise BridgeError("PROVIDER_LOGIN_FAILED", "AmazingData login failed", True) from error
        self.base_data = _sdk_call(sdk.BaseData)
        self.market_data = _sdk_call(sdk.MarketData, _sdk_call(self.base_data.get_calendar))

    def close(self) -> None:
        try:
            _sdk_call(self.sdk.logout, self.username)
        except Exception:
            pass

    def dispatch(self, request: dict[str, Any]) -> Any:
        operation = request.get("operation")
        if operation == "health":
            security_type = "EXTRA_INDEX_A" if request.get("category") == "index" else "EXTRA_STOCK_A"
            rows = _records(_sdk_call(self.base_data.get_code_info, security_type=security_type))
            return {"records": len(rows)}
        if operation == "list_instruments":
            return self._list_instruments()
        if operation == "bars":
            return self._bars(request)
        if operation == "quote":
            return self._quote(request)
        if operation == "adjustment_factors":
            return self._adjustment_factors(request)
        if operation == "constituents":
            return self._constituents(request)
        if operation == "shutdown":
            return {"stopped": True}
        raise BridgeError("UNSUPPORTED_OPERATION", f"unsupported operation: {operation}")

    def _list_instruments(self) -> list[dict[str, Any]]:
        instruments: list[dict[str, Any]] = []
        for instrument_type, security_type in (
            ("equity", "EXTRA_STOCK_A"),
            ("index", "EXTRA_INDEX_A"),
        ):
            for row in _records(_sdk_call(self.base_data.get_code_info, security_type=security_type)):
                code = row.get("code_market") or row.get("code") or row.get("index")
                name = row.get("symbol") or row.get("security_name") or row.get("name")
                if code and name:
                    instruments.append({
                        "type": instrument_type,
                        "code": str(code),
                        "name": str(name),
                        "status": _json_value(row.get("security_status")),
                    })
        return instruments

    def _bars(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        provider_symbol = request.get("providerSymbol")
        interval = request.get("interval")
        if not isinstance(provider_symbol, str) or not provider_symbol:
            raise BridgeError("INVALID_PROVIDER_SYMBOL", "providerSymbol must be a non-empty string")
        period_name = INTERVAL_PERIODS.get(interval)
        if period_name is None:
            raise BridgeError("UNSUPPORTED_INTERVAL", f"unsupported AmazingData interval: {interval}")
        end = _date_value(request.get("end"), _today_in_shanghai())
        default_start = date(1990, 1, 1) if interval == "1d" else end - timedelta(days=4)
        start = _date_value(request.get("start"), default_start)
        if interval != "1d" and (end - start).days > 89:
            raise BridgeError(
                "UNSUPPORTED_DATE_RANGE",
                "AmazingData intraday requests are limited to 90 calendar days",
            )
        rows: list[dict[str, Any]] = []
        maximum_days = 366 if interval == "1d" else 5
        for window_start, window_end in _date_windows(start, end, maximum_days):
            result = _sdk_call(
                self.market_data.query_kline,
                [provider_symbol],
                begin_date=_date_number(window_start),
                end_date=_date_number(window_end),
                period=getattr(self.sdk.constant.Period, period_name).value,
            )
            if not isinstance(result, dict):
                raise BridgeError("PROVIDER_INVALID_RESPONSE", "AmazingData K-line result is not a dictionary")
            rows.extend(_records(result.get(provider_symbol)))
        return rows

    def _quote(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        provider_symbol = request.get("providerSymbol")
        if not isinstance(provider_symbol, str) or not provider_symbol:
            raise BridgeError("INVALID_PROVIDER_SYMBOL", "providerSymbol must be a non-empty string")
        today = _date_number(_today_in_shanghai())
        result = _sdk_call(
            self.market_data.query_snapshot,
            [provider_symbol], begin_date=today, end_date=today,
        )
        if not isinstance(result, dict):
            raise BridgeError("PROVIDER_INVALID_RESPONSE", "AmazingData snapshot result is not a dictionary")
        return _symbol_records(result, provider_symbol)

    def _adjustment_factors(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        provider_symbol = request.get("providerSymbol")
        if not isinstance(provider_symbol, str) or not provider_symbol:
            raise BridgeError("INVALID_PROVIDER_SYMBOL", "providerSymbol must be a non-empty string")
        result = _sdk_call(
            self.base_data.get_backward_factor,
            [provider_symbol], local_path=self.cache_directory, is_local=False,
        )
        records = _records(result)
        return [
            {"date": row.get("date", row.get("index")), "factor": row.get(provider_symbol)}
            for row in records
            if row.get("date", row.get("index")) is not None and row.get(provider_symbol) is not None
        ]

    def _constituents(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        provider_symbol = request.get("providerSymbol")
        if not isinstance(provider_symbol, str) or not provider_symbol:
            raise BridgeError("INVALID_PROVIDER_SYMBOL", "providerSymbol must be a non-empty string")
        info_data = _sdk_call(self.sdk.InfoData)
        result = _sdk_call(
            info_data.get_index_constituent,
            [provider_symbol], local_path=self.cache_directory, is_local=False,
        )
        if not isinstance(result, dict):
            raise BridgeError(
                "PROVIDER_INVALID_RESPONSE",
                "AmazingData index constituent result is not a dictionary",
            )
        return _records(result.get(provider_symbol))


def _response(identifier: Any, data: Any) -> dict[str, Any]:
    return {"id": identifier, "ok": True, "source": SOURCE, "data": _json_value(data)}


def _error_response(identifier: Any, error: Exception) -> dict[str, Any]:
    if isinstance(error, BridgeError):
        code, message, retryable = error.code, str(error), error.retryable
    else:
        code, message, retryable = "PROVIDER_ERROR", "AmazingData request failed", True
    return {
        "id": identifier,
        "ok": False,
        "error": {"code": code, "message": message, "retryable": retryable},
    }


def serve(input_stream: TextIO, output_stream: TextIO, sdk: Any | None = None) -> None:
    session: AmazingDataSession | None = None
    try:
        sdk = sdk or importlib.import_module("AmazingData")
        session = AmazingDataSession(sdk)
        for line in input_stream:
            identifier: Any = None
            request: Any = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise BridgeError("INVALID_REQUEST", "request must be a JSON object")
                identifier = request.get("id")
                response = _response(identifier, session.dispatch(request))
            except Exception as error:
                response = _error_response(identifier, error)
            output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            output_stream.flush()
            if isinstance(request, dict) and request.get("operation") == "shutdown":
                break
    finally:
        if session is not None:
            session.close()


def main() -> None:
    try:
        serve(sys.stdin, sys.stdout)
    except Exception as error:
        sys.stderr.write(json.dumps(_error_response(None, error), ensure_ascii=False) + "\n")
        raise SystemExit(1) from None
