# 48 号审计：Anki QA 修复分支隔离性核查（issue #327 相关）

- 审计日期：2026-08-26
- 审计方式：纯只读 git 对照，未运行任何构建/测试，未触碰任何代码
- 对照对象：
  - 修复分支 `origin/cursor/0824-fix-anki-qa-cde6`（tip `d9a341ee`）
  - 官方基线 `origin/cursor/0824-cde6`（tip `2d41ea8b`）

## 核查过程与证据

### 1. 分支拓扑

- `merge-base origin/cursor/0824-cde6 origin/cursor/0824-fix-anki-qa-cde6` = `2d41ea8b`，恰好等于官方基线 tip。
- 即修复分支是官方基线的**严格后代**，领先 2 个提交，官方基线对修复分支的反向领先为 0（`log fix..official` 为空），不存在分叉。

### 2. 修复分支独有提交

```
d9a341ee Format Anki QA persistence test
e1a33f1b Fix disabled Anki QA flag persistence
```

`git branch -r --contains` 对两个提交的结果均**只有** `origin/cursor/0824-fix-anki-qa-cde6` 一个分支——修复未进入 `origin/cursor/0824-cde6`，也未进入 `origin/main` 或任何其他远程分支。

### 3. 改动范围是否只动 `streaming_anki_service.rs`

`git diff --stat origin/cursor/0824-cde6..origin/cursor/0824-fix-anki-qa-cde6`：

```
 src-tauri/src/streaming_anki_service.rs | 71 ++++++++++++++++++++++++++++++---
 1 file changed, 66 insertions(+), 5 deletions(-)
```

仅 1 个文件，确认只动 `src-tauri/src/streaming_anki_service.rs`。

### 4. 改动内容摘要（只读复核）

- 生产逻辑：将 `qa_pass_enabled == false` 时移除 `QA_FLAGS_FIELD` 的动作，从字段清洗阶段（`merge_flags` 之前）挪到 `merge_flags` **之后**，避免 lint 把 `_qa_flags` 写回，从而修复「关闭 QA pass 时留痕仍被落盘」的缺陷；校验本身仍照常执行。
- 测试：新增 `parse_and_save_card_honors_qa_pass_flag_persistence_contract`，覆盖 disabled / enabled / default 三种模式下 `_qa_flags` 的返回与落盘契约，并断言默认值保持开启。
- 改动与提交信息（"Fix disabled Anki QA flag persistence"）一致，无夹带无关改动。

## 结论

1. **改动范围符合预期**：修复分支相对官方基线的全部差异只涉及 `src-tauri/src/streaming_anki_service.rs` 一个文件（+66/-5），无其他文件被触碰。
2. **修复未进官方**：两个修复提交（`e1a33f1b`、`d9a341ee`）仅存在于 `origin/cursor/0824-fix-anki-qa-cde6`，未合入 `origin/cursor/0824-cde6`，也未出现在 `origin/main` 或任何其他远程分支，隔离性完好。
3. **明确不要 merge 该隔离分支**：`cursor/0824-fix-anki-qa-cde6` 应继续保持隔离状态，等待评审/QA 流程决定去向，本审计不做也不建议任何合并操作。
4. **本轮不改代码**：本轮为纯只读静态审计，未修改任何代码，未执行任何 git 写操作。
