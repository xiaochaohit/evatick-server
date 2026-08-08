from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_explicit_ttl_reuses_successful_result_without_second_provider_call(
    tmp_path: Path,
) -> None:
    counter_path = tmp_path / "calls.txt"
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        f"""
from pathlib import Path

COUNTER = Path({str(counter_path)!r})


def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    calls = int(COUNTER.read_text()) + 1 if COUNTER.exists() else 1
    COUNTER.write_text(str(calls))
    return [{{'calls': calls, 'symbol': symbol}}]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))
    environment["XDG_CACHE_HOME"] = str(tmp_path / "cache")
    command = [
        sys.executable,
        "-m",
        "market_cli",
        "stock",
        "zh-a-hist",
        "--symbol",
        "000009",
        "--cache-ttl",
        "60",
    ]

    first = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    second = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert first.returncode == second.returncode == 0
    assert json.loads(first.stdout) == json.loads(second.stdout) == [
        {"calls": 1, "symbol": "000009"}
    ]
    assert counter_path.read_text(encoding="utf-8") == "1"


def test_cache_status_and_clear_report_entries_and_bytes(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': 1}]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))
    environment["XDG_CACHE_HOME"] = str(tmp_path / "cache")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--cache-ttl",
            "60",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )

    status = subprocess.run(
        [sys.executable, "-m", "market_cli", "cache", "status"],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    cleared = subprocess.run(
        [sys.executable, "-m", "market_cli", "cache", "clear", "--all"],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert status.returncode == cleared.returncode == 0
    status_payload = json.loads(status.stdout)
    assert status_payload["entries"] == 1
    assert status_payload["bytes"] > 0
    clear_payload = json.loads(cleared.stdout)
    assert clear_payload["deleted"] == 1
    assert clear_payload["bytes"] == status_payload["bytes"]
