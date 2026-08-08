from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from market_cli.output import write_debug_output


class InvocationError(Exception):
    def __init__(self, code: str, message: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(process.pid, signal.SIGTERM)
    else:
        process.terminate()
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait()


def _run_attempt(
    request_path: Path,
    result_path: Path,
    timeout: float,
) -> dict[str, Any]:
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "market_cli.worker",
            "--request",
            str(request_path),
            "--result",
            str(result_path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate(process)
        raise
    if process.returncode != 0 or not result_path.is_file():
        raise InvocationError(
            "INTERNAL_ERROR",
            "worker exited without a valid result",
            False,
        )
    return json.loads(result_path.read_text(encoding="utf-8"))


def invoke(
    *,
    provider: str,
    function: str,
    adapter: str | None,
    parameters: dict[str, Any],
    secret_parameters: dict[str, str],
    timeout: float,
    retries: int,
    debug_output: Path | None = None,
    overwrite: bool = False,
) -> Any:
    started = time.monotonic()
    working_directory = Path(tempfile.mkdtemp(prefix="market-cli-worker-"))
    os.chmod(working_directory, 0o700)
    request_path = working_directory / "request.json"
    result_path = working_directory / "result.json"
    try:
        descriptor = os.open(
            request_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(
                {
                    "provider": provider,
                    "function": function,
                    "adapter": adapter,
                    "parameters": parameters,
                    "secret_parameters": secret_parameters,
                },
                stream,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )

        for attempt in range(retries + 1):
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise subprocess.TimeoutExpired("market-cli.worker", timeout)
            result_path.unlink(missing_ok=True)
            try:
                payload = _run_attempt(request_path, result_path, remaining)
            except subprocess.TimeoutExpired:
                if debug_output is not None:
                    write_debug_output(
                        debug_output,
                        "exception_type=TimeoutExpired\ntraceback:\n  worker timeout",
                        overwrite,
                    )
                raise InvocationError(
                    "TIMEOUT",
                    f"data call exceeded the {timeout:g} second total timeout",
                    True,
                ) from None
            if payload["ok"]:
                return payload["result"]
            error = payload["error"]
            if error["retryable"] and attempt < retries:
                delay = min(0.25 * (2**attempt), max(0.0, remaining))
                time.sleep(delay)
                continue
            if debug_output is not None:
                write_debug_output(
                    debug_output,
                    payload.get("diagnostic", "diagnostic unavailable"),
                    overwrite,
                )
            raise InvocationError(
                error["code"],
                error["message"],
                error["retryable"],
            )
        raise AssertionError("retry loop exhausted without a result")
    finally:
        shutil.rmtree(working_directory, ignore_errors=True)
