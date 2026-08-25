# 0824 Anki / Flashcards 发布回归审计

## 范围

基线为 `v0.9.44`（`1cf6cabc`，2026-08-09），审计当前 0824 分支的：

- 只读 Generative UI 闪卡；
- `cardAgent.startGeneration` 非阻塞制卡入口；
- `ChatV2AnkiAdapter` / `anki_tool_call` 退役状态；
- 空卡库 0% 进度、统计页调度器位置、任务台加载错误态；
- 旧卡片库 / `mistakes.db` 升级；
- critic `_qa_flags`、图像遮挡 `_occlusion` 与中英文 locale key。

`v0.9.44` 的四库 schema tuple 为：

```text
vfs=20260808, chat_v2=20260806, mistakes=20260724, llm_usage=20260525
```

## 审计结论

### 已符合发布裁决

1. `flashcard-preview` 保持只读。Generative UI 不注册
   `save-to-library` handler；持久化仍统一走 `anki_cards` 管线。
2. 划词制卡与文本制卡均调用 `cardAgent.startGeneration`。该入口只启动
   `start_enhanced_document_processing` 并返回 `documentId`，不在前端阻塞等待卡片收集。
3. `ChatV2AnkiAdapter`、`useChatV2Anki` 与 `anki_tool_call` 监听均未恢复。
4. 空卡库时 Today 目标数为 0、进度为 0%，显示建库引导，不显示 100% 或
   “今日全部完成”。
5. 正常统计态下 `SchedulerSettingsSection` 位于统计面板之后；统计加载失败时，
   独立的调度设置仍可使用。
6. Anki 任务台区分首次加载失败、真实空列表与“刷新失败但保留旧数据”三种状态，
   并提供重试。
7. `_qa_flags` 与 `_occlusion` 没有拆成新列，仍作为字符串值保存在
   `anki_cards.extra_fields_json`。前后端解析契约一致。
8. `en-US` / `zh-CN` 的 `anki.json`、`flashcards.json` leaf key 集合一致；
   本次增加自动 parity 与关键发布 key 门禁。

### 发现并修复的升级缺陷

历史 `anki_cards` schema 中 `tags_json`、`images_json`、
`extra_fields_json` 可为 NULL。旧 writer、导入或同步数据因此可能产生 NULL，
但当前卡片库和 FSRS 入队正文读取把这些列直接解码成 Rust `String`。

后果：

- 一张旧卡即可让 `list_anki_library_cards` 整页失败；
- 同一张卡即使能被选中，`fsrs_enqueue_cards` 也会在构造复习正文时失败；
- Agent 卡片库读取有相同风险。

修复采用两层防护：

1. `V20260824__normalize_anki_card_optional_json.sql` 在升级时仅把 NULL / 空串
   归一化为 `[]` 或 `{}`，并补齐可空来源字段；
2. 运行时查询与 mapper 继续容忍 NULL，防止升级后又从导入 / 同步收到旧形态数据。

迁移不会改写任何有效 `extra_fields_json`，所以 `_qa_flags`、`_occlusion`
及其他模板字段原样保留。

## 回归覆盖

- Rust 数据库回归：构造 NULL `tags_json` / `images_json` /
  `extra_fields_json` 卡片，验证 UI library、Agent library 与 FSRS enqueue 均可读取。
- 生产迁移 fixture：从 `v0.9.44` 精确 schema tuple 升级到 HEAD，验证 NULL
  JSON 被归一化，并通过 oracle 校验 `_qa_flags` / `_occlusion` 内容不变。
- Locale 回归：验证 `anki` / `flashcards` 中英文 leaf key 完全一致，并固定
  任务加载错误、模板渲染错误、空卡库、调度器、critic 与 occlusion 关键 key。
- 既有定向覆盖继续验证只读闪卡、`startGeneration`、无 `anki_tool_call`、
  空卡库 0%、调度器位于统计之后及任务台错误 / stale 状态。

## 验证命令

```bash
node scripts/check-migrations.mjs
pnpm vitest run \
  tests/vitest/generative-ui/flashcardDisplayOnly.test.ts \
  tests/vitest/anki/cardforge/CardAgent.test.ts \
  tests/vitest/flashcards/todayScreenEmptyLibrary.test.tsx \
  tests/vitest/flashcards/StatisticsScreen.test.tsx \
  src/features/anki-tasks/__tests__/AnkiTasksApp.loadError.test.tsx \
  tests/vitest/flashcards/localeKeys.test.ts
cargo test --manifest-path src-tauri/Cargo.toml \
  legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue
cargo test --manifest-path src-tauri/Cargo.toml --features data_governance \
  migration_compat -- --nocapture
```
