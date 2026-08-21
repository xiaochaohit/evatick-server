from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_cli(
    *arguments: str,
    environment_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)
    environment.update(environment_overrides or {})
    return subprocess.run(
        [sys.executable, "-m", "market_cli", *arguments],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_root_help_is_compact_plain_text() -> None:
    result = run_cli("--help")

    assert result.returncode == 0
    assert result.stderr == ""
    assert result.stdout.startswith("NAME\n    market-cli\n\nPURPOSE\n")
    assert "market-cli [--config PATH] [--server-url URL] [--api-key KEY] COMMAND [OPTIONS]" in result.stdout
    assert "\x1b[" not in result.stdout


def test_version_reports_only_cli_and_server_contract_versions() -> None:
    result = run_cli("version")

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {
        "market_cli": "0.3.0",
        "market_server_api": "v1",
        "python": platform.python_version(),
    }


def test_invalid_option_is_a_json_usage_error() -> None:
    result = run_cli("stock", "bars", "--unknown")

    assert result.returncode == 2
    assert result.stdout == ""
    error = json.loads(result.stderr)
    assert error["code"] == "INVALID_ARGUMENT"
    assert error["retryable"] is False
    assert "--unknown" in error["message"]
