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
         token_source="api", adapter="openai_responses", provider="openai"):
    # column order mirrors fetch(): session_id, caller_type, model, timestamp,
    # prompt_tokens, completion_tokens, cached_tokens, token_source, adapter, provider
    return (session, caller, model, ts, prompt, 10, cached, token_source, adapter, provider)


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
                adapter TEXT, provider TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO llm_usage_logs VALUES "
            "('s1','chat_v2','deepseek-chat','2026-08-23T00:00:00Z',"
            "1000,10,NULL,'tiktoken','openai_chat_completions','deepseek')"
        )
        rows = report.fetch(conn, days=None)
        conn.close()
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r[7], "tiktoken")
        self.assertEqual(r[8], "openai_chat_completions")
        self.assertEqual(r[9], "deepseek")


if __name__ == "__main__":
    unittest.main()
