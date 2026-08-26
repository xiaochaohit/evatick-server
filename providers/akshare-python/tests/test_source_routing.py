from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import requests

from evatick_server_akshare.__main__ import execute
from evatick_server_akshare.sources import SOURCE_ORDER


class SourceRoutingTest(unittest.TestCase):
    def test_health_checks_source_and_instrument_category_independently(self) -> None:
        calls: list[tuple[str, str]] = []

        def equity(**_kwargs):
            calls.append(("sina", "equity"))
            return [{"date": "2026-08-20", "close": 11.1}]

        def index(**_kwargs):
            calls.append(("tencent", "index"))
            return [{"date": "2026-08-20", "close": 3800}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_daily=equity,
            stock_zh_index_daily_tx=index,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            equity_result = execute({
                "operation": "health", "source": "sina",
                "instrumentType": "equity",
            })
            index_result = execute({
                "operation": "health", "source": "tencent",
                "instrumentType": "index",
            })

        self.assertEqual(calls, [("sina", "equity"), ("tencent", "index")])
        self.assertEqual(equity_result, {
            "source": "sina", "data": [{"records": 1}],
        })
        self.assertEqual(index_result, {
            "source": "tencent", "data": [{"records": 1}],
        })

    def test_source_order_is_configured_per_data_type(self) -> None:
        self.assertEqual(
            SOURCE_ORDER["equity_bars"],
            ("sina", "eastmoney", "tencent", "baostock"),
        )
        self.assertEqual(
            SOURCE_ORDER["index_bars"],
            ("sina", "tencent", "eastmoney", "baostock"),
        )
        self.assertEqual(
            SOURCE_ORDER["equity_intraday_bars"], ("sina", "eastmoney")
        )
        self.assertEqual(
            SOURCE_ORDER["index_intraday_bars"], ("sina", "eastmoney")
        )
        self.assertEqual(SOURCE_ORDER["future_bars"], ("sina",))
        self.assertIsNot(SOURCE_ORDER["equity_bars"], SOURCE_ORDER["index_bars"])

    def test_equity_bars_fall_back_to_tencent(self) -> None:
        calls: list[str] = []

        def sina(**_kwargs):
            calls.append("sina")
            raise requests.ConnectionError("sina unavailable")

        def eastmoney(**_kwargs):
            calls.append("eastmoney")
            raise requests.ConnectionError("eastmoney unavailable")

        def tencent(**_kwargs):
            calls.append("tencent")
            return [{"date": "2026-08-20", "close": 11.1, "amount": 1234}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_daily=sina,
            stock_zh_a_hist=eastmoney,
            stock_zh_a_hist_tx=tencent,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute({
                "operation": "bars", "instrumentType": "equity",
                "providerSymbol": "sz000001", "interval": "1d",
                "adjustment": "none",
            })

        self.assertEqual(calls, ["sina", "eastmoney", "tencent"])
        self.assertEqual(result["source"], "tencent")
        self.assertEqual(result["data"][0]["volume"], 1234)
        self.assertIsNone(result["data"][0]["amount"])

    def test_request_can_override_source_order_for_its_data_type(self) -> None:
        calls: list[str] = []

        def sina(**_kwargs):
            calls.append("sina")
            return [{"date": "should-not-run"}]

        def eastmoney(**_kwargs):
            calls.append("eastmoney")
            return [{"date": "2026-08-20", "close": 11.1}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_daily=sina,
            stock_zh_a_hist=eastmoney,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute({
                "operation": "bars", "instrumentType": "equity",
                "providerSymbol": "sz000001", "interval": "1d",
                "adjustment": "none",
                "sourceOrder": ["eastmoney", "sina", "tencent", "baostock"],
            })

        self.assertEqual(calls, ["eastmoney"])
        self.assertEqual(result["source"], "eastmoney")

    def test_baostock_health_checks_equity_and_index(self) -> None:
        queried_codes: list[str] = []
        logout_calls: list[bool] = []

        class Result:
            error_code = "0"
            error_msg = ""
            fields = ["date", "open", "high", "low", "close", "volume", "amount"]

            def __init__(self):
                self.pending = True

            def next(self):
                pending, self.pending = self.pending, False
                return pending

            def get_row_data(self):
                return ["2026-08-20", "10", "11", "9", "10.5", "123", "456"]

        def query(code, _fields, **kwargs):
            queried_codes.append(code)
            self.assertEqual(kwargs["frequency"], "d")
            self.assertEqual(kwargs["adjustflag"], "3")
            return Result()

        fake_baostock = SimpleNamespace(
            login=lambda: SimpleNamespace(error_code="0", error_msg=""),
            logout=lambda: logout_calls.append(True),
            query_history_k_data_plus=query,
        )
        with patch.dict(sys.modules, {
            "akshare": SimpleNamespace(), "baostock": fake_baostock,
        }):
            equity = execute({
                "operation": "health", "source": "baostock",
                "instrumentType": "equity",
            })
            index = execute({
                "operation": "health", "source": "baostock",
                "instrumentType": "index",
            })

        self.assertEqual(queried_codes, ["sz.000001", "sh.000001"])
        self.assertEqual(logout_calls, [True, True])
        self.assertEqual(equity["data"], [{"records": 1}])
        self.assertEqual(index["data"], [{"records": 1}])

    def test_equity_intraday_bars_fall_back_and_keep_the_requested_period(self) -> None:
        calls: list[tuple[str, str]] = []

        def sina(**kwargs):
            calls.append(("sina", kwargs["period"]))
            raise requests.ConnectionError("sina unavailable")

        def eastmoney(**kwargs):
            calls.append(("eastmoney", kwargs["period"]))
            return [{"时间": "2026-08-14 09:35:00", "收盘": 11.22}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_minute=sina,
            stock_zh_a_hist_min_em=eastmoney,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute(
                {
                    "operation": "bars",
                    "instrumentType": "equity",
                    "providerSymbol": "sz000001",
                    "interval": "5m",
                    "start": "2026-08-14",
                    "end": "2026-08-14",
                    "adjustment": "none",
                }
            )

        self.assertEqual(calls, [("sina", "5"), ("eastmoney", "5")])
        self.assertEqual(result["source"], "eastmoney")

    def test_intraday_bars_try_the_next_source_when_history_is_unavailable(self) -> None:
        calls: list[str] = []

        def sina(**_kwargs):
            calls.append("sina")
            return []

        def eastmoney(**_kwargs):
            calls.append("eastmoney")
            return [{"时间": "2025-01-02 09:35:00", "收盘": 10.5}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_minute=sina,
            stock_zh_a_hist_min_em=eastmoney,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute(
                {
                    "operation": "bars",
                    "instrumentType": "equity",
                    "providerSymbol": "sz000001",
                    "interval": "5m",
                    "start": "2025-01-02",
                    "end": "2025-01-02",
                    "adjustment": "none",
                }
            )

        self.assertEqual(calls, ["sina", "eastmoney"])
        self.assertEqual(result["source"], "eastmoney")

    def test_index_bars_fall_back_in_order_and_report_actual_source(self) -> None:
        calls: list[str] = []

        def sina(**_kwargs):
            calls.append("sina")
            raise requests.ConnectionError("sina unavailable")

        def tencent(**_kwargs):
            calls.append("tencent")
            return [{"date": "2026-08-14", "close": 4665.88}]

        def eastmoney(**_kwargs):
            calls.append("eastmoney")
            return [{"date": "should-not-run"}]

        fake_akshare = SimpleNamespace(
            stock_zh_index_daily=sina,
            stock_zh_index_daily_tx=tencent,
            stock_zh_index_daily_em=eastmoney,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute(
                {
                    "operation": "bars",
                    "instrumentType": "index",
                    "providerSymbol": "csi000300",
                    "adjustment": "none",
                }
            )

        self.assertEqual(calls, ["sina", "tencent"])
        self.assertEqual(result["source"], "tencent")
        self.assertEqual(result["data"][0]["close"], 4665.88)

    def test_quote_falls_back_when_a_source_returns_no_recent_rows(self) -> None:
        calls: list[str] = []

        def sina(**_kwargs):
            calls.append("sina")
            return []

        def eastmoney(**_kwargs):
            calls.append("eastmoney")
            return [{"日期": "2026-08-14", "收盘": 11.11}]

        fake_akshare = SimpleNamespace(
            stock_zh_a_daily=sina,
            stock_zh_a_hist=eastmoney,
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute(
                {
                    "operation": "quote",
                    "instrumentType": "equity",
                    "providerSymbol": "sz000001",
                }
            )

        self.assertEqual(calls, ["sina", "eastmoney"])
        self.assertEqual(result["source"], "eastmoney")

    def test_adjustment_factors_use_sina_hfq_factor_series(self) -> None:
        calls: list[dict[str, str]] = []

        def daily(**kwargs):
            calls.append(kwargs)
            return [{"date": "2026-07-15", "hfq_factor": 4.1025}]

        with patch.dict(sys.modules, {
            "akshare": SimpleNamespace(stock_zh_a_daily=daily),
        }):
            result = execute({
                "operation": "adjustment_factors",
                "providerSymbol": "sh600000",
            })

        self.assertEqual(calls, [{
            "symbol": "sh600000", "adjust": "hfq-factor",
        }])
        self.assertEqual(result, {
            "source": "sina",
            "data": [{"date": "2026-07-15", "hfq_factor": 4.1025}],
        })

    def test_lists_current_contracts_from_eastmoney_catalog(self) -> None:
        fake_akshare = SimpleNamespace(
            futures_hist_table_em=lambda: [
                {"市场简称": "中金所", "合约中文代码": "沪深300股指2609", "合约代码": "IF2609"},
                {"市场简称": "上期所", "合约中文代码": "沪铜2609", "合约代码": "cu2609"},
                {"市场简称": "上期能源", "合约中文代码": "原油2609", "合约代码": "sc2609"},
                {"市场简称": "郑商所", "合约中文代码": "白糖609", "合约代码": "SR609"},
                {"市场简称": "大商所", "合约中文代码": "铁矿石2609", "合约代码": "i2609"},
                {"市场简称": "广期所", "合约中文代码": "碳酸锂2609", "合约代码": "lc2609"},
                {"市场简称": "大商所", "合约中文代码": "铁矿石主连", "合约代码": "im"},
            ],
            futures_display_main_sina=lambda: [
                {"symbol": "IF0", "exchange": "cffex", "name": "沪深300指数期货连续"},
                {"symbol": "CU0", "exchange": "shfe", "name": "铜连续"},
                {"symbol": "SC0", "exchange": "ine", "name": "上海原油连续"},
                {"symbol": "SR0", "exchange": "czce", "name": "白糖连续"},
                {"symbol": "I0", "exchange": "dce", "name": "铁矿石连续"},
                {"symbol": "LC0", "exchange": "gfex", "name": "碳酸锂连续"},
            ],
        )
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute({"operation": "list_futures"})

        self.assertEqual(result["source"], "eastmoney-catalog+sina-main")
        self.assertEqual(
            [(item["venue"], item["symbol"], item["variety"], item["main_symbol"])
             for item in result["data"]],
            [("CFFEX", "IF2609", "沪深300股指", "MAIN:CFFEX:IF"),
             ("SHFE", "cu2609", "沪铜", "MAIN:SHFE:CU"),
             ("INE", "sc2609", "原油", "MAIN:INE:SC"),
             ("CZCE", "SR609", "白糖", "MAIN:CZCE:SR"),
             ("DCE", "i2609", "铁矿石", "MAIN:DCE:I"),
             ("GFEX", "lc2609", "碳酸锂", "MAIN:GFEX:LC")],
        )

    def test_future_contract_bars_use_sina_and_expand_czce_year(self) -> None:
        calls: list[str] = []

        def daily(symbol: str):
            calls.append(symbol)
            return [
                {"date": "2026-08-20", "open": 5900, "high": 6000, "low": 5880, "close": 5980},
                {"date": "2026-08-21", "open": 5980, "high": 6050, "low": 5960, "close": 6030},
            ]

        fake_akshare = SimpleNamespace(futures_zh_daily_sina=daily)
        with patch.dict(sys.modules, {"akshare": fake_akshare}):
            result = execute({
                "operation": "bars",
                "instrumentType": "future",
                "providerSymbol": "CZCE:AP610",
                "interval": "1d",
                "start": "2026-08-21",
                "end": "2026-08-21",
                "adjustment": "none",
                "sourceOrder": ["sina"],
            })

        self.assertEqual(result["source"], "sina")
        self.assertEqual(result["data"], [
            {"date": "2026-08-21", "open": 5980, "high": 6050, "low": 5960, "close": 6030},
        ])
        self.assertEqual(calls, ["AP2610"])

    def test_future_main_bars_use_one_sina_range_request(self) -> None:
        calls: list[dict[str, str]] = []

        def main(**kwargs):
            calls.append(kwargs)
            return [
                {"日期": "2026-08-20", "开盘价": 790, "最高价": 805, "最低价": 788, "收盘价": 801},
                {"日期": "2026-08-21", "开盘价": 780, "最高价": 795, "最低价": 777, "收盘价": 790},
            ]

        with patch.dict(sys.modules, {
            "akshare": SimpleNamespace(futures_main_sina=main),
        }):
            result = execute({
                "operation": "bars", "instrumentType": "future",
                "providerSymbol": "MAIN:DCE:I", "interval": "1d",
                "start": "2026-08-20", "end": "2026-08-21",
                "adjustment": "none", "sourceOrder": ["sina"],
            })

        self.assertEqual(result, {
            "source": "sina",
            "data": [
                {"日期": "2026-08-20", "开盘价": 790, "最高价": 805, "最低价": 788, "收盘价": 801},
                {"日期": "2026-08-21", "开盘价": 780, "最高价": 795, "最低价": 777, "收盘价": 790},
            ],
        })
        self.assertEqual(calls, [{
            "symbol": "I0", "start_date": "20260820", "end_date": "20260821",
        }])

    def test_lists_supported_foreign_commodity_series_without_network(self) -> None:
        with patch.dict(sys.modules, {"akshare": SimpleNamespace()}):
            result = execute({"operation": "list_foreign_commodities"})

        self.assertEqual(result["source"], "sina-foreign-catalog")
        self.assertEqual(
            [(item["symbol"], item["provider_symbol"], item["venue"])
             for item in result["data"]],
            [("XAU", "FOREIGN:XAU", "OTC"),
             ("XAG", "FOREIGN:XAG", "OTC"),
             ("GC", "FOREIGN:GC", "COMEX"),
             ("SI", "FOREIGN:SI", "COMEX"),
             ("CL", "FOREIGN:CL", "NYMEX"),
             ("BRN", "FOREIGN:OIL", "IFEU")],
        )

    def test_foreign_commodity_bars_use_sina_history_and_filter_dates(self) -> None:
        calls: list[str] = []

        def history(symbol: str):
            calls.append(symbol)
            return [
                {"date": "2026-08-20", "open": 80, "high": 82, "low": 79, "close": 81},
                {"date": "2026-08-21", "open": 81, "high": 83, "low": 80, "close": 82},
            ]

        with patch.dict(sys.modules, {
            "akshare": SimpleNamespace(futures_foreign_hist=history),
        }):
            result = execute({
                "operation": "bars", "instrumentType": "future",
                "providerSymbol": "FOREIGN:CL", "interval": "1d",
                "start": "2026-08-21", "end": "2026-08-21",
                "adjustment": "none", "sourceOrder": ["sina"],
            })

        self.assertEqual(calls, ["CL"])
        self.assertEqual(result, {
            "source": "sina",
            "data": [{
                "date": "2026-08-21", "open": 81, "high": 83,
                "low": 80, "close": 82,
            }],
        })


if __name__ == "__main__":
    unittest.main()
