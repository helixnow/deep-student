# 01 Chat V2 / Pipeline / Composer / 流式 静态审计

- 审计基座：`cursor/0824-cde6` @ `2d41ea8b`（本进度枝 `cursor/0824-static-audit-cde6` 相对基座仅多 `docs/0824-static-audit/README.md` 一个文档，产品代码零差异，`git diff --stat 2d41ea8b..HEAD` 实测确认）。
- 对照物：`v0.9.44`（tag @ `1cf6cabc`）、主题仓 A（#268 wrapup，i18n/流式/模型修复）、主题仓 F（#176 subapp，InputBarUI 拆分）、主题仓 H（#175+#183 prompt cache）、主题仓 E（#213 pipeline 拆模）。
- 性质：只读静态审计。本轮不改任何产品代码，不跑 Tauri 实机编译；本 VM 无 `node_modules` 且无后台安装任务，vitest/cargo 复跑不在本轮范围（历次门禁绿灯记录见 `docs/0824-MERGE-PLAN.md` Step 6/8/9/21）。

## 范围

1. Chat V2 pipeline hooks（#213 拆模：`pipeline/hooks.rs` 及其在 `pipeline.rs`/`tool_loop.rs` 的接线）；
2. `tool_loop.rs`（回合边界/压缩边界 hook 调用、prompt-cache 冻结 helper、wrap-token 策略选择）；
3. H cache 全链（tool schema 前缀冻结、`availableSkillsSnapshot` 会话快照、`cache_write_tokens` 记账、`prompt_cache_key` 门控、`<injected_context>` turn-volatile 注入、prefix snapshot 回归测试）；
4. `utf8_stream` 调用方（是否为死代码）；
5. `model_special_tokens`（#268 对 #200/#187 的最终语义与消费方）；
6. Composer* 拆分（F：InputBarUI → ComposerTextarea / ComposerToolbar / AttachmentPanelBody 及配套 helper，G 热区重放是否落在拆分文件上）；
7. 新会话链路（前端 `createSessionWithDefaults` → 后端 `chat_v2_create_session`）；
8. 流式链路（后端 SSE 解码 → `chat_v2_event_{session}` → 前端 TauriAdapter 监听/回滚/取消）；
9. 附件入口 `data-testid` 及其契约测试锁定。

## 证据（路径+行号）

### 1. Pipeline hooks（#213 / WI-13）

- `src-tauri/src/chat_v2/pipeline.rs:83`：`pub mod hooks;`（注释标明 WI-13 流水线钩子）；`pipeline.rs:243`：Pipeline 构造时 `hooks: hooks::default_pipeline_hooks()`。
- `src-tauri/src/chat_v2/pipeline/hooks.rs`（1694 行，v0.9.44 不存在此文件）：
  - `hooks.rs:99-127`：`pub(crate) trait PipelineHook`，含 `name` / `before_tool`(111) / `after_tool`(120) 等钩子点；
  - `hooks.rs:140-143`：`default_pipeline_hooks()` 返回 `[ApprovalGateHook, TaskAuditHook]`；
  - `hooks.rs:226`：`pub struct ApprovalGateHook`（Kill Switch、运行时 allowlist、trusted automation、灾难命令守卫、人工审批等准入全部迁入，见文件头 3-9 行说明）；
  - `hooks.rs:952`：`pub struct TaskAuditHook`（回合/压缩边界审计 + 执行后审计标记）；
  - `hooks.rs:38-40`：admission 证据字段刻意私有，防止追加 hook 伪造 ApprovalGateHook 决策。
- `pipeline.rs:347`：`executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()))` 在 catch-all 之前注册（#214 保留面，与不变量 #2 一致）。

### 2. tool_loop 接线

- `src-tauri/src/chat_v2/pipeline/tool_loop.rs`（5125 行）：
  - `tool_loop.rs:343-347`：每轮迭代开头 `hook.before_turn(...)`（WI-13 回合边界）；
  - `tool_loop.rs:466-469`：环内 compaction 真正执行前 `hook.before_compaction(...)`（压缩边界）；
  - `tool_loop.rs:3170/3191`：审批准入迁至内置 hook 的注释 + `hook.before_tool(self, &hook_ctx, &mut admission)` 调用；
  - `tool_loop.rs:3269-3273`：`hook.after_tool(...)`（审计标记，注释指明迁自 TaskAuditHook）；
  - `tool_loop.rs:553-559`：按 provider/model 解析 `ModelWrapTokenPolicy::for_provider_model`，无策略时 `Disabled`。

### 3. H cache 全链

- Prompt-cache 冻结 helper（#183）：`tool_loop.rs:26` `sort_tool_schemas_for_prompt_cache`、`:78` `merge_frozen_tool_schema_order_baseline`、`:105` `freeze_tool_schemas_for_prompt_cache`；生产调用点 `tool_loop.rs:985-996`（首轮名字序建基线、后续轮冻结相对顺序、schema 字节窗口级冻结、新工具只追加末尾，并 `store_session_frozen_tool_schema_order` 写回会话级状态）。
- 会话级状态：`pipeline.rs:182` `microcompact_anchors`、`pipeline.rs:192` `frozen_tool_schema_orders`；`pipeline/helpers.rs:955-1065` 消费两者。
- `availableSkillsSnapshot` 跨进程冻结：常量 `src-tauri/src/chat_v2/types.rs:470`；first-write-wins 落库 `src-tauri/src/chat_v2/repo.rs:2737/2769/4550`（只 upsert 单键）；命令 `src-tauri/src/chat_v2/handlers/manage_session.rs:386-407`（`chat_v2_freeze_available_skills_snapshot`，session_id 前缀校验 `sess_`/`agent_`/`subagent_`）；注册 `src-tauri/src/lib.rs:2082` 与 `src-tauri/permissions/application-commands.toml:82`；前端调用方 `src/features/chat/adapters/TauriAdapter.ts:5318-5325`。
- cache telemetry：迁移 `src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql`（锁定于 `migrations/migration-lock.json:272`）；记账入口 `src-tauri/src/llm_usage/mod.rs:184` `record_llm_usage_cache_ext`（`:145/:161` 旧入口转发）；数据治理迁移消费 `src-tauri/src/data_governance/migration/llm_usage.rs:143`。
- provider 门控：`src-tauri/src/llm_manager/model2_pipeline.rs:3181` `provider_accepts_prompt_cache_key`、`:3193` `provider_accepts_prompt_cache_retention`（DeepSeek 官方不写 `prompt_cache_key`，单测 `:1165-1191` 锁定）。
- 检索注入迁至 turn-volatile：`src-tauri/src/chat_v2/prompt_builder.rs:552/585/591`（`<injected_context>` 进当前 user 消息、system 保持前缀稳定）；`pipeline/prompt.rs:15`、`pipeline/multi_variant.rs:783` 同语义。
- 回归测试：`src-tauri/src/chat_v2/pipeline/prefix_snapshot_tests.rs`（234 行，文件头 14 行明确「变化必须全部落在 turn-volatile」断言，`:99` 处逐项检查）。

### 4. utf8_stream 调用方（非死代码）

- `src-tauri/src/llm_manager/mod.rs:9`：`pub mod utf8_stream;`。
- `src-tauri/src/llm_manager/utf8_stream.rs:12-14`：文件头明确「调用方：`crate::utils::sse_buffer::SseEventBuffer` 在所有 LLM 流式管线（model2_pipeline、翻译、作文/题库评分、Anki、VLM grounding 等）的字节 chunk 入口统一使用（issue #122）」。
- 实际接线：`src-tauri/src/utils/sse_buffer.rs:1` 导入 `Utf8StreamDecoder`，`:128` 作为 `SseEventBuffer` 内部字段。`SseEventBuffer` 生产消费点：`llm_manager/model2_pipeline.rs:551/1290/4838`、`llm_manager/mod.rs:7767`、`streaming_anki_service.rs:1200`、`providers/mod.rs:102/4697`、`essay_grading/pipeline.rs:1317`。调用链完整，非死代码。

### 5. model_special_tokens（#268 最终语义）

- `src-tauri/src/utils/model_special_tokens.rs`（475 行，v0.9.44 不存在）：`:8-14` 五个 GLM/Qwen 泄漏 token；`:17-20` `ModelWrapTokenPolicy { Disabled, GlmOrQwen }`；`:28-52` `for_provider_model`（provider `qwen/dashscope/zhipu/bigmodel` 或模型名 `qwen/chatglm/glm*/qwq*/qvq*` 命中才启用）；文件头 1-6 行明确保守策略：只删外层包装/空逻辑行/配对闭合 token，代码块永远透传，不做全局替换。
- 消费方（Chat V2 流式链）：`pipeline/llm_adapter.rs:192/227/246`（`ChatV2LLMAdapter::new` 第 6 参 `wrap_token_policy` + 流过滤器）、`pipeline/variant_adapter.rs:24/39/52`、`pipeline/multi_variant.rs:814/1192`、`tool_loop.rs:553-559`。
- Anki 独立副本（有意为之，非坏味道遗留）：`src-tauri/src/streaming_anki_service.rs:41-51` 同名 token 表 + `:71-95` `strip_model_special_tokens`（注释明示 #268 对 #187 的最终语义：卡片正文字面 token 必须保留，只丢纯 token 残片或剥离完整卡片 JSON 外侧包装）+ `:97-102` 纯 token 错误卡不进重试。与 `utils/model_special_tokens.rs` 的流式包装过滤语义不同，不能合并成一个实现。
- native reasoning 回放（H 与 A 的交界）：`pipeline/llm_adapter.rs:201` `response_reasoning_items` 采集、`:645` 读取、`:1415/:1484` 测试 helper 已按 Step 3 记录补传 `ModelWrapTokenPolicy::Disabled`（E0061 修复在树）。

### 6. Composer* 拆分（F）

- v0.9.44 基线：`git show v0.9.44:...InputBarUI.tsx` 为 3919 行单体；`git ls-tree v0.9.44` 确认当时无 ComposerTextarea/ComposerToolbar/AttachmentPanelBody/attachmentModeHelpers/inputBarConfig/sendAvailability。
- 现树：`src/features/chat/components/input-bar/InputBarUI.tsx` 2661 行（壳 + 附件业务），`:54-57` 注释「★ 拆分后的子模块」并导入 `ComposerTextarea`/`ComposerToolbar`/`AttachmentPanelBody`；渲染点 `:2111`（AttachmentPanelBody）、`:2442`（ComposerTextarea）、`:2482`（ComposerToolbar）。子文件：`ComposerToolbar.tsx` 934 行、`ComposerTextarea.tsx` 323 行、`AttachmentPanelBody.tsx` 400 行；配套 `attachmentModeHelpers.ts`（OCR 阶段标签 `getStageLabel`）、`inputBarConfig.ts`、`sendAvailability.ts` 均为拆分新增。
- 拆分谱系：`git log` 显示 `e40e3a98`（F：拆分 + disabledSend 收敛为 sendAvailability selector）与 `79362482`（Step 8 G merge：coarse-pointer 44px 热区重放进拆分文件而非复活单体）。
- 契约锁定（防拆分回退）：`src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts:24-29`（拆分所有权：`ContextWindowUsageRing` 必须在 ComposerToolbar、不得回流 InputBarUI）、`:31-35`（活跃表面必须是 InputBarV2，legacy InputBar 保持 `@deprecated`）、`:37-56`（coarse 44px/16px 热区）、`:58-62`（OCR 阶段标签留在 helper）。`tests/vitest/chatV2SendButtonContract.test.ts:7` 送信/停止钮契约改读 ComposerToolbar；`tests/vitest/chatV2ComposerPanelTokensContract.test.ts` 改读 AttachmentPanelBody（Step 8 收口 g-fix-chat 回收项，与树一致）。

### 7. 新会话链路

- 前端统一入口 `src/features/chat/core/session/createSessionWithDefaults.ts:44-158`：invoke `chat_v2_create_session`（:46）→ sessionManager 建 store（:53）→ 默认权限档位只在非 relaxed 时补一次 IPC、高权限档从不被记忆（:63-76）→ 组默认技能等待 `waitForSkillsLoaded` 后逐个激活、失败聚合成 i18n 通知（:81-111）→ 组 pinned 资源注入 `pendingContextRefs`（:113-155）；组 systemPrompt/runtimeRoot 快照进 metadata（:17-42，snapshot 语义防组后续修改影响已建会话）。
- 调用方：`pages/useSessionLifecycle.ts:80/216`、`pages/ensureActiveChatSession.ts:71`、`hooks/useSessionManagement.ts:287` 及 5 个 debug 插件，均走同一入口，无旁路。
- 后端 `src-tauri/src/chat_v2/handlers/manage_session.rs:232` `chat_v2_create_session`。

### 8. 流式链路

- 后端事件路由：`src-tauri/src/llm_manager/model2_pipeline.rs:2810/2853/2973`（`chat_v2_event_` 前缀识别、scope/generation 解析并推送前端）。
- 前端监听：`src/features/chat/adapters/TauriAdapter.ts:720-721`（块级事件通道 `chat_v2_event_{session_id}`）、`:740-770`（setupGeneration 防旧 listener 泄漏到新 session、`registerEventListenersWithRollback` 逐个注册 + 部分失败回滚、stale generation 立即释放）；生命周期契约测试 `src/features/chat/adapters/__tests__/tauri.streamLifecycle.test.ts:146`。
- 取消：`src-tauri/src/chat_v2/handlers/send_message.rs:752` `chat_v2_cancel_stream`、`variant_handlers.rs:1056` `chat_v2_cancel_variant`；`tool_loop.rs:998-1000` 注释明确 run-scoped UUID 防旧 StreamHooksGuard 异步 cleanup 误删新 hook。
- 字节级健壮性：见第 4 节（跨 chunk UTF-8 拼接 + SSE 分帧），中文 3 字节/emoji 4 字节切分场景由 `utf8_stream.rs` 单测覆盖（`:112-192` 共 8+ 用例）。

### 9. 附件入口 data-testid

- 附件开关/加号菜单：`ComposerPlusMenu.tsx:276` `btn-toggle-attachments`、`:301` `composer-plus-menu`、`:311/:464` `plus-menu-add-attachment`、`:320/:479` `plus-menu-camera`、`:329/:471` `plus-menu-resource-library`（ComposerPlusMenu 由 ComposerToolbar `:524` 挂载）。
- 附件面板：`AttachmentPanelBody.tsx:159` `attachment-panel-more`（移动端折叠「⋯更多」，`:158` aria-label 用 `common:more`——Step 20/21 收敛裁决在树：组件用顶层 `common:more`，rel-mobile 增补的 `actions.more` 词条保留在 locale 供契约锁定）。
- 工具栏/输入区：`ComposerToolbar.tsx:869` `btn-stop`、`:898` `btn-send`、`:916` `btn-send-disabled-hint`、`:206/:214` context-window-usage 控件；`ComposerTextarea.tsx:140` `input-bar-v2-textarea`；`InputBarUI.tsx:2202` `input-bar-v2-root`、`:2316` `long-paste-suggestion`、`:2344` `flashcard-hint`、`:2366` `media-attachment-hint`。
- 测试引用面：`__tests__/ComposerPlusMenu.test.tsx`、`__tests__/InputBarUI.attachmentPreviewChips.test.tsx`、`__tests__/InputBarUI.mobileInlinePanel.test.tsx`、`tests/ct/input-bar/attachmentMenuPosition.spec.tsx`、`tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts` 均按现 testid 断言，无悬空引用。
- 附件上限不变量：`src/features/chat/core/constants.ts:180` `ATTACHMENT_MAX_SIZE = 200MB`、`:187` `ATTACHMENT_IMAGE_MAX_SIZE = 50MB`、`:189-191` `getAttachmentSizeLimit`（拒绝 #198 的裁决保持）。

## 与 v0.9.44 / 0824 归并关系

- 相对 `v0.9.44`（`git diff --stat v0.9.44..HEAD` 实测）：
  - pipeline 区 26 个文件 +11218/−6057：`hooks.rs`（+1694 新增）、`model_special_tokens.rs`（+475 新增）、`prefix_snapshot_tests.rs`（+234 新增）、compaction/context_compiler 各拆出 5/3 个子模块（`compaction.rs` −2813 行摊到 budget/memory_flush/prompts/segmentation/test_fixtures；`context_compiler.rs` −1328 行摊到 images/model_selection/preprocess）、`tool_loop.rs` 净重构 2734 行（审批内联代码迁出 + cache 冻结迁入）；
  - input-bar 区 27 个文件 +2808/−1593：InputBarUI 3919→2661 行，拆出 ComposerToolbar/ComposerTextarea/AttachmentPanelBody + 3 个 helper + 4 个新契约测试。
- 与 0824 归并谱系逐面对应（均与 `docs/0824-MERGE-PLAN.md` 记录一致）：
  - hooks/拆模来自 E（#213，Step 1），tool_loop 的 hook 调用点在 Step 2 合 H 时按「结构听 0824、cache 语义听 H」保留；
  - H cache 冻结/记账/快照来自 Step 2（`e54603a0`），wrapup 合入后 Step 3 复核未回退；`chat_v2_freeze_available_skills_snapshot` 权限并集在 `application-commands.toml:82`；
  - `utf8_stream.rs`/`sse_buffer.rs`/`model_special_tokens.rs` 来自 A（#268，Step 3 经预演 `3efdc1b3`）；llm_adapter 第 6 参与 H 测试 helper 的 E0061 修复（`ModelWrapTokenPolicy::Disabled` 补传）在树（`llm_adapter.rs:1415/1484`）；
  - Anki 侧 token 语义为 Step 5 合 D 时的双侧保留裁决（D 结构化协议 + wrapup 最终 token 语义共存于 `streaming_anki_service.rs`）；
  - Composer 拆分来自 F（Step 6，`e40e3a98`），G 的 13 处热区按 Step 8 裁决 6 手工重放进 ComposerToolbar/AttachmentPanelBody 而非复活单体；Step 8 收口回收 g-fix-chat 的 4 个契约测试改读拆分文件 + 新增 mobileSplitContract；
  - 附件面板 aria/i18n 为 Step 20（rel-i18n `01ed64bf` 收敛 `common:more`）与 Step 21（rel-mobile locale 增补 + 拆分 i18n 契约 + `be53b8ba` 竞争性修复收敛裁决）的最终态，与树上 `AttachmentPanelBody.tsx:158` 实测一致。
- Step 9 §9.4 的 18 项不变量中与本报告相关的 #1/#2/#3/#4/#5/#7/#17 全部在本轮静态复核中按行号再确认，无回退。

## 风险与是否需要产品修复

1. 【低，无需产品修复】`InputBarUI.tsx` 仍有 2661 行：拆分把 textarea/工具栏/附件面板体/发送可用性/OCR 标签抽走后，附件上传编排与拖放逻辑仍留在壳内。拆分所有权已被 `InputBarUI.mobileSplitContract.source.test.ts` 锁定（ContextWindowUsageRing 不得回流等），残余体量属既定设计，非缺陷。若后续继续拆分应另立主题，不属本轮。
2. 【低，无需产品修复，建议记录】`MODEL_SPECIAL_TOKENS` 五元 token 表在 `utils/model_special_tokens.rs:8` 与 `streaming_anki_service.rs:45` 各有一份：两处语义刻意不同（流式包装过滤 vs 卡片正文保留），双方注释均写明理由，不能简单合并；但若未来新增泄漏 token，需两处同步，存在漂移风险。可在后续轮次考虑共享常量表（仅数据、不共享算法），本轮不改。
3. 【低，无需产品修复】`attachment-panel-more` 仅存在于 AttachmentPanelBody 的移动端分支（`isMobile` 为真时渲染）；桌面端附件入口 testid 走 ComposerPlusMenu（`btn-toggle-attachments`/`plus-menu-add-attachment`）。两组 testid 均有测试消费，无悬空，但写 E2E 时需按视口选对入口——属测试作者须知，非产品缺陷。
4. 【信息项】本 VM 无 `node_modules`、无后台安装任务，本轮未复跑 vitest/cargo；上述契约测试的最近绿灯记录为 Step 8（input-bar 19 文件 171/171）、Step 8 收口（14 个测试文件全过）、Step 21（inputBarSplitI18nKeys 3/3 + releaseUpgradeI18n 3/3），门禁表见 `docs/0824-MERGE-PLAN.md`。静态证据与这些记录相互印证，无矛盾。
5. 未发现：hooks 旁路（审批函数在 tool_loop 无残留副本）、utf8_stream 死代码、单体 InputBarUI 复活、`ChatV2AnkiAdapter` 生产复活、附件上限漂移、testid 悬空引用。

## 结论

**PASS**。Chat V2 pipeline hooks（ApprovalGateHook/TaskAuditHook 及 before_turn/before_compaction/before_tool/after_tool 四类调用点）、tool_loop 的 H cache 冻结链、`availableSkillsSnapshot`/`cache_write_tokens`/`prompt_cache_key` 全链、`utf8_stream` 调用关系、`model_special_tokens` 双语义实现、F 的 Composer* 拆分与 G 热区重放、新会话统一入口、流式监听/回滚/取消链路、附件入口 data-testid 与契约锁定，全部与 0824 归并计划记录及 18 项不变量一致，未发现回退、旁路或坏合成；仅存两条低风险维护性观察（token 表双份、壳文件残余体量），均为既定设计，不需要产品修复。**本轮不改代码**。
