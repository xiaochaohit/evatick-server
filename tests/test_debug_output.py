from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_explicit_debug_file_gets_sanitized_traceback(tmp_path: Path) -> None:
    fake_provider = tmp_path / "provider" / "akshare"
    fake_provider.mkdir(parents=True)
    (fake_provider / "__init__.py").write_text(
        """
def stock_zh_a_hist(symbol='000001', period='daily', start_date='19700101',
                    end_date='20500101', adjust='', timeout=None):
    raise RuntimeError('secret-token-must-not-escape')
""".lstrip(),
        encoding="utf-8",
    )
    debug_path = tmp_path / "diagnostic.txt"
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
            "--debug-output",
            str(debug_path),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "code": "INTERNAL_ERROR",
        "message": "data provider call failed",
        "retryable": False,
    }
    diagnostic = debug_path.read_text(encoding="utf-8")
    assert "RuntimeError" in diagnostic
    assert "__init__.py" in diagnostic
    assert "secret-token-must-not-escape" not in diagnostic
    assert stat.S_IMODE(debug_path.stat().st_mode) == 0o600
