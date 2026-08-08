from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_supervisor_terminates_provider_after_total_timeout(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
import time


def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    time.sleep(10)
    return [{'unreachable': True}]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--timeout",
            "1",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=4,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "code": "TIMEOUT",
        "message": "data call exceeded the 1 second total timeout",
        "retryable": True,
    }


def test_supervisor_retries_transient_http_statuses(tmp_path: Path) -> None:
    counter_path = tmp_path / "attempts.txt"
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        f"""
from pathlib import Path

import requests


COUNTER = Path({str(counter_path)!r})


def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    attempt = int(COUNTER.read_text()) + 1 if COUNTER.exists() else 1
    COUNTER.write_text(str(attempt))
    if attempt < 3:
        response = requests.Response()
        response.status_code = 503
        raise requests.HTTPError(response=response)
    return [{{'attempt': attempt}}]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--timeout",
            "5",
            "--retries",
            "2",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=8,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [{"attempt": 3}]
    assert counter_path.read_text(encoding="utf-8") == "3"


def test_sensitive_option_resolves_environment_variable_inside_worker(
    tmp_path: Path,
) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def news_economic_baidu(date='20251126', cookie=None):
    return [{'authenticated': cookie == 'super secret'}]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))
    environment["TEST_COOKIE"] = "super secret"

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "alternative",
            "news-economic-baidu",
            "--cookie-env",
            "TEST_COOKIE",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [{"authenticated": True}]
