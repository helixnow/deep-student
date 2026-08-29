# Wave2-A r4 #2：MODEL_SPECIAL_TOKENS 单源 + consume_prefix 游标化

分支 tip 基线：`6069675e`。红线遵守情况：负例测试一条未删、`streaming_anki_service.rs`
E 域算法函数体零改动、未跑 cargo/npm/测试（本轮禁令）。

## 1. 常量表提升为 crate 单源

- `src-tauri/src/utils/model_special_tokens.rs`：
  `MODEL_SPECIAL_TOKENS` 由模块私有 `const` 提升为 **`pub(crate) const`**，
  并补充 doc 注释声明其为 crate 内唯一 token 清单来源。
  未选择 `pub` + 再导出：该常量没有 crate 外消费者，`pub(crate)` 是能满足
  两个使用点的最小可见性。
- `src-tauri/src/streaming_anki_service.rs`：删除本地重复表（原 :45–:51），
  改为 `use crate::utils::model_special_tokens::MODEL_SPECIAL_TOKENS;`。
  原 doc 注释（#58 / #187 / 「不能做全局字符串替换」的取舍说明）降级为普通
  `//` 注释原样保留在 `use` 之上。
  **算法函数体一行未动**：`contains_only_model_special_tokens` /
  `strip_model_special_tokens` / `error_content_is_repairable` 及其全部测试
  （含 `strip_model_special_tokens_preserves_literal_tokens_in_card_body`）
  逐字节保持原样，仅常量的解析目标从本地表换成 utils 单源（两表内容本就
  逐项相同，语义零漂移）。

## 2. consume_prefix 游标化（消除 O(n²) 前端 drain）

原实现（:289）每消费一个 token/字符就 `self.input.drain(..byte_len)`，
每次 drain 都要 memmove 整个剩余尾部——对一个大 chunk 是 O(n²)。

新实现：

- 结构体新增 `input_cursor: usize`（`input` 内首个未消费字节的偏移，
  永远落在 char 边界上——只按整 token / 整 char 前进）。
- `consume_prefix` 只做 `self.input_cursor += byte_len`，O(1)。
- 新增 `pending_input()`（`&self.input[self.input_cursor..]`），
  `process_available` 主循环里所有对 `self.input` 的读取改经它，
  与旧的「drain 后剩余」逐字节等价。
- 新增 `compact_input()`：在 **每次 `process_available` 收尾** 一次性
  `drain(..cursor)` 回收已消费前缀（任务卡允许的「末尾 compact」方案），
  故缓冲里跨调用只留被 hold 的不完整 token/marker 前缀，且 `process()`
  入口处 cursor 恒为 0，`push_str` 无需搬移。`flush()` 走同一收尾路径；
  `reset()` 整体重建，天然归零。

单句概括：**`consume_prefix` 从"每字符 drain 前端"改为 O(1) 游标前进 +
每趟 `process_available` 结束时一次 `compact_input` 回收，逐字节语义与旧
实现等价。**

## 3. 大 chunk 回归测试（只写源码，未执行）

新增 `large_single_chunk_keeps_semantics_with_cursor_consumption`：
2000 行、每行含中线字面 `<|im_end|>`（后随正文，必须原样保留）的大正文，
外裹 `<|begin_of_box|>…<|end_of_box|>`（必须剥离）；断言单大 chunk 结果，
并在 char 边界处撕成两半再断言与单 chunk 一致（compaction 不得漏发/重发
被 hold 的字节）。本轮禁跑测试，源码待后续轮次统一执行。

## 4. process_newline 重置 inline-code：复核结论 = 已修，不再动

Step 22（`daf5b78e`，`fix(llm): clean <|im_start|>assistant continuation
headers and tail-glued closers`）已在 `process_newline` 开头加入
`if matches!(self.code, Some(MarkdownCode::Inline { .. })) { self.code = None; }`
（流式 CommonMark 近似：行内 code span 不跨行），并带回归测试
`unpaired_backtick_does_not_disable_filtering_past_the_line`。
现状核对：代码与测试均在位，本轮 **不重复修改**，仅作此书面确认。

## 5. 负例测试完整性核对

`preserves_literal_tokens_in_prose`、
`preserves_literal_tokens_in_inline_and_fenced_code`、
`preserves_role_word_lines_that_are_not_bare_headers`、
`preserves_mid_stream_glued_closer_when_content_follows`、
anki 侧 `strip_model_special_tokens_preserves_literal_tokens_in_card_body` /
`strip_model_special_tokens_keeps_non_whitelisted_content`
全部保留，未改动一条。
