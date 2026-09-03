from __future__ import annotations

import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from evatick_server_amazingdata.server import serve


class _PeriodValue:
    def __init__(self, value: int) -> None:
        self.value = value


class _Period:
    min1 = _PeriodValue(1)
    min5 = _PeriodValue(5)
    min15 = _PeriodValue(15)
    min30 = _PeriodValue(30)
    min60 = _PeriodValue(60)
    day = _PeriodValue(101)
    week = _PeriodValue(102)
    month = _PeriodValue(103)


class _BaseData:
    def get_code_info(self, security_type: str):
        print("SDK progress must not reach protocol stdout")
        if security_type == "EXTRA_STOCK_A":
            return [{"code_market": "600000.SH", "symbol": "浦发银行", "security_status": 1}]
        return [{"code_market": "000300.SH", "symbol": "沪深300", "security_status": 1}]

    def get_calendar(self):
        return [20260824, 20260825]

    def get_backward_factor(self, code_list, local_path: str, is_local: bool):
        return _Frame([{"index": "2026-08-25", code_list[0]: 1.25}])


class _Frame:
    def __init__(self, rows):
        self.rows = rows

    def reset_index(self):
        return self

    def to_dict(self, orient: str):
        if orient != "records":
            raise ValueError("records expected")
        return self.rows


class _MarketData:
    kline_calls: list[tuple[int, int, int]] = []

    def __init__(self, calendar) -> None:
        self.calendar = calendar

    def query_kline(self, code_list, begin_date: int, end_date: int, period: int):
        self.kline_calls.append((begin_date, end_date, period))
        return {
            code_list[0]: [{
                "code": code_list[0],
                "kline_time": "2026-08-25T09:30:00+08:00",
                "open": 10.1,
                "high": 10.3,
                "low": 10.0,
                "close": 10.2,
                "volume": 1200,
                "amount": 12240.0,
            }],
        }

    def query_snapshot(self, code_list, begin_date: int, end_date: int):
        return {
            str(begin_date): {code_list[0]: _Frame([{
                "code": code_list[0],
                "trade_time": "2026-08-25T15:00:00+08:00",
                "last": 10.2,
                "open": 10.1,
                "high": 10.3,
                "low": 10.0,
                "pre_close": 10.0,
                "volume": 1200,
                "amount": 12240.0,
            }])},
        }


class _InfoData:
    def get_index_constituent(self, code_list, local_path: str, is_local: bool):
        return {code_list[0]: [{
            "INDEX_CODE": code_list[0],
            "CON_CODE": "600000.SH",
            "INDATE": "2020-01-01",
            "OUTDATE": None,
        }]}

class _Constant:
    Period = _Period


class FakeAmazingData:
    constant = _Constant()
    BaseData = _BaseData
    MarketData = _MarketData
    InfoData = _InfoData
    logins: list[dict[str, object]] = []
    logout_calls = 0

    @classmethod
    def login(cls, **credentials):
        print("SDK token: do-not-leak")
        cls.logins.append(credentials)

    @classmethod
    def logout(cls, username: str):
        cls.logout_calls += 1


class AmazingDataProtocolTest(unittest.TestCase):
    def setUp(self) -> None:
        FakeAmazingData.logins.clear()
        FakeAmazingData.logout_calls = 0
        _MarketData.kline_calls.clear()

    def test_serves_multiple_requests_from_one_authenticated_session(self) -> None:
        requests = [
            {"id": "1", "operation": "health", "category": "equity"},
            {"id": "2", "operation": "list_instruments"},
            {
                "id": "3", "operation": "bars", "providerSymbol": "600000.SH",
                "interval": "1m", "start": "2026-08-25", "end": "2026-08-25",
            },
            {"id": "4", "operation": "quote", "providerSymbol": "600000.SH"},
            {"id": "5", "operation": "adjustment_factors", "providerSymbol": "600000.SH"},
            {"id": "6", "operation": "constituents", "providerSymbol": "000300.SH"},
            {"id": "7", "operation": "shutdown"},
        ]
        input_stream = io.StringIO("".join(json.dumps(item) + "\n" for item in requests))
        output_stream = io.StringIO()
        environment = {
            "AMAZINGDATA_USERNAME": "test-user",
            "AMAZINGDATA_PASSWORD": "test-password",
            "AMAZINGDATA_HOST": "127.0.0.1",
            "AMAZINGDATA_PORT": "8600",
            "AMAZINGDATA_CACHE_PATH": "/tmp/amazingdata-test-cache",
        }

        diagnostics = io.StringIO()
        with patch.dict(os.environ, environment, clear=True), patch("sys.stdout", diagnostics):
            serve(input_stream, output_stream, sdk=FakeAmazingData)

        responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
        self.assertEqual(1, len(FakeAmazingData.logins))
        self.assertNotIn("password", json.dumps(responses))
        self.assertEqual("", diagnostics.getvalue())
        self.assertEqual({"records": 1}, responses[0]["data"])
        self.assertEqual("equity", responses[1]["data"][0]["type"])
        self.assertEqual("index", responses[1]["data"][1]["type"])
        self.assertEqual("2026-08-25T09:30:00+08:00", responses[2]["data"][0]["kline_time"])
        self.assertEqual(10.2, responses[3]["data"][0]["last"])
        self.assertEqual(
            {"date": "2026-08-25", "factor": 1.25},
            responses[4]["data"][0],
        )
        self.assertEqual("600000.SH", responses[5]["data"][0]["CON_CODE"])
        self.assertTrue(responses[6]["ok"])
        self.assertEqual(1, FakeAmazingData.logout_calls)

    def test_returns_structured_errors_without_leaking_credentials(self) -> None:
        input_stream = io.StringIO(json.dumps({"id": "1", "operation": "unknown"}) + "\n")
        output_stream = io.StringIO()
        environment = {
            "AMAZINGDATA_USERNAME": "test-user",
            "AMAZINGDATA_PASSWORD": "do-not-leak",
            "AMAZINGDATA_HOST": "127.0.0.1",
            "AMAZINGDATA_PORT": "8600",
            "AMAZINGDATA_CACHE_PATH": "/tmp/amazingdata-test-cache",
        }

        with patch.dict(os.environ, environment, clear=True):
            serve(input_stream, output_stream, sdk=FakeAmazingData)

        response = json.loads(output_stream.getvalue())
        self.assertFalse(response["ok"])
        self.assertEqual("UNSUPPORTED_OPERATION", response["error"]["code"])
        self.assertNotIn("do-not-leak", output_stream.getvalue())

    def test_invalid_json_isolated_to_one_request(self) -> None:
        input_stream = io.StringIO("not-json\n" + json.dumps({"id": "2", "operation": "health", "category": "equity"}) + "\n")
        output_stream = io.StringIO()
        environment = {
            "AMAZINGDATA_USERNAME": "test-user",
            "AMAZINGDATA_PASSWORD": "test-password",
            "AMAZINGDATA_HOST": "127.0.0.1",
            "AMAZINGDATA_PORT": "8600",
            "AMAZINGDATA_CACHE_PATH": "/tmp/amazingdata-test-cache",
        }

        with patch.dict(os.environ, environment, clear=True):
            serve(input_stream, output_stream, sdk=FakeAmazingData)

        responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
        self.assertFalse(responses[0]["ok"])
        self.assertEqual({"records": 1}, responses[1]["data"])

    def test_large_minute_ranges_are_split_into_bounded_windows(self) -> None:
        request = {
            "id": "1", "operation": "bars", "providerSymbol": "600000.SH",
            "interval": "1m", "start": "2026-08-01", "end": "2026-08-12",
        }
        input_stream = io.StringIO(json.dumps(request) + "\n")
        output_stream = io.StringIO()
        environment = {
            "AMAZINGDATA_USERNAME": "test-user",
            "AMAZINGDATA_PASSWORD": "test-password",
            "AMAZINGDATA_HOST": "127.0.0.1",
            "AMAZINGDATA_PORT": "8600",
            "AMAZINGDATA_CACHE_PATH": "/tmp/amazingdata-test-cache",
        }

        with patch.dict(os.environ, environment, clear=True):
            serve(input_stream, output_stream, sdk=FakeAmazingData)

        self.assertEqual([
            (20260801, 20260805, 1),
            (20260806, 20260810, 1),
            (20260811, 20260812, 1),
        ], _MarketData.kline_calls)


if __name__ == "__main__":
    unittest.main()
