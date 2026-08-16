from __future__ import annotations

# Source priority is intentionally data-type specific. Reorder these tuples to
# change the default and fallback order without changing routing code.
SOURCE_ORDER: dict[str, tuple[str, ...]] = {
    "equity_bars": ("sina", "eastmoney"),
    "index_bars": ("sina", "tencent", "eastmoney"),
    "equity_quote": ("sina", "eastmoney"),
    "index_quote": ("sina", "tencent", "eastmoney"),
}
