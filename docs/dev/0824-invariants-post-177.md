# 0824 不变量复审（#177 合入后）

## 基线与结论

- 审计分支：`cursor/0824-invariants-cde6`（只读验证 + 本文档，不改产品代码）。
- 基线：`origin/cursor/0824-rehearse-cloud-latest-cde6` @ `2630dc95f`——即
  0824 基座 + PR #177 最新 tip（`cloud-sync-sota-b343`）合并后的树，
  是拟定的正式 0824 FF 目标。
- 方法：逐项 grep / 读源码取证，全部为只读操作。
- **结论：18/18 全部 PASS**，附加确认项（F Composer 拆分、G 移动加固、
  #177 五项标志物）也全部在位。**对正式 FF：GO。**

## 18 项逐条证据（路径 + 引文）

### 1. PASS — pipeline hooks 仍注册

- `src-tauri/src/chat_v2/pipeline/hooks.rs:139-142`：
  `pub(crate) fn default_pipeline_hooks()` 返回
  `Arc::new(ApprovalGateHook)` + `Arc::new(TaskAuditHook)`。
- `src-tauri/src/chat_v2/pipeline.rs:243`：pipeline 构造时
  `hooks: hooks::default_pipeline_hooks(),`。
- `src-tauri/src/chat_v2/pipeline/tool_loop.rs:3171`：
  “默认注册 ApprovalGateHook（准入，可拦截）+ TaskAuditHook（审计注记）”。

### 2. PASS — `GenerativeUiExecutor` 在且注册

- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:44`：
  `pub struct GenerativeUiExecutor;`（`:348` 实现 `ToolExecutor`）。
- `src-tauri/src/chat_v2/pipeline.rs:347`：
  `executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()));`
  在生产 executor registry 内。

### 3. PASS — H 缓存路径完整

- `src-tauri/src/chat_v2/pipeline/tool_loop.rs:105`：
  `pub(crate) fn freeze_tool_schemas_for_prompt_cache(...)`；生产调用点
  `tool_loop.rs:985`。顺序 freeze 在 `tool_loop.rs:39`
  （`freeze_tool_schema_order_for_prompt_cache`）。
- `src-tauri/src/chat_v2/pipeline/helpers.rs:1015`：会话级 freeze 基线的
  加载降级语义（“读取失败降级为空基线……由首次 freeze 按字母序建立”）。
- `src-tauri/src/llm_manager/model2_pipeline.rs:1143-1157`：
  `prompt_cache_key_is_stable_and_never_random` /
  `prompt_cache_key_only_targets_openai_affinity_endpoints` 测试仍锁定
  `stable_prompt_cache_key` 行为。

### 4. PASS — `utf8_stream` 有生产调用方

- `src-tauri/src/utils/sse_buffer.rs:1`：
  `use crate::llm_manager::utf8_stream::Utf8StreamDecoder;`；`:128` 为
  `SseEventBuffer` 的 `decoder: Utf8StreamDecoder` 字段。
- `SseEventBuffer` 生产调用方 8 处：`providers/mod.rs`、
  `llm_manager/model2_pipeline.rs`、`llm_manager/mod.rs`、
  `streaming_anki_service.rs`、`translation/pipeline.rs`、
  `qbank_grading/pipeline.rs`、`essay_grading/pipeline.rs`、
  `vlm_grounding_service.rs`。

### 5. PASS — `model_special_tokens` 在，旧 #200 实现未回流

- `src-tauri/src/utils/mod.rs:5`：`pub mod model_special_tokens;`；
  `model_special_tokens.rs:107` 定义 `ModelWrapTokenStreamFilter`。
- 生产接线：`chat_v2/pipeline/llm_adapter.rs:200,254`、
  `variant_adapter.rs:24,52`、`tool_loop.rs:553`、`multi_variant.rs:814,1192`
  均按 `ModelWrapTokenPolicy::for_provider_model` 门控。
- `SpecialTokenStreamStripper` 在 `src/` 与 `src-tauri/` 均无任何命中。

### 6. PASS — Generative UI 闪卡只读，无 save-to-library 生产 handler

- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55`：
  纯渲染 front/back/tags/deckName，无按钮、无持久化调用。
- `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:1-5`：
  “只读闪卡预览……持久化统一由 anki_cards 管线负责”。
- `src/features/generative-ui/**` 无 `save_to_library` / `saveToLibrary`
  命中；仓库内其余命中仅为错题本 locale 文案与
  `src/features/chat/debug/chatAnkiIntegrationTestPlugin.ts` 的
  anki_cards 调试场景，不属于 generative-ui 闪卡。

### 7. PASS — 无生产 `ChatV2AnkiAdapter`

- `src/**` 无该类的文件、import 或调用。仅存命中为退役说明与负向守卫：
  `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`
  （`expect(actionsSource).not.toContain('ChatV2AnkiAdapter')`）、
  `selectionCardGeneration.ts:10` / `generateCardsFromText.ts:49` 的
  “已退役”注释、`cardforge/index.ts:28` 历史说明。

### 8. PASS — `cardAgent.startGeneration` 在位

- `src/components/anki/cardforge/engines/CardAgent.ts:411`：
  `async startGeneration(input: GenerateCardsInput)`（经
  `start_enhanced_document_processing` 非阻塞启动）。
- 生产调用方：`src/features/chat/services/selectionCardGeneration.ts:121`
  与 `src/features/anki/generateCardsFromText.ts:50` 均
  `await cardAgent.startGeneration({...})`。

### 9. PASS — 附件 200MB / 图片 50MB（200MB 图片被拒）

- `src/features/chat/core/constants.ts:180,187`：
  `ATTACHMENT_MAX_SIZE = 200 * 1024 * 1024`、
  `ATTACHMENT_IMAGE_MAX_SIZE = 50 * 1024 * 1024`；`:190`
  `isImage ? ATTACHMENT_IMAGE_MAX_SIZE : ATTACHMENT_MAX_SIZE`。
- `src/features/chat/resources/types.ts:265,271`：
  `IMAGE_SIZE_LIMIT = 50MB`、`FILE_SIZE_LIMIT = 200MB`。
- `src/features/chat/components/AttachmentUploader.tsx:198,389`：图片取
  `Math.min(maxSize, ATTACHMENT_IMAGE_MAX_SIZE)`——200MB 图片在读入前即拒。
- 后端对齐：`src-tauri/src/vfs/repos/attachment_repo.rs:143-144`
  `MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024` /
  `MAX_FILE_BYTES: usize = 200 * 1024 * 1024`。

### 10. PASS — Finder 每宿主分桶

- `src/features/learning-hub/stores/finderStore.ts:377-416`：
  `DEFAULT_FINDER_HOST_ID` / `FINDER_HOST_IDS` / `resolveFinderHostId`，
  仅 `files` 与 default 共桶（`HOSTS_SHARING_DEFAULT_BUCKET`）。
- `finderStore.ts:1222-1226`：`getFinderStore` 按
  `resolveFinderHostId(hostId)` 到 `finderStoreRegistry`（Map）取/建 store，
  同宿主稳定、异宿主隔离；`:421-424` 每桶独立 persist key。
- 契约测试 `tests/vitest/learning-hub/finder-host-buckets.test.ts` 仍在。

### 11. PASS — qbank-tools 压缩描述 + `daily_target` 并存

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:162`：压缩后的
  embedded 描述（如 “分页列出用户的题目集（Low，只读）……单次最多 20 条”）。
- `tests/vitest/chat-v2/token-budget.test.ts:133,139`：实测
  “最大单组 schema = 6172 tokens（qbank-tools）”，护栏
  `MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6_800` 防回吃。
- `qbank-tools.ts:746`：`daily_target: { type: 'integer', minimum: 1,
  maximum: 50, ... }`；`src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3608`
  校验 “daily_target 必须是 1..=50 的整数” 并转发；
  `src-tauri/src/question_bank_service.rs:2852`
  `daily_target.unwrap_or(10).max(1)` 缺省 10。

### 12. PASS — tombstone 行为（#177 tip 版，含 #169 根因吸收）

- `src-tauri/src/data_governance/sync/mod.rs:11325`：
  `async fn download_assets_manifest_before_tombstones(...)`，调用点
  `:11995`（tombstone 前用未过滤清单解析物理 object_key）。
- `sync/mod.rs:9753`：`fn is_content_addressed_asset_object(key: &str)`；
  `:12053` `has_live_reference = Self::is_content_addressed_asset_object(...)`
  ——共享内容对象不随 tombstone 物理删除。
- 回归：`src-tauri/tests/sync_scenarios_tests.rs:2891`
  `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`。

### 13. PASS — WebDAV 解码（#57/#174 行为）

- `src-tauri/src/cloud_storage/webdav.rs:176-187`：`build_path_url` 先对
  base 片段 `decode_path` 再交 `path_segments_mut().push` 单次编码
  （注释 “先解码 base 片段，交由 push 统一做单次编码”）。
- `webdav.rs:602-618`：`extract_relative_key` 把 href 路径与
  `base_url.path()` “统一解码成人类可读形式后比较”（坚果云中文目录
  列举清空修复）；回归测试 `:1369,1398,1416` 在位。

### 14. PASS — S3 normalize（保守，仅已知 provider）

- `src-tauri/src/cloud_storage/s3.rs:78-113`：`normalize_endpoint` 纯字符串
  变换；仅当 host 是 `{bucket}.{已知 provider 服务域}` 时剥离前缀，
  “自建域名和 path-style endpoint 不做猜测性改写”，未触发时原样返回保
  `instance_binding_hint` 稳定。
- `s3.rs:115-128`：`is_known_provider_service_host` 白名单
  （COS/OSS/bitiful/AWS）；回归测试 `:744,811` 在位。

### 15. PASS — FTP 550 严格分类（fail-closed）

- `src-tauri/src/cloud_storage/ftp.rs:273-287`：`is_not_found_error` 要求
  状态码 550/501 **且**消息含明确不存在短语（no such file / not
  retrievable / does not exist / file|directory not found）。
- `ftp.rs:294-314`：`is_missing_directory_error` 同样只认显式 missing/gone
  标记，注释明确 vsftpd 裸 `550 Failed to change directory.`
  “属无法归类的多义回复……必须按真实错误上抛（fail-closed）”。
- 回归：`ftp.rs:1317` `test_unclassifiable_550_is_not_treated_as_missing`。

### 16. PASS — HPIAS 会话隔离

- `src/stores/hpiasSessionSlice.ts:3`：“活跃会话仍写 store 顶层字段；
  外会话事件只更新 sessions[id]”；`:95` 折叠函数外会话/活跃会话共用。
- `src/stores/researchStore.ts:100`：“多会话切片：Chat 并发研究按
  sessionId 读取，不被最新 session_started 顶掉”；`:247`
  “外会话（含 session_started）：只写入 sessions[id]，不覆盖活跃顶层字段”。

### 17. PASS — Rust ingress 18 块白名单

- `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:22-42`：
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 恰好 18 项（stat-card…table），
  注释 “与前端 `EXPECTED_BLOCK_TYPES` / `ALL_BLOCK_TYPES` 对齐的 18 种内置块”。
- `:105`：“每块必须是对象，且 `type` 落在 18 种内置白名单。未知类型在
  入口拒绝”；测试 `:693-699` 断言全 18 类通过。

### 18. PASS — 无 mythos-5 / haiku-5 模型条目；NOTICES 唯一权威在 `legal/`

- `src-tauri/src/llm_manager/builtin_vendors.rs:925`：“官方最新 Haiku 仍为
  4.5，不存在 claude-haiku-5”；`:1681-1690`
  `builtin_catalog_has_no_fabricated_claude_haiku_5` 负向断言目录无
  `claude-haiku-5` 与 `mythos`。
- `src/utils/__tests__/apiCapabilityEngine.test.ts:121-122`：
  `findModelRecordById('claude-haiku-5')` 为 `undefined`。
  `src/utils/deepseekReasoningControls.ts:213-239` 的 `mythos` 命中仅为
  适配层代际判定（对用户自填 ID 的家族匹配），非模型目录条目。
- NOTICES：`git ls-files` 仅 `legal/THIRD_PARTY_NOTICES.txt`；
  `public/legal/` 目录不存在（#213 WI-9 去重语义保持，#177 侧旧路径
  刷新已按预演裁决丢弃）。

## 附加确认项

### F：InputBar 已是 Composer* 拆分

- `src/features/chat/components/input-bar/` 含 `ComposerTextarea.tsx`、
  `ComposerToolbar.tsx`、`ComposerPlusMenu.tsx`、`ComposerInlinePanel.tsx`、
  `ComposerPanelOverlay.tsx`、`ComposerPanel/`、`composerDraftStorage.ts`。
- `InputBarUI.tsx:55-56` import `ComposerTextarea` / `ComposerToolbar`；
  `:1012` “底部工具栏整体拆至 ComposerToolbar.tsx”。

### G：44px / safe-area / Android 返回键仍在

- 44px：`ComposerToolbar.tsx:51` “触屏用透明伪元素扩命中区域到 ≥44px”、
  `:875` “移动端与发送按钮同为 44px 触控目标”；
  `EnhancedPdfViewer.tsx` 移动 tab `!min-h-11`（9 处命中）；
  契约测试 `input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts`。
- safe-area：`src/styles/ios-safe-area.css:21-28` 定义
  `--safe-area-inset-*` 与 `--mobile-safe-area-*`（Android 变量优先，
  `env(safe-area-inset-*)` 兜底）。
- Android 返回键：`src/app/navigation/androidBackCoordinator.ts:53`
  `export function registerBackHandler(...)`（栈语义 + 优先级）；
  `EnhancedPdfViewer.tsx:1250-1266` 返回键先关浮层并带可见性守卫
  （keep-alive 隐藏实例不吞其他页面返回键）；notes/todo/settings/workbench
  等 20+ 文件仍在调用。

### #177 五项标志物

- **recoveryKind**：`src-tauri/src/data_governance/commands_backup.rs:58`
  `fn classify_recovery_kind(...)`；`commands_zip.rs:543,614` 结果 stats
  写 `recovery_kind`；前端 `src/types/dataGovernance.ts:280`
  `recovery_kind?: 'disaster_recovery' | 'partial_archive'`、
  `src/utils/cloudStorageApi.ts:543,559`（便携包禁用整槽恢复判定）。
- **维护模式**：`src-tauri/src/data_governance/commands_types.rs:7-8`
  `MaintenanceStatusResponse { is_in_maintenance_mode, ... }`；前端
  `CloudStorageSection.tsx:136` / `DataGovernanceDashboard.tsx:620`
  `enterMaintenanceMode / requireMaintenanceRestart / exitMaintenanceMode`；
  回归 `tests/vitest/data-governance/r09-ux-cloud-storage.test.tsx:296`。
- **SAF**：`src-tauri/src/data_governance/commands_zip.rs:27,214`
  “Android content:// 等虚拟 URI：先导出到本地临时文件，完成后再复制到
  目标 URI”；`pending_saf_persist` 队列在
  `src-tauri/mobile/android/MainActivity.kt`、`unified_file_manager.rs`
  与 `src-tauri/tests/sync_r10_android.rs`。
- **路径哈希**：`src-tauri/src/data_governance/sync/mod.rs:160`
  `use crate::cloud_storage::{device_id_short_hash, ...}`；`:1315-1326`
  “记录级对象路径里的设备目录名：短哈希，避免把完整 device_id 写进 key”
  且旧明文双读；`tombstone.rs:11`
  “`data_governance/tombstones/blobs/{短哈希}.json`（旧 `{device_id}.json`
  仍可读）”；回归 `sync/mod.rs:12523`
  `record_path_id_is_short_hash_and_matches_raw_or_hashed`。
- **E2EE 稳定错误码**：`src-tauri/src/cloud_storage/mod.rs:58-64`
  `E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED` / `E_SYNC_E2EE_WRONG_PASSWORD` /
  `E_SYNC_E2EE_MARKER_CORRUPTED` / `E_SYNC_E2EE_PASSWORD_REQUIRED`；
  测试 `:627` `sync_e2ee_error_prefixes_stable_codes`。平台/门禁码
  `E_FTP_UNSUPPORTED_ON_ANDROID`、`E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE`
  等同样在 `secure_store.rs` / `backup/mod.rs` / `cloud_config_commands.rs`。

## Go / No-Go

**GO。** 18/18 PASS，附加项全部在位；未发现任何需要修复的回流或缺失，
本分支未做（也不需要）任何产品代码改动。正式 FF 时按
`0824-rehearse-cloud-latest.md` §7 的既有结论执行（licenses 重生成等）。
