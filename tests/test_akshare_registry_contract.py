from __future__ import annotations

import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PACKAGED_REGISTRY = PROJECT_ROOT / "market_cli" / "data" / "registry.json"


def test_pinned_akshare_registry_is_complete_and_reproducible(tmp_path: Path) -> None:
    generated_registry = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "akshare",
            "--output",
            str(generated_registry),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    summary = json.loads(result.stdout)
    assert summary["commands"] == 1090
    assert summary["excluded"] == 3

    registry = json.loads(generated_registry.read_text(encoding="utf-8"))
    assert Counter(command["path"][0] for command in registry["commands"]) == {
        "alternative": 75,
        "bond": 49,
        "fund": 94,
        "futures": 92,
        "fx": 15,
        "index": 95,
        "macro": 225,
        "option": 46,
        "stock": 399,
    }
    assert generated_registry.read_bytes() == PACKAGED_REGISTRY.read_bytes()
