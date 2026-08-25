# 0824 Step 15 后不变量复审

## 基线与结论

- 审计分支：`cursor/0824-invariants-step15-cde6`（仅本文档；产品代码零改动）。
- 官方基线（审计时 live tip，与指定基线一致）：`origin/cursor/0824-cde6` @
  `2b6488a6be592720c2a2878cb287323ca0113d97`。
- 该 tip 已包含 Step 15 的 generative-ui skill 本地化提交
  `414abdc7 fix(i18n): localize the generative-ui builtin skill name and description`
  （仅 `src/locales/{en-US,zh-CN}/skills.json` 各 +2 行），以及记录文档
  `2b6488a6 docs: record Step 15 generative UI locale landing`。
- 方法：逐项读取当前 tip 源码并做负向字符串/跟踪文件检查；下列证据均来自
  `2b6488a6` 的隔离 worktree。
- **结论：18/18 PASS。** 另：generative-ui skill 的 locale keys 在 en-US 与
  zh-CN 的 `skills.json` 中均存在（name + description），且消费方查找路径与
  key 结构一致。

## Step 15 专项：generative-ui locale keys

- `src/locales/en-US/skills.json:395`：
  `builtinNames.generative-ui = "Generative UI"`。
- `src/locales/en-US/skills.json:450`：
  `builtinDescriptions.generative-ui = "Emit structured generative UI intents (cards, progress, action bars) rendered by the component registry. No HTML/JS."`。
- `src/locales/zh-CN/skills.json:395`：
  `builtinNames.generative-ui = "生成式界面"`。
- `src/locales/zh-CN/skills.json:450`：
  `builtinDescriptions.generative-ui = "输出结构化生成式界面意图（卡片、进度、操作栏等），由组件注册表渲染，禁止 HTML/JS。"`。
- 消费方一致：`src/features/chat/skills/utils.ts:67,81` 分别按
  `skills:builtinNames.<id>` / `skills:builtinDescriptions.<id>` 查找并回退；
  `src/features/chat/skills/__tests__/builtinSkillLocalization.test.ts:19-28`
  要求两个 locale 的 `builtinNames` 覆盖全部 builtin skill id。
- **判定：locale keys present = yes（en-US ✓ / zh-CN ✓，name 与 description 均在）。**

## 18 项逐条证据

### 1. PASS — pipeline hooks 仍默认注册

- `src-tauri/src/chat_v2/pipeline/hooks.rs:139-142`：
  `default_pipeline_hooks()` 返回
  `Arc::new(ApprovalGateHook)` 与 `Arc::new(TaskAuditHook)`。
- `src-tauri/src/chat_v2/pipeline.rs:243`：
  `hooks: hooks::default_pipeline_hooks(),`，生产 pipeline 构造仍接线。

### 2. PASS — `GenerativeUiExecutor` 在且注册

- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:44-48`：
  `pub struct GenerativeUiExecutor;` / `pub fn new() -> Self`。
- `src-tauri/src/chat_v2/pipeline.rs:347`：
  `executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()));`。

### 3. PASS — H prompt-cache freeze 路径完整

- `src-tauri/src/chat_v2/pipeline/tool_loop.rs:39,105-110` 仍定义
  `freeze_tool_schema_order_for_prompt_cache` 与
  `freeze_tool_schemas_for_prompt_cache`；生产调用在 `:985`。
- `src-tauri/src/chat_v2/pipeline/helpers.rs:1014-1015` 明确
  “必须复用上一进程已发出的 tools 前缀字节序”且
  “读取失败降级为空基线”；`:1043-1050` 用 append-only merge，
  “绝不覆盖已建立的内存前缀序”。
- `src-tauri/src/llm_manager/model2_pipeline.rs:1143,1157` 的
  `prompt_cache_key_is_stable_and_never_random` /
  `prompt_cache_key_only_targets_openai_affinity_endpoints` 守卫仍在。

### 4. PASS — `utf8_stream` 仍有生产调用方

- `src-tauri/src/utils/sse_buffer.rs:1,128,138`：
  `use crate::llm_manager::utf8_stream::Utf8StreamDecoder;`，且
  `SseEventBuffer` 持有并构造 `decoder: Utf8StreamDecoder`。
- 生产 `SseEventBuffer::new()` 调用仍见
  `providers/mod.rs:4688`、`llm_manager/model2_pipeline.rs:1290,4816`、
  `llm_manager/mod.rs:7767`、`streaming_anki_service.rs:1200`、
  `translation/pipeline.rs:1151`、`qbank_grading/pipeline.rs:658`、
  `essay_grading/pipeline.rs:1317`、`vlm_grounding_service.rs:994`。

### 5. PASS — `model_special_tokens` 在，#200 旧实现未回流

- `src-tauri/src/utils/mod.rs:5`：`pub mod model_special_tokens;`；
  `model_special_tokens.rs:107` 定义 `ModelWrapTokenStreamFilter`。
- 生产接线仍见 `chat_v2/pipeline/llm_adapter.rs:200,254`、
  `variant_adapter.rs:24,52`、`tool_loop.rs:553` 与
  `multi_variant.rs:814,1192`，均走
  `ModelWrapTokenPolicy::for_provider_model` 门控。
- 负向检查：`SpecialTokenStreamStripper` 在 `src/`、`src-tauri/` 零命中。

### 6. PASS — Generative UI 闪卡只读

- `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:1-5`：
  “只读闪卡预览”且“持久化统一由 anki_cards 管线负责”。
- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx`
  对 `onClick` / `onPress` / `save` / `persist` / `invoke` 零命中，
  仅渲染预览内容。
- `src/features/generative-ui/blocks/index.ts:90` 仅注册
  `type: 'flashcard-preview'` 的预览组件；该 feature 内
  `save_to_library` / `saveToLibrary` 零命中。

### 7. PASS — 无生产 `ChatV2AnkiAdapter`

- `src/features/chat/services/selectionCardGeneration.ts:10` 与
  `src/components/anki/cardforge/index.ts:28` 只作为退役说明提及。
- 其余命中仅
  `src/features/anki/generateCardsFromText.ts:49`（退役注释）、
  `selectionCardGeneration.test.ts:108`（注释）与
  `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`
  的负向断言；不存在文件、import、实例化或生产调用。

### 8. PASS — 制卡生产入口走 `cardAgent.startGeneration`

- `src/components/anki/cardforge/engines/CardAgent.ts:411` 定义
  `async startGeneration(...)`。
- `src/features/chat/services/selectionCardGeneration.ts:121` 与
  `src/features/anki/generateCardsFromText.ts:50` 均为
  `await cardAgent.startGeneration({...})`。

### 9. PASS — 通用附件 200MB / 图片 50MB

- `src/features/chat/core/constants.ts:180,187-190`：
  `ATTACHMENT_MAX_SIZE = 200 * 1024 * 1024`、
  `ATTACHMENT_IMAGE_MAX_SIZE = 50 * 1024 * 1024`，图片选后者。
- `src/features/chat/resources/types.ts:265,271`：
  `IMAGE_SIZE_LIMIT = 50MB`、`FILE_SIZE_LIMIT = 200MB`。
- `src/features/chat/components/AttachmentUploader.tsx:198,389`：
  图片上限为 `Math.min(maxSize, ATTACHMENT_IMAGE_MAX_SIZE)`；
  `src-tauri/src/vfs/repos/attachment_repo.rs:143-144` 后端同为
  `MAX_IMAGE_BYTES = 50MB` / `MAX_FILE_BYTES = 200MB`。

### 10. PASS — Finder 每宿主分桶

- `src/features/learning-hub/stores/finderStore.ts:377,388,412,416` 定义
  `DEFAULT_FINDER_HOST_ID` / `FINDER_HOST_IDS`，仅 `files` 被
  `HOSTS_SHARING_DEFAULT_BUCKET` 映射到 default。
- `finderStore.ts:1213` 以 `Map<string, FinderStoreApi>` 按解析后的
  bucket 取建 store。
- `tests/vitest/learning-hub/finder-host-buckets.test.ts:105` 锁定：
  “every declared host its own bucket, except files which shares default”。

### 11. PASS — qbank 描述压缩与 `daily_target` 并存

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:161-162` 的
  `builtin-qbank_list` 使用单行压缩描述：
  “分页列出用户的题目集（Low，只读）……单次最多 20 条”。
- `tests/vitest/chat-v2/token-budget.test.ts:139,197-200` 保留
  `MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6_800` 预算门禁。
- `qbank-tools.ts:746` 保留
  `daily_target: { type: 'integer', minimum: 1, maximum: 50 }`；
  `src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3605` 校验并转发，
  `question_bank_service.rs:2847` 以 `unwrap_or(10).max(1)` 计算。

### 12. PASS — tombstone 正确解析物理对象并保留共享引用

- `src-tauri/src/data_governance/sync/mod.rs:11396` 定义
  `download_assets_manifest_before_tombstones`，调用在 `:12066`，
  即 tombstone 前先读未过滤资产清单。
- `sync/mod.rs:9797`：
  `is_content_addressed_asset_object` 只接受资产对象前缀；
  `:12124-12128` 仅在活跃清单仍引用同一 `object_key` 时
  `has_live_reference` 并保留对象。
- `src-tauri/tests/sync_scenarios_tests.rs:2891` 保留回归
  `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`。

### 13. PASS — WebDAV 路径单次编码与同空间解码

- `src-tauri/src/cloud_storage/webdav.rs:176-180` 的 `build_path_url`
  明确“先解码 base 片段，交由 push 统一做单次编码”。
- `webdav.rs:602-610` 的 `extract_relative_key` 明确：
  “把 href 路径与 base 路径统一解码成人类可读形式后比较”。

### 14. PASS — S3 endpoint normalize 仍保守

- `src-tauri/src/cloud_storage/s3.rs:73-74` 明确：
  “仅当 host 是已知 provider 的 `{bucket}.{service-host}` 形式时剥离 bucket”，
  “自建域名和 path-style endpoint 不做猜测性改写”。
- `s3.rs:101` 仅在 `is_known_provider_service_host(rest)` 成立时改 host；
  白名单在 `s3.rs:115` 起。

### 15. PASS — FTP 550 严格分类、歧义 fail-closed

- `src-tauri/src/cloud_storage/ftp.rs:273-284`：
  `is_not_found_error` 先要求状态码 `550 | 501`，再要求
  `no such file` / `does not exist` 等明确 missing 语义。
- `ftp.rs:293` 明确无法归类的 550
  “必须按真实错误上抛（fail-closed）”。
- `ftp.rs:1325` 的
  `test_unclassifiable_550_is_not_treated_as_missing` 仍锁定该行为。

### 16. PASS — HPIAS 会话隔离

- `src/stores/hpiasSessionSlice.ts:1-3`：
  “活跃会话仍写 store 顶层字段；外会话事件只更新 sessions[id]”。
- `src/stores/researchStore.ts:247-268` 对不同 `session_id`：
  “只写入 sessions[id]，不覆盖活跃顶层字段”，写 slice 后立即 `return`。

### 17. PASS — Rust ingress 恰为 18 块白名单

- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42` 的
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 明列从 `stat-card` 到 `table`
  的 18 项。
- `generative_ui_executor.rs:114` 以
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES.contains(&block_type)`
  在入口拒绝未知类型。

### 18. PASS — 无虚构模型；NOTICES 唯一权威仍在 `legal/`

- `src-tauri/src/llm_manager/builtin_vendors.rs:1681-1693` 负向遍历
  `BUILTIN_MODELS`：拒绝 `claude-haiku-5` 和 `mythos`，并正向要求
  `claude-haiku-4-5`。
- `src/utils/__tests__/apiCapabilityEngine.test.ts:122`：
  `findModelRecordById('claude-haiku-5')` 必须为 `undefined`。
- `git ls-files legal/THIRD_PARTY_NOTICES.txt public/legal/THIRD_PARTY_NOTICES.txt`
  只输出 `legal/THIRD_PARTY_NOTICES.txt`；`public/legal/` 不存在。
  `scripts/generate-third-party-notices.mjs:16` 与
  `src-tauri/tauri.conf.json:62` 也都引用根目录 `legal/`。

## 最终判定

**18/18 PASS；generative-ui locale keys（en-US / zh-CN，name + description）
全部存在且与消费方查找路径一致。** Step 15 只新增两个 locale 文件各 2 行与
一份记录文档，未触碰任何被审计路径，未发现回流或退化。
