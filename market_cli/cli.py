from __future__ import annotations

import click


class ModelGroup(click.Group):
    """Render deterministic, model-oriented help."""

    def format_help(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        formatter.write("NAME\n    market-cli\n\n")
        formatter.write("PURPOSE\n    为模型提供可发现的市场数据命令。\n\n")
        formatter.write("USAGE\n    market-cli COMMAND [OPTIONS]\n")


@click.group(cls=ModelGroup)
def cli() -> None:
    """Market CLI root command."""


def main() -> None:
    cli.main(prog_name="market-cli")
