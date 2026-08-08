from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import json
import platform
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Sequence
from importlib.resources import files
from pathlib import Path
from typing import Any

import click
from click.core import ParameterSource

from market_cli import __version__
from market_cli.cache import CACHE_MISS, CacheStore
from market_cli.output import export_result
from market_cli.registry.runtime import load_registry
from market_cli.serialization import SerializationError, dumps
from market_cli.supervisor import InvocationError, invoke

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
        return sorted({*self._commands_by_domain(), *super().list_commands(ctx)})

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        built_in = super().get_command(ctx, cmd_name)
        if built_in is not None:
            return built_in
        commands = self._commands_by_domain().get(cmd_name)
        return DomainGroup(cmd_name, commands) if commands is not None else None


def _click_option(parameter: dict[str, Any]) -> click.Option:
    declarations = [parameter["option"], f"data__{parameter['name']}"]
    keyword_arguments: dict[str, Any] = {
        "required": False,
    }
    if not parameter["required"]:
        keyword_arguments["default"] = parameter.get("default")
    if parameter.get("repeatable"):
        keyword_arguments["multiple"] = True
    if parameter["type"] != "boolean":
        keyword_arguments["type"] = CLICK_TYPES.get(parameter["type"], click.STRING)
    return click.Option(declarations, **keyword_arguments)


def _json_type_matches(value: Any, parameter: dict[str, Any]) -> bool:
    if value is None:
        return parameter.get("nullable", parameter.get("default") is None)
    if parameter.get("repeatable"):
        return isinstance(value, list)
    type_name = parameter["type"]
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name in {"date", "datetime", "decimal", "string"}:
        return isinstance(value, str)
    return isinstance(value, (dict, list))


def _parse_args_json(
    raw_value: str,
    contract: list[dict[str, Any]],
    context: click.Context,
) -> dict[str, Any]:
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as error:
        raise click.UsageError("--args-json must contain valid JSON") from error
    if not isinstance(parsed, dict):
        raise click.UsageError("--args-json must contain a JSON object")

    parameters_by_name = {parameter["name"]: parameter for parameter in contract}
    unknown = sorted(set(parsed) - set(parameters_by_name))
    if unknown:
        raise click.UsageError(
            f"--args-json contains unknown parameter: {unknown[0]}"
        )
    for parameter in contract:
        source = context.get_parameter_source(f"data__{parameter['name']}")
        if (
            not parameter.get("sensitive")
            and source is ParameterSource.COMMANDLINE
        ):
            raise click.UsageError(
                "--args-json cannot be mixed with individual data options"
            )
        if parameter.get("sensitive") and parameter["name"] in parsed:
            raise click.UsageError(
                f"sensitive parameter {parameter['name']} is forbidden in --args-json"
            )
        if (
            parameter["required"]
            and not parameter.get("sensitive")
            and parameter["name"] not in parsed
        ):
            raise click.UsageError(
                f"--args-json is missing required parameter: {parameter['name']}"
            )
    for name, value in parsed.items():
        if not _json_type_matches(value, parameters_by_name[name]):
            raise click.UsageError(f"--args-json has invalid type for parameter: {name}")
    return parsed


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
                click.Option(["--debug-output"], type=click.Path(path_type=Path)),
                click.Option(
                    ["--timeout"],
                    type=click.FloatRange(min=0.1),
                    default=120.0,
                ),
                click.Option(
                    ["--retries"],
                    type=click.IntRange(min=0),
                    default=2,
                ),
                click.Option(["--args-json"]),
                click.Option(
                    ["--cache-ttl"],
                    type=click.IntRange(min=1),
                ),
                click.Option(["--refresh"], is_flag=True, default=False),
            ],
        )

    def _invoke(self, **parameters: Any) -> None:
        limit = parameters.pop("limit")
        output = parameters.pop("output")
        output_format = parameters.pop("output_format")
        overwrite = parameters.pop("overwrite")
        debug_output = parameters.pop("debug_output")
        timeout = parameters.pop("timeout")
        retries = parameters.pop("retries")
        args_json = parameters.pop("args_json")
        cache_ttl = parameters.pop("cache_ttl")
        refresh = parameters.pop("refresh")
        if refresh and cache_ttl is None:
            raise click.UsageError("--refresh requires --cache-ttl")
        option_parameters = {
            name.removeprefix("data__"): value for name, value in parameters.items()
        }
        context = click.get_current_context()
        if args_json is None:
            for parameter in self.contract["parameters"]:
                if not parameter["required"]:
                    continue
                source = context.get_parameter_source(f"data__{parameter['name']}")
                if source is not ParameterSource.COMMANDLINE:
                    raise click.UsageError(f"Missing option '{parameter['option']}'.")
        data_parameters = (
            _parse_args_json(args_json, self.contract["parameters"], context)
            if args_json is not None
            else option_parameters
        )
        secret_parameters: dict[str, str] = {}
        for parameter in self.contract["parameters"]:
            if not parameter.get("sensitive"):
                continue
            environment_name = option_parameters[parameter["name"]]
            data_parameters.pop(parameter["name"], None)
            if environment_name is None:
                continue
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", environment_name) is None:
                raise click.UsageError(
                    f"{parameter['option']} requires an environment variable name"
                )
            secret_parameters[parameter["name"]] = environment_name
        provider_name = load_registry()["provider"]["name"]
        provider_contract = load_registry()["provider"]
        cache_store = CacheStore() if cache_ttl is not None else None
        cache_key = (
            cache_store.key(
                provider=provider_contract,
                function=self.contract["function"],
                parameters=data_parameters,
                secret_parameters=secret_parameters,
                limit=limit,
            )
            if cache_store is not None
            else None
        )
        result = (
            CACHE_MISS
            if cache_store is None or refresh
            else cache_store.get(cache_key, cache_ttl)
        )
        if result is CACHE_MISS:
            result = invoke(
                provider=provider_name,
                function=self.contract["function"],
                adapter=self.contract.get("adapter"),
                parameters=data_parameters,
                secret_parameters=secret_parameters,
                timeout=timeout,
                retries=retries,
                debug_output=debug_output,
                overwrite=overwrite,
            )
            if cache_store is not None:
                cache_store.set(cache_key, result, cache_ttl)
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
        if command.get("fallback_function"):
            formatter.write(
                "FALLBACK\n"
                f"    Function: {command['fallback_function']}\n"
                f"    Sources: {', '.join(command['sources'])}\n\n"
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
        formatter.write("    --debug-output PATH\n")
        formatter.write("    --timeout NUMBER\n")
        formatter.write("    --retries INTEGER\n")
        formatter.write("    --args-json JSON\n")
        formatter.write("    --cache-ttl INTEGER\n")
        formatter.write("    --refresh\n")
        formatter.write("\nRETURNS\n    返回上游函数的严格 JSON 序列化结果。\n\n")
        formatter.write(f"EXAMPLES\n    {path}\n\n")
        formatter.write("ERRORS\n    失败时 stderr 返回单个 JSON 错误对象。\n")


@click.group(cls=RegistryRootGroup)
def cli() -> None:
    """Market CLI root command."""


@cli.command("catalog")
def catalog_command() -> None:
    """Summarize command domains."""
    counts_by_domain: dict[str, Counter[str]] = {}
    for command in load_registry()["commands"]:
        domain = command["path"][0]
        counts_by_domain.setdefault(domain, Counter())[command["stability"]] += 1
    catalog = [
        {
            "domain": domain,
            "commands": sum(counts.values()),
            "stable": counts["stable"],
            "upstream": counts["upstream"],
        }
        for domain, counts in sorted(counts_by_domain.items())
    ]
    click.echo(dumps(catalog))


def _search_score(command: dict[str, Any], query: str) -> int | None:
    command_name = command["path"][1].lower()
    full_path = " ".join(("market-cli", *command["path"])).lower()
    function_name = command["function"].lower()
    query = query.lower()
    if query in {command_name, full_path}:
        return 0
    if command_name.startswith(query) or full_path.startswith(query):
        return 1
    tokens = set(re.split(r"[-_\s]+", f"{full_path} {function_name}"))
    if query in tokens:
        return 2
    if query in full_path or query in function_name:
        return 3
    return None


@cli.command("search")
@click.option("--query")
@click.option("--domain")
@click.option("--stability", type=click.Choice(["stable", "upstream"]))
@click.option("--limit", type=click.IntRange(min=1, max=200), default=20)
def search_command(
    query: str | None,
    domain: str | None,
    stability: str | None,
    limit: int,
) -> None:
    """Search command paths and provider functions."""
    if query is None and domain is None:
        raise click.UsageError("search requires --query or --domain")
    registry = load_registry()
    ranked: list[tuple[int, tuple[str, ...], dict[str, Any]]] = []
    for command in registry["commands"]:
        if domain is not None and command["path"][0] != domain:
            continue
        if stability is not None and command["stability"] != stability:
            continue
        score = 0 if query is None else _search_score(command, query)
        if score is None:
            continue
        ranked.append((score, tuple(command["path"]), command))
    ranked.sort(key=lambda item: (item[0], item[1]))
    provider = registry["provider"]["name"]
    matches = [
        {
            "path": " ".join(("market-cli", *command["path"])),
            "purpose": f"调用 AKShare 函数 {command['function']}。",
            "stability": command["stability"],
            "provider": provider,
            "function": command["function"],
        }
        for _, _, command in ranked[:limit]
    ]
    click.echo(dumps(matches))


@cli.command("version")
def version_command() -> None:
    """Report runtime and registry versions."""
    registry = load_registry()
    registry_bytes = files("market_cli.data").joinpath("registry.json").read_bytes()
    click.echo(
        dumps(
            {
                "market_cli": __version__,
                "python": platform.python_version(),
                "providers": {
                    registry["provider"]["name"]: registry["provider"]["version"]
                },
                "registry_sha256": hashlib.sha256(registry_bytes).hexdigest(),
            }
        )
    )


@cli.command("doctor")
def doctor_command() -> None:
    """Run offline installation checks."""
    registry = load_registry()
    provider = registry["provider"]
    checks: list[dict[str, str]] = [
        {
            "name": "registry",
            "status": "ok",
            "message": "static registry is readable",
        }
    ]
    try:
        installed_version = importlib.metadata.version(provider["name"])
    except importlib.metadata.PackageNotFoundError:
        installed_version = None
    version_matches = installed_version == provider["version"]
    checks.append(
        {
            "name": "provider_version",
            "status": "ok" if version_matches else "error",
            "message": (
                "installed provider matches the registry"
                if version_matches
                else "installed provider does not match the registry"
            ),
        }
    )
    provider_import = subprocess.run(
        [sys.executable, "-c", f"import {provider['name']}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    checks.append(
        {
            "name": "provider_import",
            "status": "ok" if provider_import.returncode == 0 else "error",
            "message": (
                "provider can be imported"
                if provider_import.returncode == 0
                else "provider import failed"
            ),
        }
    )
    worker_check = subprocess.run(
        [sys.executable, "-c", "from market_cli.worker import execute"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    checks.append(
        {
            "name": "worker",
            "status": "ok" if worker_check.returncode == 0 else "error",
            "message": (
                "worker process can start"
                if worker_check.returncode == 0
                else "worker process failed to start"
            ),
        }
    )
    parquet_available = importlib.util.find_spec("pyarrow") is not None
    checks.append(
        {
            "name": "parquet",
            "status": "ok" if parquet_available else "warning",
            "message": (
                "optional parquet support is available"
                if parquet_available
                else "optional parquet support is not installed"
            ),
        }
    )
    statuses = {check["status"] for check in checks}
    overall = "error" if "error" in statuses else "warning" if "warning" in statuses else "ok"
    click.echo(dumps({"status": overall, "checks": checks}))
    if overall == "error":
        raise SystemExit(1)


@cli.group("cache")
def cache_group() -> None:
    """Inspect and clear explicit result cache entries."""


@cache_group.command("status")
def cache_status_command() -> None:
    click.echo(dumps(CacheStore().status()))


@cache_group.command("clear")
@click.option("--expired", is_flag=True)
@click.option("--all", "all_entries", is_flag=True)
def cache_clear_command(expired: bool, all_entries: bool) -> None:
    if expired == all_entries:
        raise click.UsageError("cache clear requires exactly one of --expired or --all")
    click.echo(dumps(CacheStore().clear(expired_only=expired)))


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
    except InvocationError as error:
        click.echo(
            json.dumps(
                {
                    "code": error.code,
                    "message": error.message,
                    "retryable": error.retryable,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            err=True,
        )
        raise SystemExit(1) from None
