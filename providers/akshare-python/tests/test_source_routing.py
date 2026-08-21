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


if __name__ == "__main__":
    unittest.main()
