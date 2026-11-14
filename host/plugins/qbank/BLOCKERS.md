# 跨 lane 阻塞证据（L14-qbank）

本文件只记录“对方 api 尚无可用符号、且不能用本 lane 临时替身完成”的缺口。
本 lane 已完成的接线不在此列。

## L15 review：复习计划公开服务（分支已提供，待合入 main）

- 现状：main 的 `host/plugins/review/api.ts` 仍没有 `reviewPlan` 服务；分支
  `ds-mig/L15-review-analytics`（`d38ae9190`）已发布
  `ReviewPlanPort.getOrCreatePlan(questionId, examId)` /
  `getPlanByQuestion(questionId)` / `advanceFromPractice(planId)`，并在
  `host/plugins/review/index.ts` 以 `reviewPlan` 名称提供
  （`provides: ['mastery', 'review', 'reviewPlan']`）。
- qbank 侧：`src/review-plan-effects.ts` 已按该分支签名实现 `ReviewPlanPort`，
  `index.ts` 通过 `ctx.get('reviewPlan')` 注入；main 合入后即可做真实组合验证。
- 影响：`qbank_submit_answer`、`qbank_submit_practice`、`qbank_grade_practice_manually`、
  `qbank_retry_practice_grading` 的事务提交后 SM-2 计划创建/到期推进。服务未提供时
  该副作用跳过，答题结果仍按 Rust 提交；未用临时替身冒充完成。
- 需要：该分支合入 main；接口签名已对齐，不需要改动。

## L02 llm：批改诊断的推理字符数

- 缺口：`LlmStreamingService.singleShotCompletion` 的 `SingleShotCompletion` 只发布
  `reasoningBytes: number`（UTF-8 字节数），没有推理文本或 `reasoningChars`。
- Rust `qbank_grading/stream.rs:99` 对推理事件执行 `reasoning.chars().count()`，
  写入 `reasoning_chars`（`qbank_grading/types.rs:83`）。字节数在中文/emoji 上
  与字符数不同，不做换算。
- qbank 侧：`src/llm-completion.ts` 不再把 `reasoningBytes` 冒充
  `reasoning_chars`，暂置 0 并在 SPEC 记录；正向推理字符数用例保持 pending。
  重试次数显式 `maxRetries: 0`，`mode === 'nonStream'` 的回退结果按 Rust
  SSE-only 语义判为 incomplete，不落正式成绩。
- 需要：L02 在 `SingleShotCompletion` 增加 `reasoningChars`（或推理原文），
  qbank 再直接映射，不改 Rust 契约字段名。

## L14 自身：生成 runner（已接线）

- 现状：`qbank_ai_generate_questions` 已注册（`src/register-generation.ts`），
  `runQbankGeneration` 以 stream_event 在 Qbank 服务的 `GenerationSessions` 登记取消 token，
  `cancelGenerationSession` 已有生产者；`qbank_cancel_generation_task` 的 LLM 流取消与
  数据库标记保持原顺序。以下依赖拆分为历史记录。
- **2026-11-04 依赖拆分**（`qbank_generation/mod.rs`、`pipeline.rs`）：
  - L14 自有，可独立推进：`question_authoring_runner.rs` 中生成用到的 `SourceBundle` /
    `user_content` / `validate_coverage` / `attach_figures` / `validate_visual_evidence` /
    `DOCUMENT_CONTRACT`；`qbank_generation/reference.rs::collect_references`；pipeline 的
    `normalize_generation_root` / `validate_generation_source_refs` / `legacy_drafts`；
    任务提交与后台执行（`mod.rs:42-226`，task_repo 已移植）。
  - 已有：模型选择 `src/authoring-route.ts`（`resolve_question_authoring_config` +
    `resolve_visual_fallback`）；`buildGenerationInstructions`（`src/generation-prompt.ts`，X6-PR-0114）。
  - 缺 L02：`run_question_json` 已在 `host/plugins/llm/src/question_authoring.ts:394` 实现但未发布到
    service。已请求在 `llm` 上发布 `runQuestionJson(config, systemPrompt, userContent, cancel)`
    （coord queue L02 + escalate `2026-11-04T143038318Z-L14-qbank.md`）。
    `build_debug_persist_config` 的 debug 响应落盘同时询问。
  - 在 L02 发布前，命令不会注册为“假成功”；runner 其余部分按生产入口测试到 LLM 边界。

## L04 chat / L07 agentTools：工具执行器注册与消费

- 现状：main 的 `agent-skills` 已提供 `agentTools.registerToolExecutors/toolExecutors`
  （`host/plugins/agent-skills/api.ts:313-326`），注册表接口不再缺失。
- 跨 lane 缺口：`host/plugins/chat` 的派发路径尚未调用 `agentTools.toolExecutors()`；
  main 中只有 `chatanki` 注册、`agent-tools-registry.test.ts` 消费，L04 合并 main
  后才有真正的 chat tool 派发。
- 本 lane 未完成：qbank/essay/review/qbank_import_source 四个 executor 本身尚未
  迁移（Rust 合计约 9.1K 行）；在 executor 实现前不能把 48 条测试标为 ported。
- 影响：qbank_executor 21、essay 12、review 9、qbank_import_source 6 保持 pending。
- 分工：executor 本身是本 lane 自有实现，不等 registry 才写；registry/chat 派发只影响
  端到端消费，不能把“未迁移 executor”归因于 L04。

## L14 → L11：题目集级联写 qbank 自有表（L14 已发布，待 L11 接入）

- 来源：L11 V2-OWNER-QBANK 请求。L11 `repository/exams.ts:132-147,409-458,764-771,885-891`
  复制了 `qbank_helpers::retains_asset`、`copy_authoring_entities`，以及删除/恢复时对
  `qbank_materials/groups/group_materials/papers/practice_attempts` 的级联 SQL。
- L14 公开面：`ctx.qbank.examCascade`（`api.ts::QbankExamCascade`，实现
  `repository/exam-cascade.ts`），全部接收调用方的 `SqlExecutor`，不自开事务：
  - `copyAuthoringEntitiesWithConn(conn, srcExamId, targetExamId, now)` → `Map<旧id, 新id>`
    （sources/materials/groups 共用一张表，含 `source_refs_json` 重映射与 group_materials 复制；
    `exam_repo.rs:2094-2175`）。`now` 由 L11 传入：Rust 在该函数内取 `Utc::now().to_rfc3339()`，
    L11 应传同格式值。
  - `softDeleteForExamWithConn(conn, examId, now, deletionBatch)`：`exam_repo.rs:902-911`
    去掉 `questions`/`folder_items` 两条（仍归 L11）。
  - `restoreForExamWithConn(conn, examId, now, deletionBatch | null)`：`exam_repo.rs:1246-1254`。
  - `retainsAssetWithConn(conn, value)`：`qbank_helpers.rs:20`，只读。
- 错误：原样抛出 SQLite 错误与 `JSON.parse` 的 SyntaxError（对应 rusqlite/serde_json `?`），
  L11 保留自己的 `VfsError` 映射；调用顺序与 savepoint 不变。
- 依赖方向：qbank 已经 `ctx.get('vfsRepo')`；L11 应在使用时 `ctx.get('qbank')`，不要写进
  `inject`，避免像 D7 那样双向注入导致两个插件都无法启动。
- `refresh_canonical_preview_with_conn` 不在本次面：L11 copy 路径与 qbank 两处实现
  （`vfs-repos/repository/exams.ts:526`、`qbank/repository/management.ts:372`）需另行合并，待 L11 确认。
- 证据：`tests/exam-cascade.test.ts`（经 `host.ctx.qbank`），`tests/practice.test.ts::
  snapshots_retain_question_and_answer_image_references` 补上 Rust `qbank_practice.rs:1504-1506`
  三条 `retains_asset` 断言（原 TS 用例缺这三条）。

## L11 vfs-repos：Q8 四个原子方法（WP-165 依赖已解除）

- 已完成：题目/历史/作答/统计的读写已按 D1 复用 L11 `vfsRepo.questions`
  conn-bound 方法（`createQuestion`、`updateQuestion`、`applyQuestionMetadata`、
  `insertSubmission`、`submitAnswer`、`applySubmissionVerdict`、`recordHistory`、
  `refreshStats`、`bindQuestionCard`、`mergeQuestionProvenance`、
  `replaceQuestionForReparse`、`updateQuestionGroupMembership`、
  `softDeleteQuestionInGroup` 等）。
- 供方证据：正常合并 main `33d1323a9`，`api.ts` 重导出 `types/questions.ts:207–220`
  的 `updateAiFeedback` / `updateAiAnalysis` / `markAsModified` / `updateContentHash`；
  `repository/questions.ts:598–620` 全部使用传入 conn，无新增连接/事务。
  WP-178 的 `structured_data` arbitrary_precision/preserve_order 哈希读取也已在 main。
- qbank 消费：`src/grading-service.ts::persistGradingResult` 直接调用 `host.questions`，
  原 conn/now/参数保持；删除本域四个原子 writer 与 `contentHash` 五个副本。
  Analyze 的 mark/hash 错误分别保留 Rust 前缀。
- 验证与范围：`tests/grading-owner-writes.test.ts` 走真实注册命令与生产持久化入口、
  L11/F3 SQLite；原有 `grading-command-errors.test.ts` 的 WP-207 三个错误回归保留。
  不据此签收 options/tags/images typed 解码全域等价：L11 `BLOCKERS.md:344–346`
  明列重复键/seq 严格性仍用 JSON.parse；其公开 `rowToQuestion` 的 Value 精度也不在
  WP-178 专用 hash reader 的修复范围。
- D1 分工：L14 负责开事务并把同一个 `SqlExecutor` 传给 L11/L15；L11 不负责
  mastery 编排。当前 `question-service`/`practice-service`/`practice-grading-queue`
  已按此方式调用 `vfsRepo.questions` 与 `mastery.*WithConn`。
- 已闭合：`fillExplanationIfEmpty` 改为 Rust `pipeline.rs:680–701` 的单列条件 UPDATE
  （仅空解析写 explanation、按 changes 判定）后记 history，不再经 `updateQuestion` 多出
  mark/hash，并保留“写入解析失败”/“记录解析历史失败”上下文（`a899df7e`）。

## F7 native Office 生成（分支候选，main 未合入）

- 分支 `ds-mig/F7-native` 的 `host/platform/native/office/api.ts` 声明
  `NativeOfficeWriter.generateDocx(spec)`；main 的 `host/platform/native/office`
  仅保留文本解析，未发布该服务。
- 该分支 `docx.ts::generateDocx` 面向通用文档 spec（`template: handout/official`，
  仿宋/黑体/楷体，handout 页边 2098/1984/1587/1474 twip），与 Rust
  `qbank_practice/export.rs::docx_handout` 的 A4 11906×16838、页边
  960/960/1000/1000、Noto Sans CJK SC、图注/图片 EMU 规则不同；
  `tests/office-docx.test.ts` 也只验证 F7 自己的 handout 结构。
- 结论：接口存在不等于题库导出结构等价，当前不能把
  `qbank_export_paper_docx` 改为消费该候选；本 lane 的 `src/paper-docx.ts`
  按 Rust 结构独立实现，待 F7 合入并发布与 qbank 等价的 spec 后再评估。

## F7 nativeImage：题库图片解码/缩放/裁剪/编码

- main 的 `host/platform/native/image/api.ts` 只发布 `dimensions`/`decodeRgba`；
  分支 `ds-mig/F7-native`（`fe9ae8b83`）已提供
  `cropRgba` / `resizeRgba` / `resizeDimensions` / `encode`。
- qbank 现状：`src/paper-docx.ts` 与 `src/crop-source-image.ts` 已删除 sharp，
  只经 `src/native-image.ts` 的 `paperImageCodecOf`/`cropImageCodecOf` 消费上述
  正式能力；main 未合入时图片命令返回配置错误，相关正向用例按 capability 跳过
  （不冒充 ported）。
- 需要的 Rust 调用/参数（给 F7 核对）：
  - DOCX 图片：`docx_handout::prepare_png` 的
    `image::load_from_memory` → `DynamicImage::resize(2000, 2000, FilterType::Triangle)`
    → `write_to(Cursor, ImageFormat::Png)`；即 `decodeRgba` + `resizeDimensions`
    + `resizeRgba(..., 'triangle')` + `encode({format:'png'})`。
  - 源图裁剪：`commands.rs::qbank_crop_source_image` 的
    `load_from_memory(...).to_rgba8()` → `imageops::crop_imm(...).to_image()`
    → `PngEncoder`；bbox 为整数像素 `{x,y,width,height}`，先按相对坐标
    `round` 并收敛到图像边界。
- 影响：`qbank_export_paper_docx` 的图片块与 `qbank_crop_source_image` 在 main
  合入 F7 前不可用；文字/表格 DOCX 与无图路径仍正常。
- **2026-11-04 更新：F7 已合入 main，但缺依赖。** main 的 `image/api.ts` 已发布上述方法，
  所以 capability 探测通过，`paper-docx.test.ts::image_block_embeds_png_and_uses_rust_emu_sizing`
  不再跳过。`encode` 在 `host/platform/native/image/encode-worker.mjs:8,10` 中
  `require('pngjs')` / `require('jpeg-js')`，两包都不在 `package.json` 和 `node_modules`。
  复现：`decodeRgba` 1×1 PNG 成功，`encode({format:'png'})` 抛 `Cannot find module 'pngjs'`。
  qbank 的 `preparePng` 把它当成解码失败，报 Validation `Cannot decode paper image`。
  已 escalate（`2026-11-04T131731954Z-L14-qbank.md`）。qbank 不改逻辑、不削弱测试，等 F7 声明依赖后重跑自检。

## Q7：测试 worker RPC 超时（已关闭）

- 根因：每个 fixture 都执行一次全量 `migrations.runAll()`，在并行集成负载下单次
  约 12–17 秒；大量 fixture 叠加使 Vitest worker 的 `onTaskUpdate` RPC 超时。
- 修复：`tests/support/storage.ts` 只迁移一次真实模板，后续 fixture 复制模板并仍
  执行真实 `runAll()` 校验；断言与生产代码未改动。
- 关闭证据（2026-11-04，`job.mjs` 作业 `20261104091956-250d70`）：
  `npx vitest run -c vitest.host.config.ts host/plugins/qbank` →
  37 files / 241 passed / 2 skipped / **Errors 0** / 退出码 **0**，143.61s。

## 导入 / CSV / DOCX / 图片裁剪（依赖与现状）

### 依赖现状（2026-11-04 只读核实，本 lane 未安装/未改 package.json）

- `docx`：main 的 D9 提交 `40e885f89` 已把 **^9.15.2** 写入 `dependencies`，
  `qbank_export_paper_docx` 已使用（见下）。
- `sharp`：仍在 `package.json` 的 `dependencies`（**^0.34.2**），但 qbank
  `paper-docx`/`crop-source-image` 已不再 import；题库图片处理改走 F7
  `nativeImage`（见上节）。
- `iconv-lite`：`node_modules/iconv-lite/package.json` 为 **0.7.2**（`@modelcontextprotocol/sdk`
  的 `body-parser`/`raw-body` 传递依赖）；另有 `whatwg-encoding`/`d3-dsv` 使用 **0.6.3**。
  未在 `package.json` 顶层声明。
- `exceljs`：已在 `package.json` 声明 **^4.4.0**。

### DOCX 实现现状

- `qbank_export_paper_docx` 已接入 `src/paper-docx.ts`：A4 11906×16838 twip、
  页边距 960/960/1000/1000、Noto Sans CJK SC、页脚“当前页 / 总页数”、标题/段落/
  表格/图片/space 块与 Rust 错误文案逐条对应；命令返回标准 base64。
- 图片：base64 解码、50MB 上限、最长边 2000、统一重编码 PNG 通过
  `src/native-image.ts` 调用 F7 `nativeImage.decodeRgba/resizeDimensions/
  resizeRgba('triangle')/encode`，与 Rust `docx_handout::prepare_png` 的
  `image` crate 路径对齐；main 未合入 F7 前图片块返回 “Cannot decode paper image”，
  相关正向用例按 capability 跳过，不冒充 ported。
- 文字/表格/标题/页脚等无图路径不依赖 nativeImage，已在 main 验证。
- 格式覆盖由 `nativeImage.decodeRgba` 的 Rust `image 0.24` 决定，不再由业务层
  维护 sharp 允许/拒绝列表。

### Rust CSV 语义（`question_import_service.rs`）

- 编码探测顺序（`read_file_with_encoding:4490`）：先严格 UTF-8；成功则去掉开头
  `\u{FEFF}` BOM，编码名 `UTF-8`。失败后用 `encoding_rs::GBK.decode`；`!had_errors`
  才返回 `GBK`，否则用 `GB18030.decode` 兜底（不再检查错误）。
- 读取（`preview_csv:4087`、`import_csv:4176`）：`csv::ReaderBuilder::new()
  .flexible(true).has_headers(true)`。即**允许每行字段数不一致**，且首行作为表头；
  解析失败的记录在预览里跳过但计入 `total_rows`。
- 导出（`question_export_service.rs:401`）：每行按 `escape_csv_cell` 后以 `,` 连接并以
  `\n` 结尾；GBK 用 `encoding_rs::GBK.encode`，出现不可编码字符时返回 Validation
  “GBK 编码失败：内容包含 GBK 不支持的字符，请改用 UTF-8 或 UTF-8 BOM 导出”。
- 2026-11-04 已解决（不新增依赖）：解码走平台 WHATWG `TextDecoder('gbk'|'gb18030')`
  （encoding_rs 的 GBK 解码器即 WHATWG gb18030 解码器），GBK 编码表由同一解码器按 pointer
  反推；csv-core flexible 读取在 `src/csv-codec.ts` 自实现。残余差异：平台 ICU 与
  encoding_rs 版本对 GB18030-2022 个别 PUA 映射可能不同。

### 其余阻塞

- 导入命令：依赖 L13b 文本抽取、L18 ExamSheetService、authoring runner；
  当前未接线，TESTMAP 保持 pending。

### 图片裁剪现状

- `qbank_crop_source_image` 已接入 `src/crop-source-image.ts`：通过 `vfsRepo` 的
  `blobs.getBlobPath/storeBlob`、`files.createFile`、`questions.getQuestion/updateQuestion`
  完成 Rust 的完整副作用链；解码/像素裁剪/PNG 编码改走 F7
  `nativeImage.decodeRgba/cropRgba/encode`，不再在业务层使用 sharp。
- main 未合入 F7 前，源 blob 存在时命令返回配置错误；缺失源 blob 的错误顺序与
  Rust 一致。正向裁剪用例按 capability 跳过，待 F7 合入后恢复。

## F7 native：`nativeImage.encode` 依赖 pngjs 未安装（2026-11-04）

- 现状：main 已合入 F7 `nativeImage`（含 `resizeRgba/encode`），但
  `host/platform/native/image/encode-worker.mjs` 在 worker 中 `require("pngjs")`，
  根 `package.json`/`node_modules` 尚无 pngjs（F7 `NEEDS.md` 已申请；F7 自身测试以
  `imageEncoderMissing` 跳过）。真实编码报 `Cannot find module "pngjs"`，qbank
  `preparePng` 按 Rust `prepare_png` 失败分支返回 `Cannot decode paper image`。
- qbank 侧：`tests/paper-docx.test.ts::image_block_embeds_png_and_uses_rust_emu_sizing`
  与 F7 同判据，仅在 worker 无法解析 pngjs 时跳过（跳过不计通过）；契约用例
  `image_block_uses_the_native_image_contract_with_rust_emu_sizing` 仍验证调用顺序与 EMU。
- 需要：架构师按 F7 NEEDS.md 安装 pngjs/jpeg-js 后该用例自动恢复运行。

## H1 题目集导入（2026-11-04 更新：四条导入命令全部注册）

- 已注册：`cancel_question_bank_import`、`import_question_bank`、`import_question_bank_stream`、`resume_question_import`。
  旧 checkpoint 三条视觉分支经 L18 `questionImportVision`（已进 main）；题目 JSON 经 L02 `llmQuestionAuthoring@1`
  （已进 main，`src/question-json.ts` 本地实现已删除，调用方改为 `src/question-authoring-llm.ts`）。
- 剩余缺口（L11）：`ensure_vfs_file_for_blob`（question_import_service.rs:3758-3812）写 L11 的 `files` 表，L11 尚未发布
  对应方法；2026-11-04 已 `coord queue L11-vfs-repos` 请求 `files.ensureFileForBlobWithConn(conn, blobHash, fileName, mime)`。
  发布前 DocxVlmDirect 恢复走 Rust 自身的失败分支（warn「ensure_vfs_file: 创建 file 条目失败」并回退 `file_{nanoid(10)}`），
  即图片 id 不对应 files 行；其余分支不受影响。L11 发布后 wiring 自动生效（`question-import-wiring.ts` 按方法存在与否调用）。
- F4：`DIFFICULTY_RUBRIC`（dstu-core prompt_contracts.rs:57）Host 未发布，qbank 逐字内置一份，发布后改引用。

## L14 生成 runner：已移植部分与剩余接线（2026-11-04 H2，分支 ds-mig/L14-qbank-h2）

- 已移植（未注册命令）：`src/question-json.ts`（`run_question_json`，经已发布的
  `llmStreaming.singleShotCompletion`；**L02 发布 `runQuestionJson` 后改为调用它并删除本地实现**），
  `src/source-bundle.ts`（SourceBundle 覆盖/范围/user_content/validate_coverage/validate_visual_evidence），
  `src/generation-contracts.ts`（DOCUMENT_CONTRACT / GENERATION_SYSTEM_PROMPT，从 Rust 原始字符串机械提取），
  `src/generation-pipeline.ts`（normalize_generation_root / validate_generation_source_refs / legacy_drafts），
  `src/generation-runner.ts`（run_qbank_generation_with_config + execute_generation_task，含 registerGenerationSession）。
- 待接线后注册 `qbank_ai_generate_questions`：`collect_references`/`load_source_bundle`（L18 栅格化 + docx 带图抽取，
  L13b `extract_file_text_with_strategy`）、`attach_figures`（qbank 自有，用 crop codec + vfsRepo blobs/files）、
  debug 响应落盘（L02 `build_debug_persist_config`）、命令层请求按 serde 默认值解码（max_questions=10、spec.count=1）。
