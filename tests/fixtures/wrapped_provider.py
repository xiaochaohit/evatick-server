from functools import lru_cache as _lru_cache

__version__ = "4.0"


class APIError(Exception):
    pass


@_lru_cache
def bond_cached_lookup(symbol: str) -> list[dict[str, str]]:
    return [{"symbol": symbol}]
