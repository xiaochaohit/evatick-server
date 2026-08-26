from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import requests

from .sources import SOURCE_ORDER


def _records(value: Any) -> list[dict[str, Any]]:
    if hasattr(value, "to_dict"):
        value = value.to_dict(orient="records")
    normalized = _json_value(value)
    if not isinstance(normalized, list) or not all(
        isinstance(record, dict) for record in normalized
    ):
        raise TypeError("AKShare result must be a record sequence")
    return normalized


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if hasattr(value, "item"):
        return _json_value(value.item())
    raise TypeError(f"unsupported AKShare value: {type(value).__name__}")


def _compact_date(value: str | None, fallback: str) -> str:
    return (value or fallback).replace("-", "")[:8]


def _sina_date(value: str | None, fallback: str) -> str:
    compact = _compact_date(value, fallback)
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:]}"


class SourcesExhausted(Exception):
    def __init__(self, errors: list[Exception]):
        super().__init__("all configured data sources failed")
        self.errors = errors


class UpstreamConnectionError(Exception):
    pass


def _baostock_symbol(provider_symbol: str) -> str:
    normalized = (
        _index_symbol(provider_symbol)
        if provider_symbol.startswith("csi")
        else provider_symbol
    )
    for prefix in ("sh", "sz", "bj"):
        if normalized.startswith(prefix):
            return f"{prefix}.{normalized.removeprefix(prefix)}"
    raise ValueError(f"unsupported BaoStock symbol: {provider_symbol}")


def _baostock_bars(
    request: dict[str, Any], provider_symbol: str
) -> list[dict[str, Any]]:
    import baostock

    login = baostock.login()
    if login.error_code != "0":
        raise UpstreamConnectionError(
            f"BaoStock login failed: {login.error_msg}"
        )
    try:
        result = baostock.query_history_k_data_plus(
            _baostock_symbol(provider_symbol),
            "date,open,high,low,close,volume,amount",
            start_date=(request.get("start") or "1990-01-01")[:10],
            end_date=(request.get("end") or "2050-01-01")[:10],
            frequency="d",
            adjustflag={"none": "3", "forward": "2", "backward": "1"}[
                request.get("adjustment", "none")
            ],
        )
        if result.error_code != "0":
            raise UpstreamConnectionError(
                f"BaoStock query failed: {result.error_msg}"
            )
        records: list[dict[str, Any]] = []
        while result.next():
            records.append(dict(zip(result.fields, result.get_row_data())))
        return records
    finally:
        baostock.logout()


def _equity_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    provider_symbol = request["providerSymbol"]
    symbol = provider_symbol.removeprefix("sh").removeprefix("sz").removeprefix("bj")
    adjustment = {"none": "", "forward": "qfq", "backward": "hfq"}[
        request.get("adjustment", "none")
    ]
    if source == "sina":
        return _records(akshare.stock_zh_a_daily(
            symbol=provider_symbol,
            start_date=_sina_date(request.get("start"), "19700101"),
            end_date=_sina_date(request.get("end"), "20500101"),
            adjust=adjustment,
        ))
    if source == "eastmoney":
        return _records(akshare.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=_compact_date(request.get("start"), "19700101"),
            end_date=_compact_date(request.get("end"), "20500101"),
            adjust=adjustment,
            timeout=None,
        ))
    if source == "tencent":
        records = _records(akshare.stock_zh_a_hist_tx(
            symbol=provider_symbol,
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
            adjust=adjustment,
            timeout=None,
        ))
        return [
            {**record, "volume": record.get("amount"), "amount": None}
            for record in records
        ]
    if source == "baostock":
        return _baostock_bars(request, provider_symbol)
    raise ValueError(f"unsupported equity bars source: {source}")


def _index_symbol(provider_symbol: str) -> str:
    symbol = provider_symbol.removeprefix("csi").removeprefix("sh").removeprefix("sz")
    if provider_symbol.startswith("sz") or symbol.startswith("399"):
        return f"sz{symbol}"
    return f"sh{symbol}"


def _filter_dates(
    records: list[dict[str, Any]], request: dict[str, Any]
) -> list[dict[str, Any]]:
    start = request.get("start")
    end = request.get("end")
    if not start and not end:
        return records
    filtered = []
    for record in records:
        value = record.get("date", record.get("日期"))
        if value is None:
            continue
        current = str(value)[:10]
        if start and current < start[:10]:
            continue
        if end and current > end[:10]:
            continue
        filtered.append(record)
    return filtered


def _date_time_bound(value: str | None, fallback: str, end: bool = False) -> str:
    if not value:
        return fallback
    normalized = value.replace("T", " ")
    if len(normalized) == 10:
        return f"{normalized} {'23:59:59' if end else '00:00:00'}"
    return normalized[:19]


def _filter_times(
    records: list[dict[str, Any]], request: dict[str, Any]
) -> list[dict[str, Any]]:
    start = _date_time_bound(request.get("start"), "1970-01-01 00:00:00")
    end = _date_time_bound(request.get("end"), "2050-01-01 23:59:59", end=True)
    return [
        record
        for record in records
        if start
        <= str(record.get("day", record.get("时间", record.get("datetime", ""))))[:19]
        <= end
    ]


def _intraday_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    instrument_type = request["instrumentType"]
    provider_symbol = request["providerSymbol"]
    symbol = (
        _index_symbol(provider_symbol)
        if instrument_type == "index"
        else provider_symbol
    )
    numeric_symbol = symbol.removeprefix("sh").removeprefix("sz").removeprefix("bj")
    period = request["interval"].removesuffix("m")
    adjustment = {"none": "", "forward": "qfq", "backward": "hfq"}[
        request.get("adjustment", "none")
    ]
    if source == "sina":
        return _filter_times(
            _records(akshare.stock_zh_a_minute(
                symbol=symbol,
                period=period,
                adjust=adjustment,
            )),
            request,
        )
    if source == "eastmoney" and instrument_type == "equity":
        return _records(akshare.stock_zh_a_hist_min_em(
            symbol=numeric_symbol,
            start_date=_date_time_bound(
                request.get("start"), "1979-09-01 09:32:00"
            ),
            end_date=_date_time_bound(
                request.get("end"), "2222-01-01 15:00:00", end=True
            ),
            period=period,
            adjust=adjustment,
        ))
    if source == "eastmoney" and instrument_type == "index":
        return _records(akshare.index_zh_a_hist_min_em(
            symbol=numeric_symbol,
            period=period,
            start_date=_date_time_bound(
                request.get("start"), "1979-09-01 09:32:00"
            ),
            end_date=_date_time_bound(
                request.get("end"), "2222-01-01 15:00:00", end=True
            ),
        ))
    raise ValueError(f"unsupported intraday source: {source}")


def _index_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    if source == "sina":
        return _filter_dates(
            _records(akshare.stock_zh_index_daily(
                symbol=_index_symbol(request["providerSymbol"]),
            )),
            request,
        )
    if source == "tencent":
        return _records(akshare.stock_zh_index_daily_tx(
            symbol=_index_symbol(request["providerSymbol"]),
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    if source == "eastmoney":
        return _records(akshare.stock_zh_index_daily_em(
            symbol=request["providerSymbol"],
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    if source == "baostock":
        return _baostock_bars(request, request["providerSymbol"])
    raise ValueError(f"unsupported index bars source: {source}")


FUTURES_MARKETS = {
    "中金所": "CFFEX",
    "上期所": "SHFE",
    "上期能源": "INE",
    "郑商所": "CZCE",
    "大商所": "DCE",
    "广期所": "GFEX",
}

FOREIGN_COMMODITY_SERIES = (
    {
        "symbol": "XAU", "provider_symbol": "FOREIGN:XAU", "venue": "OTC",
        "name": "伦敦金 XAU 日线参考序列", "currency": "USD",
        "aliases": ["伦敦金", "现货黄金", "XAU/USD", "XAUUSD"],
    },
    {
        "symbol": "XAG", "provider_symbol": "FOREIGN:XAG", "venue": "OTC",
        "name": "伦敦银 XAG 日线参考序列", "currency": "USD",
        "aliases": ["伦敦银", "现货白银", "XAG/USD", "XAGUSD"],
    },
    {
        "symbol": "GC", "provider_symbol": "FOREIGN:GC", "venue": "COMEX",
        "name": "COMEX 黄金 GC 连续日线", "currency": "USD",
        "aliases": ["COMEX黄金", "纽约黄金"],
    },
    {
        "symbol": "SI", "provider_symbol": "FOREIGN:SI", "venue": "COMEX",
        "name": "COMEX 白银 SI 连续日线", "currency": "USD",
        "aliases": ["COMEX白银", "纽约白银"],
    },
    {
        "symbol": "CL", "provider_symbol": "FOREIGN:CL", "venue": "NYMEX",
        "name": "NYMEX WTI 原油 CL 连续日线", "currency": "USD",
        "aliases": ["WTI", "WTI原油", "NYMEX原油", "美原油"],
    },
    {
        "symbol": "BRN", "provider_symbol": "FOREIGN:OIL", "venue": "IFEU",
        "name": "ICE Brent 原油连续日线", "currency": "USD",
        "aliases": ["OIL", "Brent", "Brent原油", "布伦特原油"],
    },
)

FOREIGN_COMMODITY_PROVIDER_SYMBOLS = {
    str(series["provider_symbol"]).split(":", 1)[1]
    for series in FOREIGN_COMMODITY_SERIES
}


def _future_contracts(akshare: Any) -> list[dict[str, Any]]:
    records = _records(akshare.futures_hist_table_em())
    normalized: list[dict[str, Any]] = []
    for record in records:
        symbol = str(record.get("合约代码", "")).strip()
        venue = FUTURES_MARKETS.get(str(record.get("市场简称", "")).strip())
        if not venue or not re.fullmatch(r"[A-Za-z]+\d{3,4}", symbol):
            continue
        name = str(record.get("合约中文代码", "")).strip()
        variety = re.sub(r"\d{3,4}$", "", name).strip()
        normalized.append({
            **record,
            "symbol": symbol,
            "variety": variety or None,
            "venue": venue,
        })
    return normalized


def _list_futures(akshare: Any) -> dict[str, Any]:
    with ThreadPoolExecutor(max_workers=2) as executor:
        contracts_request = executor.submit(_future_contracts, akshare)
        main_request = executor.submit(akshare.futures_display_main_sina)
        contracts_result = contracts_request.result()
        main_result = _records(main_request.result())
    main_symbols: dict[tuple[str, str], str] = {}
    for record in main_result:
        venue = str(record.get("exchange", "")).strip().upper()
        symbol = str(record.get("symbol", "")).strip().upper()
        if venue in FUTURES_MARKETS.values() and re.fullmatch(r"[A-Z]+0", symbol):
            product = symbol[:-1]
            main_symbols[(venue, product)] = f"MAIN:{venue}:{product}"
    contracts = []
    for record in contracts_result:
        product_match = re.match(r"[A-Za-z]+", str(record["symbol"]))
        product = product_match.group().upper() if product_match else ""
        contracts.append({
            **record,
            "main_symbol": main_symbols.get((str(record["venue"]), product)),
        })
    return {"data": contracts, "source": "eastmoney-catalog+sina-main"}


def _list_foreign_commodities() -> dict[str, Any]:
    return {
        "data": [dict(series) for series in FOREIGN_COMMODITY_SERIES],
        "source": "sina-foreign-catalog",
    }


def _sina_contract_symbol(
    venue: str, symbol: str, request: dict[str, Any]
) -> str:
    normalized = symbol.upper()
    match = re.fullmatch(r"([A-Z]+)(\d)(\d{2})", normalized)
    if venue != "CZCE" or not match:
        return normalized
    reference = request.get("end") or request.get("start")
    reference_year = int(str(reference)[:4]) if reference else datetime.now().year
    year_digit = int(match.group(2))
    decade = reference_year // 10 * 10
    year = min(
        (decade - 10 + year_digit, decade + year_digit, decade + 10 + year_digit),
        key=lambda candidate: abs(candidate - reference_year),
    )
    return f"{match.group(1)}{year % 100:02d}{match.group(3)}"


def _future_bars(
    akshare: Any, request: dict[str, Any], source: str
) -> list[dict[str, Any]]:
    if source != "sina":
        raise ValueError(f"unsupported futures bars source: {source}")
    if request.get("interval", "1d") != "1d":
        raise ValueError("Sina futures supports daily bars only")
    parts = str(request["providerSymbol"]).split(":")
    if len(parts) == 2 and parts[0] == "FOREIGN":
        symbol = parts[1].upper()
        if symbol not in FOREIGN_COMMODITY_PROVIDER_SYMBOLS:
            raise ValueError("unsupported foreign commodity series")
        return _filter_dates(
            _records(akshare.futures_foreign_hist(symbol=symbol)), request
        )
    if len(parts) == 3 and parts[0] == "MAIN":
        product = parts[2].upper()
        return _records(akshare.futures_main_sina(
            symbol=f"{product}0",
            start_date=_compact_date(request.get("start"), "19900101"),
            end_date=_compact_date(request.get("end"), "20500101"),
        ))
    if len(parts) != 2:
        raise ValueError("invalid futures provider symbol")
    venue, symbol = parts
    records = _records(akshare.futures_zh_daily_sina(
        symbol=_sina_contract_symbol(venue.upper(), symbol, request),
    ))
    return _filter_dates(records, request)


def _market_data(
    akshare: Any, request: dict[str, Any]
) -> dict[str, Any]:
    instrument_type = request["instrumentType"]
    operation = request["operation"]
    intraday = operation == "bars" and request.get("interval", "1d") != "1d"
    key = (
        f"{instrument_type}_intraday_bars"
        if intraday
        else f"{instrument_type}_{operation}"
    )
    source_request = request
    if operation == "quote":
        today = datetime.now().date()
        source_request = {
            **request,
            "start": (today - timedelta(days=21)).isoformat(),
            "end": today.isoformat(),
            "adjustment": "none",
        }
    loader = (
        _future_bars
        if instrument_type == "future"
        else _intraday_bars
        if intraday
        else (_equity_bars if instrument_type == "equity" else _index_bars)
    )
    errors: list[Exception] = []
    empty_result: dict[str, Any] | None = None
    configured_order = request.get("sourceOrder")
    default_order = SOURCE_ORDER[key]
    source_order = (
        tuple(source for source in configured_order if source in default_order)
        if isinstance(configured_order, list)
        else default_order
    )
    if not source_order:
        source_order = default_order
    for source in source_order:
        try:
            data = loader(akshare, source_request, source)
            if operation == "quote":
                data = sorted(
                    data,
                    key=lambda record: str(record.get("date", record.get("日期", ""))),
                )[-2:]
                if not data:
                    raise ValueError(f"{source} returned no recent quote data")
            if intraday and not data:
                empty_result = empty_result or {"data": [], "source": source}
                continue
            return {"data": data, "source": source}
        except Exception as error:
            errors.append(error)
    if empty_result is not None:
        return empty_result
    raise SourcesExhausted(errors)


def _adjustment_factors(
    akshare: Any, provider_symbol: str
) -> dict[str, Any]:
    if provider_symbol.startswith("csi"):
        raise ValueError("price adjustment factors are only available for equities")
    records = _records(akshare.stock_zh_a_daily(
        symbol=provider_symbol,
        adjust="hfq-factor",
    ))
    return {"data": records, "source": "sina"}


def _health_check(
    akshare: Any, source: str, instrument_type: str
) -> dict[str, Any]:
    configured_sources = {
        configured_source
        for sources in SOURCE_ORDER.values()
        for configured_source in sources
    }
    if source not in configured_sources:
        raise ValueError(f"unknown data source: {source}")
    today = datetime.now().date()
    request = {
        "providerSymbol": "sz000001" if instrument_type == "equity" else "sh000001",
        "start": (today - timedelta(days=21)).isoformat(),
        "end": today.isoformat(),
        "adjustment": "none",
    }
    if instrument_type == "equity":
        if source not in SOURCE_ORDER["equity_bars"]:
            raise ValueError(f"{source} does not support equity health checks")
        records = _equity_bars(akshare, request, source)
    elif instrument_type == "index":
        if source not in SOURCE_ORDER["index_bars"]:
            raise ValueError(f"{source} does not support index health checks")
        records = _index_bars(akshare, request, source)
    elif instrument_type == "future":
        if source not in SOURCE_ORDER["future_bars"]:
            raise ValueError(f"{source} does not support futures health checks")
        records = _future_bars(akshare, {
            "providerSymbol": "MAIN:CFFEX:IF", "interval": "1d",
            "start": (today - timedelta(days=21)).isoformat(),
            "end": today.isoformat(),
        }, source)
    else:
        raise ValueError(f"unknown instrument type: {instrument_type}")
    if not records:
        raise ValueError(f"{source} health probe returned no data")
    return {"data": [{"records": len(records)}], "source": source}


def _is_transient(error: Exception) -> bool:
    if isinstance(error, SourcesExhausted):
        return bool(error.errors) and any(_is_transient(item) for item in error.errors)
    return isinstance(
        error, (requests.ConnectionError, requests.Timeout, UpstreamConnectionError)
    ) or (
        isinstance(error, requests.HTTPError)
        and error.response is not None
        and error.response.status_code in {429, 502, 503, 504}
    )


def execute(request: dict[str, Any]) -> dict[str, Any]:
    import akshare

    operation = request["operation"]
    if operation == "list_stocks":
        return {"data": _records(akshare.stock_info_a_code_name()), "source": "akshare"}
    if operation == "list_indices":
        return {"data": _records(akshare.index_stock_info()), "source": "akshare"}
    if operation == "list_futures":
        return _list_futures(akshare)
    if operation == "list_foreign_commodities":
        return _list_foreign_commodities()
    if operation == "health":
        return _health_check(
            akshare, request["source"], request["instrumentType"]
        )
    if operation in {"bars", "quote"}:
        return _market_data(akshare, request)
    if operation == "adjustment_factors":
        return _adjustment_factors(akshare, request["providerSymbol"])
    if operation == "constituents":
        symbol = request["providerSymbol"]
        for prefix in ("csi", "sh", "sz"):
            symbol = symbol.removeprefix(prefix)
        return {"data": _records(akshare.index_stock_cons(symbol=symbol)), "source": "akshare"}
    raise ValueError(f"unsupported operation: {operation}")


def _error_payload(error: Exception) -> dict[str, Any]:
    if _is_transient(error):
        return {"ok": False, "error": {
            "code": "PROVIDER_NETWORK_ERROR",
            "message": "AKShare network request failed",
            "retryable": True,
        }}
    return {"ok": False, "error": {
        "code": "PROVIDER_ERROR",
        "message": "AKShare provider call failed",
        "retryable": False,
    }}


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()
    request = json.loads(arguments.request.read_text(encoding="utf-8"))
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            payload = {"ok": True, **execute(request)}
    except Exception as error:  # provider process boundary
        payload = _error_payload(error)
    temporary = arguments.result.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, arguments.result)


if __name__ == "__main__":
    main()
