from __future__ import annotations

import importlib
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import click

from market_cli.output import export_result
from market_cli.registry.runtime import load_registry
from market_cli.serialization import SerializationError, dumps


TYPE_LABELS = {
    "date": "DATE",
    "datetime": "DATETIME",
    "decimal": "DECIMAL",
    "integer": "INTEGER",
    "json": "JSON",
    "number": "NUMBER",
    "string": "TEXT",
}
CLICK_TYPES = {
    "integer": click.INT,
    "number": click.FLOAT,
}


class ModelGroup(click.Group):
    """Render deterministic, model-oriented help."""

    def format_help(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        formatter.write("NAME\n    market-cli\n\n")
        formatter.write("PURPOSE\n    为模型提供可发现的市场数据命令。\n\n")
        formatter.write("USAGE\n    market-cli COMMAND [OPTIONS]\n\n")
        formatter.write("COMMANDS\n")
        for command_name in self.list_commands(ctx):
            formatter.write(f"    {command_name}\n")


class DomainGroup(click.Group):
    def __init__(self, domain: str, commands: Sequence[dict[str, Any]]) -> None:
        super().__init__(name=domain)
        self.domain = domain
        self.commands = {command["path"][1]: command for command in commands}

    def list_commands(self, ctx: click.Context) -> list[str]:
        return sorted(self.commands)

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        command = self.commands.get(cmd_name)
        return DataCommand(command) if command is not None else None


class RegistryRootGroup(ModelGroup):
    def _commands_by_domain(self) -> dict[str, list[dict[str, Any]]]:
        commands_by_domain: dict[str, list[dict[str, Any]]] = {}
        for command in load_registry()["commands"]:
            commands_by_domain.setdefault(command["path"][0], []).append(command)
        return commands_by_domain

    def list_commands(self, ctx: click.Context) -> list[str]:
        return sorted(self._commands_by_domain())

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        commands = self._commands_by_domain().get(cmd_name)
        return DomainGroup(cmd_name, commands) if commands is not None else None


def _click_option(parameter: dict[str, Any]) -> click.Option:
    declarations = [parameter["option"], f"data__{parameter['name']}"]
    keyword_arguments: dict[str, Any] = {
        "required": parameter["required"],
    }
    if not parameter["required"]:
        keyword_arguments["default"] = parameter.get("default")
    if parameter.get("repeatable"):
        keyword_arguments["multiple"] = True
    if parameter["type"] != "boolean":
        keyword_arguments["type"] = CLICK_TYPES.get(parameter["type"], click.STRING)
    return click.Option(declarations, **keyword_arguments)


class DataCommand(click.Command):
    def __init__(self, command: dict[str, Any]) -> None:
        self.contract = command
        super().__init__(
            name=command["path"][1],
            callback=self._invoke,
            params=[
                *[_click_option(parameter) for parameter in command["parameters"]],
                click.Option(
                    ["--limit"],
                    type=click.IntRange(min=1),
                    default=None,
                ),
                click.Option(["--output"], type=click.Path(path_type=Path)),
                click.Option(
                    ["--format", "output_format"],
                    type=click.Choice(["json", "jsonl", "csv", "parquet"]),
                ),
                click.Option(["--overwrite"], is_flag=True, default=False),
            ],
        )

    def _invoke(self, **parameters: Any) -> None:
        limit = parameters.pop("limit")
        output = parameters.pop("output")
        output_format = parameters.pop("output_format")
        overwrite = parameters.pop("overwrite")
        data_parameters = {
            name.removeprefix("data__"): value for name, value in parameters.items()
        }
        provider_name = load_registry()["provider"]["name"]
        provider = importlib.import_module(provider_name)
        function = getattr(provider, self.contract["function"])
        result = function(**data_parameters)
        if output is None:
            if output_format is not None:
                raise click.UsageError("--format requires --output")
            click.echo(dumps(result, limit=limit))
            return
        summary = export_result(
            result,
            output=output,
            output_format=output_format,
            overwrite=overwrite,
            limit=limit,
        )
        click.echo(dumps(summary))

    def format_help(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        command = self.contract
        registry = load_registry()
        provider = registry["provider"]
        path = " ".join(("market-cli", *command["path"]))
        formatter.write(f"NAME\n    {path}\n\n")
        formatter.write(
            "PURPOSE\n"
            f"    调用 AKShare 函数 {command['function']}。\n\n"
        )
        formatter.write(f"STABILITY\n    {command['stability']}\n\n")
        formatter.write(
            "UPSTREAM\n"
            f"    Provider: {provider['name']} {provider['version']}\n"
            f"    Function: {command['function']}\n\n"
        )
        formatter.write(f"USAGE\n    {path} [OPTIONS]\n\n")
        formatter.write("OPTIONS\n")
        for parameter in command["parameters"]:
            option = parameter["option"]
            type_label = TYPE_LABELS.get(parameter["type"], "")
            suffix = f" {type_label}" if type_label else ""
            required = " [required]" if parameter["required"] else ""
            formatter.write(f"    {option}{suffix}{required}\n")
        formatter.write("    --limit INTEGER\n")
        formatter.write("    --output PATH\n")
        formatter.write("    --format [json|jsonl|csv|parquet]\n")
        formatter.write("    --overwrite\n")
        formatter.write("\nRETURNS\n    返回上游函数的严格 JSON 序列化结果。\n\n")
        formatter.write(f"EXAMPLES\n    {path}\n\n")
        formatter.write("ERRORS\n    失败时 stderr 返回单个 JSON 错误对象。\n")


@click.group(cls=RegistryRootGroup)
def cli() -> None:
    """Market CLI root command."""


def main() -> None:
    try:
        cli.main(prog_name="market-cli", standalone_mode=False)
    except click.UsageError as error:
        click.echo(
            json.dumps(
                {
                    "code": "INVALID_ARGUMENT",
                    "message": error.format_message(),
                    "retryable": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            err=True,
        )
        raise SystemExit(2) from None
    except SerializationError as error:
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
