from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_dataframe_result_is_strict_json_at_the_cli_boundary(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd


def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return pd.DataFrame([{
        '代码': symbol,
        '时间': pd.Timestamp('2024-01-02T03:04:05'),
        '价格': np.nan,
        '金额': Decimal('12.3400'),
        '二进制': b'\\x01\\x02',
        '路径': Path('result.json'),
    }])
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
            "--symbol",
            "000002",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [
        {
            "二进制": "AQI=",
            "代码": "000002",
            "价格": None,
            "时间": "2024-01-02T03:04:05",
            "路径": "result.json",
            "金额": "12.3400",
        }
    ]


def test_duplicate_dataframe_columns_fail_explicitly(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
import pandas as pd


def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return pd.DataFrame([[1, 2]], columns=['price', 'price'])
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))

    result = subprocess.run(
        [sys.executable, "-m", "market_cli", "stock", "zh-a-hist"],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "code": "DUPLICATE_COLUMNS",
        "message": "DataFrame column names are not unique after JSON normalization",
        "retryable": False,
    }


def test_stdout_budget_rejects_more_than_two_hundred_records(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': row} for row in range(201)]
""".lstrip(),
        encoding="utf-8",
    )
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join((str(tmp_path), str(PROJECT_ROOT)))

    result = subprocess.run(
        [sys.executable, "-m", "market_cli", "stock", "zh-a-hist"],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "code": "RESULT_TOO_LARGE",
        "message": "result has 201 records; use --limit or --output",
        "retryable": False,
    }


def test_limit_slices_records_before_stdout_budget(tmp_path: Path) -> None:
    fake_provider = tmp_path / "akshare"
    fake_provider.mkdir()
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': row} for row in range(201)]
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
            "--limit",
            "2",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == [{"row": 0}, {"row": 1}]


def test_large_result_can_be_exported_to_json_file(tmp_path: Path) -> None:
    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': row} for row in range(201)]
""".lstrip(),
        encoding="utf-8",
    )
    output_path = tmp_path / "records.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        (str(tmp_path / "provider"), str(PROJECT_ROOT))
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--output",
            str(output_path),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert json.loads(result.stdout) == {
        "path": str(output_path.resolve()),
        "records": 201,
    }
    assert len(json.loads(output_path.read_text(encoding="utf-8"))) == 201


def test_record_sequence_can_be_exported_as_jsonl(tmp_path: Path) -> None:
    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': 1}, {'row': 2}]
""".lstrip(),
        encoding="utf-8",
    )
    output_path = tmp_path / "records.jsonl"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        (str(tmp_path / "provider"), str(PROJECT_ROOT))
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--output",
            str(output_path),
            "--format",
            "jsonl",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert output_path.read_text(encoding="utf-8").splitlines() == [
        '{"row":1}',
        '{"row":2}',
    ]


def test_flat_record_sequence_can_be_exported_as_csv(tmp_path: Path) -> None:
    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'代码': symbol, '价格': 10.5}, {'代码': '000003', '价格': None}]
""".lstrip(),
        encoding="utf-8",
    )
    output_path = tmp_path / "records.csv"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        (str(tmp_path / "provider"), str(PROJECT_ROOT))
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--symbol",
            "000002",
            "--output",
            str(output_path),
            "--format",
            "csv",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert output_path.read_text(encoding="utf-8") == (
        "代码,价格\n000002,10.5\n000003,\n"
    )


def test_explicit_format_cannot_conflict_with_known_extension(tmp_path: Path) -> None:
    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'row': 1}]
""".lstrip(),
        encoding="utf-8",
    )
    output_path = tmp_path / "records.csv"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        (str(tmp_path / "provider"), str(PROJECT_ROOT))
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--output",
            str(output_path),
            "--format",
            "json",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert json.loads(result.stderr)["code"] == "OUTPUT_FORMAT_MISMATCH"
    assert not output_path.exists()


def test_flat_record_sequence_can_be_exported_as_parquet(tmp_path: Path) -> None:
    pq = pytest.importorskip("pyarrow.parquet")

    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    return [{'symbol': symbol, 'price': 10.5}, {'symbol': '000003', 'price': None}]
""".lstrip(),
        encoding="utf-8",
    )
    output_path = tmp_path / "records.parquet"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        (str(tmp_path / "provider"), str(PROJECT_ROOT))
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli",
            "stock",
            "zh-a-hist",
            "--symbol",
            "000002",
            "--output",
            str(output_path),
            "--format",
            "parquet",
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert pq.read_table(output_path).to_pylist() == [
        {"price": 10.5, "symbol": "000002"},
        {"price": None, "symbol": "000003"},
    ]
