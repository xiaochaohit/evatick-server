from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any

from platformdirs import user_cache_path

from market_cli.serialization import SerializationError


CACHE_MISS = object()


class CacheStore:
    def __init__(self) -> None:
        self.root = user_cache_path("market-cli")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)

    def _hmac_key(self) -> bytes:
        key_path = self.root / "hmac.key"
        try:
            return key_path.read_bytes()
        except FileNotFoundError:
            key = secrets.token_bytes(32)
            descriptor = os.open(
                key_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(key)
            return key

    def key(
        self,
        *,
        provider: dict[str, str],
        function: str,
        parameters: dict[str, Any],
        secret_parameters: dict[str, str],
        limit: int | None,
    ) -> str:
        secret_digests: dict[str, str] = {}
        hmac_key = self._hmac_key() if secret_parameters else b""
        for name, environment_name in secret_parameters.items():
            if environment_name not in os.environ:
                raise SerializationError(
                    "MISSING_SECRET",
                    f"environment variable {environment_name} is not set",
                )
            value = os.environ[environment_name]
            if value == "":
                raise SerializationError(
                    "EMPTY_SECRET",
                    f"environment variable {environment_name} is empty",
                )
            secret_digests[name] = hmac.new(
                hmac_key,
                value.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
        payload = json.dumps(
            {
                "provider": provider,
                "function": function,
                "parameters": parameters,
                "secret_digests": secret_digests,
                "limit": limit,
            },
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def get(self, key: str, ttl: int) -> Any:
        entry_path = self.root / f"{key}.json"
        try:
            entry = json.loads(entry_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return CACHE_MISS
        if time.time() - entry["created"] >= ttl or time.time() >= entry["expires"]:
            entry_path.unlink(missing_ok=True)
            return CACHE_MISS
        return entry["value"]

    def set(self, key: str, value: Any, ttl: int) -> None:
        target = self.root / f"{key}.json"
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.root,
            prefix=f".{key}.",
            suffix=".tmp",
            text=True,
        )
        temporary = Path(temporary_name)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(
                    {
                        "created": time.time(),
                        "expires": time.time() + ttl,
                        "value": value,
                    },
                    stream,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def status(self) -> dict[str, int]:
        paths = list(self.root.glob("*.json"))
        return {
            "entries": len(paths),
            "bytes": sum(path.stat().st_size for path in paths),
        }

    def clear(self, *, expired_only: bool) -> dict[str, int]:
        deleted = 0
        released = 0
        now = time.time()
        for path in self.root.glob("*.json"):
            should_delete = not expired_only
            if expired_only:
                try:
                    entry = json.loads(path.read_text(encoding="utf-8"))
                    should_delete = now >= entry["expires"]
                except (json.JSONDecodeError, KeyError):
                    should_delete = True
            if not should_delete:
                continue
            size = path.stat().st_size
            path.unlink()
            deleted += 1
            released += size
        return {"deleted": deleted, "bytes": released}
