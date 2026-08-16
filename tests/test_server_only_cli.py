from __future__ import annotations

import json

from tests.test_cli_entrypoint import run_cli


def test_root_exposes_only_the_first_server_command_tree() -> None:
    result = run_cli("--help")

    assert result.returncode == 0
    assert result.stderr == ""
    assert result.stdout.startswith("NAME\n    market-cli\n")
    command_lines = {
        line.strip()
        for line in result.stdout.splitlines()
        if line.startswith("    ") and line.strip() in {
            "health", "version", "instrument", "stock", "index",
            "catalog", "alternative", "fund", "futures", "fx", "macro",
        }
    }
    assert command_lines == {"health", "version", "instrument", "stock", "index"}


def test_removed_local_provider_command_is_rejected_as_json() -> None:
    result = run_cli("stock", "zh-a-hist", "--symbol", "000001")

    assert result.returncode == 2
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "code": "INVALID_ARGUMENT",
        "message": "No such command 'zh-a-hist'.",
        "retryable": False,
    }
