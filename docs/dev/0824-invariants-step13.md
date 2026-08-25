# 0824 Step 13 后不变量复审

## 基线与结论

- 审计分支：`cursor/0824-invariants-latest-cde6`（仅本文档；产品代码零改动）。
- 官方基线（审计时 live tip）：`origin/cursor/0824-cde6` @
  `1f567a56dd20c4ce56c72fe49e9efb36d1a5eb62`。
- 该 tip 已包含 Step 13：`bf8ab827 fix(cloud): resume repo-check downloads on WebDAV and desktop S3`，并包含此前 S3 Range GET、上传后大小回验与四类 PUT 后 GET 回读提交。
- live tip 相比 `188500e0` 只新增 Step 14 盘点文档
  `1f567a56 docs: record step 14 check with no new #177 unique content`，产品树未变。
- 方法：逐项读取当前 tip 源码并做负向字符串/跟踪文件检查；下列证据均来自 `1f567a56`。
- **结论：18/18 PASS。** Composer* 拆分、G 的 44px / safe-area / Android back，以及 #177 的 reread / size-verify / Range GET 也全部 PASS。

## 18 项逐条证据

### 1. PASS — pipeline hooks 仍默认注册

- `src-tauri/src/chat_v2/pipeline/hooks.rs:138-143`：
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

- `src-tauri/src/chat_v2/pipeline/tool_loop.rs:39-40,105-110` 仍定义
  `freeze_tool_schema_order_for_prompt_cache` 与
  `freeze_tool_schemas_for_prompt_cache`；生产调用在 `:985-988`。
- `src-tauri/src/chat_v2/pipeline/helpers.rs:1013-1016` 明确：
  “必须复用上一进程已发出的 tools 前缀字节序”且
  “读取失败降级为空基线”；`:1043-1045` 用 append-only merge，
  “绝不覆盖已建立的内存前缀序”。
- `src-tauri/src/llm_manager/model2_pipeline.rs:1143,1157` 的
  `prompt_cache_key_is_stable_and_never_random` /
  `prompt_cache_key_only_targets_openai_affinity_endpoints` 守卫仍在。

### 4. PASS — `utf8_stream` 仍有生产调用方

- `src-tauri/src/utils/sse_buffer.rs:1,125-138`：
  `use crate::llm_manager::utf8_stream::Utf8StreamDecoder;`，且
  `SseEventBuffer` 持有并构造 `decoder: Utf8StreamDecoder`。
- 生产 `SseEventBuffer::new()` 调用仍见
  `providers/mod.rs:4688`、`llm_manager/model2_pipeline.rs:1290`、
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
- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55`
  只渲染 `front` / `back` / `tags` / `deckName` 的 `Card` 与 `Badge`，
  无按钮、事件 handler 或持久化调用。
- `src/features/generative-ui/blocks/index.ts:89-93` 仅注册
  `type: 'flashcard-preview'` 的预览组件；该 feature 内
  `save_to_library` / `saveToLibrary` 零命中。

### 7. PASS — 无生产 `ChatV2AnkiAdapter`

- `src/features/chat/services/selectionCardGeneration.ts:10-11` 明确：
  “该适配器已随 Chat V2 工具桥退役删除”。
- `src/components/anki/cardforge/index.ts:25-29` 同样把
  `ChatV2AnkiAdapter / useChatV2Anki` 标为已整体删除。
- 全部命中仅为上述退役说明和
  `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`
  的负向断言；不存在文件、import、实例化或生产调用。

### 8. PASS — 制卡生产入口走 `cardAgent.startGeneration`

- `src/components/anki/cardforge/engines/CardAgent.ts:411-434` 定义
  `async startGeneration(...)`，通过后端
  `start_enhanced_document_processing` 非阻塞启动。
- `src/features/chat/services/selectionCardGeneration.ts:121` 与
  `src/features/anki/generateCardsFromText.ts:50` 均为
  `await cardAgent.startGeneration({...})`。

### 9. PASS — 通用附件 200MB / 图片 50MB

- `src/features/chat/core/constants.ts:180,187-190`：
  `ATTACHMENT_MAX_SIZE = 200 * 1024 * 1024`、
  `ATTACHMENT_IMAGE_MAX_SIZE = 50 * 1024 * 1024`，图片选择后者。
- `src/features/chat/resources/types.ts:265,271`：
  `IMAGE_SIZE_LIMIT = 50MB`、`FILE_SIZE_LIMIT = 200MB`。
- `src/features/chat/components/AttachmentUploader.tsx:197-199`：
  图片上限为 `Math.min(maxSize, ATTACHMENT_IMAGE_MAX_SIZE)`；
  `src-tauri/src/vfs/repos/attachment_repo.rs:143-144` 后端同为
  `MAX_IMAGE_BYTES = 50MB` / `MAX_FILE_BYTES = 200MB`。

### 10. PASS — Finder 每宿主分桶

- `src/features/learning-hub/stores/finderStore.ts:377-416` 定义
  `DEFAULT_FINDER_HOST_ID` / `FINDER_HOST_IDS`，仅 `files` 被
  `HOSTS_SHARING_DEFAULT_BUCKET` 映射到 default。
- `finderStore.ts:1213-1226` 以
  `Map<string, FinderStoreApi>` 按解析后的 bucket 取建 store。
- `tests/vitest/learning-hub/finder-host-buckets.test.ts:105-114` 锁定：
  “every declared host its own bucket, except files which shares default”。

### 11. PASS — qbank 描述压缩与 `daily_target` 并存

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:161-162` 的
  `builtin-qbank_list` 使用单行压缩描述：
  “分页列出用户的题目集（Low，只读）……单次最多 20 条”。
- `tests/vitest/chat-v2/token-budget.test.ts:139,196-200` 保留
  `MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6_800` 预算门禁。
- `qbank-tools.ts:746` 保留
  `daily_target: { type: 'integer', minimum: 1, maximum: 50 }`；
  `src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3605` 校验并转发，
  `question_bank_service.rs:2847` 以 `unwrap_or(10).max(1)` 计算。

### 12. PASS — tombstone 正确解析物理对象并保留共享引用

- `src-tauri/src/data_governance/sync/mod.rs:11396` 定义
  `download_assets_manifest_before_tombstones`，调用在 `:12066`，
  即 tombstone 前先读未过滤资产清单。
- `sync/mod.rs:9797-9798`：
  `is_content_addressed_asset_object` 只接受 `ASSET_OBJECTS_PREFIX`；
  `:12124-12128` 仅在活跃清单仍引用同一 `object_key` 时
  `has_live_reference` 并保留对象。
- `src-tauri/tests/sync_scenarios_tests.rs:2891` 保留回归
  `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`。

### 13. PASS — WebDAV 路径单次编码与同空间解码

- `src-tauri/src/cloud_storage/webdav.rs:176-180` 的 `build_path_url`
  明确“先解码 base 片段，交由 push 统一做单次编码”。
- `webdav.rs:602-610` 的 `extract_relative_key` 明确：
  “把 href 路径与 base 路径统一解码成人类可读形式后比较”。
- 非 ASCII / 空格端点回归仍在 `webdav.rs:1982-2048`。

### 14. PASS — S3 endpoint normalize 仍保守

- `src-tauri/src/cloud_storage/s3.rs:70-78` 明确：
  “仅当 host 是已知 provider 的 `{bucket}.{service-host}` 形式时剥离 bucket”，
  “自建域名和 path-style endpoint 不做猜测性改写”。
- `s3.rs:94-112` 仅在
  `is_known_provider_service_host(rest)` 成立时改 host；否则返回原值。
- 白名单在 `s3.rs:115-132`，path-style / 自建端点负向回归在
  `:1030-1098`。

### 15. PASS — FTP 550 严格分类、歧义 fail-closed

- `src-tauri/src/cloud_storage/ftp.rs:270-286`：
  `is_not_found_error` 先要求状态码 `550 | 501`，再要求
  `no such file` / `does not exist` 等明确 missing 语义。
- `ftp.rs:289-313` 明确裸
  `550 Failed to change directory.` 是多义回复，
  “必须按真实错误上抛（fail-closed）”。
- `ftp.rs:1325-1333` 的
  `test_unclassifiable_550_is_not_treated_as_missing` 仍锁定该行为。

### 16. PASS — HPIAS 会话隔离

- `src/stores/hpiasSessionSlice.ts:1-3`：
  “活跃会话仍写 store 顶层字段；外会话事件只更新 sessions[id]”。
- `src/stores/researchStore.ts:247-268` 对不同 `session_id`：
  “只写入 sessions[id]，不覆盖活跃顶层字段”，写 slice 后立即 `return`。

### 17. PASS — Rust ingress 恰为 18 块白名单

- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:22-42` 的
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 明列从 `stat-card` 到 `table`
  的 18 项。
- `generative_ui_executor.rs:105-115` 明确：
  “未知类型在入口拒绝”，并以
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES.contains(&block_type)` 校验。

### 18. PASS — 无虚构模型；NOTICES 唯一权威仍在 `legal/`

- `src-tauri/src/llm_manager/builtin_vendors.rs:1681-1692` 负向遍历
  `BUILTIN_MODELS`：拒绝 `claude-haiku-5` 和 `mythos`，并正向要求
  `claude-haiku-4-5`。
- `src/utils/__tests__/apiCapabilityEngine.test.ts:121-122`：
  `findModelRecordById('claude-haiku-5')` 必须为 `undefined`。
- `git ls-files legal/THIRD_PARTY_NOTICES.txt public/legal/THIRD_PARTY_NOTICES.txt`
  只输出 `legal/THIRD_PARTY_NOTICES.txt`；`public/legal/` 不存在。
  `scripts/generate-third-party-notices.mjs:16` 与
  `src-tauri/tauri.conf.json:62` 也都引用根目录 `legal/`。

## 附加确认

### Composer* 拆分：PASS

- `src/features/chat/components/input-bar/` 仍有
  `ComposerTextarea.tsx`、`ComposerToolbar.tsx`、`ComposerPlusMenu.tsx`、
  `ComposerInlinePanel.tsx`、`ComposerPanelOverlay.tsx` 与 `ComposerPanel/`。
- `InputBarUI.tsx:39-56` import 上述 panel、textarea、toolbar；
  `:2181,2442,2482,2559` 分别渲染 `ComposerInlinePanel`、
  `ComposerTextarea`、`ComposerToolbar`、`ComposerPanelOverlay`。
- `ComposerToolbar.tsx:46,524` 自己 import 并渲染 `ComposerPlusMenu`；
  InputBar 仍是编排壳，不是把拆分内容复制回去。

### G：44px / safe-area / Android back：PASS

- 44px：`ComposerToolbar.tsx:51-67` 明确 coarse pointer 命中区
  “≥44px”，发送按钮为 `h-11 w-11`；`:875-876` 停止按钮同为 44px。
  `EnhancedPdfViewer.tsx:3785-3815` 的移动 panel tabs 均保留
  `[@media(pointer:coarse)]:!min-h-11`。
- safe-area：`src/styles/ios-safe-area.css:21-30` 同时保留
  `--safe-area-inset-*` 与 `--mobile-safe-area-*`，后者优先读取
  `--android-safe-area-*`，并以 `env(safe-area-inset-*)` 兜底。
- Android back：`src/app/navigation/androidBackCoordinator.ts:49-55`
  的 `registerBackHandler` 保留“同优先级后注册者先执行”的栈语义；
  `EnhancedPdfViewer.tsx:1259-1266` 先检查连接、布局盒和 computed
  visibility，明确 keep-alive 隐藏实例不得吞返回键，再于 `:1267-1297`
  依次关闭浮层。

### #177 Step 10–13：reread / size-verify / Range GET：PASS

- **PUT 后 GET 回读**：
  - `src-tauri/src/data_governance/sync/mod.rs:1639-1660`
    `put_bytes_and_reread` 对上传字节做 GET 等值比较；
    `:1711` 记录级设备清单、`:9594` 文件级清单均走该闸。
  - `src-tauri/src/data_governance/sync/tombstone.rs:597-621` 的
    `put_tombstone_manifest_and_reread` 同样回读；`:1432,1468,1497`
    覆盖 blob / asset / workspace 每设备 tombstone 清单。
  - `src-tauri/src/cloud_storage/sync_manager.rs:601-615`
    `write_encryption_marker` 在 PUT 后 GET；不一致或不存在均
    “已停止并不得报成功”。
- **上传后大小回验**：
  - `src-tauri/src/cloud_storage/traits.rs:208-225`
    `verify_remote_object_size` 用 `stat` 要求精确大小，否则删除并失败。
  - 生产后端调用仍在 `webdav.rs:899-900`、`s3.rs:317,444`、
    `ftp.rs:1160`。
  - `src-tauri/src/data_governance/sync/mod.rs:2280-2299`
    `put_file_and_verify_size` 在编排层再验；不符时明确
    “不得写入清单”，工作区 / blob / asset 调用在
    `:10127,10543,11108`。
- **Range GET / resume**：
  - WebDAV：`src-tauri/src/cloud_storage/webdav.rs:1030-1041`
    声明支持续传；`:1072-1075` 发送
    `Range: bytes={resume_from}-`；`:1084-1105` 仅在 `206` 且
    `Content-Range` 起点精确时追加，`200` 则诚实从零重下。
  - S3：`src-tauri/src/cloud_storage/s3.rs:545-551` 声明
    S3 Range GET；`:578-580` 调用
    `request.range(format!("bytes={resume_from}-"))`，
    `:239-249` 对 `Content-Range` 错位 fail-closed。
  - Step 13 repo-check：`src-tauri/src/cloud_storage/repo_check.rs:286-310`
    对 WebDAV / desktop S3 调 `get_file_resumable` 并从 `.partial`
    长度续传；`:553-555` 已接入正式巡检下载路径。

## 最终判定

**18/18 PASS；附加确认全部 PASS。** 未发现 post-G 不变量回流，也未发现
Step 13 对 Composer*、G 或既有 #177 保护造成退化。
