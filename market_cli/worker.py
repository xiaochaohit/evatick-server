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
    transient_http_error = (
        isinstance(error, requests.HTTPError)
        and error.response is not None
        and error.response.status_code in {429, 502, 503, 504}
    )
    if (
        isinstance(error, (requests.ConnectionError, requests.Timeout))
        or transient_http_error
    ):
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
            function = getattr(provider, request["function"])
            result = function(**parameters)
        return {"ok": True, "result": to_json_value(result)}
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
