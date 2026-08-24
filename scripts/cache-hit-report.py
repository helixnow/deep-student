#!/usr/bin/env python3
"""Prompt-cache hit-rate report for the deep-student Chat V2 pipeline.

Absorbed from the downstream "big cache refactor" experience (measurement is
item 7 of the transfer checklist): record real usage per request (already done
by llm_usage with `cached_tokens`), then aggregate token-weighted hit rate per
scenario. DeepSeek/OpenAI prefix caches make cached reads ~10x cheaper, so the
hit rate directly tracks cost.

Scenarios reported (downstream section 3.3):
  - overall: token-weighted cached/prompt across all requests;
  - per caller_type (chat_v2 / translation / ...);
  - per adapter/protocol (openai_chat_completions / openai_responses / ...);
  - per provider (openai / anthropic / deepseek / ...);
  - per token_source (api / tiktoken / heuristic / mixed);
  - cache write/read: token-weighted cache_write_tokens vs cached_tokens
    (Anthropic bills cache writes at 1.25x; write >> read means the prefix is
    unstable and caching is uneconomical), overall and per adapter;
  - cold vs steady (all sessions): every session's first request aggregated
    against all follow-up requests — the cross-turn prefix stability signal;
  - per session: first request (cold start, expected ~0%) vs steady state;
  - per model.

Rows whose `cached_tokens` are all NULL never had a cache measurement (adapter
did not surface the field); they are reported as 无测量 instead of 0% so a
telemetry gap is not mistaken for a cold cache. The same NULL≠0 rule applies to
`cache_write_tokens` (column added by llm_usage migration V20260824; older DBs
without the column report 无测量 for every write bucket).

Usage:
    python3 scripts/cache-hit-report.py [--db PATH] [--days N] [--session ID]

The DB is auto-discovered under ~/Library/Application Support/com.deepstudent.app
(slots A/B) when --db is omitted.
"""

import argparse
import os
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Tuple


APP_DATA_CANDIDATES = [
    Path.home() / "Library" / "Application Support" / "com.deepstudent.app",
    Path.home() / ".deep-student",
]


def find_db(explicit: Optional[str]) -> Optional[Path]:
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.exists() else None
    for base in APP_DATA_CANDIDATES:
        if not base.exists():
            continue
        for found in base.rglob("llm_usage.db"):
            return found
    return None


def fetch(conn: sqlite3.Connection, days: Optional[int]):
    where = ""
    params: list = []
    if days:
        where = "WHERE timestamp >= datetime('now', ?1)"
        params.append(f"-{days} days")
    # cache_write_tokens 是 V20260824 新列；老库缺列时以 NULL 占位（无测量），
    # 报表不得因用户尚未升级 schema 而直接崩掉。
    has_write_col = bool(
        conn.execute(
            "SELECT 1 FROM pragma_table_info('llm_usage_logs') "
            "WHERE name = 'cache_write_tokens'"
        ).fetchone()
    )
    write_col = "cache_write_tokens" if has_write_col else "NULL AS cache_write_tokens"
    rows = conn.execute(
        f"""
        SELECT session_id, caller_type, model, timestamp,
               prompt_tokens, completion_tokens, cached_tokens, token_source,
               adapter, provider, {write_col}
        FROM llm_usage_logs
        {where}
        ORDER BY timestamp ASC
        """,
        params,
    ).fetchall()
    return rows


def hit_rate(rows):
    """token-weighted cached/prompt; cached may be NULL or exceed prompt (gateway quirks).

    Returns (rate, prompt, cached, measured). `measured` is False when every
    row's cached_tokens is NULL — i.e. no adapter ever reported the field —
    which must be rendered as 无测量, not 0%.
    """
    prompt = sum(max(r[4], 0) for r in rows)
    measured = any(r[6] is not None for r in rows)
    cached = sum(max(r[6], 0) for r in rows if r[6] is not None)
    cached = min(cached, prompt)
    return (cached / prompt) if prompt > 0 else 0.0, prompt, cached, measured


def fmt_rate(rate: float, measured: bool) -> str:
    """Format a hit rate; all-NULL buckets show 无测量 instead of a fake 0%."""
    if not measured:
        return "无测量"
    return f"{rate*100:6.2f}%"


def print_rate(label: str, rows, indent: str = ""):
    rate, prompt, cached, measured = hit_rate(rows)
    print(
        f"{indent}{label:<34} hit={fmt_rate(rate, measured):>7}  "
        f"prompt={prompt:>9}  cached={cached:>9}"
    )
    return rate


def write_read_stats(rows):
    """token-weighted cache write vs read totals.

    Returns (write, read, write_measured, read_measured). A bucket whose
    cache_write_tokens (resp. cached_tokens) are all NULL was never measured
    — render 无测量, not 0. Rows shorter than 11 columns (defensive: pre-write
    fetch shape) count as write-unmeasured.
    """
    write_vals = [r[10] for r in rows if len(r) > 10 and r[10] is not None]
    read_vals = [r[6] for r in rows if r[6] is not None]
    write_measured = bool(write_vals)
    read_measured = bool(read_vals)
    write = sum(max(v, 0) for v in write_vals)
    read = sum(max(v, 0) for v in read_vals)
    return write, read, write_measured, read_measured


def fmt_write_read(write, read, write_measured, read_measured) -> str:
    """Format one write/read line; ratio only when both sides are measured."""
    write_s = f"{write}" if write_measured else "无测量"
    read_s = f"{read}" if read_measured else "无测量"
    if write_measured and read_measured and read > 0:
        ratio = f"  write/read={write / read:6.3f}"
    elif write_measured and read_measured and write > 0:
        ratio = "  write/read=仅写入"
    else:
        ratio = ""
    return f"write={write_s:>9}  read={read_s:>9}{ratio}"


def print_write_read(label: str, rows, indent: str = ""):
    write, read, write_measured, read_measured = write_read_stats(rows)
    print(
        f"{indent}{label:<34} "
        f"{fmt_write_read(write, read, write_measured, read_measured)}"
    )


def cold_steady_split(rows):
    """Split rows into (cold, steady): each session's first request by
    timestamp is cold, every follow-up request is steady.

    Aggregating cold vs steady across all sessions is the cross-turn prefix
    stability signal: a healthy stable prefix shows steady ≫ cold.
    """
    by_session = defaultdict(list)
    for r in rows:
        by_session[r[0] or "none"].append(r)
    cold, steady = [], []
    for rs in by_session.values():
        ordered = sorted(rs, key=lambda r: r[3])
        cold.append(ordered[0])
        steady.extend(ordered[1:])
    return cold, steady


def main() -> int:
    ap = argparse.ArgumentParser(description="Prompt-cache hit-rate report")
    ap.add_argument("--db", help="path to llm_usage.db (auto-discovered by default)")
    ap.add_argument("--days", type=int, default=None, help="only rows within last N days")
    ap.add_argument("--session", help="restrict to one session id (substring match)")
    args = ap.parse_args()

    db = find_db(args.db)
    if not db:
        print("llm_usage.db not found. Pass --db PATH.", file=sys.stderr)
        return 1
    print(f"DB: {db}")

    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = fetch(conn, args.days)
    if args.session:
        rows = [r for r in rows if args.session in (r[0] or "")]
    conn.close()

    if not rows:
        print("No matching rows.")
        return 0

    print(f"Rows: {len(rows)}")
    print_rate("overall", rows)
    print()

    by_caller = defaultdict(list)
    for r in rows:
        by_caller[r[1] or "unknown"].append(r)
    print("== per caller_type ==")
    for caller, rs in sorted(by_caller.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(caller, rs)

    by_adapter = defaultdict(list)
    for r in rows:
        by_adapter[r[8] or "unknown"].append(r)
    print()
    print("== per adapter/protocol ==")
    for adapter, rs in sorted(by_adapter.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(adapter, rs)

    by_provider = defaultdict(list)
    for r in rows:
        by_provider[r[9] or "unknown"].append(r)
    print()
    print("== per provider ==")
    for provider, rs in sorted(by_provider.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(provider, rs)

    by_source = defaultdict(list)
    for r in rows:
        by_source[r[7] or "unknown"].append(r)
    print()
    print("== per token_source ==")
    for source, rs in sorted(by_source.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(source, rs)

    by_model = defaultdict(list)
    for r in rows:
        by_model[r[2] or "unknown"].append(r)
    print()
    print("== per model ==")
    for model, rs in sorted(by_model.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(model, rs)

    # 缓存 write/read 比（token 加权）：Anthropic 写入按 1.25x 计费，
    # write 明显大于 read = 前缀不稳定/缓存不经济的直接信号
    print()
    print("== cache write/read (token-weighted) ==")
    print_write_read("overall", rows)
    for adapter, rs in sorted(by_adapter.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_write_read(adapter, rs, indent="  ")

    # 跨会话聚合的冷启动 vs 稳态：跨轮前缀稳定性的总体信号
    cold, steady = cold_steady_split(rows)
    print()
    print("== cold vs steady (all sessions) ==")
    print_rate("cold (每会话首请求)", cold)
    if steady:
        print_rate("steady (后续请求)", steady)
    else:
        print("  steady (后续请求)                  （无后续请求行）")

    by_session = defaultdict(list)
    for r in rows:
        by_session[r[0] or "none"].append(r)
    print()
    print("== per session (first request = cold start) ==")
    session_rates = []
    for sid, rs in by_session.items():
        rs.sort(key=lambda r: r[3])
        first = rs[:1]
        steady = rs[1:]
        total_rate, total_prompt, _, total_measured = hit_rate(rs)
        first_rate, _, _, first_measured = hit_rate(first)
        steady_rate, _, _, steady_measured = hit_rate(steady)
        session_rates.append(
            (
                sid,
                total_rate,
                total_prompt,
                first_rate,
                steady_rate,
                total_measured,
                first_measured,
                steady_measured,
            )
        )
    for (
        sid,
        total_rate,
        total_prompt,
        first_rate,
        steady_rate,
        total_measured,
        first_measured,
        steady_measured,
    ) in sorted(session_rates, key=lambda x: -x[2])[:25]:
        print(
            f"  {sid[:48]:<50} total={fmt_rate(total_rate, total_measured):>7}  "
            f"cold={fmt_rate(first_rate, first_measured):>7}  "
            f"steady={fmt_rate(steady_rate, steady_measured):>7}  prompt={total_prompt}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
