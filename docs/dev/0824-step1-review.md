# 0824 Step 1 第三轮复查与后续回归清单

复查基线：`origin/cursor/0824-cde6` @ `8361e6b7`（2026-08-24）。
复查分支：`cursor/0824-step1-review-cde6`。本报告不改 `main`，也不把主题仓 C
的后续提交抢推到 0824。

## 1. Step 1 合并结论

### `6f636ad5`（#213 optimization）

- `package-lock.json` 与 `package.json` 的根依赖表一致；优化仓删除的冗余生产依赖
  没有被后续合并复活。
- `legal/THIRD_PARTY_NOTICES.txt` 是唯一权威副本，
  `public/legal/THIRD_PARTY_NOTICES.txt` 保持删除；这与
  `scripts/generate-third-party-notices.mjs`、
  `scripts/check-license-compliance.mjs` 和 `src-tauri/tauri.conf.json` 的资源映射一致。
- NOTICES 内记录的 `Cargo.lock` SHA256
  `a5c5138be46a1d765a06aa348b97cd2eb4ef75d07741f47d60a9e3f52f255ae3`
  和 `package-lock.json` SHA256
  `cccf1dc958a0a9b52f0da2fc8c1bf0a485e3255e08a9116b33cf12b43394f8d4`
  与工作树文件逐字匹配。
- `src-tauri/src/lib.rs` 中 #213 的 MCP feature gate、VFS Lance 单例/后台 worker、
  `chat_v2_export_session_jsonl` 注册均保留；没有被 #214 的模块注册覆盖。
- `src-tauri/src/chat_v2/pipeline.rs` 中 #213 的拆分模块、compaction、hooks 状态和
  executor 顺序在 Step 1 当前 tip 上自洽。

### `23090166`（#214 Generative UI）

- `package.json` 把 `zod` 作为直接生产依赖（`^4.4.3`）是正确语义：
  `src/features/generative-ui/schema.ts` 以及多个运行时 block 直接导入它。
  `package-lock.json` 根依赖与 `node_modules/zod@4.4.3` 条目一致。
- `legal/THIRD_PARTY_NOTICES.txt` 从 1847 增至 1848 个组件，并包含
  `NPM: zod@4.4.3`/MIT 正文；旧 public 副本没有复活。
- `src-tauri/src/lib.rs` 只在 #213 结果上增加 `pub mod hpias`，#213 初始化与命令
  注册没有丢失。
- `src-tauri/src/chat_v2/pipeline.rs` 在 catch-all `GeneralToolExecutor` 之前注册
  `GenerativeUiExecutor`，并把 `render_generative_ui` 映射到
  `block_types::GENERATIVE_UI`；#213 的 hook/compaction 路径仍在。
- `src/features/learning-hub/views/IndexStatusView.tsx` 把当前 `summary` 的
  `totalResources/indexedCount/pendingCount/failedCount/indexingCount` 传给
  `IndexStatusGenerativeBriefing`，动作继续复用 `handleUnifiedIndex` 与 `loadData`，
  没有另造索引写路径。
- `src/components/TranslateWorkbench.tsx` 用 `dstuMode.resourceId` 发布流式快照；
  `src/features/learning-hub/apps/views/TranslationContentView.tsx` 同时把 `node.id`
  作为 `resourceId` 和 `TranslationGenerativeBriefing.streamKey`，发布/订阅 key
  对齐，节点切换仍由 `key={node.id}` 隔离。

### `82fc755a`（Rust E0716 修复）

`src-tauri/src/chat_v2/tools/generative_ui_executor.rs` 先把
`extract_question_from_intent(&intent)` 绑定到 `extracted_question`，再借用
`as_deref()`。这只延长临时 `Option<String>` 的生命周期；title 优先、问题兜底和
HPIAS 事件参数语义均未改变。

当前静态审查没有发现需要回写 0824 的 Step 1 逻辑修复。

## 2. 主题仓 C i18n 差异

0824 **尚未包含**主题仓 C 的 `423dc82a`
（`fix(generative-ui): wire hardcoded Chinese guard texts to existing i18n`）。
该提交涉及：

- `src/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers.ts`
- `src/features/generative-ui/utils/dispatchCanvasAIEditRequest.ts`
- `src/features/notes/hooks/useAIEditState.ts`
- `src/locales/en-US/generativeUi.json`
- `src/locales/zh-CN/generativeUi.json`
- `src/locales/en-US/notes.json`
- `src/locales/zh-CN/notes.json`

正式移植由主题仓 C/总集成代理完成。移植时还应跑
`src/features/notes/hooks/__tests__/useAIEditState.i18n.test.ts`、
`tests/vitest/generative-ui/builderI18n.contract.test.ts` 和
`tests/vitest/generative-ui/generativeUiI18n.parity.contract.test.ts`。

## 3. 后续逐仓合入回归清单

### H cache

主题分支 `cursor/0824-theme-cache-cde6` 当前版本会改动：

- `src-tauri/src/chat_v2/pipeline.rs`
- `src-tauri/src/chat_v2/pipeline/helpers.rs`
- `src-tauri/src/chat_v2/pipeline/history.rs`
- `src-tauri/src/chat_v2/pipeline/llm_adapter.rs`
- `src-tauri/src/chat_v2/pipeline/multi_variant.rs`
- `src-tauri/src/chat_v2/pipeline/persistence.rs`
- `src-tauri/src/chat_v2/pipeline/prefix_snapshot_tests.rs`
- `src-tauri/src/chat_v2/pipeline/prompt.rs`
- `src-tauri/src/chat_v2/pipeline/tool_loop.rs`
- `src-tauri/src/chat_v2/pipeline/variant_adapter.rs`

重点：该主题分支 tip 的 `pipeline.rs` 已看不到 Step 1 的 `pub mod hooks`、
`default_pipeline_hooks()`、`GenerativeUiExecutor` 和 `render_generative_ui` 映射。
合 H 时不能整文件取 H；必须同时保留 H 的
`microcompact_anchors/frozen_tool_schema_orders/prefix_snapshot_tests`，以及 0824 的
hook 链、Generative UI executor/块类型映射、compaction 与 memory-flush 状态。
`tool_loop.rs` 要同时保留 cache token 记账和 `before_tool/after_tool` hook 调用。

### A wrapup

冲突后至少逐个确认：

- `src/i18n.ts`
- `src/locales/en-US/generativeUi.json`
- `src/locales/zh-CN/generativeUi.json`
- `src/locales/en-US/notes.json`
- `src/locales/zh-CN/notes.json`
- `src/locales/en-US/workbench.json`
- `src/locales/zh-CN/workbench.json`
- `src/__tests__/i18n.source.test.ts`
- `src/features/notes/hooks/__tests__/useAIEditState.i18n.test.ts`
- `tests/vitest/generative-ui/builderI18n.contract.test.ts`
- `tests/vitest/generative-ui/generativeUiI18n.parity.contract.test.ts`
- `tests/vitest/harness/react-i18next-mock-stability.test.tsx`

A 会批量修改两种语言的大量 namespace，不能用整目录覆盖 0824；en-US/zh-CN
必须成对保留 #214 的 `generativeUi` 注册和 `423dc82a` 的待移植 key。测试合并时
保留 A 的 a11y/i18n source 契约，也保留 `tests/vitest/generative-ui/` 全目录。

### B cloud-sync

实现冲突面：

- `src-tauri/src/cloud_storage/config.rs`
- `src-tauri/src/cloud_storage/ftp.rs`
- `src-tauri/src/cloud_storage/mod.rs`
- `src-tauri/src/cloud_storage/repo_check.rs`
- `src-tauri/src/cloud_storage/s3.rs`
- `src-tauri/src/cloud_storage/sync_lease.rs`
- `src-tauri/src/cloud_storage/sync_manager.rs`
- `src-tauri/src/cloud_storage/traits.rs`
- `src-tauri/src/cloud_storage/webdav.rs`
- `src-tauri/src/data_governance/commands_sync.rs`
- `src-tauri/src/data_governance/sync/tombstone.rs`

必须验证 FTP 550 tombstone 仍按“对象不存在”收敛，WebDAV 列举先解码再归一化，
S3 自定义 endpoint/bucket/path-style 判定没有退回旧实现，且
`get_auto_sync_config` 返回完整持久化状态。至少保留并跑
`src-tauri/tests/sync_provider_contract_tests.rs`、
`src-tauri/tests/sync_r06_delete_resolve_tests.rs`、
`src-tauri/tests/sync_r10_provider_contract.rs` 和
`src-tauri/tests/sync_r11_autosync.rs`。

### D anki

高风险文件：

- `src-tauri/src/streaming_anki_service.rs`
- `src-tauri/src/enhanced_anki_service.rs`
- `src-tauri/src/chat_v2/tools/anki_executor.rs`
- `src-tauri/src/chat_v2/tools/chatanki_executor.rs`
- `src-tauri/src/chat_v2/tools/chatanki_transform.rs`
- `src-tauri/src/cmd/anki_connect.rs`
- `src/features/chat/anki/index.tsx`
- `src/services/ankiApiAdapter.ts`
- `src/features/chat/plugins/events/ankiCards.ts`
- `src/features/chat/plugins/blocks/ankiCardsBlock.tsx`

`StreamingAnkiService::parse_and_save_card` 已调用 `insert_anki_card`，随后前端预览的
“保存到卡片库”又会经 `saveCardsToLibrary` → `save_anki_cards`。合并后必须证明
第二次操作幂等：同一批 N 张卡前后 DB 卡片数仍为 N、持久 ID 不漂移、不会生成
第二份内容或让已删除卡复活；`cardIdMappings/duplicatedIds/skippedIds` 要被当作
成功而不是“0 张保存”错误。另需保留 A 对 `streaming_anki_service.rs` 的特殊模型
token 清理，以及 D 的 QA flag/原始生成快照/遮挡字段。

### F subapp + G mobile

共同冲突面：

- `src/features/chat/components/InputBar.tsx`
- `src/features/chat/components/input-bar/InputBarUI.tsx`
- `src/features/pdf/components/EnhancedPdfViewer.tsx`
- `src/features/pdf/components/TextbookPdfViewer.tsx`
- `src/features/notes/NotesContextPanel.tsx`
- `src/features/notes/NotesCrepeEditor.tsx`
- `src/features/notes/components/NotesEditorToolbar.tsx`
- `src/features/workbench/apps/notes/NotesWorkspaceApp.tsx`

`InputBarUI.tsx` 以 F 的发送阻断提示/运行态为主体，重放 G 的移动触控尺寸；不得
用 G 整文件覆盖 F。两个 PDF viewer 要同时保留 F 的 selection/save-as-note
流程和 G 的移动触控/布局。

G 明确删除 legacy notes 路径，包括
`src/features/notes/DndFileTree/`、
`src/features/notes/NotesHome.tsx`、
`src/features/notes/NotesSidebarV2.tsx`、
`src/features/notes/PreviewPanel.tsx`、
`src/features/notes/preview/` 和
`src/features/notes/reference-selector/`。删除应保持，不要因 F 对
`src/features/notes/reference-selector/ReferenceSelector.tsx`、
`src/features/notes/components/NoteTagsEditor.tsx` 的修改而复活旧树；F 的新能力要迁到
`src/features/workbench/apps/notes/`。最终用 `rg` 确认生产代码没有引用上述删除路径。

## 4. 每次合入后的统一门禁

```bash
npm ci
npm run version:generate
npm run licenses:check
npm run typecheck
npx vite build
cargo check --manifest-path src-tauri/Cargo.toml --lib
```

只要 `package.json`、`package-lock.json` 或 `src-tauri/Cargo.lock` 变化，就必须重跑
`npm run licenses:generate`，确认 `legal/THIRD_PARTY_NOTICES.txt` 的两个 lock 哈希
更新，并确认 `public/legal/THIRD_PARTY_NOTICES.txt` 没有复活。

## 5. 本轮门禁实测

| 门禁 | 结果 |
|---|---|
| `npm ci` | 通过，按 lock 安装 1192 packages |
| `npm run licenses:check` | 通过，`[license-compliance] OK` |
| `npm run typecheck` | 通过，0 个 TypeScript 错误 |
| `npx vite build` | 通过（仅既有 circular-chunk/dynamic-import/chunk-size 警告） |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Rust stable 1.98.0 下通过；22 条既有 warning |
| Step 1 定向 vitest | 6 files / 30 tests 全通过 |

定向 vitest 覆盖
`src/features/learning-hub/components/__tests__/IndexStatusGenerativeBriefing.test.tsx`、
`tests/vitest/learning-hub/TranslationGenerativeBriefing.test.tsx`、
`tests/vitest/generative-ui/translationStreamBridge.test.ts`、
`tests/vitest/generative-ui/generativeUiI18n.parity.contract.test.ts`、
`tests/vitest/generative-ui/builderI18n.contract.test.ts` 和
`tests/vitest/generative-ui/generativeUiRustMapping.contract.test.ts`。

环境初始 Cargo 1.83.0 无法解析 lock 中依赖的 edition-2024 manifest；仓库 CI 使用
stable。本轮切换到与 CI 一致的 stable 1.98.0，并按 Linux CI 安装 GTK/WebKit 与
PDFium 前置资源后，使用上表中的原命令复跑通过。该过程没有产生仓库内容变更。
