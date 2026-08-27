# Wave2-E R5-05：qbank-tools 工具契约补齐（description 微调）

- 轮次：0824 Wave2-E 第 5 轮「工具契约」
- 独占文件：`src/features/chat/skills/builtin-tools/qbank-tools.ts`
- 约束：仅改 description 一两句，未动 runtime / inputSchema / 提示词正文；未跑测试，未 commit

## 改动内容

只改了两条 description，各补一处 runtime 已实现但描述缺失的返回契约：

1. **`builtin-qbank_get_question_history`**：在返回字段列举后补一句——
   `old_value/new_value 为 {text,truncated}（2000 字符截断）或 null`。
   依据 runtime（`src-tauri/src/chat_v2/tools/qbank_executor.rs` 的
   `execute_get_question_history` → `bounded_optional_text`）：有值时输出
   `{ text, truncated }`（2000 字符边界），无值时输出 `null`，而非裸字符串。
   旧描述只写 `old/new_value`，模型容易把它当纯文本直接引用。

2. **`builtin-qbank_update_question`**：在既有截断说明处加半句——
   `fieldsTruncated 标明截断（fieldsTruncated 可含 structured_data 嵌套路径）`。
   依据 runtime：bounded question/previous 的 `fieldsTruncated` 由
   `truncate_json_strings` 递归遍历整个 JSON 生成，`structured_data` 内的长字符串
   会以嵌套路径形式出现（如 `structured_data.pairs[0].left`），不限于顶层字段名和
   `options[i].content`。落点选 update_question 是因为它返回 question 与 previous
   两份 bounded 对象，且 structured_data 是它的核心可写字段。

## 未做的事

- history 条目本身没有 `fieldsTruncated`（runtime 只对 bounded question 附加），
  因此没有把嵌套路径的说明写进 get_question_history 的 description；
- 未在其他提及 `fieldsTruncated` 的工具（toggle_favorite、generate_paper、
  search_questions 等）重复展开该说明，避免恢复大段重复文案；
- 未改任何 inputSchema、runtime 代码或提示词正文。
