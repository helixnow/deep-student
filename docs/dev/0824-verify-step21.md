# 0824 Step 21 发版前独立实证

## 基线

- 分支：`origin/cursor/0824-cde6`
- Tip：`2d41ea8baca24e96ef02770a3a9b56ec0b87043d`（与预期 `2d41ea8b` 一致）
- 隔离环境：`git worktree add /tmp/0824-verify21 origin/cursor/0824-cde6`，全部验证在该 worktree 内完成，未触碰官方工作区。
- 工具链：Node v22.14.0、Rust 1.98.0（`cargo +1.98.0`）、protoc 3.21.12、gtk3/webkit2gtk-4.1/libsoup-3.0 齐备；pdfium 7350 经 `scripts/download-pdfium.sh linux-x64` 现场补齐（许可证文件未提交）。

## 四项硬门禁

| # | 门禁 | 结果 | Exit | 备注 |
|---|------|------|------|------|
| 1 | `npm run version:generate && npm run typecheck` | PASS | 0 | 生成 0.9.44+16375.2d41ea8b；`tsc --noEmit -p tsconfig.json` 0 error |
| 2 | `npx vite build` | PASS | 0 | `✓ built in 1m 8s`，仅 chunk 体积 warning |
| 3 | `cargo +1.98.0 check --manifest-path src-tauri/Cargo.toml --lib` | PASS | 0 | `Finished dev profile in 4m 54s`，28 warnings、0 error |
| 4 | `node scripts/check-migrations.mjs` | PASS | 0 | 迁移静态门禁通过（111 个迁移文件） |

## 18 项不变量逐项核验

| # | 不变量 | 结果 | 证据（路径:行） |
|---|--------|------|-----------------|
| 1 | pipeline hooks | PASS | `src-tauri/src/chat_v2/pipeline.rs:243` 构造时安装 `hooks::default_pipeline_hooks()`；`src-tauri/src/chat_v2/pipeline/hooks.rs:141-142` 默认注册 `ApprovalGateHook` + `TaskAuditHook`（定义于 226/952） |
| 2 | GenerativeUiExecutor 注册 | PASS | `src-tauri/src/chat_v2/pipeline.rs:347` 生产 executor registry `executors.push(Arc::new(GenerativeUiExecutor::new()))` |
| 3 | H cache（tools 会话内冻结 + append-only） | PASS | `src-tauri/src/chat_v2/pipeline/tool_loop.rs:30-110` `freeze_tool_schema_order_for_prompt_cache` / `freeze_tool_schemas_for_prompt_cache`，985 为生产调用点；`src-tauri/src/chat_v2/pipeline/helpers.rs:1015-1069` 会话冻结基线加载、单调合并与持久化 |
| 4 | utf8_stream 有调用方 | PASS | `src-tauri/src/utils/sse_buffer.rs:1,128-148` 实例化 `Utf8StreamDecoder`；`SseEventBuffer` 生产调用方含 providers/mod.rs、llm_manager/{mod,model2_pipeline}.rs、streaming_anki_service.rs、translation/pipeline.rs、qbank_grading/pipeline.rs、essay_grading/pipeline.rs、vlm_grounding_service.rs |
| 5 | model_special_tokens | PASS | `src-tauri/src/utils/model_special_tokens.rs:107` `ModelWrapTokenStreamFilter`；生产接入 `chat_v2/pipeline/llm_adapter.rs:192,246` 与 `chat_v2/pipeline/variant_adapter.rs:24,52`；`SpecialTokenStreamStripper` 旧实现无回流 |
| 6 | 闪卡只读 | PASS | `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55` 仅渲染 front/back/tags/deckName，无按钮/持久化；`src/features/generative-ui/**` 无 `save_to_library`/`saveToLibrary` 命中 |
| 7 | 无生产 ChatV2AnkiAdapter | PASS | `src/**` 无同名模块文件、无 import/new；字符串命中仅为注释与负向守卫测试（`src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts:28-77` 等） |
| 8 | cardAgent.startGeneration | PASS | `src/features/chat/services/selectionCardGeneration.ts:121`、`src/features/anki/generateCardsFromText.ts:50` 直调；实现 `src/components/anki/cardforge/engines/CardAgent.ts:411` |
| 9 | 附件 200MB / 图片 50MB | PASS | `src/features/chat/core/constants.ts:180,187` `ATTACHMENT_MAX_SIZE=200MB`/`ATTACHMENT_IMAGE_MAX_SIZE=50MB`；`src/features/chat/resources/types.ts:265,271`；后端 `src-tauri/src/vfs/repos/attachment_repo.rs:143-144,374-379` 一致 |
| 10 | finder host buckets | PASS | `src/features/learning-hub/stores/finderStore.ts:412-424` 每宿主 bucket 解析（仅 `files -> default` 兼容）、`1264-1268` `Map<bucketId, store>` 注册；`tests/vitest/learning-hub/finder-host-buckets.test.ts` 在位 |
| 11 | qbank-tools 压缩 + daily_target | PASS | `src/features/chat/skills/builtin-tools/qbank-tools.ts:746` `daily_target: 1..=50`（缺省 10）；预算锁 `tests/vitest/chat-v2/token-budget.test.ts:131,147,196`（单组 9500/合计 68000/总计 95000 护栏） |
| 12 | tombstone 发布后复读 | PASS | `src-tauri/src/data_governance/sync/tombstone.rs:594-615` PUT 后 GET 回读、`read_back == payload` 不一致即 fail-closed；`:321` 不可变事件回读；测试 `:2031-2087` 锁定三条上传链均走回读闸 |
| 13 | WebDAV decode_path | PASS | `src-tauri/src/cloud_storage/webdav.rs:597` 定义 `decode_path`；`:187,616-619` base segment 与 PROPFIND href 在同一解码空间比较；`:2147-2151` 源码级守卫 |
| 14 | S3 normalize_endpoint | PASS | `src-tauri/src/cloud_storage/s3.rs:85` 定义、`:152` 生产调用；测试 `:1121-1196` 锁定仅剥已知 provider 的 bucket 前缀 host、补 https、自建不猜改 |
| 15 | FTP 550/501 | PASS | `src-tauri/src/cloud_storage/ftp.rs:267-299` 仅白名单 550/501 且消息明确 missing 才判不存在，歧义 550 fail-closed；测试 `:1287-1330` 覆盖权限型/无法归类 550 上抛 |
| 16 | HPIAS session_id + 恰 18-block allowlist | PASS | `src/stores/hpiasSessionSlice.ts:75-107` 按 `session_id` 折叠、外会话拒绝；`src/stores/researchStore.ts:101,253-263` 多 session slices + 有界淘汰；`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42` allowlist 恰 18 项（stat-card/alert/list/progress/action-bar/text/key-value-grid/flashcard-preview/review-calendar/mistake-analysis/mindmap-embed/paper-digest/research-plan/research-report/markdown/chart/steps/table），`:114` 未知 type 拒绝 |
| 17 | 无 mythos-5/haiku-5 真实条目 | PASS | 生产源码零条目；命中仅为负向守卫 `src-tauri/src/llm_manager/builtin_vendors.rs:925,1681-1689`（断言编造 ID 不进内置目录） |
| 18 | NOTICES 在 legal/；Composer* 拆分；G 44px/safe-area/Android back | PASS | 唯一跟踪文件 `legal/THIRD_PARTY_NOTICES.txt`，`public/legal/` 不存在；`src/features/chat/components/input-bar/` 下 ComposerToolbar/ComposerPlusMenu/ComposerInlinePanel/ComposerPanelOverlay 独立拆分；`ComposerToolbar.tsx:51-55,875` ≥44px 触控目标、`src/styles/responsive-utilities.css:43-44` safe-area 变量族、`androidBackCoordinator` 广泛接入（App.tsx、QuestionHistoryView、ImageCropDialog 等） |

## 额外抽查：附件「更多」按钮 i18n 路径

- PASS：`src/features/chat/components/input-bar/AttachmentPanelBody.tsx:158` 使用 `t('common:more', { defaultValue: 'More' })`。
- 生产源码无 `t('common:actions.more')` / `t('actions.more')` 调用；唯一字符串命中是 `src/__tests__/releaseUpgradeI18n.test.ts:61` 把 `common:actions.more` 列入 `removedKeys` 负向守卫。
- locale 侧 `src/locales/{en-US,zh-CN}/common.json` 同时保有顶层 `more`（t() 实际解析目标）与 `actions.more` 词条（允许保留）。

## 结论

- Tip `2d41ea8b`，四项硬门禁全部 exit 0，18/18 不变量 PASS，额外抽查 PASS。可进入发版流程。
