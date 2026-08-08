from __future__ import annotations

import json
from functools import lru_cache
from importlib.resources import files
from typing import Any


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    registry_path = files("market_cli.data").joinpath("registry.json")
    return json.loads(registry_path.read_text(encoding="utf-8"))
