model=claude-fable-5-thinking-xhigh
# Step 22 后 18 不变量再证(官方统一枝)

- 取证对象:`origin/cursor/0824-cde6` @ **`f83e541b1deaf65d9e9c4ac6f4755a73f4c19580`**
  (Step 22 tip,`git rev-parse HEAD` 于 `/tmp/0824-official` 工作树核实;
  tip 提交为 "docs: record Step 22 quality-review tenfold fix + reviewfix landing")。
- 方法:在 `/tmp/0824-official` 只读 grep/read 逐项重新取证,**全部行号为
  f83e541b 现树实测**,不照抄 09 号报告旧行号;数字口径以
  `27-invariants-number-errata.md` 勘误为准(不翻案)。
  本轮不改产品代码、无任何 git 写操作,本文件是唯一产出。

## 18/18 总表

| # | 不变量 | 判定 |
|---|---|---|
| 1 | pipeline hooks(ApprovalGateHook + TaskAuditHook) | PASS |
| 2 | GenUI 执行器注册(catch-all 前) | PASS |
| 3 | H cache(prefix freeze + cache_write_tokens) | PASS(行号漂移) |
| 4 | utf8_stream 有生产调用方 | PASS |
| 5 | model_special_tokens(#200 未回流) | PASS |
| 6 | 闪卡只读(无 save_to_library) | PASS |
| 7 | 无生产 ChatV2AnkiAdapter | PASS |
| 8 | cardAgent.startGeneration 两入口 | PASS |
| 9 | 附件 200/50(#198 未回流) | PASS |
| 10 | finder host buckets | PASS |
| 11 | qbank-tools(daily_target 1..=50 等) | PASS(数字按勘误) |
| 12 | tombstone 复读 fail-closed | PASS |
| 13 | WebDAV decode | PASS |
| 14 | S3 normalize | PASS |
| 15 | FTP 550/501 白名单 | PASS |
| 16 | HPIAS 18-block + 会话隔离 | PASS(行号漂移) |
| 17 | 无 mythos-5 / haiku-5 目录条目 | PASS |
| 18 | NOTICES + Composer* 拆分 + G 44px | PASS(数字按勘误) |

**总判定:18/18 全部 PASS,无 FAIL,无翻案性口径漂移。**
Step 22 落地未回退任何不变量;三处标注"行号漂移/数字按勘误"均为
证据位置或计数口径的正常演进,裁决方向不变(详见各条)。

## 逐项证据(f83e541b 现树实测行号)

### 1. pipeline hooks — PASS

- `src-tauri/src/chat_v2/pipeline.rs:83` `pub mod hooks`;`pipeline.rs:243`
  构造时安装 `hooks::default_pipeline_hooks()`。
- `src-tauri/src/chat_v2/pipeline/hooks.rs:99` `trait PipelineHook`;
  `hooks.rs:141-142` 默认注册 `ApprovalGateHook` + `TaskAuditHook`;
  两 hook 定义/实现在 `hooks.rs:226/229`、`hooks.rs:952/955`。
- 生产调用点:`src-tauri/src/chat_v2/pipeline/tool_loop.rs:3191`
  (`hook.before_tool`)、`tool_loop.rs:3272`(`hook.after_tool`);
  `tool_loop.rs:3269` 注释确认审计已迁至 `TaskAuditHook::after_tool`,
  无旧副本回流。与 09 记录一致。

### 2. GenUI 执行器注册 — PASS

- `src-tauri/src/chat_v2/pipeline.rs:347`
  `executors.push(Arc::new(super::tools::GenerativeUiExecutor::new()))`;
  catch-all `GeneralToolExecutor` 在 `pipeline.rs:408-409`
  ("must be last (catch-all)"),注册顺序满足"catch-all 前"。
- `src-tauri/src/chat_v2/tools/mod.rs:165` 导出;
  `generative_ui_executor.rs:44-49` 定义 + `new()`,
  `:351` `impl ToolExecutor for GenerativeUiExecutor`(09 记 :348,
  行号漂移 +3,实现仍在)。

### 3. H cache(prefix freeze + cache telemetry)— PASS(行号漂移)

- prefix freeze 全链:`src-tauri/src/chat_v2/pipeline/tool_loop.rs:26`
  `sort_tool_schemas_for_prompt_cache`、`:44` freeze order 内部调用、
  `:78` `merge_frozen_tool_schema_order_baseline`、`:105`
  `freeze_tool_schemas_for_prompt_cache`、`:985` 生产调用。
- 会话基线持久化/恢复:`src-tauri/src/chat_v2/repo.rs:2658`
  `get_session_frozen_tool_schema_order`、`:2686`
  `merge_session_frozen_tool_schema_order`(09 记 :2708,行号漂移,
  函数对齐在 :2658-2699 区间);pipeline 侧内存+落库双层在
  `pipeline.rs:192/240`,断电恢复回归
  `pipeline.rs:1153` `frozen_tool_schema_order_survives_memory_clear`;
  快照回归 `src-tauri/src/chat_v2/pipeline/prefix_snapshot_tests.rs` 在树。
- cache telemetry:迁移
  `src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql`
  在树,`src-tauri/migrations/migration-lock.json:272` 锁定
  (09 写 `src-tauri/migration-lock.json`,实际路径在 `migrations/` 下,
  属 09 的路径简写,非回退);
  `src-tauri/src/llm_usage/mod.rs:184` `record_llm_usage_cache_ext`;
  `cache_write_tokens` 在 `src-tauri/src` 15 个文件命中
  (providers/mod.rs 15 处、model2_pipeline.rs 10 处、
  llm_usage/{repo,mod,types,database,collector}.rs、
  chat_v2/{types,tool_loop,llm_adapter,pipeline_tests,llm_usage_executor}、
  data_governance/migration/{coordinator,llm_usage}.rs、
  migration_compat_tests.rs),全链在位。

### 4. utf8_stream 有生产调用方 — PASS

- `src-tauri/src/llm_manager/utf8_stream.rs:28` 定义 `Utf8StreamDecoder`。
- `src-tauri/src/utils/sse_buffer.rs:1` 导入,`:128` 作为 `SseEventBuffer`
  字段,`:138`、`:148` 两个构造函数实例化。
- `SseEventBuffer` 生产调用方 8 处(files_with_matches 实测):
  `providers/mod.rs`、`llm_manager/model2_pipeline.rs`、
  `llm_manager/mod.rs`、`streaming_anki_service.rs`、
  `translation/pipeline.rs`、`qbank_grading/pipeline.rs`、
  `essay_grading/pipeline.rs`、`vlm_grounding_service.rs`。
  #158 的 hygiene 删除未回流。

### 5. model_special_tokens — PASS

- `src-tauri/src/utils/model_special_tokens.rs` 在树
  (`ModelWrapTokenPolicy` + `ModelWrapTokenStreamFilter`)。
- 两条生产流入口接入:`src-tauri/src/chat_v2/pipeline/llm_adapter.rs:192`
  (filter 字段)、`:227`(`ModelWrapTokenPolicy` 构造参数)、`:246`
  (`ModelWrapTokenStreamFilter::new`);
  `src-tauri/src/chat_v2/pipeline/variant_adapter.rs:24/:39/:52` 同构。
- Anki 侧终版语义:`src-tauri/src/streaming_anki_service.rs:45`
  `MODEL_SPECIAL_TOKENS`、`:75` `strip_model_special_tokens`、
  `:1457` 残片收尾(09 记 :1447,行号漂移 +10,语义不变)。
- #200 旧实现标识 `SpecialTokenStreamStripper` 在 `src-tauri/**`
  **零命中**,未回流。

### 6. 闪卡只读 — PASS

- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55`
  全文核读:仅渲染 front/back/tags/deckName,无按钮、无 handler、
  无持久化调用(纯 Card/Badge 展示)。
- `src/features/generative-ui/blocks/index.ts:89-92` 仅注册
  `flashcard-preview` 为 preview block;
  `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts` 在树。
- `save_to_library`/`saveToLibrary` 在 `src/features/generative-ui/**`
  **零命中**;zh-CN/en-US 两份 `generativeUi.json` 零命中;
  `src/locales/zh-CN/common.json:1185`(「保存到错题本」)与
  `en-US/common.json:771` 的 `save_to_library` 为错题本既有键,
  非 GenUI 死键回流。Step 22 未回退闪卡只读。

### 7. 无生产 ChatV2AnkiAdapter — PASS

- `src/**` 无名为 `ChatV2AnkiAdapter` 的模块文件;字符串命中仅为
  迁移注释(`selectionCardGeneration.ts:10`、
  `generateCardsFromText.ts:49`、`cardforge/index.ts:28`、
  `selectionCardGeneration.test.ts:108`)与负向守卫测试:
  `src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts:28/:34/:45`
  (无 import)、`:50-66`(无模块文件、无动态 import),
  `src/features/pdf/components/__tests__/pdfSelectionToolbar.source.test.ts:68`。

### 8. cardAgent.startGeneration 两入口 — PASS

- 聊天划词入口 `src/features/chat/services/selectionCardGeneration.ts:121`
  直调 `cardAgent.startGeneration`;共享文本入口
  `src/features/anki/generateCardsFromText.ts:50` 同。
- `src/components/anki/cardforge/engines/CardAgent.ts:446`
  `startGeneration`,`:461` 经 `start_enhanced_document_processing`
  非阻塞启动(09 记 :411,行号漂移,链路不变)。
- 守卫:`cardGenerationSurfaces.source.test.ts:25-33` 锁定两入口
  必须包含 `cardAgent.startGeneration(`。

### 9. 附件 200/50 — PASS

- 前端:`src/features/chat/core/constants.ts:180`
  `ATTACHMENT_MAX_SIZE = 200 * 1024 * 1024`、`:187`
  `ATTACHMENT_IMAGE_MAX_SIZE = 50 * 1024 * 1024`、`:189-191`
  `getAttachmentSizeLimit(isImage)` 按图片/文件选限额;
  `src/features/chat/resources/types.ts:265` `IMAGE_SIZE_LIMIT = 50MB`、
  `:271` `FILE_SIZE_LIMIT = 200MB`。
- 后端:`src-tauri/src/vfs/repos/attachment_repo.rs:143`
  `MAX_IMAGE_BYTES = 50MB`、`:144` `MAX_FILE_BYTES = 200MB`,
  `:376-378` 按 mime 选择。
- #198 的"图片入口统一 200MB"赋值不存在(`MAX_IMAGE_BYTES` 仍为 50MB),
  未回流。

### 10. finder host buckets — PASS

- `src/features/learning-hub/stores/finderStore.ts:415`
  `resolveFinderHostId`、`:527` `createFinderStore(bucketId)`、
  `:1264-1267` 按 bucketId 惰性建 store 注册、`:1286`
  `useFinderStoreFor`、`:1302` 活跃宿主解析。
- `tests/vitest/learning-hub/finder-host-buckets.test.ts` 在树;
  无断言共桶的 wrapup 回流测试。

### 11. qbank-tools — PASS(数字按 27 号勘误口径)

- `src/features/chat/skills/builtin-tools/qbank-tools.ts:744-745`
  保留【必填】标注(year/month),`:746`
  `daily_target: { minimum: 1, maximum: 50 }`(缺省 10)、
  `:748` `page_size ≤ 20`;压缩版描述在位(`:738` 等)。
- 后端校验:`src-tauri/src/chat_v2/tools/qbank_executor.rs:3588-3594`
  ("daily_target 必须是 1..=50 的整数")、`:3605` 转发;
  达标计算 `src-tauri/src/question_bank_service.rs:2847`
  `daily_target.unwrap_or(10).max(1)`。
- token 预算锁:`tests/vitest/chat-v2/token-budget.test.ts:139-141`
  现行护栏 `MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6_800` /
  `MAX_TOTAL_SCHEMA_TOKENS = 51_500` / `MAX_TOTAL_TOKENS = 75_500`,
  由 `:197-200`(单组)与 `:209-210`(合计)断言强制。
  **与 27 号勘误第 1 条完全一致**(09 所引 9500/68000/95000 为
  :131 注释里的 R1 旧护栏,不翻案,以勘误为准)。

### 12. tombstone 复读 fail-closed — PASS

- `src-tauri/src/data_governance/sync/tombstone.rs:302`
  `put_event_verified`(生产调用 `:414`)、`:597`
  `put_tombstone_manifest_and_reread`;`:1432/:1468/:1497`
  blob/asset/workspace 三类清单全部走复读 helper。
- 源码契约 `:2030`(source contains
  "put_tombstone_manifest_and_reread")+ 截断替身回归
  `:2048` `upload_blob_tombstones_fails_when_reread_mismatches`。

### 13. WebDAV decode — PASS

- `src-tauri/src/cloud_storage/webdav.rs:597` `fn decode_path`;
  `:182-188` URL builder 对 base segment 先解码再交由 push 单次编码;
  `:610-620` PROPFIND href 与 base 统一解码后同空间比较。
- 回归:`:1998` `extract_relative_key_decodes_non_ascii_endpoint_path`、
  `:2051` `extract_relative_key_decodes_space_in_endpoint_path`、
  `:2147` 源码契约锁定 `fn decode_path` 不被删除。

### 14. S3 normalize — PASS

- `src-tauri/src/cloud_storage/s3.rs:85` `fn normalize_endpoint`,
  `:152` 生产调用;`:198-199` path_style 强制透传。
- 回归:`:1121` 剥离 bucket-prefixed host、`:1188` 补 scheme/trim、
  `:1202` `normalize_endpoint_keeps_path_style_paths_untouched`、
  `:1218` `normalize_endpoint_keeps_canonical_endpoints_untouched`。

### 15. FTP 550/501 白名单 — PASS

- `src-tauri/src/cloud_storage/ftp.rs:278`
  `if !matches!(code, 550 | 501) { return false; }` 状态码白名单先行;
  `:267-272` 注释锚定"白名单 + 明确 not-found 文案"双条件,
  `:281-286` 明确 not-found 文案枚举;`:289-302`
  `is_missing_directory_error` 删除路径仅认明确 not-found/gone 的 550,
  无法归类的 550 fail-closed 上抛。
- 回归:`:1294` 合法 missing 样本、`:1325` 歧义 550 不当 missing、
  `:1341` 明确缺失父目录放行、`:1370` 权限型/歧义 CWD 仍报错。

### 16. HPIAS 18-block + 会话隔离 — PASS(行号漂移)

- 18 块白名单:`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:23-42`
  `ALLOWED_GENERATIVE_UI_BLOCK_TYPES` **逐项数过恰 18 项**
  (stat-card / alert / list / progress / action-bar / text /
  key-value-grid / flashcard-preview / review-calendar /
  mistake-analysis / mindmap-embed / paper-digest / research-plan /
  research-report / markdown / chart / steps / table);
  `:111-116` ingress 拒绝非字符串与未知 type;
  `:685-703` 测试 `parse_intent_accepts_all_registered_block_types`
  断言 `Some(18)`。**Step 22 未增减块数**。
- 会话隔离:`src/features/generative-ui/bridge/hpiasEventBridge.ts:106-116`
  scoped bridge fail-closed——缺失/非字符串/不匹配 `session_id`
  一律拒收(09 记 :106-113,行号漂移,收紧逻辑原样在位);
  `src/stores/hpiasSessionSlice.ts:7` `MAX_HPIAS_SESSION_SLICES = 8`、
  `:28` 建切片、`:95-101` 按会话折叠、`:198-201` 有界淘汰;
  `src/stores/researchStore.ts:101` 多 session slices、`:247-253`
  外会话事件只写 `sessions[id]` 不覆盖活跃顶层,`:263/:571` 淘汰调用。
- 清洗链:`src/features/generative-ui/utils/` 下
  `sanitizeGenerativeUrl.ts`、`sanitizeGenerativeMarkdown.ts`、
  `sanitizeGenerativeText.ts` 三件套均在树。

### 17. 无 mythos-5 / haiku-5 目录条目 — PASS

- `src-tauri/src/llm_manager/builtin_vendors.rs:925` 注释锁定
  "官方最新 Haiku 仍为 4.5,不存在 claude-haiku-5";
  `:1682-1687` 负向断言 `claude-haiku-5` 不进内置目录、
  `:1690` `mythos` 不进内置目录。
- `src/utils/__tests__/apiCapabilityEngine.test.ts:121-122` 锁定
  `findModelRecordById('claude-haiku-5')` 为 undefined。
- `src/utils/deepseekReasoningControls.ts:213/:227/:233/:239` 的
  `mythos/fable` 命中为适配层代际启发式(对用户手填 ID 的能力判定),
  非目录条目,与 09 既有裁决一致,不构成违例。

### 18. NOTICES + Composer* 拆分 + G 44px — PASS(数字按 27 号勘误口径)

- NOTICES:`legal/THIRD_PARTY_NOTICES.txt` 为唯一权威文件,
  `public/legal/` **不存在**(ls 实测 No such file);四处指向核实:
  `scripts/generate-third-party-notices.mjs:16`(输出 `legal/`,
  `:13` 注释明确"不再放 public/")、
  `scripts/check-license-compliance.mjs:39/:96`、
  `src-tauri/tauri.conf.json:62`、`vite.config.ts:84`。
- Composer* 拆分:`src/features/chat/components/input-bar/` 下
  `ComposerToolbar.tsx`、`ComposerTextarea.tsx`、`ComposerPlusMenu.tsx`、
  `ComposerInlinePanel.tsx`、`ComposerPanelOverlay.tsx`、`ComposerPanel/`
  与 `AttachmentPanelBody.tsx` 齐全;`InputBarUI.tsx` 现为 **2661 行**
  (wc -l 实测);v0.9.44 单体本轮 `git show v0.9.44:… | wc -l`
  复算为 **3919 行**(与 27 号勘误第 3 条一致;09 的 3921 为旧口径),
  2661 < 3919,单体未复活。
- G 44px/safe-area/返回键:`ComposerToolbar.tsx:67`(发送钮 coarse
  `!h-11 !w-11`)、`:731`(模型搜索框 coarse `!h-11 !text-base`)、
  `:876`(停止钮 coarse `!w-11 !h-11`,注释"移动端与发送按钮同为
  44px 触控目标");`pointer:coarse` 计数按勘误口径实测:
  **src 4101 + tests 4 = 4105**(与 27 号勘误第 2 条逐位吻合,
  ≥ Step 8 基线 3056);`registerBackHandler` src 内 172 处
  (与 Step 8 持平);safe-area 覆盖 src 内 68 个文件 +
  `src/styles/ios-safe-area.css` 在树;
  `src-tauri/mobile/android/MainActivity.kt:10/:46`
  `OnBackPressedCallback` 注册。

## Step 22 专项:落地是否回退不变量

重点核对三处,均无回退:

1. **VFS coordinator 加法完好**:
   `src-tauri/src/data_governance/migration/coordinator.rs:2383`
   `apply_vfs_init_missing_tables`(生产调用 `:2280`,
   置于 `ensure_change_log_table` 之前,防 V20260131 触发器回放踩空表;
   测试 `:5873`);`coordinator.rs:2345`
   `pre_repair_vfs_v20260824_note_props`(生产调用 `:2331`,
   收敛 notes.props 两种中间态——history 有列缺则补列、列有 history 缺
   则补记账,两者皆缺不抢跑;测试 `:5388`)。两个加法的定义、
   生产调用、测试三层俱在。
2. **HPIAS 18-block 数量**:allowlist 逐项数过恰 18,测试断言
   `Some(18)` 在位(见第 16 项),Step 22 未增删。
3. **闪卡只读**:`FlashcardPreviewBlock.tsx` 全文核读纯展示,
   GenUI 目录与两份 `generativeUi.json` 中 `save_to_library` 零命中
   (见第 6 项),Step 22 未加保存入口。

## 口径漂移与勘误对账(不翻案)

- 第 11 项:护栏按 27 号勘误为 **6800/51500/75500**
  (`token-budget.test.ts:139-141` 实测),本轮直接以勘误口径取证,吻合。
- 第 18 项:`pointer:coarse` 按勘误口径 **src 4101 + tests 4 = 4105**,
  本轮分域计数逐位复现;v0.9.44 单体按勘误为 **3919 行**,本轮
  `git show` 复算吻合。
- 纯行号漂移(证据仍在,判定不变):第 2 项 `impl ToolExecutor`
  348→351;第 3 项 repo.rs 会话基线 2708→2658-2699;第 5 项
  Anki 残片收尾 1447→1457;第 8 项 `startGeneration` 411→446;
  第 16 项 hpiasEventBridge 106-113→106-116。均为 Step 18-22 期间
  正常代码演进,无任何一处削弱不变量语义。
- 第 3 项 migration-lock 路径:09 写 `src-tauri/migration-lock.json`,
  实际为 `src-tauri/migrations/migration-lock.json:272`,
  属 09 的路径简写,锁记录本身在位。

## 结论

**18/18 全部 PASS,无 FAIL。** Step 22(质量评审 10 路 + reviewfix)
落地未回退任何不变量;VFS coordinator 两个加法、HPIAS 18-block、
闪卡只读三处重点专项均完好。数字层面全部与 27 号勘误对齐,
无新增口径漂移。**本轮不改代码。**
