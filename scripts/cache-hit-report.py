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
  - per session: first request (cold start, expected ~0%) vs steady state;
  - per model.

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
    rows = conn.execute(
        f"""
        SELECT session_id, caller_type, model, timestamp,
               prompt_tokens, completion_tokens, cached_tokens, token_source
        FROM llm_usage_logs
        {where}
        ORDER BY timestamp ASC
        """,
        params,
    ).fetchall()
    return rows


def hit_rate(rows):
    """token-weighted cached/prompt; cached may be NULL or exceed prompt (gateway quirks)."""
    prompt = sum(max(r[4], 0) for r in rows)
    cached = sum(max(r[6] or 0, 0) for r in rows)
    cached = min(cached, prompt)
    return (cached / prompt) if prompt > 0 else 0.0, prompt, cached


def print_rate(label: str, rows, indent: str = ""):
    rate, prompt, cached = hit_rate(rows)
    print(f"{indent}{label:<34} hit={rate*100:6.2f}%  prompt={prompt:>9}  cached={cached:>9}")
    return rate


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

    by_model = defaultdict(list)
    for r in rows:
        by_model[r[2] or "unknown"].append(r)
    print()
    print("== per model ==")
    for model, rs in sorted(by_model.items(), key=lambda kv: -sum(x[4] for x in kv[1])):
        print_rate(model, rs)

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
        total_rate, total_prompt, _ = hit_rate(rs)
        first_rate, first_prompt, _ = hit_rate(first)
        steady_rate, steady_prompt, _ = hit_rate(steady)
        session_rates.append((sid, total_rate, total_prompt, first_rate, steady_rate))
    for sid, total_rate, total_prompt, first_rate, steady_rate in sorted(
        session_rates, key=lambda x: -x[2]
    )[:25]:
        print(
            f"  {sid[:48]:<50} total={total_rate*100:6.2f}%  "
            f"cold={first_rate*100:6.2f}%  steady={steady_rate*100:6.2f}%  prompt={total_prompt}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
