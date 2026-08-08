from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)
    return subprocess.run(
        [sys.executable, "-m", "market_cli", *arguments],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_model_can_read_stable_plain_text_root_help() -> None:
    result = run_cli("--help")

    assert result.returncode == 0
    assert result.stderr == ""
    assert result.stdout.startswith("NAME\n    market-cli\n\nPURPOSE\n")
    assert "\nUSAGE\n    market-cli COMMAND [OPTIONS]\n" in result.stdout
    assert "\x1b[" not in result.stdout
