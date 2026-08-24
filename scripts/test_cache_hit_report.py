#!/usr/bin/env python3
"""Unit tests for cache-hit-report.py.

Key regression (ROUND-02 P0-4): buckets whose cached_tokens are all NULL were
previously reported as 0% hit rate; they must render as 无测量 (no measurement)
because the adapter never surfaced the field.

Run:
    python3 scripts/test_cache_hit_report.py
"""

import importlib.util
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "cache_hit_report", Path(__file__).with_name("cache-hit-report.py")
)
report = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(report)


def _row(prompt, cached, session="s1", caller="chat_v2", model="m", ts="2026-08-23T00:00:00Z",
         token_source="api", adapter="openai_responses", provider="openai", cache_write=None):
    # column order mirrors fetch(): session_id, caller_type, model, timestamp,
    # prompt_tokens, completion_tokens, cached_tokens, token_source, adapter,
    # provider, cache_write_tokens
    return (session, caller, model, ts, prompt, 10, cached, token_source, adapter,
            provider, cache_write)


class HitRateTests(unittest.TestCase):
    def test_all_null_cached_is_unmeasured_not_zero(self):
        rows = [_row(1000, None), _row(2000, None)]
        rate, prompt, cached, measured = report.hit_rate(rows)
        self.assertFalse(measured)
        self.assertEqual(prompt, 3000)
        self.assertEqual(cached, 0)
        self.assertEqual(report.fmt_rate(rate, measured), "无测量")
        self.assertNotIn("0.00%", report.fmt_rate(rate, measured))

    def test_measured_zero_is_reported_as_zero_percent(self):
        # cached explicitly 0 is a real measurement (cache miss), not a gap
        rows = [_row(1000, 0)]
        rate, _, _, measured = report.hit_rate(rows)
        self.assertTrue(measured)
        self.assertEqual(report.fmt_rate(rate, measured).strip(), "0.00%")

    def test_mixed_null_and_values_counts_only_measured_cached(self):
        rows = [_row(1000, None), _row(1000, 500)]
        rate, prompt, cached, measured = report.hit_rate(rows)
        self.assertTrue(measured)
        self.assertEqual(prompt, 2000)
        self.assertEqual(cached, 500)
        self.assertAlmostEqual(rate, 0.25)

    def test_cached_clamped_to_prompt(self):
        # gateway quirk: cached can exceed prompt; clamp so rate <= 100%
        rows = [_row(100, 500)]
        rate, prompt, cached, measured = report.hit_rate(rows)
        self.assertTrue(measured)
        self.assertEqual(cached, prompt)
        self.assertAlmostEqual(rate, 1.0)

    def test_fetch_row_shape_has_adapter_and_provider(self):
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.execute(
            """
            CREATE TABLE llm_usage_logs (
                session_id TEXT, caller_type TEXT, model TEXT, timestamp TEXT,
                prompt_tokens INTEGER, completion_tokens INTEGER,
                cached_tokens INTEGER, token_source TEXT,
                adapter TEXT, provider TEXT, cache_write_tokens INTEGER
            )
            """
        )
        conn.execute(
            "INSERT INTO llm_usage_logs VALUES "
            "('s1','chat_v2','deepseek-chat','2026-08-23T00:00:00Z',"
            "1000,10,NULL,'tiktoken','openai_chat_completions','deepseek',256)"
        )
        rows = report.fetch(conn, days=None)
        conn.close()
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r[7], "tiktoken")
        self.assertEqual(r[8], "openai_chat_completions")
        self.assertEqual(r[9], "deepseek")
        self.assertEqual(r[10], 256)

    def test_fetch_survives_old_schema_without_cache_write_column(self):
        # 老库尚未执行 V20260824：fetch 不得崩溃，write 一律 NULL（无测量）
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.execute(
            """
            CREATE TABLE llm_usage_logs (
                session_id TEXT, caller_type TEXT, model TEXT, timestamp TEXT,
                prompt_tokens INTEGER, completion_tokens INTEGER,
                cached_tokens INTEGER, token_source TEXT,
                adapter TEXT, provider TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO llm_usage_logs VALUES "
            "('s1','chat_v2','deepseek-chat','2026-08-23T00:00:00Z',"
            "1000,10,500,'api','openai_chat_completions','deepseek')"
        )
        rows = report.fetch(conn, days=None)
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0][10])
        write, read, w_meas, r_meas = report.write_read_stats(rows)
        self.assertFalse(w_meas)
        self.assertTrue(r_meas)
        self.assertEqual(read, 500)
        self.assertIn("write=", report.fmt_write_read(write, read, w_meas, r_meas))
        self.assertIn("无测量", report.fmt_write_read(write, read, w_meas, r_meas))


class WriteReadTests(unittest.TestCase):
    def test_all_null_write_is_unmeasured_not_zero(self):
        rows = [_row(1000, 500), _row(2000, 300)]
        write, read, w_meas, r_meas = report.write_read_stats(rows)
        self.assertFalse(w_meas)
        self.assertTrue(r_meas)
        self.assertEqual(read, 800)
        line = report.fmt_write_read(write, read, w_meas, r_meas)
        self.assertIn("write=      无测量".replace(" ", ""), line.replace(" ", ""))
        self.assertNotIn("write/read", line)

    def test_measured_zero_write_is_a_real_measurement(self):
        # 显式 0 是真实测量（本轮无缓存写入），不是遥测空洞
        rows = [_row(1000, 500, cache_write=0)]
        write, read, w_meas, r_meas = report.write_read_stats(rows)
        self.assertTrue(w_meas)
        self.assertEqual(write, 0)
        line = report.fmt_write_read(write, read, w_meas, r_meas)
        self.assertIn("write=        0".replace(" ", ""), line.replace(" ", ""))

    def test_write_read_ratio_token_weighted(self):
        rows = [
            _row(1000, 800, cache_write=200),
            _row(1000, None, cache_write=100),
            _row(1000, 700, cache_write=None),
        ]
        write, read, w_meas, r_meas = report.write_read_stats(rows)
        self.assertTrue(w_meas)
        self.assertTrue(r_meas)
        self.assertEqual(write, 300)
        self.assertEqual(read, 1500)
        line = report.fmt_write_read(write, read, w_meas, r_meas)
        self.assertIn("write/read= 0.200", line)

    def test_write_only_bucket_reports_write_only_marker(self):
        # 全是缓存写入、零读取：前缀每轮都被打碎的最坏形态
        rows = [_row(1000, 0, cache_write=900)]
        write, read, w_meas, r_meas = report.write_read_stats(rows)
        self.assertTrue(w_meas)
        self.assertTrue(r_meas)
        self.assertEqual(read, 0)
        self.assertIn("仅写入", report.fmt_write_read(write, read, w_meas, r_meas))


class ColdSteadyTests(unittest.TestCase):
    def test_split_takes_first_request_per_session_by_timestamp(self):
        rows = [
            _row(100, None, session="a", ts="2026-08-23T00:00:02Z"),
            _row(200, 150, session="a", ts="2026-08-23T00:00:05Z"),
            _row(300, 0, session="a", ts="2026-08-23T00:00:01Z"),  # a 的首请求
            _row(400, None, session="b", ts="2026-08-23T00:00:03Z"),  # b 的首请求
        ]
        cold, steady = report.cold_steady_split(rows)
        self.assertEqual(sorted(r[4] for r in cold), [300, 400])
        self.assertEqual(sorted(r[4] for r in steady), [100, 200])

    def test_steady_rate_excludes_cold_rows(self):
        rows = [
            _row(1000, 0, session="s", ts="2026-08-23T00:00:01Z"),
            _row(1000, 900, session="s", ts="2026-08-23T00:00:02Z"),
            _row(1000, 900, session="s", ts="2026-08-23T00:00:03Z"),
        ]
        cold, steady = report.cold_steady_split(rows)
        cold_rate, _, _, cold_measured = report.hit_rate(cold)
        steady_rate, _, _, steady_measured = report.hit_rate(steady)
        self.assertTrue(cold_measured)
        self.assertTrue(steady_measured)
        self.assertAlmostEqual(cold_rate, 0.0)
        self.assertAlmostEqual(steady_rate, 0.9)

    def test_all_null_sessions_stay_unmeasured_in_both_buckets(self):
        rows = [
            _row(1000, None, session="s", ts="2026-08-23T00:00:01Z"),
            _row(1000, None, session="s", ts="2026-08-23T00:00:02Z"),
        ]
        cold, steady = report.cold_steady_split(rows)
        _, _, _, cold_measured = report.hit_rate(cold)
        _, _, _, steady_measured = report.hit_rate(steady)
        self.assertFalse(cold_measured)
        self.assertFalse(steady_measured)


if __name__ == "__main__":
    unittest.main()
