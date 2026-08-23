from __future__ import annotations

# Source priority is intentionally data-type specific. Reorder these tuples to
# change the default and fallback order without changing routing code.
SOURCE_ORDER: dict[str, tuple[str, ...]] = {
    "equity_bars": ("sina", "eastmoney", "tencent", "baostock"),
    "index_bars": ("sina", "tencent", "eastmoney", "baostock"),
    "equity_intraday_bars": ("sina", "eastmoney"),
    "index_intraday_bars": ("sina", "eastmoney"),
    "equity_quote": ("sina", "eastmoney", "tencent", "baostock"),
    "index_quote": ("sina", "tencent", "eastmoney", "baostock"),
    "future_bars": ("cffex", "shfe", "ine", "czce"),
    "future_quote": ("cffex", "shfe", "ine", "czce"),
}
