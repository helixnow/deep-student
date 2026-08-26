# Wave2-A r6 #5：过滤器面全面二检（consume_prefix 游标 + reasoning 独立过滤）

基线 tip：`4b784bb4`。结论三选一：**确认 ×2 + 补丁 ×1**——两项 R4 改动
（游标化、reasoning 独立过滤）二检通过；另在 `process_newline` 与 tail-hold
的交互中发现一处与模块契约相悖的明确 bug，按授权在
`model_special_tokens.rs` 内落地修复与回归测试源码。

## 1. 负例测试完整性 grep 核对（红线）

以下负例测试全部在位，一条未删、未改：

- `preserves_literal_tokens_in_prose`
- `preserves_literal_tokens_in_inline_and_fenced_code`
- `preserves_role_word_lines_that_are_not_bare_headers`
- `preserves_mid_stream_glued_closer_when_content_follows`
- anki 侧 `strip_model_special_tokens_preserves_literal_tokens_in_card_body` /
  `strip_model_special_tokens_keeps_non_whitelisted_content`（本轮未触碰
  `streaming_anki_service.rs`，其对 `MODEL_SPECIAL_TOKENS` 单源的 `use`
  引用亦核对在位）。

## 2. consume_prefix 游标（R4 #2）：确认

逐行复核 `input_cursor` / `pending_input` / `consume_prefix` / `compact_input`
四件套，未发现语义漂移：

- **char 边界不变量成立**：cursor 只按整 token（`token.len()`）、整 char
  （`ch.len_utf8()`）或 marker run 前进；marker run 的 `width` 是 char 计数，
  但 `` ` `` / `~` 均为单字节 ASCII，char 数 = 字节数，`consume_prefix(width)`
  传参正确。
- **compact 时机正确**：`process_available` 每趟收尾一次 `drain(..cursor)`，
  跨调用缓冲里只留被 hold 的不完整 token/marker 前缀，`process()` 入口
  cursor 恒为 0；`flush()` 走同一收尾；`reset()` 整体重建归零。
- **hold 判定与游标解耦**：`is_incomplete_token_prefix` / marker run 的
  「整段 pending 皆 marker」判定都作用于 `pending_input()`，与旧「drain 后
  剩余」逐字节等价。
- 回归测试 `large_single_chunk_keeps_semantics_with_cursor_consumption`
  （单大 chunk + char 边界撕两半一致性）在位未改。

## 3. reasoning 独立过滤（R4 #1）：确认

三处接线与 r4-reasoning-filter.md 声明逐项一致：

- `llm_adapter.rs`：`reasoning_wrap_token_filter` 独立实例（:196/:255）；
  `on_reasoning_chunk` 保序 `touch_activity` → `enable_thinking` 门 →
  `reasoning_content_observed` 置位 → 空 `text` 早退 → 独立过滤 → 空结果
  早退（:1177–:1201）；`finalize_all_inner` 先冲 reasoning 尾巴直接归
  thinking（不回灌 `think_tag_buffer`），再 `flush_think_tag_buffer` /
  `finalize_thinking`（:405–:430）；`reset_stream_state` 同步 `reset()`（:598）。
- `variant_adapter.rs`：同构（字段 :28、finalize :126–:143、reset :438、
  `on_reasoning_chunk` :489–:499），空结果早退不建块不发事件。
- `stream_filter_core.rs`（未接线骨架）：`process_reasoning` / `flush` /
  `reset` 挂点与两适配器语义一致。
- content 路径（`wrap_token_filter` → `think_tag_buffer`）与 reasoning 路径
  无共享状态，行前缀互不污染——独立实例动机成立。

## 4. 补丁：空白行导致 tail-hold 原样泄漏（明确 bug）

### 现象

模块头部契约：粘在流末、其后**直到 flush 只有空白**的 close token
（`<|im_end|>` / `<|end_of_box|>` / `<|endoftext|>`）应删除，空白保留。
`tail_hold_raw` / `tail_hold_stripped` 双缓冲即为此设计。但
`process_newline` 里「继续 hold」的分支要求 `!line_is_candidate`，只覆盖
紧跟 closer 的**第一个**换行；该换行把 `line_is_candidate` 置回 `true`
后，下一个空行/纯空白行的换行落入 else 分支，调用 `release_tail_hold`
把 closer **原样放行**：

- `"回答完毕<|im_end|>\n\n"` → 泄漏为 `"回答完毕<|im_end|>\n\n"`
  （契约应得 `"回答完毕\n\n"`）。
- 不一致对照：同为纯空白尾巴的 `"…<|im_end|>\n "`（空格进
  `line_candidate`，flush 走 `tail_hold_stripped`）能正确剥离。
- 连带：`"正文<|im_end|>\n\n<|im_start|>assistant\n继续"` 中间隔空行的
  续写头场景，closer 同样泄漏——尽管后随 header 已证明它是 stop-token
  失败尾巴。

`release_tail_hold` 自身文档写明放行条件是「more content arrived」，空行
不是 substantive content，三处文档同向，判定为明确 bug 而非设计取舍。

### 修复（`process_newline`）

`line_is_candidate` 分支新增中间臂：候选行无 token、且 `tail_hold_raw`
非空（此时行内容必为纯空白；hold 非空蕴含 `code == None`，因为开围栏走
`begin_literal_content` 会先放行 hold）→ 把候选空白 + 换行追加进
`tail_hold_raw` / `tail_hold_stripped` 双缓冲，继续 hold，不放行。

语义边界核查：

- 后随 substantive 内容仍原样放行（`"字面<|im_end|>\n\n下一段正文"` 不变，
  `begin_literal_content` → `release_tail_hold` 顺序未动）——负例语义无回退。
- 后随续写头则 `drop_tail_hold_tokens` 丢 token 留空白（上述连带场景
  修为 `"正文\n\n继续"`）。
- hold 为空时新臂不触发，原 else（含既有 `release_tail_hold` 空调用）
  行为逐字节不变。

### 回归测试（仅写源码，本轮禁跑）

新增 `strips_tail_glued_closer_followed_by_blank_lines_at_flush`：
`\n\n` / `\n \n` 两种纯空白尾巴断言 token 删、空白留；附一条「空行后仍有
正文则原样放行」的负例断言，钉住不误伤。

## 5. 红线自查

- 负例测试一条未删未改（§1）。
- 改动仅限 `model_special_tokens.rs`（`process_newline` 一处分支 + 一个
  新测试）；两适配器、`stream_filter_core.rs`、anki 侧零改动。
- 未执行 cargo/npm/测试；未 commit（按任务约束）。
