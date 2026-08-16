from __future__ import annotations

from tests.test_cli_entrypoint import run_cli


def test_every_first_server_command_has_offline_help() -> None:
    paths = [
        ("health",),
        ("version",),
        ("instrument", "list"),
        ("instrument", "search"),
        ("instrument", "resolve"),
        ("instrument", "show"),
        ("stock", "quotes"),
        ("stock", "bars"),
        ("index", "quotes"),
        ("index", "bars"),
        ("index", "constituents"),
    ]

    for path in paths:
        result = run_cli(*path, "--help")
        assert result.returncode == 0, (path, result.stderr)
        assert result.stderr == ""
        assert "Options:" in result.stdout
