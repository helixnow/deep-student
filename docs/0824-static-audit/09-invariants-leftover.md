# 09 — 18 不变量复核 + leftover PR 吸收审计

- 审计树：`cursor/0824-static-audit-cde6` @ `9f1aa668`。该提交仅新增
  `docs/0824-static-audit/README.md`（`git show --stat` 核实 1 file +29），
  产品文件与基座 `origin/cursor/0824-cde6` @ `2d41ea8b` **零差异**，
  以下全部路径+行号证据等价于对基座的取证。
- 方法：本地只读 grep/read 逐项取证；leftover 部分用 `gh`（只读）拉取全部
  65 个开放 PR 的 head SHA，与 `docs/0824-MERGE-PLAN.md` Step 1–21 记录及
  #308 全量扫描表核对，head 移动者用 compare API 逐提交核实，
  已吸收提交用 `git merge-base --is-ancestor` 验证确在基座历史中。
- 本轮不改产品代码、不做 git 写操作；本文件是唯一产出。

## 一、18 不变量逐项复核

### 1. pipeline hooks — PASS

- `src-tauri/src/chat_v2/pipeline.rs:83` `pub mod hooks`；`pipeline.rs:243`
  构造时安装 `hooks::default_pipeline_hooks()`。
- `src-tauri/src/chat_v2/pipeline/hooks.rs:99` `trait PipelineHook`；
  `hooks.rs:141-142` 默认注册 `ApprovalGateHook` + `TaskAuditHook`；
  两 hook 实现在 `hooks.rs:226-229`、`hooks.rs:952-955`。
- 生产调用点：`src-tauri/src/chat_v2/pipeline/tool_loop.rs:3190-3191`
  （`before_tool`）、`tool_loop.rs:3271-3272`（`after_tool`）；
  `tool_loop.rs:3170`、`3269` 注释明确审批/审计已迁至 hooks，无旧副本回流。

### 2. GenUI 执行器注册 — PASS

- `src-tauri/src/chat_v2/pipeline.rs:347` 在 catch-all 前
  `executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()))`。
- `src-tauri/src/chat_v2/tools/mod.rs:165` 导出；
  `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:44-48` 定义，
  `:348` 实现 `ToolExecutor`。

### 3. H cache（prefix freeze + cache telemetry）— PASS

- prefix freeze 全链：`src-tauri/src/chat_v2/pipeline/tool_loop.rs:26`
  `sort_tool_schemas_for_prompt_cache`、`:44` freeze order、`:78`
  `merge_frozen_tool_schema_order_baseline`、`:105`
  `freeze_tool_schemas_for_prompt_cache`、`:985` 生产调用；
  会话基线恢复 `src-tauri/src/chat_v2/repo.rs:2708`；
  回归测试 `src-tauri/src/chat_v2/pipeline/prefix_snapshot_tests.rs:22`。
- cache telemetry：迁移
  `src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql`
  （`migration-lock.json:272` 锁定）；
  `src-tauri/src/llm_usage/mod.rs:184` `record_llm_usage_cache_ext`；
  `cache_write_tokens` 全链在 `providers/mod.rs`、
  `llm_manager/model2_pipeline.rs`、`chat_v2/pipeline/tool_loop.rs`、
  `llm_usage/{types,database,repo,collector}.rs` 等 15 个文件在树。

### 4. utf8_stream 有生产调用方 — PASS

- `src-tauri/src/llm_manager/utf8_stream.rs:28` 定义 `Utf8StreamDecoder`。
- `src-tauri/src/utils/sse_buffer.rs:1` 导入，`:128` 作为 `SseEventBuffer`
  字段，`:138`、`:148` 两个构造函数实例化。
- `SseEventBuffer` 生产调用方 8 处：`providers/mod.rs`、
  `llm_manager/model2_pipeline.rs`、`llm_manager/mod.rs`、
  `streaming_anki_service.rs`、`translation/pipeline.rs`、
  `qbank_grading/pipeline.rs`、`essay_grading/pipeline.rs`、
  `vlm_grounding_service.rs`。#158 的 hygiene 删除未回流。

### 5. model_special_tokens — PASS

- `src-tauri/src/utils/model_special_tokens.rs` 在树（保守、按
  provider/model 启用的 `ModelWrapTokenPolicy` + `ModelWrapTokenStreamFilter`）。
- 两条生产流入口接入：`src-tauri/src/chat_v2/pipeline/llm_adapter.rs:192`、
  `:227`（`ChatV2LLMAdapter::new` 第 6 参）、`:246`；
  `src-tauri/src/chat_v2/pipeline/variant_adapter.rs:24`、`:39`、`:52`。
- Anki 侧终版语义（#268 对 #187）：
  `src-tauri/src/streaming_anki_service.rs:45` `MODEL_SPECIAL_TOKENS`、
  `:75` `strip_model_special_tokens`、`:1447` 残片收尾。
- #200 旧实现标识 `SpecialTokenStreamStripper` 在 `src-tauri/**` 零命中，
  未回流。

### 6. 闪卡只读 — PASS

- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55`
  仅渲染 front/back/tags/deckName，无按钮、handler、持久化调用。
- `src/features/generative-ui/blocks/index.ts:90-91` 仅注册
  `flashcard-preview` 为 preview block；
  `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts` 在树。
- `save_to_library`/`saveToLibrary` 在 `src/features/generative-ui/**` 与
  zh-CN / en-US 两份 `generativeUi.json` 均零命中；
  `src/locales/{zh-CN,en-US}/common.json:1185/:771` 的 `save_to_library`
  为错题本既有键，非 GenUI 死键回流。

### 7. 无生产 ChatV2AnkiAdapter — PASS

- `src/**` 无名为 `ChatV2AnkiAdapter` 的模块文件，无 import/new/方法调用；
  现存字符串仅为迁移注释（`selectionCardGeneration.ts:10`、
  `generateCardsFromText.ts:49`、`cardforge/index.ts:28`）与负向守卫测试
  （`src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts:28-77`
  锁定"无模块文件 + 无 import"；
  `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`）。

### 8. cardAgent.startGeneration — PASS

- 聊天划词入口 `src/features/chat/services/selectionCardGeneration.ts:121`
  直调 `cardAgent.startGeneration`；共享文本入口
  `src/features/anki/generateCardsFromText.ts:50` 同。
- `src/components/anki/cardforge/engines/CardAgent.ts:411`
  `startGeneration` 经 `start_enhanced_document_processing` 非阻塞启动。
- 守卫：`cardGenerationSurfaces.source.test.ts:25-33` 锁定两入口
  必须包含 `cardAgent.startGeneration(`。

### 9. 附件 200/50 — PASS

- 前端：`src/features/chat/core/constants.ts:180`
  `ATTACHMENT_MAX_SIZE = 200MB`、`:187`
  `ATTACHMENT_IMAGE_MAX_SIZE = 50MB`、`:189-191` 按图片/文件选限额；
  `src/features/chat/resources/types.ts:265` `IMAGE_SIZE_LIMIT = 50MB`、
  `:271` `FILE_SIZE_LIMIT = 200MB`。
- 后端：`src-tauri/src/vfs/repos/attachment_repo.rs:143-144`
  `MAX_IMAGE_BYTES = 50MB` / `MAX_FILE_BYTES = 200MB`，`:375-379`
  按 mime 选择。#198 的"图片入口统一 200MB"赋值不存在。

### 10. finder host buckets — PASS

- `src/features/learning-hub/stores/finderStore.ts:415-417`
  `resolveFinderHostId`（除兼容共桶集合外每宿主独立）、`:421-424`
  每桶独立持久化 key、`:527` `createFinderStore(bucketId)`、
  `:1263-1268` `Map<bucketId, store>` 注册、`:1286-1287`
  `useFinderStoreFor`、`:1301-1302` 活跃宿主机制。
- `tests/vitest/learning-hub/finder-host-buckets.test.ts` 在树；
  无断言共桶的 wrapup 回流测试。

### 11. qbank-tools — PASS

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:744-745`
  保留【必填】标注，`:746` `daily_target: 1..=50`（缺省 10）、
  `:748` `page_size ≤ 20`；压缩版描述在位。
- 后端校验转发 `src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3605`
  （"daily_target 必须是 1..=50 的整数"）；达标计算
  `src-tauri/src/question_bank_service.rs:2847`
  `daily_target.unwrap_or(10).max(1)`。
- token 预算锁 `tests/vitest/chat-v2/token-budget.test.ts:131`
  （现行基线：单组 7389 / schema 合计 54050 / 总计 75689，
  护栏 9500/68000/95000——预算锁随实现演进但仍在位）。

### 12. tombstone — PASS

- `src-tauri/src/data_governance/sync/tombstone.rs:302`
  `put_event_verified`（事件 PUT 后核验）、`:597`
  `put_tombstone_manifest_and_reread`（清单 PUT 后 GET 复读，短写
  fail-closed）、`:1432/:1468/:1497` blob/asset/workspace 三类清单
  全部走复读 helper。
- 源码契约 `tombstone.rs:2027-2031` + 截断替身回归
  `:2048`（`upload_blob_tombstones_fails_when_reread_mismatches`）。

### 13. WebDAV decode — PASS

- `src-tauri/src/cloud_storage/webdav.rs:597-599` `decode_path`；
  `:187` URL builder 对 base segment 先解码再单次编码；
  `:616-619` PROPFIND href 与 base 在同一解码空间比较。
- 回归：`webdav.rs:1998`（非 ASCII 路径）、`:2051`（空格路径）、
  `:2147-2152` 源码契约锁定 decode 链不被删除。

### 14. S3 normalize — PASS

- `src-tauri/src/cloud_storage/s3.rs:85` `normalize_endpoint`，
  `:152` 生产调用。仅对已知 provider 的 bucket-prefixed host 保守剥离；
  `:1202-1222` 回归锁定 path-style 与规范 endpoint 不猜改，
  `:1188` 补 scheme/trim 语义。

### 15. FTP 550/501 — PASS

- `src-tauri/src/cloud_storage/ftp.rs:278`
  `if !matches!(code, 550 | 501)`——状态码白名单先行；`:267-277` 注释与
  实现要求"白名单 + 明确 not-found 语义"同时满足；`:289-299` 删除路径仅认
  明确 not-found/gone 的 550。
- 回归：`ftp.rs:1287-1299`（合法 missing 样本）、`:1325-1335`
  （权限型/歧义 550 fail-closed）、`:1343-1345`。

### 16. HPIAS 18-block + 会话隔离 — PASS

- 18 块白名单：
  `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42`
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` 恰 18 项，`:114-116` ingress 拒绝
  未知 type；`:683-700` 测试锁定恰好 18。
- 会话隔离：`src/features/generative-ui/bridge/hpiasEventBridge.ts:106-113`
  缺失/非字符串/不匹配 `session_id` 一律拒收（Step 20 rel-chat
  `249df98a` 收紧已在基座）；
  `src/stores/hpiasSessionSlice.ts:28/42/96/198` 按 session 折叠与有界淘汰；
  `src/stores/researchStore.ts:101` 多 session slices、`:247`
  外会话事件只写 `sessions[id]` 不覆盖活跃顶层。
- 清洗链：`src/features/generative-ui/utils/sanitizeGenerativeUrl.ts`、
  `sanitizeGenerativeMarkdown.ts`、`sanitizeGenerativeText.ts` 均在树。

### 17. 无 mythos-5 / haiku-5 — PASS

- `src-tauri/src/llm_manager/builtin_vendors.rs:925` 注释锁定
  "官方最新 Haiku 仍为 4.5"；`:1681-1690` 负向断言
  `claude-haiku-5` 与 `mythos` 不进内置目录。
- `src/utils/__tests__/apiCapabilityEngine.test.ts:121-123` 锁定
  `claude-haiku-5` 无 registry 解析。
- `src/utils/deepseekReasoningControls.ts:213-239` 的 `mythos/fable`
  命中为适配层代际启发式（对用户手填 ID 的能力判定），非目录条目，
  与 `builtin_vendors.rs:1689` 注释的裁决一致，不构成违例。

### 18. NOTICES + Composer* + G 44px — PASS

- NOTICES：`legal/THIRD_PARTY_NOTICES.txt` 为唯一权威文件，
  `public/legal/` 不存在；`scripts/generate-third-party-notices.mjs:16`、
  `scripts/check-license-compliance.mjs:39`、`src-tauri/tauri.conf.json:62`、
  `vite.config.ts:84` 全部指向 `legal/`。
- Composer* 拆分：`src/features/chat/components/input-bar/` 下
  `ComposerToolbar.tsx`、`ComposerTextarea.tsx`、`ComposerPlusMenu.tsx`、
  `ComposerInlinePanel.tsx`、`ComposerPanelOverlay.tsx`、`ComposerPanel/`
  与 `AttachmentPanelBody.tsx` 齐全；`InputBarUI.tsx` 现为 2661 行，
  3921 行单体未复活。
- G 44px/safe-area/返回键：`ComposerToolbar.tsx:67`（发送钮 coarse
  `!h-11 !w-11`）、`:731`（模型搜索框 coarse `!h-11 !text-base`）、
  `:876`（停止钮 coarse）；全树 `pointer:coarse` 出现 4105 次
  （≥ Step 8 基线 3056）、`registerBackHandler` 172 处（与 Step 8 持平）、
  safe-area 68 个文件 + `src/styles/ios-safe-area.css`；
  `src-tauri/mobile/android/MainActivity.kt:10/:46` `OnBackPressedCallback`。

## 二、leftover：开放 PR 未吸收产品增量复核

开放 PR 共 65 个（`gh` 只读快照，本审计执行时点）。按指令排除
dependabot（#123）、对照/隔离/预演族后，逐类核对：

### 2.1 指令点名的四个已处理 PR

| PR | head（现） | 核实结果 |
|---|---|---|
| #177 cloud-sync | `89808fd8` | 与 Step 17 收口 tip 完全一致，零新增；Step 10–17 的 14 个端口提交（`4bebbf81`…`172fd10d`）经 `merge-base --is-ancestor` 逐一确认在基座 |
| #213 optimization | `746445fc` | head 自 Step 9 审计后未动。按指令仅吸收 parser `e83d4081` + rustfmt `6a903224`（两者 IN-BASE 核实），其余（`746445fc` 测试重放、`e311daa4` skill 契约）维持 DROP，未回流 |
| #214 Generative-UI | `c2786d4b` | head 未动；**整支未合并**（`git log` 无该 merge）；其 GenUI/HPIAS 产品增量经 leftovers-safe（#292 @ `0aab5fd7`，Step 7 merge `362dd2df`）patch 等价落地，树上核实：18-block allowlist、sanitize 三件套、session slices 全在（见第一节 6/16 项）；8 分片 CI 按指令 DROP，未出现在 `.github/` |
| #160 practice-review | `7c1a5094` | 经 #303 承载，产品尾款 Step 10.2 落地（`41587d48` IN-BASE）；#303 此后仅 +1 docs 提交（`f62082e7`，compare 核实） |

### 2.2 Step 18–21 rel 枝（#313–#324）

12 条 rel 枝 head 与 Step 18–21 记录逐一对上：INCLUDE 提交的落地映射
（`e24b828d`/`67a7fdf8`/`5f324e1f`/`920dd665`/`0105a7eb`/`1df0ec6a`/
`6cfabf67`/`d7fb7677`/`01ed64bf`/`a4057892`/`5f80e9a0`/`65a53f3d`/
`705a05f4`/`f702121b`/`e7aa650e`/`77ee8ecb`/`caa86864`/`249df98a`/
`71a51913`/`17f8cdba`/`0b3d20ed`/`96a1ca42`/`2e788607`/`be53b8ba`）
全部 IN-BASE。唯一 head 移动是 #313 rel-finder：`0a6344e1` 之后
+1 提交 `f2b55909`，compare 核实为 docs-only
（"record finder upgrade compatibility audit"），无产品增量。
#314/#318/#319/#321/#322/#324 的 head 即各自 Step 19–21 记录的
docs-only SKIP 提交，无遗漏。

### 2.3 主题源 PR（#172/#176/#183/#215/#268）

compare API 核实各主题仓 tip 完整包含源 PR head（`behind_by=0`）：
#176 @ `97ee408c` ⊂ theme-F `575fee7f`；#172 @ `e963b6df` ⊂ theme-G
`4ab24435`；#183 @ `59c7f0aa` ⊂ theme-H `9101aa0b`；#215 @ `f4f1300e`
⊂ theme-D `07146ea9`。#268 现 head `1306b85a` 为已吸收 tip `1f8d9850`
的**祖先**（compare status=behind, ahead=0），无新增。#175 为 docs 枝，
且为 theme-H 底座，已随 Step 2 吸收。

### 2.4 卫星 PR（#158–#267）与旧 PR

全部 head SHA 与 #308 全量扫描表（基线 `188500e0`）逐一比对**相同**，
扫描判定继续有效：祖先 90、等价 cherry-pick 5（#177/#205/#208/#210/#212）、
适配吸收 7（#159/#161/#162/#163/#164/#167 + #158 工具链部分）、
指令 IGNORE（#170 mythos-5、#198 图片 200MB、#200 旧 token 剥离、#203、
#158 有害 utf8_stream 删除、#209/#218 被取代）。其中与 18 不变量直接相关的
四个拒绝项（#170/#198/#200/#158-删除）已在第一节 17/9/5/4 项逐一确认
未回流。#113/#134/#155 为合并计划第 2 节明确忽略的过旧冲突/机器人 PR，
维持不吸收，属既定决策而非新 leftover。

### 2.5 对照/隔离/预演族（按指令忽略，仅记录移动）

#269（0824 本体 @ `2d41ea8b` = 本审计基座）、#280–#300 预演、
#270/#271/#275 主题仓、#279/#289/#292 leftovers 族（#292 已吸收，
#279/#289 被其取代）、#293/#301/#302/#304–#308/#310–#311/#325 对照与
文档枝、#326（本进度仓）。head 移动仅三处且均无产品增量：
#309 +1 docs（`1be75038`）、#312 +2 提交 = `2e74b23c`
（Step 17 已端口为 `c8f40a01`，IN-BASE）+ docs（`10ccd369`）、
#304 加法已被 `08b81e29` 吸收（Step 10.3 记录，本次 IN-BASE 复核）。

### 2.6 小结

自 #308/#321 两轮扫描与 Step 18–21 收口以来，开放 PR 的全部 head 移动
（#303/#309/#312/#313）均为 docs-only 或已端口的测试提交；
**不存在未吸收的产品增量**。#214 维持整支不合并、#213 维持
"parser+rustfmt 之外 DROP"，两者 head 均未前进，无需新动作。

## 结论

**PASS。** 18 项不变量在基座 `2d41ea8b`（= 本审计树的产品文件终态）上
逐项复核全部成立，证据见第一节各条路径+行号；leftover 复核确认开放 PR
中除已处理的 #160/#177/#213/#214 与 Step 18–21 rel 枝外无任何未吸收
产品增量，扫描以来的分支移动全部为 docs-only 或已端口内容。
无需产品修复；两处非违例观察已记录在案（#11 token 预算基线随实现演进、
#17 适配层 mythos/fable 启发式为能力判定非目录条目）。
**本轮不改代码。**
