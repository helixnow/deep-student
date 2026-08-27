# R4 #8 评审：过滤器保守哲学未放宽（#1/#2/#3 三案全确认，一处陈述翻案）

评审人：R4 #8（claude-fable-5-thinking-high）。只写本文档，不改产品，不 commit。

## 0. 评审基线与快照说明

- 枝 tip：`6069675e`（与远端 `origin/cursor/0824-wave2-agent-cache-a875` 一致）。
- 评审期间（2026-08-26 15:52–16:00 UTC）#1/#2/#3 与本人**共用同一工作树并行写入**，
  改动以未提交 diff 形式陆续出现。本文结论基于对每份 diff 的逐行快照审查；
  截稿时各文件工作树 blob 指纹（`git hash-object`，供 ledger 收口时比对是否又变）：

| 文件 | 截稿 blob |
|---|---|
| `src-tauri/src/utils/model_special_tokens.rs` | `c0144ba9` |
| `src-tauri/src/chat_v2/pipeline/llm_adapter.rs` | `470ae5cf` |
| `src-tauri/src/chat_v2/pipeline/variant_adapter.rs` | `ce4652e7` |
| `src-tauri/src/chat_v2/pipeline/stream_filter_core.rs` | `5e3d2aa5` |
| `src-tauri/src/streaming_anki_service.rs` | `75ad640a` |
| `src-tauri/src/translation/pipeline.rs` | `fd04ad34` |
| `src-tauri/src/essay_grading/pipeline.rs` | `5b0b8ea4` |

若合枝时 blob 与上表不符，按 §6 的五分钟复核清单重跑即可，不必重读全文。

## 1. "保守三形态"的定义溯源（评审依据）

- 原始提交 `b0bf113d`（fix(chat): safely filter leaked model wrapper tokens）的模块头明文：
  token 仅在三种形态下删除——**(a) 行首外层包装**（`<|im_start|>` / `<|begin_of_box|>`
  出现在任何正文之前）、**(b) 纯 token 逻辑行**、**(c) 与先前已剥包装配对的闭合 token**。
  除此之外一律保留，明确拒绝全局字符串替换。
- Step 22 `daf5b78e` 增加两个**窄化扩展**（非放宽）：续写头
  `行首 <|im_start|> + 角色词 + 行尾` 整行剥除，以及粘在**流尾**的闭合 token 剥除；
  同时把保留面（What is NOT removed）写死为四条：散文中段字面引用、inline/围栏代码、
  中流粘连闭合符后仍有正文、角色词行带更多内容。
- 守护性负例测试即任务卡点名的 `preserves_literal_tokens_in_prose` 等（见 §5 清单）。

评审标准：任何改动若 (1) 扩大删除形态、(2) 收窄保留面、(3) 删除/弱化负例测试、
(4) 引入全局替换式清理，即为"放宽"，需翻案。

## 2. #1（reasoning 独立过滤器）——**确认，未放宽**

diff 面：`llm_adapter.rs`（cbff0ee5→470ae5cf）、`variant_adapter.rs`（d98d75b4→ce4652e7）、
`stream_filter_core.rs`（骨架顺手填实）。自述文档 `r4-reasoning-filter.md`。

逐条核实：

- **未新增任何删除形态**：三处挂点全部复用 `ModelWrapTokenStreamFilter` 本体，
  过滤器自身语义零改动（#1 未碰 `model_special_tokens.rs` 的状态机）。这是**覆盖面
  扩展**（reasoning 通道从裸转发改为过过滤器），不是形态放宽——任务卡明令项。
- **独立实例**：`reasoning_wrap_token_filter` 与 content 路径 `wrap_token_filter`
  以同一 `wrap_token_policy` 各自新建，不共享行前缀/围栏状态。共享实例才是真正的
  放宽风险（两路交错会污染行首判定，把正文行误判成 token 行），#1 的理由成立。
- **policy 门未动**：非 GLM/Qwen 路由 `Disabled`，`process()` 恒等直通——其他
  供应商的 reasoning 不受影响。
- **空 chunk 早退保留**：LLM 侧 `touch_activity → enable_thinking 门 →
  reasoning_content_observed 置位（仍在空判之前，"字段是否出现"语义不变）→
  空 text 早退 → 过滤`（工作树 :1177-1201 实测与自述一致）；变体侧同构。
- **content 路径一行未改**：两适配器 `on_content_chunk` → `wrap_token_filter` →
  `think_tag_buffer` 链路 diff 零触碰，`<think>` 状态机 / 最早匹配 / 不完整前缀
  保留 / HTML 负例语义原样。
- **finalize 尾巴**：reasoning 过滤器 `flush()` 尾巴直接归 thinking（累积 +
  THINKING chunk），**不回灌** `think_tag_buffer`——正确，reasoning 通道不参与
  `<think>` 状态机，回灌反而会让 reasoning 残尾被当 content 解析。时序在
  `flush_think_tag_buffer()` / `finalize_thinking()` 之前，块未关先补尾，成立。
- **重置**：LLM 侧 `reset_stream_state`（外层重试）与变体侧 `reset_for_new_round`
  均补了 `reset()`，无跨轮泄漏。

非阻塞观察（不构成翻案）：finalize 补尾走 `ensure_thinking_started` /
`get_thinking_block_id`，依赖"优先返回已结束 thinking 块 ID"的既有语义
（llm_adapter.rs :536 注释）——与 content 尾巴的既有兜底对称，风险等同现状，不新增。

## 3. #2（常量单源 + 游标化）——**确认，未放宽**

diff 面：`model_special_tokens.rs`（ed5bf902→c0144ba9）、`streaming_anki_service.rs`
（585d22d2→75ad640a）。自述文档 `r4-tokens-cursor.md`。

- **token 清单五项一字未增删**（`begin_of_box / end_of_box / im_start / im_end /
  endoftext`），仅可见性 `const` → `pub(crate) const` + doc 注释。清单不变 ⇒
  删除形态的匹配面不变。`pub(crate)` 是两个使用点的最小可见性，未选 `pub`，正确。
- **模块头 What IS / NOT removed 两节零删改**（diff 删除行核对：仅机械改写行 +
  const 可见性行，无文档行、无测试行）。
- **游标化逐字节等价**：`consume_prefix` 由 `input.drain(..byte_len)`（每字符
  memmove 尾部，大 chunk O(n²)）改为 `input_cursor += byte_len`；主循环所有
  `self.input` 读取改经 `pending_input()`（= `&input[cursor..]`，与旧"drain 后
  剩余"等价）；`compact_input()` 每趟 `process_available` 收尾一次性回收，
  故 `process()` 入口 cursor 恒 0、跨调用只留 hold 的不完整前缀。`flush()` 走
  同一收尾，`reset()` 整体重建归零。控制流、hold/early-break 判定全部未动——
  这是纯性能改写，无语义面。
- **anki E 域算法零改动**：`streaming_anki_service.rs` 仅删本地重复表改
  `use` 单源（两表内容本就逐项相同），`contains_only_model_special_tokens` /
  `strip_model_special_tokens` / `error_content_is_repairable` 函数体与其全部
  测试原样。"只能丢纯 token 残片、不能全局替换"的原注释保留。红线达标。
- **新增测试是加严不是放宽**：`large_single_chunk_keeps_semantics_with_cursor_consumption`
  在 2000 行大 chunk 上同时断言正例（外包装剥离）与**负例**（每行中段字面
  `<|im_end|>` 后随正文必须原样保留），并在 char 边界撕两半断言与单 chunk 一致。
- **process_newline 复核结论正确**：inline-code 行末重置系 Step 22 `daf5b78e`
  已修（含回归测试 `unpaired_backtick_does_not_disable_filtering_past_the_line`），
  工作树代码与测试均在位，#2 不重复改，仅书面确认——核实无误。

## 4. #3（翻译/作文出口挂接）——**确认，未放宽**（截稿时已见两出口，豁免文档未见）

diff 面：`translation/pipeline.rs`（13f8f5e7→fd04ad34）、`essay_grading/pipeline.rs`
（a77cfa2a→5b0b8ea4）。

- 两处均为**同源同策略**：`ModelWrapTokenStreamFilter::new(for_provider_model(...))`
  挂在各域唯一的流式内容咽喉（SSE `ContentChunk` → `on_chunk`），流末 `flush()`
  冲尾。未自造清理逻辑、未做任何 replace、未改过滤器本体。非 GLM/Qwen 路由
  `Disabled` 恒等直通，其他供应商零影响。与 #1 同理属覆盖面扩展，非形态放宽。
- 作文侧注释点明 chunk 双消费（前端展示 + `<score>` 标签解析）故在源头过滤，
  翻译侧点明三调用方（run_translation 分段 / candidates / chat_popover）共此咽喉，
  挂一处全覆盖——盘点逻辑成立。
- **截稿时未见**：非流式 `call_unified_model_2` 出口（`knowledge_executor.rs:76`、
  `rag_extension.rs:1385` 等）的挂接或书面豁免，#3 的盘点文档也尚未落盘。
  这不是放宽（现状 = 维持原样），但 ledger 收口时应核对 #3 最终文档对每个
  非流式出口给出"挂接"或"为何不会泄漏"的书面结论。可接受的豁免理由示例：
  出口产物只进内部结构化解析（JSON/schema 修复层已有 wrapper 剥离）而不进
  用户可见渲染。

## 5. 负例测试完整性核对（任务卡红线，逐条 grep 实测）

`src-tauri/src/utils/model_special_tokens.rs`（截稿工作树行号）：

| 测试 | 行 | 状态 |
|---|---|---|
| `disabled_policy_preserves_even_a_token_only_stream` | :653 | 在，未改 |
| `preserves_literal_tokens_in_prose` | :681 | 在，未改 |
| `preserves_literal_tokens_in_inline_and_fenced_code` | :691 | 在，未改 |
| `preserves_role_word_lines_that_are_not_bare_headers` | :771 | 在，未改 |
| `preserves_mid_stream_glued_closer_when_content_follows` | :803 | 在，未改 |

`src-tauri/src/streaming_anki_service.rs`：
`strip_model_special_tokens_keeps_non_whitelisted_content`（:3535）、
`strip_model_special_tokens_preserves_literal_tokens_in_card_body`（:3541）均在，未改。

`git diff HEAD` 删除行中**无任何 `fn` 行**——三个任务合计零测试删除；新增测试
一条（#2 大 chunk 回归，含负例断言）。红线达标。

## 6. 翻案项（一处，陈述性，非语义）

**R3 "骨架未接线/死代码占位"的陈述不实，且被 R4 #1 文档沿袭。**

- `r3-adapter-parallel.md` :6 与 `stream_filter_core.rs` 头注释 :10-11 声称
  "`pipeline.rs` 尚未声明 `mod stream_filter_core;`，属死代码占位"。
  实际 R3 落地提交 `6069675e` 自己就在 `pipeline.rs` 加了
  `pub(crate) mod stream_filter_core;`（现 :99）——骨架自 R3 起**就参与编译**，
  仅靠文件头 `#![allow(dead_code)]` 压未使用告警。R3 提交与自家文档互相矛盾。
- `r4-reasoning-filter.md` :53 沿袭了同一错误（"骨架仍未接线（pipeline.rs 未声明
  mod）"）。"未接线"（两适配器尚未改调本核心）这半句仍然成立，"未声明 mod"半句不成立。
- 影响评估：无语义风险——模块编译通过与否会被 CI 兜住，且 #1 顺手填实的
  `process_reasoning` 与适配器内联实现语义一致。但 R5 接线负责人若按 R3 文档
  先去"补 mod 声明"会撞重复声明。**处置建议**：R5 接线时顺手把
  `stream_filter_core.rs` 头注释 :10-11 与两份文档的该句改为"mod 已于 R3 声明
  （pipeline.rs:99），`#![allow(dead_code)]` 待接线后移除"。

除此之外无翻案：#1/#2/#3 的产品改动本身全部通过 §1 的四条放宽判据。

## 7. ledger 收口时的五分钟复核清单（防截稿后追加改动走样）

1. `git hash-object` 比对 §0 表格；不符则只看新增 diff。
2. `rg "fn preserves_|fn disabled_policy_preserves" model_special_tokens.rs` 应为 5 条；
   anki 侧两条 `strip_model_special_tokens_*` 在位。
3. `rg "MODEL_SPECIAL_TOKENS: &\[&str\]"` 全仓应只剩 utils 一处定义，且仍为 5 token。
4. `git diff <base> -- '*model_special_tokens.rs'` 删除行不得含 `//!`（模块头保留面）
   与 `fn `（测试）。
5. 各新挂点（reasoning×2、translation、essay）grep 确认均为
   `ModelWrapTokenStreamFilter::new(...for_provider_model...)` + 流末 `flush()`，
   无任何 `replace(` 式清理；#3 文档对非流式出口有挂接或书面豁免。
