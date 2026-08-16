from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any


class SerializationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def to_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise SerializationError(
                "SERIALIZATION_ERROR", "JSON object keys must be strings"
            )
        return {key: to_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json_value(item) for item in value]
    raise SerializationError(
        "UNSUPPORTED_RESULT_TYPE",
        f"result type {type(value).__name__} has no explicit serializer",
    )


def dumps(
    value: Any,
    *,
    limit: int | None = None,
    record_budget: int | None = 200,
) -> str:
    normalized = to_json_value(value)
    if limit is not None:
        if not isinstance(normalized, list):
            raise SerializationError(
                "LIMIT_NOT_APPLICABLE", "--limit requires a record sequence result"
            )
        normalized = normalized[:limit]
    if (
        record_budget is not None
        and isinstance(normalized, list)
        and len(normalized) > record_budget
    ):
        raise SerializationError(
            "RESULT_TOO_LARGE",
            f"result has {len(normalized)} records; use --limit or --output",
        )
    return json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
