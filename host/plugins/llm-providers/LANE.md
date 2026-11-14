# L01-llm-providers：LLM 供应商

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L01-llm-providers（LLM 供应商） |
| 目录 | `host/plugins/llm-providers/` |
| Rust 范围（lanes.md） | dstu-llm 的 providers、adapters、openai_codex、multimodal、ocr_adapters |
| 主要提供 | `llm.adapter@1` |
| 主要消费 | F4 secrets |
| 特别注意 | SSE 解析、重试分类、各供应商特殊处理（quirk）、reasoning 映射 |
| 规模（本目录） | 20605 行 · 26 个文件 · 5 个命令（前端调用 1） · 246 个测试 |
| 规模（整条 lane，inventory） | 20605 行 · 26 个文件 · 5 个命令（前端 1） · 246 个测试 |
| 契约 | [`contracts/ipc/L01-llm-providers.json`](../../../contracts/ipc/L01-llm-providers.json) |
| 服务草稿 | [`contracts/services/DRAFT-L01-llm-providers.md`](../../../contracts/services/DRAFT-L01-llm-providers.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-llm/src/adapters/gemini-openai-converter.rs` | 2858 | 30 |  |
| `src-tauri/crates/dstu-llm/src/adapters/mod.rs` | 5 | 0 |  |
| `src-tauri/crates/dstu-llm/src/multimodal/embedding_chunker.rs` | 737 | 12 |  |
| `src-tauri/crates/dstu-llm/src/multimodal/embedding_service.rs` | 1144 | 5 |  |
| `src-tauri/crates/dstu-llm/src/multimodal/mod.rs` | 45 | 0 |  |
| `src-tauri/crates/dstu-llm/src/multimodal/page_indexer.rs` | 92 | 1 |  |
| `src-tauri/crates/dstu-llm/src/multimodal/types.rs` | 424 | 6 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/deepseek.rs` | 452 | 5 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/factory.rs` | 299 | 4 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/mod.rs` | 337 | 1 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/paddle.rs` | 480 | 5 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/system_ocr/macos.rs` | 153 | 0 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/system_ocr/mod.rs` | 130 | 0 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/system_ocr/windows.rs` | 96 | 0 |  |
| `src-tauri/crates/dstu-llm/src/ocr_adapters/types.rs` | 405 | 2 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/error.rs` | 145 | 2 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/manager.rs` | 3426 | 31 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/mod.rs` | 17 | 0 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/protocol.rs` | 663 | 6 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/store.rs` | 85 | 0 |  |
| `src-tauri/crates/dstu-llm/src/openai_codex/types.rs` | 300 | 3 |  |
| `src-tauri/crates/dstu-llm/src/providers/deepseek_harness_tests.rs` | 494 | 14 |  |
| `src-tauri/crates/dstu-llm/src/providers/mod.rs` | 6856 | 99 |  |
| `src-tauri/crates/dstu-llm/src/providers/wave2_a_anthropic_budget_tests.rs` | 471 | 14 |  |
| `src-tauri/crates/dstu-llm/src/providers/wave2_a_prefix_snapshot_tests.rs` | 424 | 6 |  |
| `src-tauri/src/cmd/openai_codex.rs` | 67 | 0 | 5 |

### 命令（5）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `openai_codex_auth_status` | `src/cmd/openai_codex.rs:12` | async | app | src/hooks/useVendorModels.ts:163 | (（无）) → CodexAuthStatus ! string |
| `openai_codex_login_cancel` | `src/cmd/openai_codex.rs:36` | async | none | — | (attemptId: string) → null ! string |
| `openai_codex_login_start` | `src/cmd/openai_codex.rs:19` | async | none | — | (flow: string) → Value ! string |
| `openai_codex_logout` | `src/cmd/openai_codex.rs:48` | async | none | — | (（无）) → null ! string |
| `openai_codex_usage` | `src/cmd/openai_codex.rs:57` | async | none | — | (（无）) → CodexUsageSnapshot ! string |

### 发出的事件（0）

无（静态未检出 `emit` / `emit_to` / `emit_filter` 调用）。
<!-- END GENERATED:lane -->

## 备注

## v2 takeover inventory (2026-11-04, GPT-6.1 Sol)

Baseline: `7b4c107fe`, merged normal main; clean worktree. Existing SSE wiring
is `c269212f5`, not reapplied. R1 owns ACCEPTANCE.md; its diff against main is empty.

The following is an intake audit, not an equivalence certificate. Categories
are standard-v2 sections 1.1 through 1.8; unverified means further source review,
not a cross-lane blocker. Paths below are relative to this plugin unless stated.

| Command/module | Categories | Evidence and result |
|---|---|---|
| openai_codex_auth_status | 1.1/1.3/1.5/1.6 | index.ts:101-102 reaches manager.ts:96-104; tests/codex-commands.test.ts:30-51 exercises IPC. Store decoding still needs an integer-width/precision audit (src/openai-codex/store.ts:19-28). |
| openai_codex_login_start | 1.1/1.3/1.4/1.6/1.7 | index.ts:104-114 preserves three flow names, fixed error and warn at :95-98; manager.ts:271-392 owns attempts, HTTP and listeners. Token decoder and all callback exits need v2 review. |
| openai_codex_login_cancel | 1.1/1.4/1.5/1.7 | index.ts:116-120; manager.ts:236-244 releases gate in finally and aborts selected attempt. tests/codex-manager.test.ts covers stale IDs and save/cancel races; command error test :61-67 does not yet assert the warning. |
| openai_codex_logout | 1.1/1.2/1.4/1.7 | index.ts:122-126; manager.ts:247-269 uses settings store, gate covers delete and revoke, timeout cleared in finally. No plugin SQL. R1 already checked delete failure and ordering; no regression identified in those reviewed branches. |
| openai_codex_usage | 1.1/1.3/1.4/1.6/1.7 | index.ts:128-131; manager.ts:114-129 refreshes once; :413-425 bounds body. manager-values.ts:101-148 converts wide counters/timestamps to Number; D3 audit remains self-owned work. |
| llmCodexAuth | 1.1/1.4/1.5/1.6/1.8 | index.ts:63-92 shares the command manager. response.ts:107-126 already fixes 03.b.1; do not redo old findings. tests/codex-auth-service.test.ts uses real plugin/HTTP. 03.b.1 signed off by R1 (a72ef7dee/bf6479dc8). L02 main send paths consume it (llm/index.ts:78-350); R1 L02-01 signed the specified Model2/OCR shared-prepare branches (C1 receipt). Usage precision/persistence remains open, not those signed branches. |
| llmAdapters / remote images | 1.1/1.2/1.6/1.7/1.8 | index.ts:41-56 binds real prefetch/cache; src/media/remote-image.ts:123-146. L02 prepared_request.ts:41 awaits prefetch on the main send path; R1 L02-01 signed the specified Model2/OCR preparation branches. Shared SSE CR residual fixed by F4 d1d251987. |
| llmOcr | 1.1/1.3/1.4/1.6/1.7/1.8 | index.ts:59 publishes factory; src/ocr/system.ts:11-41 lacks native binding. Native OCR explicitly assigned to C2; Linux unsupported is not macOS/Windows evidence. Full adapter decoding/log review not yet certified. |
| llmMultimodal | 1.1/1.2/1.3/1.4/1.5/1.6 | index.ts:60; src/multimodal/service.ts:17-30 exposes actual code. page-indexer.ts:33-38 silently selects one of duplicate serde aliases: self-owned defect V2-01. Missing L02 runtime methods block real embedding integration, not local parsing fixes. |
| Whole plugin ownership | 1.2 | No INSERT/UPDATE/DELETE/REPLACE in src; credentials use SettingsStore in src/openai-codex/store.ts:17,39,43. No other owner's table is written. |
| Test evidence / closure | 1.5/1.8 | TESTMAP has 246 ported rows, zero pending (generated header is historical). This is not v2 acceptance. Parser job 20261104093352-f278f2: 174 passed, exit 0; type job 20261104093350-4ed4ab: exit 0. No Errors/unhandled report. |

### Finding disposition

- L01-01: preserve implemented provider side; request L02 asynchronous prefetch before buildRequest and real consumer evidence.
- L01-02: preserve Linux cfg behavior; await C2/F7 actual Vision/Windows.Media.Ocr binding and platform evidence.
- L01-03 / 03.b.1: signed off by R1 (a72ef7dee/bf6479dc8); no further work. R1 L02-01 also signed the specified Model2/OCR prepare branches; do not reopen them. Remaining usage/multimodal/native boundaries are listed in BLOCKERS.md.
- L01-04: independently closed; do not rewrite those eight tests.
- V2-01: add production-service alias-conflict tests before changing preview decoder.
- Further self-owned review: stored-session/token numeric decoding, usage precision, complete serde/log maps. These are not falsely labeled external blockers.

See BLOCKERS.md for concrete external API requirements. No command remains unimplemented;
the five registrations alone do not establish v2 completion.

### Progress log

- V2-01 (serde alias duplicate / required null): code in checkpoint `372463c33`; `8282828f5` is only the report. R1 signed off the specified scope (ACCEPTANCE `020765b15`/`804419498`).
- V2-02 (integer width / D3): see SPEC.md "整数宽度"; tests/codex-integer-width.test.ts. Awaiting R1 signoff.
- V2-03 (serde struct duplicate fields, recursion limit 128, preview text seam): json.ts scanner + duplicateField; store.ts, manager.ts tokenRequest, page-indexer.ts; `parseAttachmentPreviewJson` on llmMultimodal; tests in tests/codex-integer-width.test.ts (5 new). Awaiting R1; production precision needs L12 consumer (BLOCKERS.md).
- Log mapping unit is recorded below; remaining self-owned work is the typed first-error/unknown/sequence boundary, internal usage precision and byte/text decoding (do not reopen signed log vectors).

## v2 排雷清单（X6 gate-checks，基线 2ee9a9cbe 候选；核验于本分支 d56af1760）

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。候选不是缺陷全集；计数类只作人工线索。single-writer、log-parity：本插件 0 候选。

### unchecked-decode

| ID | 位置（基线） | 当前核验 | Rust 证据 | 处置 |
|---|---|---|---|---|
| X6-unchecked-decode-llm-providers-paddle-92 | src/ocr/paddle.ts:92 `JSON.parse(...) as JsonValue` | 真缺陷，但不在断言本身：后续 `object(block)!` 对非对象 block 抛 TypeError，被 parseResponse 吞掉后走 document 兜底；Rust `Value::get` 对非对象返回 None，产出默认 region。另 JSON.parse 不执行 serde 递归上限 128 | `ocr_adapters/paddle.rs:213,221-240` | 已修 `d56af1760`：改用 `parseJsonExact`，非对象 block 走默认值；测试经 `ctx.llmOcr.createAdapter('paddle_ocr_vl').parseResponse`（tests/services.test.ts，提交于检查点 `eb46024ef`） |
| X6-unchecked-decode-llm-providers-json-14 | src/json.ts:14 `parseJson` | **不豁免，仍为候选（C1 13:2x 更正）**。原"与 serde Value 对等"说法过宽：JSON.parse 与 `serde_json::from_str::<Value>`（1.0.149，app 图开启 arbitrary_precision）的差异不会被下游字段校验自动恢复。逐项：(1) 未配对 `\uD800-\uDFFF` 转义 serde 报错（read.rs:900-960），JSON.parse 接受 → 已修；(2) 嵌套深度 ≥128 → 已修；(3) `-0` 在 arbitrary_precision 下存为整数 0（de.rs parse_any_number），`as_u64`/u8 字段接受 → 已修；(4) `as_f64` 在 arbitrary_precision 下过滤非有限值（number.rs:170）→ 已修：入站 as_f64 落点（paddle score/bbox、Codex usage `number_at`）改用 `f64()`；请求体上的 `typeof === 'number'`（temperature/top_p 等）来自 IPC，按 D3 不改；(5) `int`/`uint` → 已修：全部入站 `as_i64`/`as_u64` 落点（anthropic usage/index/max_tokens/budget/top_k、gemini usage/index/top_k/thinking_budget、responses output_index、openai-chat tool index、codex event_index）改用按字面量判定的 `i64At`/`i32At`/`u64At`；`as i32` 在精确 i64 上截断；gemini 流式/非流式 usage 原先漏了 `as i32`，一并修正；anthropic merged usage 用 `cloneExact`/`setExactInteger` 保留字面量；(6) serde struct 重复字段只在已列 struct 落点处理（V2-03）→ 其余开放 | serde_json 1.0.149 read.rs / de.rs / number.rs | (1)-(3) `parseJson` 现即 `parseJsonExact`，全部调用方共享；测试 tests/codex-integer-width.test.ts「serde_json Value lexical acceptance」经 `ctx.llmAdapters` / IPC。(4)(5) 测试「provider stream integers and floats follow serde_json Value accessors」经 `ctx.llmAdapters`/`ctx.llmOcr` |
| X6-unchecked-decode-llm-providers-anthropic-571（572/573 同） [info] | src/providers/anthropic.ts:572-574（当前行） | 出站方向：把本地已构造的强类型 `messages/system/tools` 放进请求 JsonObject，不是入站解码 | `providers/mod.rs` anthropic `convert_openai_to_anthropic` | 非缺陷，记录 |

### prod-reachable

| ID | 位置 | 当前核验 | 处置 |
|---|---|---|---|
| X6-prod-reachable-llm-providers-deepseek-harness-1 / X6-prod-reachable-llm-providers-openai-responses-1 | tests/deepseek-harness.test.ts、tests/openai-responses.test.ts 引用 `src/sse-buffer.ts:7 SseEventBuffer` | 基线过时：本地 `src/sse-buffer.ts` 已删除（`c269212f5` 消费 F4 共享面），测试改从 `host/platform/util/api.ts` 引入；该共享类在生产中由 L02 `host/plugins/llm/src/single_shot_stream.ts`、`stream_validation.ts` 使用 | 无需改动；TESTMAP 行不改 |

### assert-parity（41 候选，逐条对照原 Rust 断言）

计数差不判失败。下表按 Rust 断言逐条核对，`覆盖` 表示每条 Rust 断言都有等价或更强的 TS 检查（整体 `toEqual`、循环可覆盖多条）。

| TS 位置 | Rust 测试 | 结论 |
|---|---|---|
| tests/codex-manager.test.ts:260 | manager.rs:3162 status_never_exposes_tokens | 覆盖：4 条 `!contains` 由 for 循环覆盖，`contains("***456789")` 对应 |
| tests/codex-protocol.test.ts:53 | protocol.rs:579 responses_body_is_sanitized_for_codex | 覆盖：6 条 `is_null` 由循环 `not.toHaveProperty` 覆盖，store/stream/effort/include 一一对应 |
| tests/embedding-chunker.test.ts:17 | embedding_chunker.rs:623 test_chunk_short_text | 覆盖：`toEqual([text])` 同时断言长度与内容 |
| tests/embedding-chunker.test.ts:48 | embedding_chunker.rs:677 test_chunk_text_overlap_respects_token_budget | 覆盖：Rust 第 3 条在 for 循环内，TS 同为循环 |
| tests/embedding-chunker.test.ts:53 | embedding_chunker.rs:714 test_chunk_text_no_overlap_when_single_chunk | 覆盖：`toEqual([text])` |
| tests/gemini-converter.test.ts:136 | gemini-openai-converter.rs:2236 test_parse_gemini_stream_line_usage_without_cache_omits_cached_tokens | 缺口已补：Rust `_ => panic!("Expected Usage")` 无 TS 对应；加 `events[0].type === 'Usage'` |
| tests/anthropic.test.ts:163 | mod.rs:5995 anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow | 缺口已补：Rust `system[0..2]` 直接索引隐含长度 ≥3，TS 循环对空数组也通过；改为 3 元素 `toEqual` |
| tests/anthropic.test.ts:381 | mod.rs:6725 anthropic_message_level_thought_signature_attaches_to_thinking_block | 缺口已补：`content[0]["type"] == "thinking"`（6744）无 TS 对应；已加 |
| tests/anthropic.test.ts:584 | wave2_a_anthropic_budget_tests.rs:389 anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers | 缺口已补：同 163 |
| gemini-converter 26/58/145/162/199/216/241/416 | gemini-openai-converter.rs:2056/2103/2252/2293/2370/2419/2467/2770 | 覆盖：逐条对照，is_some/unwrap 由精确值或 `toEqual` 覆盖 |
| openai-chat 40/51/66/77/82/93/98/102/107/120/126 | mod.rs:4027/4056/4123/4159/4187/4232/4366/4719/4771/4847/4897 | 覆盖：多条 index/matches! 断言由整数组 `toEqual` 覆盖 |
| openai-responses 50/56/139/220/230/347/373/391/505 | mod.rs:4426/4441/4657/5069/5100/5467/5543/5591/6258 | 覆盖：347/373 为同列表循环；其余整对象 `toEqual` |
| anthropic 89/241/250/363 | mod.rs:5835/6323/6343/6693 | 覆盖 |

结论：41 条中 4 条有真实断言缺口，已补（测试改动在检查点 `f146a8ea8`）；其余 37 条为计数差，未加无意义 expect。

### log 映射（自有小单元，log-parity 0 候选）

openai_codex、ocr_adapters 无 `warn!/error!`（TS 唯一 warn 为 index.ts command_error，对应 commands.rs）。multimodal 12 处 `warn!/error!`（embedding_chunker.rs:95,326,558；embedding_service.rs:390,399,456,468,610,836,941,956,1014）与 TS 12 处 logger 调用一一对应，级别与模板一致。差异：embedding_service.rs:1014 的 warn 与 1027 的 info 用 `{:?}` 打印 `MultimodalIndexingMode`，Rust 输出变体名（`VLSummaryThenTextEmbed`/`VLEmbedding`），TS 原输出 serde 字符串；已修并经 `ctx.llmMultimodal` 测试。仍开放：日志中错误对象的 Display 文本取决于 L02 运行时错误类型，未独立复验。
- V2-03 code: json.ts/store.ts/manager.ts/page-indexer.ts/service.ts and tests landed in checkpoints `41db21bce`, `30e14d8e3`, `debfd09ae`, `ccb05e306`; `64ee1dfa4` carries api.ts + SPEC/BLOCKERS/LANE.
- X6 unchecked-decode paddle-92: `d56af1760` (paddle.ts) + test in checkpoint `eb46024ef`.
- X6 assert-parity gaps (gemini:136, anthropic:163/381/584): test edits in checkpoint `f146a8ea8`.
- Log map: embedding-service.ts `{:?}` mode names in checkpoint `6d0e37a58`; test in the next commit (tests/services.test.ts).

### C2 稳定 ID 映射（冻结报告 0119143715c0，源码基线 2ee9a9cbe）

只做编号映射，处置与上方 v2 排雷清单相同，不另起整改。

| C2 ID | 本清单条目 | 处置 |
|---|---|---|
| X6-UD-0040 | X6-unchecked-decode-llm-providers-json-14 | 候选未关闭：(1)-(5) 已修待复验，(6) 开放，见上表 |
| X6-UD-0041 | X6-unchecked-decode-llm-providers-paddle-92 | 已修 `d56af1760`，测试在检查点 `eb46024ef`；待 R1 |
| X6-PR-0063 / X6-PR-0064 | X6-prod-reachable-llm-providers-deepseek-harness-1 / -openai-responses-1 | 基线过时：本地 sse-buffer.ts 已删，改用平台共享 `SseEventBuffer`（L02 生产使用）；TESTMAP 不改 |
| X6-AP-0274 | gemini-converter.test.ts:136 | 断言缺口已补（检查点 `f146a8ea8`）。注：报告 ID 写的是 `test_parse_gemini_stream_line_usage`（:2200），TS:136 实际对应 `..._without_cache_omits_cached_tokens`（gemini-openai-converter.rs:2236），按后者核对 |
| X6-AP-0306 | anthropic.test.ts:163 | 断言缺口已补（`f146a8ea8`） |
| X6-AP-0311 | anthropic.test.ts:381 | 断言缺口已补（`f146a8ea8`） |
| X6-AP-0312 | anthropic.test.ts:584 | 断言缺口已补（`f146a8ea8`） |
| X6-AP-0272..0273, 0275..0280 | gemini-converter.test.ts:26/58/145/162/199/216/241/416 | 覆盖，计数差，不加 expect |
| X6-AP-0281..0283 | embedding-chunker.test.ts:17/48/53 | 覆盖 |
| X6-AP-0284 | codex-manager.test.ts:260 | 覆盖 |
| X6-AP-0285 | codex-protocol.test.ts:53 | 覆盖 |
| X6-AP-0286..0292, 0296..0299 | openai-chat.test.ts:40/51/66/77/82/93/98/102/107/120/126 | 覆盖 |
| X6-AP-0293..0295, 0300..0304, 0307 | openai-responses.test.ts:50/56/139/220/230/347/373/391/505 | 覆盖 |
| X6-AP-0305, 0308..0310 | anthropic.test.ts:89/241/250/363 | 覆盖 |

本插件在该报告中没有 SW、LP 条目。
- V2-02 内部精度（R1 14:1x 复验意见）：附件预览 `page_index`/`page_count`（usize）在 Host 内部保持 bigint，不再在 `parseAttachmentPreviewJson` 内 Number 化；u32 字段仍为 number（值域内精确）。无字面量的 Host 构造值按精确整数值判定（原 `JSON.stringify` 回退会把 2^60 读成 ...847000）。测试：tests/codex-integer-width.test.ts 新增 2^53 与 2^53+1 区分向量，原舍入期望改为精确期望。
- V2-02 内部精度仍开放项：(a) provider `StreamEvent` usage 数值是 `JsonValue`（number），超过 2^53 在交给 L02 前已舍入；D3 已要求修复，无需再批准“保精确”。最小同批提案 [USAGE-PRECISION.md](USAGE-PRECISION.md) 仅拆出 Usage variant，复用已有 DbJson/bigint/JsonFloat，不改全局 JsonValue，逐点列 L02/L03/F3 算术、SQL、最终 wire 责任。(b) Codex 会话时间已补 bigint 候选（见下节），仍待 main 后独立复验，不据常见日期签全 i64。(c) 重复字段的首错顺序等超出 R1 V2-03 指定签收向量的部分仍未决，不能外推。
- R1 `43e86df2e` 对 preview 原反例仅静态确认：`3f2fb4e04` 的内部 usize bigint 与 `4700ab5f5` 的 2^60 Host 数值回退已确认；原提前 Number 化不再作现存缺陷派回。未独立执行，也未继承 322pass，不签完整 D3；`7fbd14169` 仅 LANE 报告。后续 main 复验限两 preview 服务向量与原只读 probe，不重跑旧签收集。
- 本轮已通过 coord.mjs 投递 Usage 最小同批提案给 L02-llm-manager，并通知 L03-chat-pipeline / F3-storage 的准确 Host hook / collector SQL 接口请求。未单边改 StreamEvent 类型；收到消费方响应后同批改。仅文档变更，按 C1 “无新 diff 不重跑 322” 不新增测试回执；既有 cff1b69ad 自检结果不外推到新提交。

### X6 handoff-8d7b05d14：39 条 AP 逐用例增量核差

清单固定版本 `a07019791e219c91f89fc3960ef5644846486b94`，路径
`scripts/electron-migration/gate-checks/reports/handoff-8d7b05d14.md`。
本次核对 HEAD `d51442ae2`（merge main: already up to date），lane 非 parked。
这 7 个 TS 测试文件及其 6 个原 Rust 文件相对已逐断言审读的 `f146a8ea8` **均无 diff**；
再次按测试名定位当前断言如下。无新缺口，不改测试/TESTMAP，不重跑旧全量，以下不是执行 pass。
保留原 cfg/ignore；这里仅核 AP 语义，不从 unknown 粗关联推导生产不可达。

行号均为 `host/plugins/llm-providers/tests/` 下当前文件的 **断言行**，不是旧测试标题行。
Rust 定位沿 C2 稳定 ID 表及冻结报告的测试名；`toEqual` 同时验证长度、位置、变体和值。
Rust `is_ok`/`unwrap`/`expect` 的成功分支由 TS 同输入调用不抛错及后续值断言覆盖；
事件变体的 panic 分支须有变体断言，不以单纯“不抛错”替代。

| 固定 ID | 当前 TS 断言位置 | 对应 Rust 断言语义 / 核差结果 |
|---|---|---|
| X6-AP-0272 | gemini-converter.test.ts:43-55 | 非流式 URL 两项、2 个 header 及各名字、1 个 content、2 个 part；text/inlineData 的存在检查由精确内容覆盖 |
| X6-AP-0273 | gemini-converter.test.ts:67-71 | 流式 URL、systemInstruction 存在及 parts 精确对象；整体 toEqual 覆盖存在性 |
| X6-AP-0275 | gemini-converter.test.ts:156-160 | 1 个 choice、拼接文本与 usage 5/2/7 |
| X6-AP-0276 | gemini-converter.test.ts:177-180 | tools 存在且长 1、declarations 长 1、get_weather 名字；toHaveLength 覆盖存在性 |
| X6-AP-0277 | gemini-converter.test.ts:204-214 | 无 usage 为 0/0/0，部分 usage 为 10/0/10；两种输入均保持 |
| X6-AP-0278 | gemini-converter.test.ts:234-239 | 3 个 contents、user/model/user 顺序、assistant text、含 get_weather 的 tool response；精确文本强于 is_some/is_string/contains |
| X6-AP-0279 | gemini-converter.test.ts:257-258 | 两段拼接文本、tool_calls 存在且长 1 |
| X6-AP-0280 | gemini-converter.test.ts:431-432 | 未知 content part 降级成功，parts 长 1、Describe this 原文 |
| X6-AP-0281 | embedding-chunker.test.ts:18 | toEqual(['短文本']) 同时覆盖长度 1 和第一项等于输入 |
| X6-AP-0283 | embedding-chunker.test.ts:54 | 单块 overlap 测试精确数组，同时覆盖长度及原文 |
| X6-AP-0284 | codex-manager.test.ts:263-264 | 同一个 for 覆盖四个 secret 不出现，后续断言掩码 ***456789 出现 |
| X6-AP-0285 | codex-protocol.test.ts:55-58 | store=false/stream=true；for 覆盖 6 个剔除字段；effort=xhigh、include 含 encrypted_content |
| X6-AP-0286 | openai-chat.test.ts:44,46-48 | 首片无 Done；整数组覆盖长度 5 及 content/reasoning/tool id/usage total=5/Done 顺序 |
| X6-AP-0287 | openai-chat.test.ts:53-55 | 唯一 content 精确数组、首 finish 返回 Done、再次 finish 空 |
| X6-AP-0288 | openai-chat.test.ts:72,74-75 | Done marker 前无 Done；整数组覆盖 early/late/usage(total18,cached8)/Done 及长度4；finish 空 |
| X6-AP-0289 | openai-chat.test.ts:79-80 | content 数组输出两个事件的完整类型/文本；string thinking 的 first 变体和值 |
| X6-AP-0290 | openai-chat.test.ts:84-86 | reasoning、reasoning_details、双字段去重三输入；整体数组同时约束长度及文本 |
| X6-AP-0291 | openai-chat.test.ts:96 | tool_choice 精确对象覆盖 type、function.name 及无 flat name |
| X6-AP-0292 | openai-chat.test.ts:100 | tools 精确两元素数组覆盖 web_search 与 function.name/长度 |
| X6-AP-0293 | openai-responses.test.ts:52-53 | reasoning 整对象含 high/auto；text 整对象含 low |
| X6-AP-0294 | openai-responses.test.ts:58 | reasoning 整对象含 none/auto |
| X6-AP-0295 | openai-responses.test.ts:147-154 | function type/name/description/parameters/strict=false/无 nested function；精确 tool_choice；parallel=false |
| X6-AP-0296 | openai-chat.test.ts:104-105 | 唯一保留 first tool；精确 tool_choice 覆盖 nested name 且无 flat name |
| X6-AP-0297 | openai-chat.test.ts:109-114 | 两元素精确数组；循环逐 tool 排除空白 flat name 与 nested name |
| X6-AP-0298 | openai-chat.test.ts:121 | 整 tools 数组包含 parameters={type:'object',properties:{}}，覆盖两个原断言 |
| X6-AP-0299 | openai-chat.test.ts:128-129 | buildRequest 成功、唯一合法工具精确数组、无 tool_choice |
| X6-AP-0300 | openai-responses.test.ts:223,226-227 | 首个 call_1/index0；终态只补 call_2/index1，精确数组约束数量；尾 Done |
| X6-AP-0301 | openai-responses.test.ts:233-243 | added、两段 delta、done 的精确数组逐一约束 index/id/arguments；item_done 空、终态不再出 ToolCall 且尾 Done |
| X6-AP-0302 | openai-responses.test.ts:348-349 | 同 Rust 的 6 个 true 与 7 个 false 模型名，分别在循环中逐项断言 |
| X6-AP-0303 | openai-responses.test.ts:374 | 同 Rust 的 3 个 URL，在循环中逐个断言 false |
| X6-AP-0304 | openai-responses.test.ts:393 | 唯一 SafetyBlocked 精确数组覆盖 reason/details.message，长度1排除 Done |
| X6-AP-0305 | anthropic.test.ts:100-107 | request ephemeral；system 长1、block 的 type/text/ephemeral；tools 长2、首个无 cache_control、末项 ephemeral |
| X6-AP-0306 | anthropic.test.ts:181-184 | **既有缺口已修**于 f146a8ea8：map 后精确三元素 ephemeral 数组（非可空循环），覆盖 Rust system[0..2] 直接索引隐含长度与值；request/tools 断言仍保留 |
| X6-AP-0307 | openai-responses.test.ts:510-512 | assistant role；两个 output_text/refusal part 的完整对象分别覆盖 type 和正文 |
| X6-AP-0308 | anthropic.test.ts:246-247 | thinking 精确 adaptive 对象，覆盖存在/type/无 budget；effort=medium |
| X6-AP-0309 | anthropic.test.ts:255 | thinking 精确 enabled/budget2048 对象，覆盖存在性/type/budget |
| X6-AP-0310 | anthropic.test.ts:376-378 | 三个完整 block 分别覆盖 thinking 文本/signature、空 thinking/signature、redacted/data |
| X6-AP-0311 | anthropic.test.ts:393-394,404-405 | **既有缺口已修**于 f146a8ea8：首 case 显式 type=thinking 加 signature；第二 case 完整 thinking block 加后续 tool_use |
| X6-AP-0312 | anthropic.test.ts:603-606 | **既有缺口已修**于 f146a8ea8：request/tools 控制保留；system 映射精确三元素 ephemeral 数组，非可空循环 |

39 条中仍被计数报告列出的 X6-AP-0306/0311/0312 已有对应修复，不重复整改；
其余 36 条是组合断言/循环等静态覆盖。原 41 条中 X6-AP-0274 与 X6-AP-0282
不在这次 39 条清单，沿原登记，不另编号。不改“已修待 main 独立复验”的状态。
preview 的两个服务向量及原只读 probe 与这些 AP 核差分开；新增 adapter/f64 修复
不得搭车继承 preview 签收。

### V2-02：Codex 内部会话时间独立小单元（待 R1）

- 支持输入依据：`openai_codex/types.rs:11-27,46-52,56-112`：持久化两个字段为
  i64 / Option<i64>；仅 expires>0 属于 is_valid 条件，last_refresh_at 可为 i64::MIN。
  `store.rs:32-44` 为 serde 原数值 load/save；`manager.rs:1794-1798` 明确 i64 clamp +
  saturating_mul/add。没有 JS 安全整数上限，也不能依据当前日期限制历史 JSON。
- 当前反例已锁：未改实现时经真实 `ctx.llmCodexAuth.requestAuth(false)`，输入
  expiresAtUnixMs=9007199254740993，返回内部值为 9007199254740992；作业
  `20261104151846-52d5e0` 1 failed/16 filtered、exit1。之前作业
  `20261104151642-8b62c9` 也红（首先发现内部仍为 number）；不把红作业算 pass。
- 候选改动：`StoredCodexSession` 两个时间字段、`CodexRequestAuth` 到期时间、OAuth
  expires_in 和 expiry 算术为 bigint。Host status 使用 `CodexAuthState`，只在
  `index.ts` auth_status 命令的最终 IPC DTO 中转 number。store 保存复用现有公开
  lossless serializer，原 JSON 字段名/次序和数值 token 保持，未改任何 SQL/外部文件。
- 错误范围不变：原 i64 越界/浮点拒绝、expires<=0 的 CredentialStore、token 缺字段和
  refresh identity/错误传播未改；重复字段首错顺序仍开放。usage/rate-limit 的内部分量、
  generation/counter 完整宽度不随此单元签收。
- 新增 4 条测试：requestAuth + Host status 与真正 IPC 的边界对照（2^53/+1/i64MAX）；
  两个时间字段的真实 store load/clone/save/reload（包含 i64MIN/MAX）；真实 HTTP OAuth
  expires_in 的 i64MIN/MAX clamp 后刷新及保存；完整 i64 域 saturating_add 纯算术补充。
  原 IPC 舍入断言不变；不是“先 Number 再转回 bigint”。
- 改动既有测试的逐条理由：`codex-manager` 的 refresh_merge 原 Rust `last_refresh_at==Some(1000)`
  仅改为精确 `1000n`，其余取值/方向不动；account switch 输入时间仅换表示。
  `status_never_exposes_tokens` 原 serde_json::to_string 用现有 lossless serializer，四项
  secret 拒绝和掩码断言原样保留。HTTP token fixture 3600n 序列化仍是 JSON 数字 3600。
  `codex-auth-service` 仍完整比较同 manager 状态，只在与 IPC 对照的副本转换时间；
  新测试另要求 Host 原值为 bigint。protocol/auth fixtures 的时间也仅换 bigint 表示，
  不改协议头、脱敏、错误或业务断言。
- 实现和首批测试在协调者检查点 `b22f519b8`；公开 status 精确类型及既有服务对照测试调整
  在 `d8dcc68d9`。不要将后续文档提交误报成这些代码的提交。
- R1 ba85d0d48 usage 提案意见另已补到 USAGE-PRECISION.md：snapshot() 整体 clone、
  single_shot 双方 as_i64 判定、F1 最终 wire/debug 接纳点、L20 自有 __proto__ clone
  保真；Usage 类型/消费方仍未改，不因本时间修复解除同批停放。
- 本单元验证：`20261104152740-2add4b` 5 个 Codex 相关文件 83 passed、exit0；
  `20261104152740-7612e0` typecheck:host exit0。此前 `20261104152450-9f35e7`
  82 passed/1 failed（既有 service 对照把内部 bigint 与 wire number 直接比较），按上述
  边界理由修对照方式后才转绿，不隐藏该失败。不继承旧 322 或 R1 preview 签收。
- §5 自检：`7ea3c5aff`（main 基线 `4525e11ac`）5 项全过，已投递 C1/R1；没有再次跑回执。
  R1 `70fd4e998` 仅静态认可该指定时间差异（归属/新旧断言亦核过），未执行、非 main 祖先时
  不算独立签收。main 后四个标题最小复验与既有 preview 两标题/原 probe 分开。

### V2-03 首错顺序：已锁反例，未改实现/旧测试（2026-11-04 15:4x）

真实插件服务 `ctx.llmMultimodal.parseAttachmentPreviewJson` 只读诊断作业
`20261104154111-25ea10` exit0，**不是测试 pass / Rust 差分**：

| 输入 | 当前 TS | Rust 源码应走的首分支（静态） |
|---|---|---|
| `{"pages":"bad","dpi":1,"renderDpi":2}` | duplicate field dpi | 第一项 pages 的 Vec 类型错误，不应读到后面的 duplicate |
| `{"dpi":1,"renderDpi":2,"pages":"bad"}` | duplicate field dpi | 第二个别名键即 duplicate dpi，不应读取其后的坏 pages |
| `{"pages":[{"page_index":"bad","pageIndex":0}]}` | duplicate field page_index | 第一个 page_index 的 usize 类型错误先于 alias 重复 |
| `{"pages":[{"page_index":0,"pageIndex":"bad"}]}` | duplicate field page_index | alias 键重复应先于它自己的坏值解码 |
| `{"pages":[{"page_index":-0}]}` | 接受，内部 page_index=0n | 直接 typed usize 与 Value 数字路径不同，见下述静态反证待 R1 |

源码依据：AttachmentPreview/Page 为 serde derive（`multimodal/page_indexer.rs:17-50`），
按 MapAccess 顺序遇 known key 先查字段是否见过，再 next_value 解码；当前 TS 在
`page-indexer.ts:92,115` 先扫全体重复键，又固定字段顺序校验，故会抢报后面的 duplicate。

必须先区分两条 serde_json 1.0.149 路径（原文 `de.rs`/`read.rs`，本机无 Rust 工具链，
以下是静态证据，已请 R1 窄核；不自行撤旧签收）：

- `deserialize_i64/u64`（de.rs:1500-1507）→ `deserialize_number:319-341` →
  `parse_integer/parse_number:462-524`：`-0` 是 F64(-0)，typed 整数 visitor 拒绝。
  arbitrary_precision 的 `parse_any_number:938`（Value 路径）才把 `-0` 归为 i64 0。
  之前把 Value::as_u64 的规则外推到 Store/Preview 整数字段过宽；既有 `-0` 测试的
  typed 部分待按 Rust 纠正，不得靠其绿结果豁免（仍沿 V2-02/UD0040，不新编号）。
- `deserialize_ignored_any:1910` → `ignore_value:1102`：数值调用 `ignore_integer/
  decimal/exponent:1217-1283`，只扫词法不做范围/有限性检查；字符串用
  `read.rs::ignore_escape:1025`，u 转义只解 4 位 hex，不验证代理项配对；容器为迭代栈，
  不走 Value 的 remaining_depth 递归检查。因此 typed struct 的未知字段不是普通 Value。
- 第二个只读诊断 `20261104154323-4ebccc` exit0：`{"pages":[],"unknown":"\\ud800"}`
  和 unknown 中的 127 层数组（总文档深 128）当前均报 invalid JSON；unknown=1e400 当前
  接受；`[[],null,null,null]`（struct sequence 候选）当前拒绝。需按 derive 的对象/序列
  支持与 IgnoredAny 路径分别核，不能将 Value 的限制一并套用。旧深度测试的 x 是未知
  字段，不能仅凭 Value 默认深度 128 证明其 typed serde 断言；已单独告知 R1。

没有在这些诊断中改生产代码或测试断言。已请求 F4 现有 JsonReader 提供明确的
`skipIgnoredValue()`（消费值/colon、保 JSON 语法检查，不构造 Value、不限制忽略数值/代理项/
容器深度为 Value 规则）；现 `skipValue()` 直接 `readValue()`，若直接套用会连当前接受的
unknown=1e400 也多拒绝。字段解码/默认值/alias/sequence 仍由 L01 实现，不把自有 bug
转嫁 owner；公共 reader 缺口写入 BLOCKERS，先接口后消费，不复制第三套 JSON。

D10 口径已同步 BLOCKERS：两包正式获批，不再称未批准；不安装、不改变 F7 停放/PSNR 状态。

### R1 c7bd5d5ce 确认后的最小 typed -0 修复（V2-02 / X6-UD-0040；候选）

- R1 用本地锁定 serde_json1.0.149 / serde_derive/core1.0.228 亲读确认 typed -0
  拒绝、Value arbitrary_precision 另路接受；确认字段顺序/精确 IgnoredAny/struct sequence。
  R1 撤回旧 §11 把 preview 未知 x 深128拒绝视为等价的子项，不抹去其原 5pass 事实；
  preview bigint 两标题+probe、Paddle **Value** 深度子项仍保持签收范围。
- 在 F4 candidate `b6dc607f7` 尚未正常进入 main 时，先只修可独立的 known 整数字段：
  新 `typedI64`/`typedU64` 依据原文字面量拒绝 -0；Store 的 u8/i64/Option<i64>、
  OAuth expires_in、Preview usize/u32 改用它们。Value accessor 未改，不错误拒绝 Value
  路径的整数0。所有合法整数范围及 bigint 保真不变，未增 feature flag 或替身 reader。
- `codex-integer-width.test.ts` 原自加 “-0 is integer0 for u8/u64/i64” 是路径混淆，
  按 R1 §16 明确源码反证改为 typed 拒绝（CredentialStore / MalformedResponse /
  Preview 类型错误），并补 integer0 正常接受和真实 Gemini Value -0 输出0向量。
  原正确 IPC 舍入、内部精度、大整数/溢出拒绝断言不动。
- 被撤回的 preview 深度向量不是正确 Rust 拒绝断言，已改成 deep unknown 应接受的
  正确方向并显式 `it.skip`，理由是公共 IgnoredAny 候选待正常集成；不计 pass、不降
  整文件 TESTMAP。另补真实 OpenAI provider stream Value 深127接受/深128跳过的测试，
  与 Paddle/Value 的既有正确深度语义一致。未知字段首错修复仍属于 L01，不因此免责。
- F4 接缝候选只读核过并已向 C1 请求正常集成通知；不手动 merge 别的 lane，不复制
  scanner，不用旧 skipValue 顶替。整文档顺序、unknown/sequence 仍未修，不签 V2-03。
- 实际代码、测试和本节首版记录在协调者检查点 `d1dd22ed6`，后续描述性提交不冒充实现。
  `20261104160745-b76336` 三文件 57 passed / 1 pending skip、exit0；
  `20261104160748-74a870` Host 类型检查 exit0。skip 是已纠正方向、尚缺 typed
  IgnoredAny 生产接缝的预览未知深度用例；不是 Rust ignore/cfg，更不是通过。
  R1 `a0b6e80ba` 对 F4 候选仅作需求内静态认可，不继承 16pass 为 L01 签收。
- C1 后续纠正：原整 case 的 skip 也停掉了仍正确的 nested(127) 接受断言，已拆成
  活动的 depth127 测试和单独 pending 的 depth128 正确接受测试。不保留旧错误的128拒绝，
  不改 typed -0 / Value0 或 TESTMAP。窄作业 `20261104161947-52326a` 实际 1 passed、
  1 项显式 pending + 21 项标题过滤、exit0（Vitest 合计显示22 skipped，不能全算 pending）。
  F4 正常 main 接入后只解除该独立128 pending，并测领域入口。

### 续派独立小单元：Codex HTTP Value 正文的 UTF-8（X6-UD-0040，候选）

- 已先 merge main；`b6aa8f016`（main `fb463060d`）§5 五项自检全过。
  F4 IgnoredAny `b6dc607f7` 仍不是祖先，现 util API 无该方法；不复制候选或用旧 skipValue
  顶替。L02 新 raw-prompt/OCR 服务已读，但多模态高层/usage owner/native OCR 阻塞未解除。
- 原 Rust 证据：`openai_codex/manager.rs:276-280,734-738,784-788` 成功 usage/device
  authorization/device poll 正文按 `serde_json::from_slice::<Value>` 读取；解析失败分别
  为 MalformedResponse 的 usage/device authorization/device poll response；所有非成功
  正文（含 OAuth token 失败）按 `parse_error_body:1844-1845` 失败回 Value::Null。
- 当前反例先红：`20261104165812-422a72` 两失败/一通过/23 标题过滤，exit1。
  原始 0xff 放在 usage 的字符串内被 Buffer.toString 替换成 U+FFFD，错误地成功返回
  limitName="�"；0xff 放在 OAuth 400 错误正文的 note 内，错误地读到 invalid_grant
  并设 reauthRequired=true，而 Rust 整个 Value 解析失败应回 http_400/false。
  合法 UTF-8 U+FFFD 数据向量原本通过，须保持接受。
- 只修 Value 路径：manager 内部 `parseResponseValue(bytes)` 复用 F4 的
  `decodeUtf8Strict`/`Utf8DecodeError`，不重写 UTF-8 校验。失效字节返回解析失败标记，
  调用方仍走原 Rust 的 MalformedResponse 或非2xx Null 回退，不转换成 Network 错误。
  该面用于 usage、device authorization、device poll 以及 token 非2xx错误正文。
- 成功 OAuthTokenResponse 是 **typed struct**，不能对整个字节正文一律严格拒绝：
  未知字段 IgnoredAny 的 byte-string 忽略规则与 Value 不同。该分支仍保留原处理，
  其 known-field 原始 UTF-8/首错等作为后续 typed 原文解码残差，不声称本单元解决。
  没有更改 Usage 类型/跨 owner SQL/已签 preview/时间/typed -0 语义。
- 新测试全部经真实插件 HTTP/ctx/IPC：无效 usage/device code 正文拒绝；无效 OAuth
  错误正文不应逼迫重新认证；真实 device poll 必须先报 malformed 且不交换被修复的
  authorization code；合法 U+FFFD 仍接受。没有修改已有业务断言或增加外部包。
- 实际测试在协调者检查点 `2bd9e7e9b`；实际 manager 实现及 SPEC 在 `5b12dc109`。
  后续 finding 提交只记录 LANE，不冒充实现所在提交。
  `20261104170243-0260a8` 四文件 77 passed / 1 pending skipped、exit0；
  `20261104170243-ec83a5` typecheck:host exit0。仅待 F4 接入的128向量 pending；
  127活动、typed -0/Value规则/旧正确断言保留。未将提供方自检当独立签收。
- 读最新集成结果：F4 候选还因 `integration/src/stream-context.ts:220`、
  `qbank/src/question-import-service.ts:175` 对新增 arbitrary 数字分支的 `.value`
  类型检查失败而未合入。属于跨 owner 消费，不在 L01 改写；通知 C1/F4 精确消费位置，
  不把旧 skipValue 当替代方案。

### 窄审交接保留：复核服务故障期间暂停重复投递（C1 17:14:29 回执）

- HTTP Value UTF-8 候选的原归属不变：`5b12dc109` 是 manager 实现 + SPEC，
  `2bd9e7e9b` 是四个 HTTP 生产入口测试，`24df140c2` 仅 LANE 报告。
- 原作业证据保留，不重跑换回执：`20261104165812-422a72` 两失败/一通过/23标题过滤、
  exit1；`20261104170243-0260a8` 四文件77 passed/1 pending、exit0；
  `20261104170243-ec83a5` Host typecheck exit0；`24df140c2` 对 main `fb463060d`
  的五项 selfgate 通过。C1 已亲读取回这些结果，但仍仅为提供方证据，非 R1 独立签收。
- C1 确认 R1 新登记 PID 已退出，17:14:29 仍为 `provider.content-filter` 确定性拒绝，
  C2 同类失败；架构师处理服务侧诊断。此事不归因于本 lane 业务代码，不改变提示或模型
  规避拒绝，不自行重启/重派 failed R1，也不继续重复投递相同候选触发即时重试。
- 服务恢复确认后，沿原 SHA、原作业结果与既定窄审接续：preview 精度已签范围不重跑；
  Codex 时间四标题、typed -0/Value 三标题的原最小计划不扩；HTTP Value UTF-8 候选
  不扩为完整 decoder。成功 typed token 的原始字节/IgnoredAny/首错仍开，Usage 同批仍等。
- F4 union 两个 owner 的集成阻塞已有记录，本轮没有新增业务归因。仅保存交接，不启动
  runner、不重跑已过77/322，不把文档提交冒充新实现或新 selfgate。

### 自动质量反馈：未实现的128向量退回文档 pending

- `codex-integer-width.test.ts` 不再保留被禁用的 depth128 测试；正确接受向量、原 Rust
  源码依据、依赖和恢复条件完整移入 [PENDING.md](PENDING.md)，状态明确为 pending，
  不计执行或通过，不是改名伪装成活动测试。
- depth127 仍为活动用例；typed -0 / Value0、真正 Value 深度、preview bigint、HTTP
  字节边界的原正确断言不改；旧错误128拒绝不恢复。TESTMAP 仅追加非生成的 v2 回归
  pending 索引：该向量无原 Rust 测试 ID，不伪造行、不批量修改已有去向或 cfg/ignore。
- 前面1项 runtime skip的作业记录只是历史事实；当前 pending 在文档中，不再借测试
  运行器跳过表示。F4 正常 main 接缝可消费并完成领域实现后，恢复成活动断言再验证。
- 遵守 C1 服务故障期间交接纪律：不向 failed R1 重复投递，不重跑已过77/322换回执。
- 实际测试清理、PENDING.md 与 TESTMAP 补充索引在协调者检查点 `a88f1e3cf`。
  直接检查本文件已无禁用测试声明；用 ledger 的 `parseTestmapStatuses` 前后比较，
  246 个原 Rust 测试去向完全不变。窄作业 `20261104173340-1fa7ac` 四个活动标题
  4 passed / 22 标题过滤、exit0；22 项是过滤，不是显式 pending 或新通过。

### 续派 L01-03 字符串边界补充：协议值使用 Rust trim（候选）

- merge main 后 `9c9bd13d6`（main `e87727c09`）§5 五项自检全过；F4 IgnoredAny
  候选仍非祖先，不因等待它停止自有审读，也不复制共享代码。
- 原 Rust `llm_manager/mod.rs:3775-3776` 使用 `.trim().to_lowercase()`，其配置协议值
  在 :3990-3998 先归一化再判断显式协议；Codex prepare 在 `model2_pipeline.rs:4995-4998`
  据该结果拒绝非 Responses。公共 config 的协议字段是 string，NEL/BOM 均为合法输入，
  Rust trim 规则与 JS trim 不能互换。
- 先红作业 `20261104180336-31f870`：两新增生产服务测试失败、14标题过滤、exit1。
  NEL 包裹显式 CHAT 时 TS 未去 NEL，误入 Responses fallback 而成功；BOM 包裹 CHAT 时
  TS 去了 Rust 不去的 BOM，误把未知协议变成显式 CHAT 并拒绝。NEL 包裹 RESPONSES
  也保留了独立成功向量，防止只改拒绝分支。
- 修复只把 `src/openai-codex/prepare.ts::normalizeProtocolValue` 的 JS trim 换为已引用
  的共享 `rustTrim`，Unicode lowercase 原样保留（Rust 这里不是 to_ascii_lowercase）。
  不改路由优先级/完整注册表、认证/HTTP/Usage 公共类型或原断言，不重开既有签收。
- SPEC 同步清掉仍残留的“已签 Model2/OCR prepare 未交付”和“尾 CR 未修”旧描述；
  getter/raw-prompt/OCR 低层已发布与完整多模态 runtime 仍缺的边界分开写明。
  复核服务故障期间不向 failed R1 重复投递；保原 SHA/作业供恢复后窄核。
- 修后 `20261104180452-0615ce` 真实 Codex service 文件16 passed、exit0；
  `20261104180452-923586` Host 类型检查 exit0。原两个新反例先红结果不隐藏；
  不继承这些提供方结果为 R1 签收，也不重跑旧77/322只为确认回执。
- 准确归属：实现 `prepare.ts`、两项新测试和 SPEC 被协调者保存到 `ce1d2a14b`；
  `3f9882f8b` 仅 LANE 记录，不把其提交标题当成代码所在 SHA。

### 续派 L01-03 / X6-UD-0040：HTTP header / BOM 保真（候选）

- 本轮 `git merge main` 无新增，HEAD `49c1effbe` 与已通过 selfgate 一致，未为确认
  同一提交重复启动门禁。F4 IgnoredAny 仍非祖先，原 pending/同批事项不变。
- 源码：`model2_pipeline.rs:4723-4734` 的 Content-Type 先对整个值 `to_str()`，再取 MIME
  并 trim/ASCII 不区分大小写；任一非可见 ASCII（含参数里）都不桥接。`:4704` 为
  `String::from_utf8_lossy`，`:4746-4747` 为 `String::from_utf8`，均不删 BOM。
  JWT claims 在 `openai_codex/manager.rs:1343` 对 decoded bytes 直接 from_slice，
  leading BOM 不属于 JSON whitespace，应按原 `.ok()` 当无效 claims 忽略。
- 先红 `20261104183551-ec8c33` 三失败/16标题过滤、exit1：NBSP 包裹 MIME 被 JS trim
  误认 SSE；带 BOM 的 JSON 错误正文被修复后误取 custom_code 而非 http_400；带 BOM
  的唯一 SSE data 行被修复为有效事件，本应不完整错误却返回成功。
- 另锁 JWT 反例，`20261104183833-7cd579` 一失败/19标题过滤、exit1：BOM-prefixed JSON
  payload 中的 other-account 被误当有效 claims，刷新抛 AccountChanged；Rust 应忽略
  此无效 JSON claims、保留当前账户。没有放宽有效 claims 的账户切换检查。
- 修复：对完整 Content-Type 检查可见 ASCII/HTAB；合法 ASCII 上 MIME/大小写既有逻辑
  不变。lossy decoder 用 ignoreBOM=true **保留** BOM，仍允许修复失效 UTF-8（Rust
  此分支就是 lossy）；严格 SSE 与 JWT 复用现有 `decodeUtf8Strict`，不写新解码器。
  JWT 只将 Utf8DecodeError 作为原 `.ok()` 空值，其他异常不吞。无公共类型/SQL/新包变化。
- 四项新回归经真实插件 HTTP/ctx 路径，含 MIME 参数非ASCII、无BOM/失效UTF8但需
  保持lossy解析的对照，以及现有正常SSE和有效JWT账户校验；未修改原正确断言或TESTMAP。
  既有已签 preview、时间、typed -0 不重开；完整 typed 原文/IgnoredAny/sequence/Usage
  仍未决。复核服务恢复前保本节原SHA/结果，不重复投递 failed R1。
- 四项新增 HTTP/服务测试被协调者保存于 `e6fd1ff39`，生产实现另在后续提交，不能混报。
  修后 `20261104183958-327e7f` 三文件63 passed、exit0；
  `20261104183958-d17d41` Host typecheck exit0。中间 `183720-cf7ca6` 两文件31passed
  只覆盖前三项修复，不能代替含 JWT 向量的最终63条结果。
- 准确归属补记：生产 `response.ts` / `manager-values.ts` 与 SPEC 被协调者保存到
  `edd1ef6df`；`47cffacb1` 仅 LANE。四项测试仍在 `e6fd1ff39`。

### 续派 X6-UD-0040：Codex rate-limit NaN 仅在 IPC 编码 null（候选）

- 先 merge main，自检 `191d60ea4` / main `cce44494c` 五项全过。F4 原文 typed 接缝
  仍非祖先；128向量继续文档 pending，127活动，不借旧 skipValue 替代，不重复投递故障 R1。
- 原 Rust 支持输入：`openai_codex/manager.rs:1766-1771` 的 string `parse::<f64>`
  允许 NaN/inf，`:1710-1716` clamp 保留 NaN；`types.rs:179-185` used_percent 为
  Option<f64> 且仅 None 被省略。serde_json1.0.149 `ser.rs:169-178` 明确把 NaN/Infinity
  写为 JSON null（已亲读锁定版本源码，非 Rust 运行）。现生成 IPC DTO 也允许 nullable。
- 真实 HTTP/IPC 反例先红：`20261104191120-52a140` 一失败/26标题过滤、exit1；
  合法 `"used_percent":"NaN"` 返回内部 NaN 后，被 kernel JSON 检查拒绝，未能像 Rust
  正常返回 `usedPercent:null`。不能把此合法值改成解析失败或误当 None 省略。
- 新 `usage-wire.ts::codexUsageToWire` 只在 `openai_codex_usage` handler 编码已知 DTO，
  覆盖顶层 rateLimits 及全部 rateLimitsByLimitId 的 primary/secondary；原对象与内部
  NaN 不改。非有限百分比复制为 null，有限值及缺省键不改；不写通用 serializer，不改
  public type / kernel / SQL，不提前转换 Host 数值，不触碰 Usage 同批协议。
- 新 HTTP 生产入口向量区分 NaN 显式 null、正/负 infinity clamp 后100/0、没有百分比时
  保持省略；补生产 parser+wire helper 的不可变性向量，确认原 snapshot 仍为 NaN。
  没有删改旧正确断言、TESTMAP、typed -0、时间/preview 或既有诊断记录。
- 准确归属：helper 和两项新测试在协调者检查点 `e58c90aec`；真实 IPC 接线在
  `8f85b1005`。该提交仅 index.ts 两行变化，不冒充 helper/测试的来源。
  全部仍仅为候选，不签 rate-limit 内部完整 i64/u64 精度或完整 decoder。
- 修后 `20261104191427-65cccb` 三个相关文件65 passed、exit0；
  `20261104191427-a39f34` Host typecheck exit0。原 NaN/Inf 字符串接受规则未变，
  文档 pending 未计通过；不把提供方结果外推为独立复核签收。

### 续派 V2-02：Codex rate-limit 内部整数保持至 IPC（候选）

- 先 merge main，无新增，HEAD `b176eb231` 与已过 selfgate 一致，未重复同 tip 自检。
  F4 仍非祖先。此次处理已登记的 rate-limit 内部精度残差，不等 F4、也不单边改
  等待 L02 同批的 provider StreamEvent Usage 公共类型。
- 原 Rust `types.rs:179-185` 的 window_duration_mins 为 u64、resets_at 为 i64；
  `parse_rate_limit_window` 在 manager.rs:1710-1757 返回这些内部整数，根 fetched_at
  同为 i64。:1737 的饱和加法/除法与 :1745 的 signed fetched/1000 + seconds as i64
  不应先经过 Number。旧代码算术虽用 BigInt，返回内部 struct 前又立即 Number 化。
- 生产反例先红：`20261104192847-45ba1a` 一失败/28标题过滤、exit1；真实 HTTP→manager→
  命令 encoder 链输出的 windowDurationMins=9007199254740993 在进 encoder 前已变成
  9007199254740992。测试使用 **默认 call-through spy** 观察真实 encoder 入参，不提供
  替身结果，不绕过 HTTP/parser/encoder；先比实际数值，再比 bigint 类型，非单纯类型差。
- 新内部 `usage-state.ts` 复用原 DTO 字段结构但仅将三个整数域换 bigint；manager 和
  parser 返回精确 state。现有 usage-wire 只在实际 IPC command 边界转换整数和 fetchedAt，
  生成独立 DTO，不回写内部对象，原 NaN 编码也保留。无 generated/API/public type/SQL 改动。
- 新真实 IPC 向量同时检查内部2^53/+1可区分、u64MAX、i64MIN/MAX、u64MAX seconds as
  i64回绕、fetchedAt bigint及外部舍入；补生产 parser 的极限 signed fetchedAt 除法与
  wrapping 结果（固定字面预期，不以重复被测算法代替断言）。
- 既有 `usage_fixture_is_parsed_into_frontend_shape` 的原 Rust内部 u64值300仅换表示为
  300n，输入 fetched=1000000仅换为1000000n，语义/方向不变；NaN内部复制测试的1700
  同样换1700n。原真实 IPC 舍入、大整数拒绝、percent数值与NaN/None断言都未改。
  TESTMAP、文档pending和已签preview/时间/typed负零范围不动。
- 复核服务故障期间不重复投递 failed R1；保原SHA/红绿证据，恢复后仅窄审本内部精度项，
  不外推 provider usage/typed原文/unknown/sequence 等其他未决。
- 准确归属：内部 state/manager/parser/wire、新旧测试表示修正及 SPEC 都在协调者检查点
  `02d3c0ac9`，后续 finding 提交仅记录 LANE。原 Rust fixture 的1000000/Some(300)
  对应 `manager.rs:3221,3228`，数值与断言方向未改。
- 验证：`20261104193117-f6cbbc` 三文件66 passed、exit0；
  `20261104193117-8469ab` Host typecheck exit0。后来补入的 signed fetchedAt 极限算术
  向量由 `20261104193222-e2aa18` 单标题1 passed/29标题过滤、exit0 独立执行，不把前
  一个66条作业冒充已覆盖后补向量。不是独立 Rust 差分或 R1 签收。

### 续派 V2-03：预览 struct sequence 的领域分支（候选）

- 先 merge main 无新增，HEAD `6955bf100` 与已过 selfgate 一致，不重跑同 tip。
  F4 IgnoredAny 候选仍未正常 main；先做无需该 API 的实际 struct 序列分支，不停止自有
  领域工作，不用 legacy skipValue 顶替，不复制第三套 scanner。
- Rust 证据：AttachmentPreview/Page 为 `page_indexer.rs:17-50` 的普通 derive struct；
  R1 `c7bd5d5ce` 已确认 `de.rs:1820-1857` / derive struct_.rs:70-95 的序列入口，
  `[[],null,null,null]` 应接受。另亲读 serde_derive1.0.228 `de.rs:451-506,805-835`：
  seq 缺槽只有 #[serde(default)] 才补默认；无 default 的 Option 不自动补槽。因此
  Page 的第二槽 blob_hash 必须存在（null可），与 map 的 Option 缺失不同。
- 真实 ctx 服务先红 `20261104200709-8eeaa4` 两失败/5标题过滤、exit1：合法根序列被
  拒为 expected struct，空序列也没有走正确必填槽分支。
- `page-indexer.ts` 在现有领域 decoder 中按对象/序列选字段别名或下标，复用同一
  optionalString/typedU64/u32 校验，不投影为舍入后的新对象。声明顺序、default/必填、
  usize bigint 不变；已知字段先解码，后拒额外槽；原对象 alias/duplicate 分支不改。
- 两项新增真实 `ctx.llmMultimodal` 回归包含完整四/六槽、default尾槽、blob_hash 的
  map缺失与seq必填差别、2^53+1/u64MAX/u32MAX保真、长度/多余槽/首个坏已知槽、
  typed -0及u64越界拒绝。原正确测试、TESTMAP与文档pending均不改。
- 仍先整体 parseJsonExact 的事实未变：混合序列内的未知 map 字段、全篇语法错误与
  先前 typed 错误的竞争、错误字节位置仍待公共 reader 集成后实现，不把本合法序列
  分支候选扩成完整 typed decoder 签收；不解除128未知深度的文档 pending。
  reviewer服务故障纪律不变，不向 failed R1 重复投递，原证据保留等待恢复窄核。
- 实际领域实现、新测试及 SPEC 在协调者检查点 `a01a4c38a`，后续 finding 提交仅 LANE。
  修后 `20261104200904-67b820` 三文件38 passed、exit0；
  `20261104200904-d7231e` Host typecheck exit0。这里只是提供方验证，不继承 F4/R1
  其他向量签收，也不将文档 pending 计通过。

### 续派 V2-03：持久化会话 / OAuthTokenResponse 的序列分支（候选）

- merge main 无新增，HEAD `3d4a6877b` 与已过 selfgate 一致，不重复同 tip 自检。
  F4 原文接缝仍未正常 main；沿已确认的 struct sequence 继续自有领域实现，不复制
  scanner、不依赖旧 skipValue。没有改 public API/类型、SQL、Usage 同批或核准依赖。
- Rust `types.rs:9-26` 声明 StoredCodexSession 十字段；schema/access/refresh/expires/account
  必填，idToken 及最后四槽有 default。`manager.rs:94-103` TokenResponse 四字段，仅
  access_token 必填，后三槽 default。derive 的序列入口/default 原证据沿 R1 §16 与
  serde_derive1.0.228 源码，不重新把任意数组当合法结构。
- 先红 `20261104203144-836bdb` 两失败/32标题过滤、exit1：合法历史持久化序列被报
  credential_store_failed，合法 token 序列被报 MalformedResponse token response。
- Store 在原 object/array 容器上按字段名/声明下标读取，不投影丢失数字原文；u8/i64/
  Option<i64> 复用 typed 字段校验。已知布尔 null 不冒充缺省false，必填缺失/额外槽仍
  CredentialStore。保存仍复用原 lossless serializer，输出对象而非照搬输入数组。
- `decodeTokenResponse` 放于已有领域 values 模块，manager 成功响应调用它；对象原
  已知字段/重复/类型检查保持，序列按四槽读取并允许 default尾槽。所有结构错误先归
  token response，再做原 access_token 非空检查；只含空白的合法结构报 access_token，
  同时有额外槽则仍报 token response。非2xx Value/401/账户身份/refresh锁分支未改。
- 四项新增真实 ctx/IPC/HTTP 回归覆盖历史数组加载、canonical保存重读、全i64精度与
  metadata槽位、缺必填/额外/布尔null/浮点/-0拒绝，token短/满序列的默认和clamp生命周期，
  refresh/id字段缺省保留，以及空白access规则与结构校验顺序。原正确断言、TESTMAP、
  depth127活动与depth128文档pending不改。
- 仍先完整 Value 预解析；成功 token 的原始无效字节、合法未知字段 IgnoredAny、整篇
  语法与首错竞争仍开，不把本序列分支当完整 typed decoder。复核服务故障期间只保
  本节原SHA/红绿证据，不向 failed R1 追加即时重试。
- 准确归属：Store/manager接线及新测试在协调者检查点 `e8eaa277a`；token领域decoder、
  SPEC与负向测试pair的 readonly tuple类型修正在 `f630a612d`。后续 finding 提交仅LANE。
- 验证：`20261104203502-18f4ec` 四文件91 passed、exit0；之后增强metadata及保存回读
  断言的两正向标题由 `20261104203726-b5fc6c` 实际2 passed/32标题过滤、exit0补验，
  不把前91结果冒充已包含后加断言。最初 typecheck `203502-6c61e2` exit2（测试静态
  pair被推为可能undefined），加as const保持原用例和值后，`20261104204129-9b780b`
  typecheck:host exit0。均为提供方验证，非独立Rust执行/签收。
- 收尾 merge main `5b1b19055` 后发现 F3 recorder 外部条件确已解除：
  `storage/api.ts:668-680` 正式 LlmUsageService 与 `index.ts:157-165` 的实际提供者均在。
  BLOCKERS/USAGE-PRECISION 已更正，不再称“无正式提供者”。Usage 内部保真/u32算术/
  真实SQL与最终wire同批验证仍未完成；不因此擅自改停放中的 L02/L03 公共类型或重启会话。

### C1 限定新增：ToolCall 在提供方复制/序列化的数值损失（V2-02 / X6-UD-0040）

- 已先 merge main `9b3c18601`，工作区开工前干净；不越权写 L02/F2/L05，不自行派
  停放 L02。按 C1 归因：OpenAI **标准字符串** arguments 原样保留，首次确认 parse
  损失在 L02 `tool_calls.ts:81`；不是 L01 把该标准字符串 parse 掉。非标准对象在 L01
  虽已投影number，原文数字仍在 WeakMap，`structuredClone(tc)` 才丢旁带。
- Rust 依据：`providers/mod.rs:2773` base_input clone Value；`:2801-2811` 仅空白buffer
  且存在baseInput才取它，否则parse Value失败才{}，再serde_json::to_string；`:2792-2823`
  保签名先出/移除pending/工具事件顺序。arbitrary_precision 数字的 :de.rs938-953,
  1027-1059 保大整数/小数并规范化 exponent，不能把所有参数原文逐字回放当等价。
- 真实 adapter→ToolCall 先红 `20261104221604-20dc4e`：3 failed/1 passed、exit1；
  partial和baseInput的大整数变2^53，1.0/1E0变整数1，u64MAX近似、1e400变null；
  另发现合法buffer `null` 被 `?? {}` 误当失败。标准OpenAI字符串对照原已通过，保持原样。
- 修复只在自有分支：OpenAI发出值用精确clone；Anthropic baseInput在源holder/key捕获
  数字，存现有DbJson而非丢旁带副本；partial先走原Value接受校验，再复用
  `sync/api.ts` 的 parseJsonLossless/stringifyJsonLossless，不复制parser/serializer。
  null成功与undefined失败明确区分，非空坏JSON仍{}，不改baseInput/空buffer/签名顺序。
- json.ts 只增加从已记录原数字旁带投影到既有bigint/JsonFloat的读取，不造新通用JSON。
  api.ts仅增两个ToolCall专用函数：cloneProviderToolCall与stringifyProviderToolCall；
  StreamEvent的JsonValue联合未改，不能原生承载bigint/JsonFloat。完整输入/输出、使用
  时机与不能恢复已丢信息的限制见 TOOLCALL-PRECISION.md，明确普通clone/JSON.stringify
  后调用无济于事。跨owner消费仍未接，绝不只换clone便报模型→L05闭环。
- 六项新测试走真实ctx.llmAdapters：partial分片归并规范化数字/重复键；baseInput对象及
  根标量精度；scalar partial数值变体；坏/空buffer、null与签名工具顺序；标准字符串
  原样（含坏JSON增量）；非标准对象经公开接缝输出，再用已有共享lossless parser核
  bigint与JsonFloat类型。原正确业务断言、TESTMAP及其他协议未重写，未知args_json
  来源、未查协议、缺chatToolRuntime及L02/F2实际owner工作继续未决。
- 实际测试首版在检查点 `7aa600278`；核心投影/精确副本/Anthropic改动和首个非标准对象
  seam测试在 `09af85402`。后续公开出口、根标量partial补充测试及文档另记实际提交。
- 后续准确归属：根标量partial补充测试与 TOOLCALL-PRECISION.md 在 `dd9543354`；
  api.ts 的两项正式公开出口、SPEC/BLOCKERS/LANE 在 `0ddfb4d8e`，它不包含核心实现。
- 提供方验证：初修 `20261104221930-8ad82f` 三文件83 passed、exit0；含后补根标量用例
  的最终 `20261104222433-f86a00` 三文件84 passed、exit0；
  `20261104222433-1a5a60` Host typecheck exit0。原文源码审读，不伪称Rust执行；
  提供方绿不签跨owner链，服务未恢复前不向 failed R1 重复投递。

### WP-017 · B4/D16：AttachmentPreview typed reader（2026-11-05）

- 开工干净，检测到共享环境并行vitest；在本worktree fast-forward main至 `967f43c75`。
  `git show main:host/platform/util/api.ts` / `json-exact.ts` 已核实公开 JsonReader、IgnoredAny、
  endArray及enum原语。旧“等F4集成”条件已更正，两个preview结构没有enum字段。
- Rust全文依据：`dstu-llm/src/multimodal/page_indexer.rs:17-50,63-90`、
  `dstu-vfs/src/vfs/multimodal_service.rs:1378-1395`；锁定serde_derive1.0.228
  struct_.rs:266-325 / de.rs:451-506,805-835与serde_json1.0.149 de.rs:1072-1086,
  1820-1865,1910-1915。仅静态审读，未运行Rust。
- 文本入口按键序驱动F4 reader，别名重复先于重复值读取、null仍占槽、已知字段先于后续
  坏JSON/重复键；未知深层字段走skipIgnoredValue；固定序列槽满后endArray，额外坏值不读。
  usize仍bigint全u64域，u32才转number；typed负零/浮点拒绝与Value语义保持不同。
  原值级入口不能复原丢失token，不用它实现文本解码。
- 错误保留既有服务上下文及所有原断言，并附完整Rust风格Display/UTF-8行列与
  JsonSyntaxError cause。原Rust camelCase测试改从实际插件服务进入，原成功/长度/取值
  及legacy额外断言均保留。原深unknown128纠正后的pending向量恢复活动，127与真正Value
  深度断言保留；PENDING保留原撤回原因、原执行事实和本次红绿证据。
- 起点类型检查 `20261105140558-f7c102` exit0。起点测试排队后执行时已包含先写的六项
  新回归，生产实现仍旧：`20261105140558-9d4879` 42passed/6failed/0skipped、exit1；
  不能把它称为原始测试集失败。独立窄红作业 `20261105140945-6d857d` 6failed/35标题过滤、
  exit1。无Errors/unhandled报告，六项分别锁首错、unknown接受/词法、数组结束、null别名、深128。
- 首次修后 `20261105141327-8880db` 三文件48passed/0failed/0skipped，exit0，
  无Errors/unhandled报告。后补精确cause/Unicode位置用例由最终lane-gate覆盖，不能算入此48条。
- TESTMAP原246行去向不变、pending0→0；补充pending1→0，证据不是运行时skip。
  实际生产提供链 `index.ts:61 → service.ts:30 → parseAttachmentPreviewJson`；
  L12 `multimodal-service.ts:583` 仍调用自己parsePreviewJson，跨owner消费继续BLOCKERS登记。
  本包完成范围为L01真实公开入口；不宣称L12索引、Usage/ToolCall、系统OCR或独立R1签收完成。
- 中断续作：BLOCKERS提交 `07b4cab3d`（代码/测试/文档在检查点 `45ca6001b`、`2f0b76dd0`、
  `cebea0e38`、`f48f702a2`）。全lane `20261105142925-026286` 22文件361passed/1skipped
  （system-ocr平台skipIf，非本包）、exit0、无Errors；page-indexer 7项含cause/Unicode位置用例。
  ledger `20261105142354-73d878`、wiring `20261105142354-826923`（ported246，未接入0）、
  boundaries:strict `20261105142354-f0ddf4` 均exit0。merge main `1f3d621f0` → `35a99cfec`
  后lane-gate五项全绿。
