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
  - cold vs steady (all prefix streams): every prefix stream's first request
    aggregated against all follow-up requests — the cross-turn prefix
    stability signal;
  - per session: first request per prefix stream (cold start, expected ~0%)
    vs steady state;
  - per model.

Grouping identity (会话/变体/run 三级分组):
  llm_usage_logs 的遥测身份是三列 session_id / variant_id / run_id
  （variant_id / run_id 为新列；见 Wave2-A 第 5 轮 #1 的遥测身份分列）。
  - session_id: 真实会话 —— per-session 报表的分组键；
  - variant_id: 多变体回答里的单个变体。每个变体维护自己的历史流，跨轮
    前缀在 会话×变体 内延续，因此 cold/steady 的前缀流身份取
    (session_id, variant_id)；
  - run_id: 单次尝试的随机 UUID（取消重试复用 variant 但换 run）。同一
    变体的前缀在 run 之间延续，所以 run_id 只用于 per-session 行的 run
    计数，绝不参与前缀流身份 —— 把 run 纳入身份等于让每次尝试自成一组、
    稳态请求全被误判为冷启动。

  多变体 steady 修复 / stream_event ≠ session:
  历史上多变体路径把整个 run-scoped stream_event
  （chat_v2_event_{session}_var_{variant}_run_{run}[__stream_generation__{n}]）
  当 session_id 落库。本报表对形如 chat_v2_event_ 前缀的 session_id 一律
  解析还原（与 model2_pipeline::chat_v2_session_scope_and_generation 的
  rsplit 规则一致），历史行 / 未升级旧库均按真实会话与变体归组。

  缺列降级: variant_id / run_id 是加法新列。旧库缺列时以 NULL 占位、报表
  不崩，分组降级为「解析 session_id 中的 stream_event 形状还原
  会话/变体/run；无法解析的值按 session_id 原值整体分组（旧行为）」，
  并在输出头部注明当前生效的分组模式。

Rows whose `cached_tokens` are all NULL never had a cache measurement (adapter
did not surface the field); they are reported as 无测量 instead of 0% so a
telemetry gap is not mistaken for a cold cache. The same NULL≠0 rule applies to
`cache_write_tokens` (column added by llm_usage migration V20260824; older DBs
without the column report 无测量 for every write bucket).

Usage:
    python3 scripts/cache-hit-report.py [--db PATH] [--days N] [--session ID]

--session matches the normalized (parsed) session id as well as the raw
session_id column value.

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
    """Fetch report rows plus the set of identity columns actually present.

    Returns (rows, missing_identity_cols). cache_write_tokens（V20260824）与
    variant_id / run_id（遥测身份分列）都是加法新列；老库缺列时以 NULL 占位，
    报表不得因用户尚未升级 schema 而直接崩掉。缺失的身份列名单交给 main
    打印降级说明。
    """
    where = ""
    params: list = []
    if days:
        # llm_usage_logs.timestamp 是 RFC3339（'T' 分隔，repo/collector 均写
        # created_at.to_rfc3339()，如 2026-08-26T10:30:00.123+00:00），而
        # datetime('now') 生成空格分隔（2026-08-26 10:30:00）。TEXT 列是字典序
        # 比较，'T' > ' '，混用两种形状会把截止日**当天早于截止时刻**的行也
        # 全部放进来（--days 最多多算近一天）。用同形状的 strftime 生成截止串，
        # 字典序才等价于时间序。
        where = "WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%S', 'now', ?1)"
        params.append(f"-{days} days")

    def has_col(name: str) -> bool:
        return bool(
            conn.execute(
                "SELECT 1 FROM pragma_table_info('llm_usage_logs') WHERE name = ?1",
                (name,),
            ).fetchone()
        )

    write_col = (
        "cache_write_tokens" if has_col("cache_write_tokens")
        else "NULL AS cache_write_tokens"
    )
    missing_identity_cols = [c for c in ("variant_id", "run_id") if not has_col(c)]
    variant_col = "variant_id" if "variant_id" not in missing_identity_cols else "NULL AS variant_id"
    run_col = "run_id" if "run_id" not in missing_identity_cols else "NULL AS run_id"
    rows = conn.execute(
        f"""
        SELECT session_id, caller_type, model, timestamp,
               prompt_tokens, completion_tokens, cached_tokens, token_source,
               adapter, provider, {write_col}, {variant_col}, {run_col}
        FROM llm_usage_logs
        {where}
        ORDER BY timestamp ASC
        """,
        params,
    ).fetchall()
    return rows, missing_identity_cols


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


STREAM_EVENT_PREFIX = "chat_v2_event_"
GENERATION_MARKER = "__stream_generation__"


def parse_stream_event_scope(value):
    """还原 run-scoped stream_event 中的 (session_id, variant_id, run_id)。

    多变体路径历史上把整个 stream_event 落进 session_id 列：
      chat_v2_event_{session}_var_{variant}_run_{run}[__stream_generation__{n}]
    与 model2_pipeline::chat_v2_session_scope_and_generation 保持同一解析
    规则（去 generation 后缀、rsplit `_var_`），再在变体段上 rsplit `_run_`
    拆出随机 run id。非该形状的值原样返回 (value, None, None)。
    """
    if not value or not value.startswith(STREAM_EVENT_PREFIX):
        return value, None, None
    scope = value[len(STREAM_EVENT_PREFIX):]
    marker_at = scope.rfind(GENERATION_MARKER)
    if marker_at != -1:
        generation = scope[marker_at + len(GENERATION_MARKER):]
        # 与 Rust 解析器同口径（chat_v2_stream_identity: raw_generation
        # .parse::<u64>() 失败 → 整个事件名不视为合法 chat_v2 run scope）：
        # 代际后缀非 ASCII 数字时不拆列，按原值整体分组 —— 写入侧对同样
        # 形状也是走 fallback、整个事件名落 session_id。isascii() 排除
        # str.isdigit() 会放行而 u64 解析会拒绝的全角/上标数字。
        if not (generation.isascii() and generation.isdigit()):
            return value, None, None
        scope = scope[:marker_at]
    session, sep, rest = scope.rpartition("_var_")
    if not sep:
        return scope, None, None
    variant, sep2, run = rest.rpartition("_run_")
    if not sep2:
        return session, rest, None
    return session, variant, run


def row_identity(r) -> Tuple[str, str, str]:
    """行的 (session, variant, run) 三级分组键。

    优先取显式列 variant_id / run_id（索引 11/12；缺列旧库为 NULL 占位）。
    session_id 若仍是原始 stream_event（新列落地前的历史行 / 未升级旧库），
    解析还原真实会话，并用解析结果补齐缺失的 variant/run。
    """
    variant = r[11] if len(r) > 11 else None
    run = r[12] if len(r) > 12 else None
    session, parsed_variant, parsed_run = parse_stream_event_scope(r[0])
    return (
        session or "none",
        variant or parsed_variant or "",
        run or parsed_run or "",
    )


def stream_key(r) -> Tuple[str, str]:
    """cold/steady 的前缀流身份：会话×变体。

    每个变体维护自己的历史流，跨轮前缀在 会话×变体 内延续。run_id 是每次
    尝试的随机 UUID（取消重试复用 variant 但换 run），前缀在 run 之间延续，
    因此 run 不参与身份 —— 纳入 run 等于复刻「把 stream_event 当 session」
    的老 bug：每次尝试自成一组、稳态请求全被误判为冷启动。
    """
    session, variant, _run = row_identity(r)
    return (session, variant)


def cold_steady_split(rows):
    """Split rows into (cold, steady): each prefix stream's (会话×变体) first
    request by timestamp is cold, every follow-up request is steady.

    Aggregating cold vs steady across all prefix streams is the cross-turn
    prefix stability signal: a healthy stable prefix shows steady ≫ cold.
    """
    by_stream = defaultdict(list)
    for r in rows:
        by_stream[stream_key(r)].append(r)
    cold, steady = [], []
    for rs in by_stream.values():
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
    rows, missing_identity_cols = fetch(conn, args.days)
    if args.session:
        # 同时匹配原始列值与解析还原后的真实会话 id
        rows = [
            r
            for r in rows
            if args.session in (r[0] or "") or args.session in row_identity(r)[0]
        ]
    conn.close()

    if not rows:
        print("No matching rows.")
        return 0

    print(f"Rows: {len(rows)}")
    if missing_identity_cols:
        print(
            f"分组键: 降级 —— 库缺列 {'/'.join(missing_identity_cols)}（schema 未升级）。"
            "从 session_id 中的 stream_event 形状解析还原 会话/变体/run；"
            "无法解析的值按 session_id 原值整体分组（旧行为）。"
        )
    else:
        print(
            "分组键: session_id × variant_id（显式新列；run_id 仅计数，"
            "不参与前缀流身份）。形如 chat_v2_event_ 的历史 session_id 仍解析还原。"
        )
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

    # 跨前缀流聚合的冷启动 vs 稳态：跨轮前缀稳定性的总体信号。
    # 前缀流 = 会话×变体（不是 stream_event / run）：多变体回答的每个变体
    # 各算一条流，取消重试（换 run 不换变体）延续原流。
    cold, steady = cold_steady_split(rows)
    print()
    print("== cold vs steady (all prefix streams: 会话×变体) ==")
    print_rate("cold (每前缀流首请求)", cold)
    if steady:
        print_rate("steady (后续请求)", steady)
    else:
        print("  steady (后续请求)                  （无后续请求行）")

    by_session = defaultdict(list)
    for r in rows:
        by_session[row_identity(r)[0]].append(r)
    print()
    print("== per session (每变体首请求 = cold start) ==")
    session_rates = []
    for sid, rs in by_session.items():
        # 会话内按前缀流（变体）拆分：每条流的首请求是 cold，其余 steady。
        # 多变体会话若整体只排一次序，第一条流之外的变体首请求会被误判为
        # steady（或反之），这里逐流拆分修正。
        streams = defaultdict(list)
        runs = set()
        for r in rs:
            streams[stream_key(r)].append(r)
            _, _, run = row_identity(r)
            if run:
                runs.add(run)
        first, steady = [], []
        for srs in streams.values():
            srs.sort(key=lambda r: r[3])
            first.append(srs[0])
            steady.extend(srs[1:])
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
                len(streams),
                len(runs),
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
        n_streams,
        n_runs,
    ) in sorted(session_rates, key=lambda x: -x[2])[:25]:
        extra = f"  variants={n_streams}" if n_streams > 1 else ""
        if n_runs > max(n_streams, 1):
            extra += f"  runs={n_runs}"
        print(
            f"  {sid[:48]:<50} total={fmt_rate(total_rate, total_measured):>7}  "
            f"cold={fmt_rate(first_rate, first_measured):>7}  "
            f"steady={fmt_rate(steady_rate, steady_measured):>7}  prompt={total_prompt}"
            f"{extra}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
