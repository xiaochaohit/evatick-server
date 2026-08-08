from __future__ import annotations

import json
from pathlib import Path

import click

from market_cli.registry.builder import RegistryBuildError, build_registry


@click.group()
def registry() -> None:
    """Build and inspect static command registries."""


@registry.command("build")
@click.option("--provider", required=True, help="Importable provider module.")
@click.option("--output", type=click.Path(path_type=Path), required=True)
def build_command(provider: str, output: Path) -> None:
    summary = build_registry(provider, output)
    click.echo(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))


def main() -> None:
    try:
        registry.main(standalone_mode=False)
    except RegistryBuildError as error:
        click.echo(
            json.dumps(
                {
                    "code": error.code,
                    "message": error.message,
                    "retryable": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            err=True,
        )
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
