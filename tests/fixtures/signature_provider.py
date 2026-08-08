from __future__ import annotations

__version__ = "2.0"


def stock_secure_snapshot(
    symbol: str,
    api_key: str,
    timeout: int = 5,
    adjusted: bool = True,
    tags: list[str] | None = None,
) -> list[dict[str, str]]:
    """查询需要凭据的行情快照。"""
    return [{"symbol": symbol}]
