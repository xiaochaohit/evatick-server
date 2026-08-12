from __future__ import annotations

import argparse
import contextlib
import importlib
import io
import json
import os
import traceback
from pathlib import Path
from typing import Any

import requests

from market_cli.serialization import SerializationError, to_json_value


def _sanitized_diagnostic(error: Exception) -> str:
    lines = [f"exception_type={type(error).__name__}", "traceback:"]
    for frame in traceback.extract_tb(error.__traceback__):
        lines.append(f"  {Path(frame.filename).name}:{frame.lineno} in {frame.name}")
    return "\n".join(lines)


def _is_transient_network_error(error: Exception) -> bool:
    transient_http_error = (
        isinstance(error, requests.HTTPError)
        and error.response is not None
        and error.response.status_code in {429, 502, 503, 504}
    )
    return isinstance(error, (requests.ConnectionError, requests.Timeout)) or (
        transient_http_error
    )


def _sina_stock_symbol(symbol: str) -> str:
    if symbol.startswith("6"):
        return f"sh{symbol}"
    if symbol.startswith(("4", "8")):
        return f"bj{symbol}"
    return f"sz{symbol}"


def _sina_date(value: str) -> str:
    if len(value) == 8 and value.isdigit():
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value


def _stock_bars(provider: Any, parameters: dict[str, Any]) -> tuple[Any, str]:
    if parameters.get("period", "daily") != "daily":
        return provider.stock_zh_a_hist(**parameters), "eastmoney"
    sina_parameters = {
        "symbol": _sina_stock_symbol(parameters.get("symbol", "000001")),
        "start_date": _sina_date(parameters.get("start_date", "19700101")),
        "end_date": _sina_date(parameters.get("end_date", "20500101")),
        "adjust": parameters.get("adjust", ""),
    }
    try:
        return provider.stock_zh_a_daily(**sina_parameters), "sina"
    except Exception as error:
        if not _is_transient_network_error(error):
            raise
    return provider.stock_zh_a_hist(**parameters), "eastmoney"


def _mark_source(result: Any, source: str) -> Any:
    normalized = to_json_value(result)
    if isinstance(normalized, list) and all(
        isinstance(record, dict) for record in normalized
    ):
        return [{"_market_cli_source": source, **record} for record in normalized]
    return normalized


def _error_payload(error: Exception) -> dict[str, Any]:
    if isinstance(error, SerializationError):
        payload = {
            "ok": False,
            "error": {
                "code": error.code,
                "message": error.message,
                "retryable": False,
            },
        }
        payload["diagnostic"] = _sanitized_diagnostic(error)
        return payload
    if _is_transient_network_error(error):
        payload = {
            "ok": False,
            "error": {
                "code": "NETWORK_ERROR",
                "message": "temporary network failure",
                "retryable": True,
            },
        }
        payload["diagnostic"] = _sanitized_diagnostic(error)
        return payload
    return {
        "ok": False,
        "error": {
            "code": "INTERNAL_ERROR",
            "message": "data provider call failed",
            "retryable": False,
        },
        "diagnostic": _sanitized_diagnostic(error),
    }


def execute(request: dict[str, Any]) -> dict[str, Any]:
    try:
        parameters = dict(request["parameters"])
        for parameter_name, environment_name in request.get(
            "secret_parameters", {}
        ).items():
            if environment_name not in os.environ:
                return {
                    "ok": False,
                    "error": {
                        "code": "MISSING_SECRET",
                        "message": f"environment variable {environment_name} is not set",
                        "retryable": False,
                    },
                }
            value = os.environ[environment_name]
            if value == "":
                return {
                    "ok": False,
                    "error": {
                        "code": "EMPTY_SECRET",
                        "message": f"environment variable {environment_name} is empty",
                        "retryable": False,
                    },
                }
            parameters[parameter_name] = value
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ):
            provider = importlib.import_module(request["provider"])
            if request.get("adapter") == "stock_bars":
                result, source = _stock_bars(provider, parameters)
                normalized = _mark_source(result, source)
            else:
                function = getattr(provider, request["function"])
                normalized = to_json_value(function(**parameters))
        return {"ok": True, "result": normalized}
    except Exception as error:  # noqa: BLE001 - worker is the provider boundary
        return _error_payload(error)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()

    request = json.loads(arguments.request.read_text(encoding="utf-8"))
    payload = execute(request)
    temporary = arguments.result.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(
            payload,
            stream,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, arguments.result)


if __name__ == "__main__":
    main()
