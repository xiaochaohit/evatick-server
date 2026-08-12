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
    extra_pythonpath: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    python_paths = [str(PROJECT_ROOT)]
    if extra_pythonpath is not None:
        python_paths.insert(0, str(extra_pythonpath))
    environment["PYTHONPATH"] = os.pathsep.join(python_paths)
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


def test_model_can_read_generated_leaf_help_without_calling_provider() -> None:
    result = run_cli("stock", "zh-a-hist", "--help")

    assert result.returncode == 0
    assert result.stderr == ""
    assert result.stdout.startswith(
        "NAME\n"
        "    market-cli stock zh-a-hist\n\n"
        "PURPOSE\n"
        "    调用 AKShare 函数 stock_zh_a_hist。\n\n"
    )
    assert "\nSTABILITY\n    upstream\n" in result.stdout
    assert "\nUPSTREAM\n    Provider: akshare 1.18.82\n" in result.stdout
    assert "    Function: stock_zh_a_hist\n" in result.stdout
    assert "\nUSAGE\n    market-cli stock zh-a-hist [OPTIONS]\n" in result.stdout
    assert "\nOPTIONS\n" in result.stdout
    assert "    --symbol TEXT" in result.stdout
    assert "    --start-date TEXT" in result.stdout
    assert "    --arg-timeout NUMBER" in result.stdout
    assert "\x1b[" not in result.stdout


def test_model_can_invoke_generated_command_with_named_options(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'symbol': symbol, 'start_date': start_date}]
""".lstrip(),
        encoding="utf-8",
    )

    result = run_cli(
        "stock",
        "zh-a-hist",
        "--symbol",
        "000002",
        "--start-date",
        "20240101",
        extra_pythonpath=tmp_path,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {"start_date": "20240101", "symbol": "000002"}
    ]


def test_stable_stock_bars_uses_sina_as_the_default_source(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(**parameters):
    raise AssertionError('Eastmoney must not be called when Sina succeeds')


def stock_zh_a_daily(symbol, start_date, end_date, adjust):
    return [{
        'symbol': symbol,
        'start_date': start_date,
        'end_date': end_date,
        'adjust': adjust,
        'close': 10.16,
    }]
""".lstrip(),
        encoding="utf-8",
    )

    result = run_cli(
        "stock",
        "bars",
        "--symbol",
        "000001",
        "--start-date",
        "20260701",
        "--end-date",
        "20260808",
        "--adjust",
        "qfq",
        "--retries",
        "0",
        extra_pythonpath=tmp_path,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {
            "_market_cli_source": "sina",
            "adjust": "qfq",
            "close": 10.16,
            "end_date": "2026-08-08",
            "start_date": "2026-07-01",
            "symbol": "sz000001",
        }
    ]


def test_stable_stock_bars_falls_back_to_eastmoney_on_network_failure(
    tmp_path: Path,
) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
import requests


def stock_zh_a_daily(**parameters):
    raise requests.ConnectionError('Sina is temporarily unavailable')


def stock_zh_a_hist(symbol, period, start_date, end_date, adjust, timeout):
    return [{
        'symbol': symbol,
        'period': period,
        'start_date': start_date,
        'end_date': end_date,
        'adjust': adjust,
        'timeout': timeout,
        'close': 10.18,
    }]
""".lstrip(),
        encoding="utf-8",
    )

    result = run_cli(
        "stock",
        "bars",
        "--symbol",
        "000001",
        "--start-date",
        "20260701",
        "--end-date",
        "20260808",
        "--adjust",
        "qfq",
        "--retries",
        "0",
        extra_pythonpath=tmp_path,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {
            "_market_cli_source": "eastmoney",
            "adjust": "qfq",
            "close": 10.18,
            "end_date": "20260808",
            "period": "daily",
            "start_date": "20260701",
            "symbol": "000001",
            "timeout": None,
        }
    ]


def test_invalid_generated_option_is_a_json_usage_error() -> None:
    result = run_cli(
        "alternative",
        "bank-fjcf-table-detail",
        "--page",
        "not-a-number",
    )

    assert result.returncode == 2
    assert result.stdout == ""
    error = json.loads(result.stderr)
    assert error["code"] == "INVALID_ARGUMENT"
    assert error["retryable"] is False
    assert "--page" in error["message"]


def test_model_can_supply_data_parameters_as_strict_json(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'symbol': symbol, 'start_date': start_date}]
""".lstrip(),
        encoding="utf-8",
    )

    result = run_cli(
        "stock",
        "zh-a-hist",
        "--args-json",
        '{"symbol":"000009","start_date":"20240203"}',
        extra_pythonpath=tmp_path,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {"start_date": "20240203", "symbol": "000009"}
    ]


def test_args_json_can_satisfy_required_signature_parameter(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def macro_china_nbs_nation(kind, path, period='LAST10'):
    return [{'kind': kind, 'path': path}]
""".lstrip(),
        encoding="utf-8",
    )

    result = run_cli(
        "macro",
        "china-nbs-nation",
        "--args-json",
        '{"kind":{"code":"zb"},"path":"A0101"}',
        extra_pythonpath=tmp_path,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {"kind": {"code": "zb"}, "path": "A0101"}
    ]


def test_catalog_summarizes_static_registry_without_expanding_commands() -> None:
    result = run_cli("catalog")

    assert result.returncode == 0
    assert result.stderr == ""
    catalog = json.loads(result.stdout)
    assert sum(domain["commands"] for domain in catalog) == 1101
    assert next(domain for domain in catalog if domain["domain"] == "stock") == {
        "commands": 405,
        "domain": "stock",
        "stable": 6,
        "upstream": 399,
    }
    assert all("path" not in domain for domain in catalog)


def test_search_ranks_exact_command_name_before_substrings() -> None:
    result = run_cli(
        "search",
        "--query",
        "zh-a-hist",
        "--domain",
        "stock",
        "--limit",
        "5",
    )

    assert result.returncode == 0
    assert result.stderr == ""
    matches = json.loads(result.stdout)
    assert matches[0] == {
        "function": "stock_zh_a_hist",
        "path": "market-cli stock zh-a-hist",
        "provider": "akshare",
        "purpose": "调用 AKShare 函数 stock_zh_a_hist。",
        "stability": "upstream",
    }
    assert len(matches) <= 5


def test_version_reports_cli_provider_and_registry_fingerprint() -> None:
    result = run_cli("version")

    assert result.returncode == 0
    assert result.stderr == ""
    version = json.loads(result.stdout)
    assert version["market_cli"] == "0.1.1"
    assert version["providers"] == {"akshare": "1.18.82"}
    assert version["python"] == platform.python_version()
    assert len(version["registry_sha256"]) == 64


def test_doctor_runs_offline_checks_without_exposing_home_directory() -> None:
    result = run_cli("doctor")

    assert result.returncode == 0
    assert result.stderr == ""
    doctor = json.loads(result.stdout)
    assert doctor["status"] in {"ok", "warning"}
    checks = {check["name"]: check for check in doctor["checks"]}
    assert checks["registry"]["status"] == "ok"
    assert checks["provider_version"]["status"] == "ok"
    assert checks["worker"]["status"] == "ok"
    assert checks["parquet"]["status"] in {"ok", "warning"}
    assert str(Path.home()) not in result.stdout
