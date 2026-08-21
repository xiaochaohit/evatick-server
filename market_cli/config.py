from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigurationError(Exception):
    pass


@dataclass(frozen=True)
class CliConfiguration:
    base_url: str | None = None
    api_key: str | None = None


def default_configuration_path() -> Path:
    override = os.environ.get("MARKET_CLI_CONFIG")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        root = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "market-cli" / "config.json"


def load_configuration(path: Path) -> CliConfiguration:
    if not path.exists():
        return CliConfiguration()
    if os.name != "nt" and path.stat().st_mode & 0o077:
        raise ConfigurationError(
            f"configuration file must be owner-only (use chmod 600): {path}"
        )
    try:
        value: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigurationError(f"cannot read configuration file: {path}") from error
    if not isinstance(value, dict) or value.get("schema") != "market.cli-config.v1":
        raise ConfigurationError("configuration schema must be market.cli-config.v1")
    unknown = set(value) - {"schema", "base_url", "api_key"}
    if unknown:
        raise ConfigurationError(f"configuration contains unknown field: {sorted(unknown)[0]}")
    base_url = value.get("base_url")
    api_key = value.get("api_key")
    if base_url is not None and (
        not isinstance(base_url, str)
        or not base_url.startswith(("http://", "https://"))
    ):
        raise ConfigurationError("configuration.base_url must be an HTTP(S) URL")
    if api_key is not None and (not isinstance(api_key, str) or not api_key.strip()):
        raise ConfigurationError("configuration.api_key must be a non-empty string")
    return CliConfiguration(base_url=base_url, api_key=api_key)


def save_configuration(path: Path, configuration: CliConfiguration) -> None:
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    value = {
        "schema": "market.cli-config.v1",
        **({"base_url": configuration.base_url} if configuration.base_url else {}),
        **({"api_key": configuration.api_key} if configuration.api_key else {}),
    }
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
