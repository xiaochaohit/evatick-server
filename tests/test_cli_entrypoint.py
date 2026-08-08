from __future__ import annotations

import json
import os
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
