from __future__ import annotations

__version__ = "1.0"


def index_stock_cons(symbol: str) -> list[dict[str, str]]:
    """查询指数成分。"""
    return [{"symbol": symbol}]


def set_token(token: str) -> None:
    """Mutate provider credential state."""


def stock_zh_a_hist(
    symbol: str,
    start_date: str = "20200101",
) -> list[dict[str, str]]:
    """查询 A 股历史行情。"""
    return [{"symbol": symbol, "date": start_date}]
