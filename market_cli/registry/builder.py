from __future__ import annotations

import importlib
import inspect
import json
import os
import types
import typing
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from typing import Any

SCHEMA_VERSION = 1
EXCLUDED_FUNCTIONS = {
    "get_token": "credential state management",
    "pro_api": "returns a provider client instead of data",
    "set_token": "credential state management",
}
DOMAIN_ALIASES = {
    "currency": "fx",
    "forex": "fx",
}
MODULE_DOMAINS = {
    "bond": "bond",
    "cal": "stock",
    "currency": "fx",
    "economic": "macro",
    "forex": "fx",
    "fund": "fund",
    "futures": "futures",
    "futures_derivative": "futures",
    "fx": "fx",
    "hf": "futures",
    "index": "index",
    "interest_rate": "bond",
    "option": "option",
    "qdii": "fund",
    "qhkc_web": "futures",
    "rate": "bond",
    "reits": "fund",
    "stock": "stock",
    "stock_feature": "stock",
    "stock_fundamental": "stock",
    "tool": "stock",
}
FRAMEWORK_OPTIONS = {
    "cache_ttl",
    "debug_output",
    "format",
    "limit",
    "output",
    "overwrite",
    "refresh",
    "retries",
    "timeout",
}
SENSITIVE_PARAMETER_PARTS = {"api_key", "cookie", "password", "secret", "token"}
TYPE_NAMES = {
    bool: "boolean",
    date: "date",
    datetime: "datetime",
    Decimal: "decimal",
    float: "number",
    int: "integer",
    str: "string",
}
STABLE_COMMANDS = {
    ("calendar", "trading-days"): "tool_trade_date_hist_sina",
    ("index", "bars"): "stock_zh_index_daily_em",
    ("index", "constituents"): "index_stock_cons",
    ("index", "instruments"): "index_stock_info",
    ("index", "quotes"): "stock_zh_index_spot_em",
    ("stock", "bars"): "stock_zh_a_daily",
    ("stock", "corporate-actions"): "stock_dividend_cninfo",
    ("stock", "financials"): "stock_financial_abstract",
    ("stock", "instruments"): "stock_info_a_code_name",
    ("stock", "profiles"): "stock_profile_cninfo",
    ("stock", "quotes"): "stock_zh_a_spot_em",
}


class RegistryBuildError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _provider_identity(provider: ModuleType) -> dict[str, str]:
    return {
        "name": provider.__name__.rsplit(".", 1)[-1],
        "version": str(provider.__version__),
    }


def _command_path(function_name: str, function_module: str) -> list[str]:
    prefix, separator, remainder = function_name.partition("_")
    prefix_domain = DOMAIN_ALIASES.get(prefix, prefix)
    module_parts = function_module.split(".")
    if len(module_parts) > 1 and module_parts[0] == "akshare":
        domain = MODULE_DOMAINS.get(module_parts[1], "alternative")
    else:
        domain = prefix_domain
    command_name = remainder if separator and prefix_domain == domain else function_name
    return [domain, command_name.replace("_", "-").lower()]


def _is_sensitive(name: str) -> bool:
    return any(
        name == part or name.endswith(f"_{part}") or name.startswith(f"{part}_")
        for part in SENSITIVE_PARAMETER_PARTS
    )


def _unwrap_nullable(annotation: Any) -> tuple[Any, bool]:
    origin = typing.get_origin(annotation)
    if origin not in (typing.Union, types.UnionType):
        return annotation, False
    arguments = typing.get_args(annotation)
    non_none = tuple(argument for argument in arguments if argument is not type(None))
    if len(non_none) == 1 and len(non_none) != len(arguments):
        return non_none[0], True
    return annotation, False


def _parameter_type(annotation: Any, default: Any) -> tuple[str, bool, bool]:
    if annotation is inspect.Parameter.empty:
        annotation = type(default) if default is not inspect.Parameter.empty else str
    annotation, nullable = _unwrap_nullable(annotation)
    origin = typing.get_origin(annotation)
    repeatable = origin is list
    if repeatable:
        arguments = typing.get_args(annotation)
        annotation = arguments[0] if arguments else str
    return TYPE_NAMES.get(annotation, "json"), nullable, repeatable


def _parameter_contracts(function: Any) -> list[dict[str, Any]]:
    signature = inspect.signature(function)
    hints = typing.get_type_hints(function)
    contracts: list[dict[str, Any]] = []
    for parameter in signature.parameters.values():
        if parameter.kind in (
            inspect.Parameter.VAR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        ):
            raise TypeError(f"variadic parameter is not supported: {parameter.name}")
        annotation = hints.get(parameter.name, parameter.annotation)
        type_name, nullable, repeatable = _parameter_type(annotation, parameter.default)
        required = parameter.default is inspect.Parameter.empty
        sensitive = _is_sensitive(parameter.name)
        option_name = parameter.name.replace("_", "-")
        if sensitive:
            option = f"--{option_name}-env"
        elif parameter.name in FRAMEWORK_OPTIONS:
            option = f"--arg-{option_name}"
        elif type_name == "boolean":
            option = f"--{option_name}/--no-{option_name}"
        else:
            option = f"--{option_name}"
        contract: dict[str, Any] = {
            "name": parameter.name,
            "option": option,
            "required": required,
            "type": type_name,
        }
        if not required:
            contract["default"] = parameter.default
        if nullable:
            contract["nullable"] = True
        if repeatable:
            contract["repeatable"] = True
        if sensitive:
            contract["sensitive"] = True
        contracts.append(contract)
    return contracts


def _discover(provider: ModuleType) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    commands: list[dict[str, Any]] = []
    exclusions: list[dict[str, str]] = []
    seen_functions: set[int] = set()

    for name, value in inspect.getmembers(provider):
        if name.startswith("_") or not callable(value) or inspect.isclass(value):
            continue
        if name in EXCLUDED_FUNCTIONS:
            exclusions.append({"name": name, "reason": EXCLUDED_FUNCTIONS[name]})
            continue
        identity = id(value)
        if identity in seen_functions:
            continue
        seen_functions.add(identity)
        commands.append(
            {
                "function": name,
                "module": value.__module__,
                "parameters": _parameter_contracts(value),
                "path": _command_path(name, value.__module__),
                "stability": "upstream",
            }
        )

    if provider.__name__.rsplit(".", 1)[-1] == "akshare":
        for path, function_name in STABLE_COMMANDS.items():
            function = getattr(provider, function_name)
            parameter_function = function
            if path == ("stock", "bars"):
                parameter_function = provider.stock_zh_a_hist
            command = {
                "function": function_name,
                "module": function.__module__,
                "parameters": _parameter_contracts(parameter_function),
                "path": list(path),
                "stability": "stable",
            }
            if path == ("stock", "bars"):
                command["adapter"] = "stock_bars"
                command["fallback_function"] = "stock_zh_a_hist"
                command["sources"] = ["sina", "eastmoney"]
            commands.append(command)

    commands.sort(key=lambda command: tuple(command["path"]))
    commands_by_path: dict[tuple[str, ...], str] = {}
    for command in commands:
        path = tuple(command["path"])
        previous = commands_by_path.get(path)
        if previous is not None:
            rendered_path = " ".join(("market-cli", *path))
            raise RegistryBuildError(
                "COMMAND_PATH_COLLISION",
                f"{rendered_path} maps to both {previous} and {command['function']}",
            )
        commands_by_path[path] = command["function"]
    exclusions.sort(key=lambda exclusion: exclusion["name"])
    return commands, exclusions


def build_registry(provider_module: str, output: Path) -> dict[str, Any]:
    provider = importlib.import_module(provider_module)
    commands, exclusions = _discover(provider)
    registry = {
        "schema_version": SCHEMA_VERSION,
        "provider": _provider_identity(provider),
        "commands": commands,
        "exclusions": exclusions,
    }

    output = output.resolve()
    output.parent.mkdir(parents=False, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(
        json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, output)
    return {
        "commands": len(commands),
        "excluded": len(exclusions),
        "output": str(output),
    }
