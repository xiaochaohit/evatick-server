from __future__ import annotations

import csv
import io
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

from market_cli.serialization import SerializationError, to_json_value


def _apply_limit(value: Any, limit: int | None) -> Any:
    normalized = to_json_value(value)
    if limit is None:
        return normalized
    if not isinstance(normalized, list):
        raise SerializationError(
            "LIMIT_NOT_APPLICABLE",
            "--limit requires a record sequence result",
        )
    return normalized[:limit]


def _validate_target(target: Path, overwrite: bool) -> None:
    if not target.parent.is_dir():
        raise SerializationError(
            "OUTPUT_PARENT_MISSING",
            "output parent directory does not exist",
        )
    if not target.exists() and not target.is_symlink():
        return
    mode = target.lstat().st_mode
    if not stat.S_ISREG(mode):
        raise SerializationError(
            "OUTPUT_PATH_INVALID",
            "output path must be a regular file",
        )
    if not overwrite:
        raise SerializationError("OUTPUT_EXISTS", "output path already exists")


def _atomic_write(target: Path, content: str, overwrite: bool) -> None:
    _validate_target(target, overwrite)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=target.parent,
        prefix=f".{target.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if overwrite:
            os.replace(temporary, target)
        else:
            try:
                os.link(temporary, target)
            except FileExistsError as error:
                raise SerializationError(
                    "OUTPUT_EXISTS", "output path already exists"
                ) from error
            temporary.unlink()
    finally:
        temporary.unlink(missing_ok=True)


def export_result(
    value: Any,
    *,
    output: Path,
    output_format: str | None,
    overwrite: bool,
    limit: int | None,
) -> dict[str, Any]:
    target = output.absolute()
    inferred_format = target.suffix.removeprefix(".").lower()
    known_formats = {"csv", "json", "jsonl", "parquet"}
    if (
        output_format is not None
        and inferred_format in known_formats
        and inferred_format != output_format
    ):
        raise SerializationError(
            "OUTPUT_FORMAT_MISMATCH",
            "explicit output format conflicts with the file extension",
        )
    selected_format = output_format or inferred_format
    if selected_format not in {"csv", "json", "jsonl"}:
        raise SerializationError(
            "UNSUPPORTED_OUTPUT_FORMAT",
            "output format is not supported",
        )
    normalized = _apply_limit(value, limit)
    if selected_format == "csv":
        if not isinstance(normalized, list) or not all(
            isinstance(record, dict) for record in normalized
        ):
            raise SerializationError(
                "INCOMPATIBLE_OUTPUT_FORMAT",
                "csv requires a sequence of record objects",
            )
        if not normalized:
            content = ""
        else:
            field_names = list(normalized[0])
            expected_fields = set(field_names)
            for record in normalized:
                if set(record) != expected_fields or any(
                    isinstance(item, (dict, list)) for item in record.values()
                ):
                    raise SerializationError(
                        "INCOMPATIBLE_OUTPUT_FORMAT",
                        "csv requires consistent flat record fields",
                    )
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(
                stream,
                fieldnames=field_names,
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(normalized)
            content = stream.getvalue()
    elif selected_format == "jsonl":
        if not isinstance(normalized, list) or not all(
            isinstance(record, dict) for record in normalized
        ):
            raise SerializationError(
                "INCOMPATIBLE_OUTPUT_FORMAT",
                "jsonl requires a sequence of record objects",
            )
        lines = [
            json.dumps(
                record,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            for record in normalized
        ]
        content = "\n".join(lines) + ("\n" if lines else "")
    else:
        content = (
            json.dumps(
                normalized,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    _atomic_write(target, content, overwrite)
    records = len(normalized) if isinstance(normalized, list) else 1
    return {"path": str(target), "records": records}
