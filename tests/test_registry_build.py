from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_builder_discovers_public_functions_and_generates_domain_paths(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "tests.fixtures.fake_provider",
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
        "commands": 2,
        "excluded": 1,
        "output": str(output_path.resolve()),
    }
    registry = json.loads(output_path.read_text(encoding="utf-8"))
    assert registry["schema_version"] == 1
    assert registry["provider"] == {"name": "fake_provider", "version": "1.0"}
    assert [command["path"] for command in registry["commands"]] == [
        ["index", "stock-cons"],
        ["stock", "zh-a-hist"],
    ]
    assert registry["exclusions"] == [
        {"name": "set_token", "reason": "credential state management"}
    ]


def test_builder_uses_python_signature_for_parameter_contract(tmp_path: Path) -> None:
    output_path = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "tests.fixtures.signature_provider",
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
    command = json.loads(output_path.read_text(encoding="utf-8"))["commands"][0]
    assert command["parameters"] == [
        {
            "name": "symbol",
            "option": "--symbol",
            "required": True,
            "type": "string",
        },
        {
            "name": "api_key",
            "option": "--api-key-env",
            "required": True,
            "sensitive": True,
            "type": "string",
        },
        {
            "default": 5,
            "name": "timeout",
            "option": "--arg-timeout",
            "required": False,
            "type": "integer",
        },
        {
            "default": True,
            "name": "adjusted",
            "option": "--adjusted/--no-adjusted",
            "required": False,
            "type": "boolean",
        },
        {
            "default": None,
            "name": "tags",
            "nullable": True,
            "option": "--tags",
            "repeatable": True,
            "required": False,
            "type": "string",
        },
    ]


def test_builder_rejects_colliding_command_paths(tmp_path: Path) -> None:
    output_path = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "tests.fixtures.collision_provider",
            "--output",
            str(output_path),
        ],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    error = json.loads(result.stderr)
    assert error["code"] == "COMMAND_PATH_COLLISION"
    assert error["retryable"] is False
    assert "forex_rate" in error["message"]
    assert "fx_rate" in error["message"]
    assert not output_path.exists()


def test_builder_includes_wrapped_functions_but_not_exception_classes(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "tests.fixtures.wrapped_provider",
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
    registry = json.loads(output_path.read_text(encoding="utf-8"))
    assert [command["function"] for command in registry["commands"]] == [
        "bond_cached_lookup"
    ]


def test_builder_maps_source_modules_to_compact_domain_taxonomy(
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "registry.json"
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(PROJECT_ROOT)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "market_cli.registry",
            "build",
            "--provider",
            "tests.fixtures.taxonomy_provider",
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
    registry = json.loads(output_path.read_text(encoding="utf-8"))
    assert [command["path"] for command in registry["commands"]] == [
        ["alternative", "air-quality-hebei"],
        ["fund", "amac-fund-info"],
        ["futures", "get-cffex-daily"],
        ["fx", "boc-sina"],
    ]
