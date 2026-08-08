from __future__ import annotations

import base64
import json
import math
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


class SerializationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _column_names(columns: list[Any]) -> list[str]:
    names = [str(column) for column in columns]
    if len(names) != len(set(names)):
        raise SerializationError(
            "DUPLICATE_COLUMNS",
            "DataFrame column names are not unique after JSON normalization",
        )
    return names


def _is_default_range_index(index: pd.Index) -> bool:
    return (
        isinstance(index, pd.RangeIndex)
        and index.start == 0
        and index.stop == len(index)
        and index.step == 1
    )


def _index_field_names(index: pd.Index) -> list[str]:
    if isinstance(index, pd.MultiIndex):
        return [
            str(name) if name is not None else f"_index_{position}"
            for position, name in enumerate(index.names)
        ]
    return [str(index.name) if index.name is not None else "_index"]


def _dataframe_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    column_names = _column_names(list(frame.columns))
    include_index = not _is_default_range_index(frame.index)
    index_names = _index_field_names(frame.index) if include_index else []
    all_names = [*index_names, *column_names]
    if len(all_names) != len(set(all_names)):
        raise SerializationError(
            "SERIALIZATION_ERROR",
            "DataFrame index fields conflict with data columns",
        )

    records: list[dict[str, Any]] = []
    for position, values in enumerate(frame.itertuples(index=False, name=None)):
        record: dict[str, Any] = {}
        if include_index:
            index_value = frame.index[position]
            index_values = (
                tuple(index_value)
                if isinstance(frame.index, pd.MultiIndex)
                else (index_value,)
            )
            record.update(
                {
                    name: to_json_value(value)
                    for name, value in zip(index_names, index_values, strict=True)
                }
            )
        record.update(
            {
                name: to_json_value(value)
                for name, value in zip(column_names, values, strict=True)
            }
        )
        records.append(record)
    return records


def to_json_value(value: Any) -> Any:
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, pd.DataFrame):
        return _dataframe_records(value)
    if isinstance(value, pd.Series):
        column_name = str(value.name) if value.name is not None else "_value"
        return _dataframe_records(value.to_frame(name=column_name))
    if isinstance(value, np.ndarray):
        return to_json_value(value.tolist())
    if isinstance(value, np.generic):
        return to_json_value(value.item())
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise SerializationError(
                "SERIALIZATION_ERROR",
                "JSON object keys must be strings",
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
                "LIMIT_NOT_APPLICABLE",
                "--limit requires a record sequence result",
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
