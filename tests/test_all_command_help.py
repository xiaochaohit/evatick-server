from __future__ import annotations

import sys

from click.testing import CliRunner

from market_cli.cli import cli
from market_cli.registry.runtime import load_registry


def test_every_generated_command_has_renderable_help_without_provider_import() -> None:
    runner = CliRunner()

    for command in load_registry()["commands"]:
        result = runner.invoke(cli, [*command["path"], "--help"])
        assert result.exit_code == 0, (command["path"], result.output, result.exception)
        assert result.output.startswith("NAME\n")
        assert "\nUPSTREAM\n" in result.output
        assert "\nOPTIONS\n" in result.output
        assert "\nRETURNS\n" in result.output

    assert "akshare" not in sys.modules
