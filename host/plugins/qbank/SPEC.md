# L14-qbank 行为规格（`host/plugins/qbank/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 88 个 · 发出事件 7 种 · 契约：`contracts/ipc/L14-qbank.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：契约中 `x-option:"null"` 的字段一律输出 JSON null；Rust `Option<T>` 无 `skip_serializing_if`，Host 不省略键（questions/practice 全部结构同）。
- [x] u64/i64 超过 2^53 的表示：qbank 传输计数均为 i32/u32/i64 小整数，SQLite INTEGER 经 better-sqlite3 读为 JS number；未出现 >2^53 的值，不引入 BigInt。
- [x] 字段顺序（serde_json preserve_order）：Rust serde 结构按声明顺序输出；Host 对象字面量按 api.ts 顺序构造。HashMap 字段（answers/results/type_stats）键序不保证，前端与测试不得依赖。
- [x] f32 精度：qbank 无 f32；比率均按 Rust `f64::round` 语义用 JS `Math.round` 计算（0-100 整数）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：服务错误统一 `AppError` 序列化为 `{error_type,message,details}`，`CommandError` 原样透传；`withDatabase` 把非 `QbankServiceError` 包装为 `Database`，与 Rust `AppError::database(e.to_string())` 一致；未使用 panic。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：已迁移的同步 DB 命令无取消点；练习 deadline 用 `setTimeout(...).unref()`，卸载时 `clearTimeout`；AI 评判经 `llmStreaming` 的 AbortSignal 取消，生成任务取消同时调用 `requestCancelStream` 与 `cancelGenerationSession`；导入取消仍随导入命令阻塞。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：better-sqlite3 单连接同步执行，写操作用 `db.transaction`/`tx.savepoint` 包裹；练习提交/保存用 revision 乐观锁；AI 批改队列由 `PracticeGradingQueue` 串行执行 `run_grading_queue`（启动重置 running、按 `(updated_at,id)` 取任务、先标 running 再判分、事务内落判定与 job 状态、提交后发事件并同步掌握度；qbank_practice.rs:735-958）。题目/历史/作答/统计的写入按 D1 复用 L11 `vfsRepo.questions` conn-bound 方法；WP-165 将四个 AI/同步原语也接入该 owner，删除本域相应 SQL/hash 副本。回填通用 updateQuestion 的既存差异见本命令 WP-165 小节，不签全域等价。
- [x] 服务与依赖（ARCHITECTURE.md §3）：本插件提供 `qbank`（`api.ts` 导出 `qbankService = {name:'qbank',version:'1.0.0'}`），`meta.provides=['qbank']`，`ctx.provide` 由 `Service` 构造器完成；生产路径经 `ctx.get` 解析真实服务：`vfsIndex.indexing.markResourcePending`（索引失效）、`vfsRepo.exams`（exam_sheets 读写）、`vfsRepo.attachments`（题目/材料/作答图内容）、`llm`（配置与取消）、`llmStreaming`（流式补全）、`mastery`（客观题同事务掌握度，缺失即失败）。内核把 `inject` 当必需服务（`kernel/runtime.ts:verifyStarted`），而这些在 Rust 中都是 warn 后继续的副作用，故 `inject` 只保留 `storage`/`paths`。
- [x] 待接线清单（对方 api 尚无对应符号，证据随行）：
  - `待接线：reviewPlan.getOrCreatePlan / getPlanByQuestion / advanceFromPractice`——分支 `ds-mig/L15-review-analytics`（`d38ae9190`）已发布 `ReviewPlanPort` 并以 `reviewPlan` 服务名提供；main 尚未合入。qbank 的 `ReviewPlanPort` 已按该分支签名覆盖三个方法，并在提交/改判/练习提交后按 Rust 顺序调用；main 合入后自动接线，缺失时复习计划副作用跳过并保持答题结果。
  - generation runner 已接线：`qbank_ai_generate_questions` 由 `src/register-generation.ts` 注册，`src/generation-runner.ts` 的 `runQbankGeneration` 以 stream_event 在 Qbank 服务持有的同一 `GenerationSessions` 登记 token；取消命令先发 `requestCancelStream` 并按 Rust 顺序标记数据库（`tests/generation-runner.test.ts` 覆盖登记后取消）。
  - `vfsRepo.exams` 已由 L11 提供并用于 exam_sheets 读写；`examSheetSession` 已由 L18 提供，三条整卷会话命令已接线。
  - `待评估：F7 nativeOfficeWriter.generateDocx`——仅在 `ds-mig/F7-native` 分支，main 未合入；其 handout 布局（仿宋/黑体/楷体、页边 2098/1984/1587/1474）与 Rust qbank DOCX 结构不同，不能替代本 lane `src/paper-docx.ts`。
  - `待接线：F7 nativeImage.cropRgba/resizeRgba/resizeDimensions/encode`——main 的 `host/platform/native/image/api.ts` 只有 `dimensions`/`decodeRgba`；分支 `ds-mig/F7-native`（`fe9ae8b83`）已提供。`src/paper-docx.ts`/`src/crop-source-image.ts` 已删除 sharp，只经 `src/native-image.ts` 消费这些正式能力；main 合入前图片块/裁剪返回配置错误，相关正向用例按 capability 跳过并保持 pending。
  - `待接线：vfsIndex.indexing` 以外无（`vfsIndex` 已由 L13 更名并可用）。
- [x] 时间与 ID：生成方式、格式、时区：`utcNow()` 输出 chrono `to_rfc3339` 形状（`+00:00`）；本地日期用 JS 本地 getter，对应 Rust `chrono::Local` + SQLite `DATE(...,'localtime')`；题目 ID `q_<nanoid>`、提交 `as_<nanoid>`、练习/试卷 UUID 由 randomUUID 生成。
- [x] 不对含 HashMap 的结构做序列化后比对：测试只比较具体键值（如 answers/results/type_stats 的已知键），从未整串序列化比对 HashMap。

## 命令 `cancel_question_bank_import`

<!-- BEGIN GENERATED:cmd:cancel_question_bank_import -->
- Rust：`src-tauri/src/commands.rs:1264` · sync
- 前端：app（3 处，例 `src/components/ExamSheetUploader.tsx:388`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：importId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:cancel_question_bank_import -->

- [x] 入口：Rust `commands.rs:1265`（sync）→ TS `index.ts` `ctx.commands.register('cancel_question_bank_import')` →
  `src/question-import-cancellation.ts` `QuestionImportCancellations.cancel`。
- [x] 分支表：`let … else { return Ok(false) }`（未登记）→ `cancel()` 中 `undefined` 返回 false；
  `Ok(cancellation.request_cancel())` → `requestCancel()`：运行中→取消（abort 信号、返回 true）；
  已取消/已完成→false（`compare_exchange(0,1)` 失败）。`finish_or_cancelled`（`compare_exchange(0,2)`）→ `finishOrCancelled()`。
- [x] 输入：`importId: string`（必填，契约解码）；输出：`boolean`；错误：无（Rust 不返回 Err）。
- [x] 事件：无。DB 读写：无。日志：Rust 本函数与 `QuestionImportCancellation` 无 warn!/error!。
- [x] 取消/并发：登记表每个插件实例一张（`AppState.question_import_cancellations`，lib.rs:3579）；JS 单线程下
  CAS 等价于检查后写入；`CancellationToken` → `AbortController.signal`。取消不移除登记项（Rust 只 clone Arc），
  由导入命令收尾移除。
- [ ] 生产者：`import_question_bank_stream` / `resume_question_import` 尚未迁移（见 BLOCKERS「H1 题目集导入」），
  在此之前登记表无生产者，命令按 Rust 语义恒返回 false；登记（`register`，`DashMap::entry` 占用返回 null）已就位。
- [x] 测试：`tests/question-import-cancellation.test.ts`（经 host.invoke + `ctx.qbank.questionImports`，Rust 无对应测试，契约测试 6 条）。
- [x] 证据等级：生产入口测试。

## 命令 `cancel_questions_csv_import`

<!-- BEGIN GENERATED:cmd:cancel_questions_csv_import -->
- Rust：`src-tauri/src/commands.rs:1859` · sync
- 前端：app（2 处，例 `src/components/CsvImportDialog.tsx:245`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：importId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:cancel_questions_csv_import -->

- [x] 输入：importId: string；commands.rs:1860
- [x] 输出：未登记返回 false，否则 `request_cancel()` 的 CAS 结果（仅 Active→Cancelled 为 true）；question_import_service.rs:3978。`src/csv-commands.ts::CsvImportRegistry.cancel`
- [x] 错误：无错误分支；commands.rs:1860-1870
- [x] 事件：无（Cancelled 事件由导入方发出）
- [x] DB 读写：无
- [x] 取消/并发：令牌由 import_questions_csv 以 import_id 登记，结束时只移除自己的登记；完成后迟到的取消返回 false
- [x] 时间/ID：无
- [x] 测试：tests/csv-commands.test.ts（Rust `cancellation_and_completion_have_a_single_terminal_winner` + 生产入口取消用例）

## 命令 `export_questions_csv`

<!-- BEGIN GENERATED:cmd:export_questions_csv -->
- Rust：`src-tauri/src/commands.rs:1875` · async
- 前端：app（2 处，例 `src/components/QuestionBankExportDialog.tsx:599`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: CsvExportCommandRequest
  - 结果：CsvExportResult · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:export_questions_csv -->

- [x] 输入：CsvExportCommandRequest：fields 缺省 []、filters 缺省 default、include_answers 缺省 false、encoding gbk/utf8_bom/其余→utf8；commands.rs:1686-1910
- [x] 输出：{exported_count, file_path, file_size}；虚拟 URI 目标时 file_path 改写为原目标；question_export_service.rs:111-262
- [x] 错误：`..` 组件→Validation；不支持字段→Validation `不支持的导出字段: x`；首页为空→Validation `没有可导出的题目`；列表失败→Database `获取题目失败: …`；创建文件→Internal `创建文件失败: <io>`；GBK 不可编码→Validation 并删除半成品；虚拟目标回写失败→FileSystem `写入目标 URI 失败: …`
- [x] 事件：无
- [x] DB 读写：只读，经 L11 `questions.listQuestions(conn, exam_id, filters, page, 200)` 分页
- [x] 取消/并发：无取消；失败路径删除半成品/临时文件，清理失败 warn
- [x] 时间/ID：暂存文件名 `questions_export_<uuid>.csv`；GBK 编码按 WHATWG GBK 编码器（src/csv-codec.ts），编码表由平台 ICU 解码器反推
- [x] 测试：tests/csv-commands.test.ts（3 条生产入口用例）；Rust 无该命令测试

## 命令 `get_csv_exportable_fields`

<!-- BEGIN GENERATED:cmd:get_csv_exportable_fields -->
- Rust：`src-tauri/src/commands.rs:2005` · sync
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：（无）
  - 结果：?[][]
<!-- END GENERATED:cmd:get_csv_exportable_fields -->

- [x] 输入：无参数；commands.rs:2006。
- [x] 输出：按 EXPORTABLE_FIELDS 顺序返回 18 个 [key, 中文名] 元组；question_export_service.rs:65-85,105-110。
- [x] 错误：无 Result 错误通道；commands.rs:2006。
- [x] 事件：无；commands.rs:2006-2009。
- [x] DB 读写：无；question_export_service.rs:105-110。
- [x] 取消/并发：同步纯函数，无取消点或共享状态；同上。
- [x] 时间/ID：无；同上。

## 命令 `get_csv_preview`

<!-- BEGIN GENERATED:cmd:get_csv_preview -->
- Rust：`src-tauri/src/commands.rs:1967` · async
- 前端：app（2 处，例 `src/components/CsvImportDialog.tsx:268`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：filePath: string, rows?: integer(usize) | null
  - 结果：CsvPreviewResult · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:get_csv_preview -->

- [x] 输入：filePath、rows 缺省 5；commands.rs:1968-1991
- [x] 输出：{headers, rows（前 N 条记录）, total_rows（全部数据记录数）, encoding UTF-8/GBK/GB18030}；question_import_service.rs:4087-4118
- [x] 错误：路径含 `..`→Validation；打开/读取失败→Internal（error_type Unknown）`打开文件失败: <io>`/`读取文件失败: <io>`；虚拟 URI 物化失败沿用平台 copyFileVerified 的 FileSystem 错误
- [x] 取消/并发：无；临时物化文件在返回前清理，失败 warn `[csv_preview] 清理临时 CSV 文件失败`
- [x] 时间/ID：物化文件 `dstu_materialized_<uuid>[.ext]`；CSV 读取按 csv-core flexible 语义自实现（src/csv-codec.ts），不新增依赖
- [x] 测试：tests/csv-commands.test.ts（3 条：UTF-8 BOM/引号/空行/变长行、GBK 回退、错误分支）

## 命令 `get_enhanced_statistics`

<!-- BEGIN GENERATED:cmd:get_enhanced_statistics -->
- Rust：`src-tauri/src/commands.rs:2109` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:267`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_enhanced_statistics -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_exam_sheet_session_detail`

<!-- BEGIN GENERATED:cmd:get_exam_sheet_session_detail -->
- Rust：`src-tauri/src/commands.rs:945` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ExamSheetSessionDetailRequest
  - 结果：ExamSheetSessionDetailResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_exam_sheet_session_detail -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_learning_heatmap`

<!-- BEGIN GENERATED:cmd:get_learning_heatmap -->
- Rust：`src-tauri/src/commands.rs:8244` · async
- 前端：app（1 处，例 `src/hooks/useLearningHeatmap.ts:96`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：startDate: string, endDate: string
  - 结果：LearningActivity[] · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:get_learning_heatmap -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_question_bank`

<!-- BEGIN GENERATED:cmd:import_question_bank -->
- Rust：`src-tauri/src/commands.rs:1087` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ImportQuestionBankRequest
  - 结果：QuestionImportDraftResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:import_question_bank -->

- 状态：**已注册**（题目 JSON 经 L02 `llmQuestionAuthoring@1`）。
- [x] 入口：TS `src/question-import-commands.ts` → `src/question-import-service.ts::prepareDocument` → `src/question-import-runner.ts`。
- [x] 分支表：zip → `importPackage`（authoring.rs:188-319，含严格 Base64、typed 解码 + validate）；json → `decodeTextContent` 失败回退原文 →
  `valueFromStr`（失败「JSON 解析失败: …」）→ 无 schema_version 时规范化旧版 questions（缺数组「JSON 需要 questions 数组」）→
  `questionDocument` 解码（「题目 JSON 契约无效: …」）→ validate；其他格式 → loadSourceBundle → scoped（有 source_ranges）→
  resolve config（或受信配置）→ create_import_session → import_state{schema_version,source_bundle,model_config_id,model_fingerprint,qbank_name}
  → SessionCreated → runDocument（失败时补写 last_error 后原样抛出，取消时不写）；空题「未提取到可作答题目，未创建正式内容」；
  保存草稿 → import_state{schema_version:2,job_id} → SessionCreated/QuestionParsed*/Completed(partial = status≠ready) → count_questions（失败按 0）。
- [x] 数据边界：`ImportQuestionBankRequest` 由内核契约校验，`importRequestOf` 补 serde default；`QuestionImportDraftResponse` = L18
  `ExamSheetSessionDetail` flatten + 5 字段；SourceBundle/SourcePage/QuestionDocument 字段序与 Rust 一致；指纹按 ApiConfig camelCase 字段序
  （Rust `remove("api_key")` 不命中 `apiKey`，逐字保留）。
- [x] 所有权：exam_sheets（L11 `vfsRepo.exams`）、questions（L11）、blobs/files（L11），qbank 只写 question_authoring_jobs（自有）。
- [x] 时钟/ID：temp_id `randomUUID()`（Rust uuid v4）；card_id `card_${nanoid(12)}`。
- [x] 测试：`tests/question-import-invoke.test.ts`（host.invoke）。
- [x] 取消/并发：无 import_id、无进度通道（Rust `import_document` → progress None）。

## 命令 `import_question_bank_stream`

<!-- BEGIN GENERATED:cmd:import_question_bank_stream -->
- Rust：`src-tauri/src/commands.rs:1122` · async
- 前端：app（1 处，例 `src/components/ExamSheetUploader.tsx:687`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ImportQuestionBankRequest
  - 结果：QuestionImportDraftResponse · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:import_question_bank_stream -->

- 状态：**已注册**（题目 JSON 经 L02 `llmQuestionAuthoring@1`）。
- [x] 入口：TS `src/question-import-commands.ts` → `src/question-import-service.ts::prepareDocument` → `src/question-import-runner.ts`。
- [x] 分支表：zip → `importPackage`（authoring.rs:188-319，含严格 Base64、typed 解码 + validate）；json → `decodeTextContent` 失败回退原文 →
  `valueFromStr`（失败「JSON 解析失败: …」）→ 无 schema_version 时规范化旧版 questions（缺数组「JSON 需要 questions 数组」）→
  `questionDocument` 解码（「题目 JSON 契约无效: …」）→ validate；其他格式 → loadSourceBundle → scoped（有 source_ranges）→
  resolve config（或受信配置）→ create_import_session → import_state{schema_version,source_bundle,model_config_id,model_fingerprint,qbank_name}
  → SessionCreated → runDocument（失败时补写 last_error 后原样抛出，取消时不写）；空题「未提取到可作答题目，未创建正式内容」；
  保存草稿 → import_state{schema_version:2,job_id} → SessionCreated/QuestionParsed*/Completed(partial = status≠ready) → count_questions（失败按 0）。
- [x] 数据边界：`ImportQuestionBankRequest` 由内核契约校验，`importRequestOf` 补 serde default；`QuestionImportDraftResponse` = L18
  `ExamSheetSessionDetail` flatten + 5 字段；SourceBundle/SourcePage/QuestionDocument 字段序与 Rust 一致；指纹按 ApiConfig camelCase 字段序
  （Rust `remove("api_key")` 不命中 `apiKey`，逐字保留）。
- [x] 所有权：exam_sheets（L11 `vfsRepo.exams`）、questions（L11）、blobs/files（L11），qbank 只写 question_authoring_jobs（自有）。
- [x] 时钟/ID：temp_id `randomUUID()`（Rust uuid v4）；card_id `card_${nanoid(12)}`。
- [x] 测试：`tests/question-import-invoke.test.ts`（host.invoke）。
- [x] 取消/并发（commands.rs:1135-1246）：import_id trim 后非空才登记，占用 →「该题目集导入仍在进行中，请稍后再试」；
  `raceCancellation` = `tokio::select!`，`ImportRun.step` 在下一个 await 点停止被丢弃的导入；`finishOrCancelled` 失败 →「题目集导入已取消」；
  finally 中按 `Arc::ptr_eq` 释放登记。
- [x] 事件：`question_import_progress`，payload 末尾追加 import_id；emit 失败 `log.error('[question_import_progress] emit failed: …')`。

## 命令 `import_questions_csv`

<!-- BEGIN GENERATED:cmd:import_questions_csv -->
- Rust：`src-tauri/src/commands.rs:1709` · async
- 前端：app（2 处，例 `src/components/CsvImportDialog.tsx:402`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: CsvImportCommandRequest
  - 结果：CsvImportResult · 错误：AppError · 注入：state, app-handle, window
<!-- END GENERATED:cmd:import_questions_csv -->

- [x] 输入：CsvImportCommandRequest：duplicate_strategy overwrite/merge/其余→skip；import_id 去空白为空视为无；commands.rs:1663-1830
- [x] 输出：CsvImportResult（含 cancelled）；新建题目集时 exam_id 为 L11 生成的真实 ID
- [x] 错误：字段映射四类 Validation（缺 content/列不存在/不支持目标/重复映射）；创建题目集→Database `创建题目集失败`；行级错误进 errors（`第 N 行: content 为空`、images 格式/解析、`创建失败/更新失败/合并失败: …`）；重复 import_id→Validation `该 CSV 导入仍在进行中，请稍后再试`；非 AppError 异常→Internal `CSV 导入任务异常终止: …`
- [x] 事件：`csv_import_progress`（tag=type）：Started / 每 10 行及末行 Progress / Completed / Cancelled；命令失败时补发 Failed{error, exam_id=请求 exam_id}
- [x] DB 读写：写入只经 L11：`exams.getExamSheet/createExamSheet/purgeExamSheet`、`questions.createQuestion/updateQuestion/getQuestion/refreshStats`；本插件只读 questions（去重哈希、空题目集计数）
- [x] 取消/并发：CsvImportCancellation 三态 CAS；完成守卫在所有返回路径收尾；TS 在导入开始和每行写入前让出事件循环，使取消在行间生效；取消时新建空题目集被 purge，已有写入刷新统计
- [x] 时间/ID：card_id `csv_<nanoid10>`；缺题号时 `Q<row-1>`；去重键 = trim 后去空白的 SHA-256 前 16 字节 hex
- [x] 测试：tests/csv-commands.test.ts（Rust `cancelled_csv_import_does_not_create_questions_or_an_empty_exam` + 5 条契约用例）

## 命令 `inspect_pdf_text_for_qbank`

<!-- BEGIN GENERATED:cmd:inspect_pdf_text_for_qbank -->
- Rust：`src-tauri/src/commands.rs:1042` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: InspectPdfTextRequest
  - 结果：PdfTextInspection · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:inspect_pdf_text_for_qbank -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `list_exam_sheet_sessions`

<!-- BEGIN GENERATED:cmd:list_exam_sheet_sessions -->
- Rust：`src-tauri/src/commands.rs:932` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ExamSheetSessionListRequest
  - 结果：ExamSheetSessionListResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:list_exam_sheet_sessions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `list_importing_sessions`

<!-- BEGIN GENERATED:cmd:list_importing_sessions -->
- Rust：`src-tauri/src/commands.rs:1646` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：（无）
  - 结果：ImportingSession[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:list_importing_sessions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_ai_generate_questions`

<!-- BEGIN GENERATED:cmd:qbank_ai_generate_questions -->
- Rust：`src-tauri/src/qbank_generation.rs:16` · async
- 前端：app（1 处，例 `src/hooks/useQbankAiGeneration.ts:94`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: QbankGenerationRequest
  - 结果：GenerationTaskView · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:qbank_ai_generate_questions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_ai_grade`

<!-- BEGIN GENERATED:cmd:qbank_ai_grade -->
- Rust：`src-tauri/src/qbank_grading.rs:22` · async
- 前端：app（1 处，例 `src/hooks/useQbankAiGrading.ts:327`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: QbankGradingRequest
  - 结果：QbankGradingResponse | null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:qbank_ai_grade -->

- [x] 输入：QbankGradingRequest；Grade 必须有 submission，Analyze 可无；submission 必须属于该题；绑定提交快照。
- [x] 输出：QbankGradingResponse | null；取消返回 null 并发 cancelled；错误先发 error 事件。
- [x] 错误：模型配置/图片缺失/非多模态/缺少 verdict/截断/供应商/传输错误均保留反馈草稿且不落正式成绩。
- [x] 事件：`qbank_grading_stream_<session>` 的 data/complete/error/cancelled；取消经 `qbank_cancel_grading` 订阅 AbortSignal。
- [x] DB 读写：题目/submission 读取；Grade 在事务内更新 submission、题目状态、统计与掌握度事件，Analyze 只回填解析。
- [x] 取消/并发：`llmStreaming.singleShotCompletion` + `subscribeCancelStream`/`consumePendingCancel`；已交付正文的取消保留草稿。
- [x] 时间/ID：诊断记录 finish_reason/usage/response_chars/reasoning_chars/http_status；stream_event 前缀 `qbank_grading_stream_`。

### WP-207：已结构化批改错误的命令边界

- Rust `qbank_grading/stream.rs:164–169`：HTTP/provider 失败生成 LLM AppError；
  `pipeline.rs:312–320,494–528` 保留 error_type/details，失败草稿写入失败只追加 message，
  WARN diagnostics 后发送 failure；`mod.rs:48` 与 app `src/qbank_grading.rs:29` 原样传播。
- TS `src/grading-service.ts:418–420` 已保有同一 AppError；`index.ts` 的
  `qbank_ai_grade` catch 须将它交给 `serviceCallAsync` 支持的 `QbankServiceError`，
  再由唯一外层构造 CommandError。原来的内层 CommandError 会被外层当作普通 Error
  再包装成 Database（message 为序列化 AppError）。
- 分支：AppErrorThrow → 原 appError；其它异常 → 既有 serviceCallAsync 分类。
  共享 `serviceCallAsync`/`serviceCall` 均保持原实现，影响面仅本命令 catch。
- `tests/grading-command-errors.test.ts`：真实注册命令、L02/L01、X5 公开 HTTP sidecar
  与真实迁移 SQLite；HTTP500、HTTP500 后草稿 INSERT 失败、正文成功后 AI 缓存 UPDATE
  失败分别精确断言 LLM/LLM/Database、完整 message/details、终态事件先于拒绝、
  正式 question/submission/stats/mastery 前后相等、草稿记录与诊断。
  后两种失败由 SQLite TEMP trigger 产生，不替换任何生产函数。
- 证据等级：B 生产入口回归 + Rust 源码审读；正式 desktop/main 后原 HTTP500 两 take
  由 X1 复验，不据此签 A/golden/C/G1。

### WP-165：四个 owner 原语消费分支表

| Rust | TS 落点 / 错误与副作用 |
|---|---|
| `pipeline.rs:593–610` Grade / Analyze | `persistGradingResult` 单次 utcNow；分别 `host.questions.updateAiFeedback(conn,id,feedback,score,now)` / `updateAiAnalysis(conn,id,feedback,now)`；原 SQLite 错误加“保存 AI 反馈失败: ” |
| `pipeline.rs:611–616` 0 rows | NotFound “题目不存在或已删除: {id}”，不执行回填/mark/hash/判分 |
| `pipeline.rs:618–623` fill flag | 保留 `repo.fillExplanationIfEmpty`，flag=false 不回填；null/SQL 空白回填、已有解析不覆盖，记一条 explanation 历史 |
| `pipeline.rs:627–637` Analyze mark/hash | `host.questions.markAsModified` 后 `updateContentHash`；分别加“标记同步状态失败: ”和“更新内容哈希失败: ”，保留 owner 的 Database error / question not found 文本 |
| `pipeline.rs:640–654` Grade guards | 原 verdict/submissionId/事务内 submission 重读与归属检查保留，失败由调用事务回滚 AI 写入 |
| `pipeline.rs:656–663` Grade verdict | 原 `applySubmissionVerdict` 编排保留，mark/hash 由 L11 判分原语完成，不重复调用 |
| `question_sync_service.rs:1518–1556` | 直接消费 L11 已公开 owner，不复制 CASE/hash；同 conn，无新增事务/连接 |
| `question_sync_service.rs:1612–1718` | owner 自己读取未软删题目并处理失败；WP-178 已修 structured_data 的 Value 精度/键序/日志，qbank 直接消费 |

测试：`tests/grading-owner-writes.test.ts`（追加消费证据，不改 TESTMAP 去向）；成功命令
和触发器失败均走真实注册 `qbank_ai_grade` → `runQbankGrading` → `persistGradingResult`，
另以独立 F3 transaction 驱动同一生产持久化入口证明写入只在 caller conn 可见并可回滚。
原 pipeline 断言和 WP-207 三个精确错误回归保留。SQL audit 的 AI 时刻断言证明原 now
同时用于 ai_graded_at/updated_at；SQLite 原 schema 自带后续 updated_at trigger 保持。

限定：`fillExplanationIfEmpty` 已改为 Rust :680–701 的单列条件 UPDATE 后 history
（`a899df7e`，`repository/questions.ts`；不再经 `updateQuestion` 多出 mark/hash，保留
“写入解析失败”/“记录解析历史失败”上下文，回归见 `tests/grading-pipeline.test.ts`）。供方 options/tags/images typed 残差
也未在此签收。源码审读/生产入口回归属 B 证据，不代替 X1/210 固定 main 独验。

## 命令 `qbank_batch_create_questions`

<!-- BEGIN GENERATED:cmd:qbank_batch_create_questions -->
- Rust：`src-tauri/src/commands.rs:7718` · async
- 前端：app（1 处，例 `src/essay-grading/essayMistakes.ts:63`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：paramsList: CreateQuestionParams[]
  - 结果：Question[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_batch_create_questions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_batch_delete_questions`

<!-- BEGIN GENERATED:cmd:qbank_batch_delete_questions -->
- Rust：`src-tauri/src/commands.rs:7789` · async
- 前端：app（2 处，例 `src/components/ExamSheetUploader.tsx:818`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionIds: string[]
  - 结果：BatchResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_batch_delete_questions -->

- [x] 输入：questionIds（空数组直接返回 0/0/[]，question_bank_service.rs:378-432）。
- [x] 输出：BatchResult：逐题 `not found` 或删除错误进入 errors，单题失败不回滚整批。
- [x] 错误：读取/删除异常按 `{id}: {error}` 收集；事务开启失败为 Database。
- [x] 事件：无事件。
- [x] DB 读写：单事务内逐题读取、软删除；同事务刷新涉及 exam 的统计（失败 warn）。
- [x] 取消/并发：同步单事务；`getQuestion` 在单项 catch 内，读取失败只记该题错误。
- [x] 时间/ID：软删除 updated_at 用 `utcNow()`；错误文案保持 Rust `{id}: not found`。

## 命令 `qbank_batch_update_questions`

<!-- BEGIN GENERATED:cmd:qbank_batch_update_questions -->
- Rust：`src-tauri/src/commands.rs:7764` · async
- 前端：app（3 处，例 `src/stores/questionBankStore.ts:1620`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: BatchUpdateQuestionsRequest
  - 结果：BatchResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_batch_update_questions -->

- [x] 输入：questionIds + UpdateQuestionParams（空数组直接返回 0/0/[]，question_bank_service.rs:282-351）。
- [x] 输出：BatchResult：逐题 SAVEPOINT，成功计数并按 exam 汇总刷统计。
- [x] 错误：单项失败 `{id}: {AppError::database(...)}` 文案后继续；整批事务提交失败为 Database。
- [x] 事件：无事件。
- [x] DB 读写：单事务 + 每题 savepoint；仅成功项进入统计刷新集合。
- [x] 取消/并发：同步单事务；savepoint 回滚单项，不改变部分成功语义。
- [x] 时间/ID：updated_at 用 `utcNow()`；统计刷新失败 warn。

## 命令 `qbank_cancel_generation_task`

<!-- BEGIN GENERATED:cmd:qbank_cancel_generation_task -->
- Rust：`src-tauri/src/qbank_generation.rs:48` · async
- 前端：app（1 处，例 `src/hooks/useQbankAiGeneration.ts:119`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：taskId: string
  - 结果：GenerationTaskView | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_cancel_generation_task -->

- [x] 输入：taskId（qbank_generation/mod.rs:263-300）。
- [x] 输出：GenerationTaskView | null：任务不存在返回 null；终态原样返回；活动任务先标记 cancelled，但返回的视图仍为取消前状态（同 Rust 先读 record 再 mark_cancelled）。
- [x] 错误：DB 异常 Database；无 Validation。
- [x] 事件：Rust 后台任务收尾会发 cancelled 事件；Host 尚未实现出题流，故无事件。
- [x] DB 读写：读 qbank_generation_tasks；非终态执行 UPDATE status=cancelled, updated_at/finished_at=now WHERE status IN (queued,running)。
- [x] 取消/并发：调用 `llm.requestCancelStream(record.stream_event)` 并 `cancelGenerationSession`（登记表随 runner 接线）；随后单写落库取消，返回取消前视图。
- [x] 时间/ID：updated_at/finished_at 为毫秒时间戳（与任务表同）。

## 命令 `qbank_cancel_grading`

<!-- BEGIN GENERATED:cmd:qbank_cancel_grading -->
- Rust：`src-tauri/src/qbank_grading.rs:33` · async
- 前端：app（4 处，例 `src/hooks/useQbankAiGrading.ts:159`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：streamEventName: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_cancel_grading -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_commit_authoring_draft`

<!-- BEGIN GENERATED:cmd:qbank_commit_authoring_draft -->
- Rust：`src-tauri/src/commands.rs:1361` · sync
- 前端：app（3 处，例 `src/components/AiQuestionGenerationPanel.tsx:415`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：jobId: string, selectedLocalIds: string[], expectedVersion: integer(i64)
  - 结果：AuthoringCommitReceipt · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_commit_authoring_draft -->

- [x] 输入：jobId、selectedLocalIds、expectedVersion（commands.rs:1362-1383）。
- [x] 输出：AuthoringCommitReceipt：committed/exam_id/question_ids/material_ids/group_ids/imported_count/total_questions/partial/needs_review/coverage/unmatched_answers。
- [x] 错误：`请选择不重复的有效题目`/`该草稿不可提交`/`所选题目不属于当前草稿`/`目标题目集已删除`/`同源重新解析内容变化...`/`CONFLICT: ...`，DB 异常 Database。
- [x] 事件：成功且 committed 后 `qbank://changed` `{exam_id,reason:"authoring_committed"}`（commands.rs:1373-1381）。
- [x] DB 读写：Immediate 事务：写 qbank_sources（按 source_key 合并页面证据）、qbank_materials/qbank_groups/qbank_group_materials、questions（含 card_id/group_id/source_key/provenance_json）、question_bank_stats、exam_sheets（preview/status/metadata/import_state）、qbank_import_jobs（committed/receipt/selected）。
- [x] 取消/并发：expectedVersion 乐观锁；已 committed 时按 selected_json 幂等返回原 receipt，不同选择冲突；任何中途失败整事务回滚。
- [x] 时间/ID：stamp 为 RFC3339 UTC；qsource/qmat/qgroup/qgm id 为前缀+16 位 nanoid；source_key=SHA256(来源ID列表+section_path+原题号)。

## 命令 `qbank_complete_paper_export`

<!-- BEGIN GENERATED:cmd:qbank_complete_paper_export -->
- Rust：`src-tauri/crates/dstu-qbank/src/qbank_practice/export_bridge.rs:66` · async
- 前端：app（2 处，例 `src/components/practice/PracticeRuntimeBridge.tsx:33`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：requestId: string, data?: string | null, error?: string | null
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:qbank_complete_paper_export -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_count_by_type`

<!-- BEGIN GENERATED:cmd:qbank_count_by_type -->
- Rust：`src-tauri/src/commands.rs:7882` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：object · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_count_by_type -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_create_practice`

<!-- BEGIN GENERATED:cmd:qbank_create_practice -->
- Rust：`src-tauri/src/qbank_practice.rs:16` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:95`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: CreatePracticeRequest
  - 结果：PracticeDraft · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:qbank_create_practice -->

- [x] 输入：request 的 id/scope_id/mode/title/question_ids 或 attempt_id 或 paper_id/duration_seconds/started_at/start_question_id（qbank_practice.rs:219-337）。
- [x] 输出：PracticeDraft：题目去重后完整 Question、revision=1、deadline 由 started_at+duration 计算（同源 :306-320）。
- [x] 错误：`Invalid practice identity`/`Invalid practice mode`/`Practice scope mismatch`/`Practice already submitted`/`Question not found:` /`Practice requires 1–10000 questions`/`No questions available`/`Duration exceeds 480 minutes`/`Invalid practice start time`，DB 异常转 Database（:223-300）。
- [x] 事件：无事件；创建后按 `deadline` 在 Host 内注册 unref 定时器，到点自动提交（Rust `schedule_deadline` :570-577）。
- [x] DB 读写：事务（Immediate）读 qbank_practice_drafts/qbank_practice_attempts/qbank_papers/questions，写 qbank_practice_drafts（:238-333）。
- [x] 取消/并发：Rust immediate 事务对应 better-sqlite3 `db.transaction`；同一 draft.id 重复创建返回原草稿，跨 scope 拒绝。
- [x] 时间/ID：created_at/updated_at 为 RFC3339 UTC；deadline 同格式；id 由调用方提供。

## 命令 `qbank_create_question`

<!-- BEGIN GENERATED:cmd:qbank_create_question -->
- Rust：`src-tauri/src/commands.rs:7704` · async
- 前端：app（1 处，例 `src/quick-assistant/service.ts:256`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：params: CreateQuestionParams
  - 结果：Question · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_create_question -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_crop_source_image`

<!-- BEGIN GENERATED:cmd:qbank_crop_source_image -->
- Rust：`src-tauri/src/commands.rs:8609` · async
- 前端：app（1 处，例 `src/components/ImageCropDialog.tsx:189`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: CropSourceImageRequest
  - 结果：QuestionImage · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_crop_source_image -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_delete_group`

<!-- BEGIN GENERATED:cmd:qbank_delete_group -->
- Rust：`src-tauri/src/commands.rs:1612` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:332`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：groupId: string, mode: DeleteGroupMode__De, expectedVersion: integer(i64)
  - 结果：GroupDeleteResult · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_delete_group -->

- [x] 输入：groupId/mode（ungroup|delete_members）/expectedVersion（qbank_management.rs:474-602）。
- [x] 输出：GroupDeleteResult：deleted_question_ids/ungrouped_question_ids/solo_group_ids/material_ids。
- [x] 错误：`题组不存在或已删除`（NotFound）、`CONFLICT: 题组版本已变化，请重新载入`、`题组成员在操作期间已变化，请重新载入`、`题组成员仍是其他活动变式题的父题，请先处理变式依赖`。
- [x] 事件：成功且版本匹配后 `qbank://changed` `{exam_id,reason:"group_deleted"}`（commands.rs:1613-1632）。
- [x] DB 读写：Immediate 事务：ungroup 时无材料直接解绑、有材料建 solo 组；delete_members 时软删成员题目并写 history；软删组与关联材料；刷新 preview/stats/索引。
- [x] 取消/并发：expectedVersion 乐观锁；变式依赖检查在删除前完成，失败整批回滚。
- [x] 时间/ID：deletion_batch=qdel_+nanoid；时间戳 RFC3339。

## 命令 `qbank_delete_material`

<!-- BEGIN GENERATED:cmd:qbank_delete_material -->
- Rust：`src-tauri/src/commands.rs:1453` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:340`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：materialId: string, expectedVersion: integer(i64)
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_delete_material -->

- [x] 输入：materialId、expectedVersion（commands.rs:1454-1466）。
- [x] 输出：null。
- [x] 错误：`材料仍被题组引用，请先替换或解除依赖`、`CONFLICT: 材料版本已变化`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：Immediate 事务：检查活动题组引用后软删 qbank_materials（deleted_at/updated_at/local_version+1）。
- [x] 取消/并发：expectedVersion 乐观锁；引用检查失败不写。
- [x] 时间/ID：删除时间戳 RFC3339 UTC。

## 命令 `qbank_delete_practice`

<!-- BEGIN GENERATED:cmd:qbank_delete_practice -->
- Rust：`src-tauri/src/qbank_practice.rs:63` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:122`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, submitted: boolean
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_delete_practice -->

- [x] 输入：id、submitted（qbank_practice.rs:676-690）。
- [x] 输出：null。
- [x] 错误：DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：submitted=true 软删 qbank_practice_attempts（deleted_at/updated_at/local_version+1），否则物理删除 qbank_practice_drafts。
- [x] 取消/并发：单写事务；不存在的 id 按 Rust 语义静默成功。
- [x] 时间/ID：软删时间戳为 RFC3339 UTC。

## 命令 `qbank_delete_question`

<!-- BEGIN GENERATED:cmd:qbank_delete_question -->
- Rust：`src-tauri/src/commands.rs:7778` · async
- 前端：app（2 处，例 `src/features/learning-hub/apps/views/ExamContentView.tsx:1944`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_delete_question -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_export_document`

<!-- BEGIN GENERATED:cmd:qbank_export_document -->
- Rust：`src-tauri/src/commands.rs:1489` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:401`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_export_document -->

- [x] 输入：examId（commands.rs:1490-1500）。
- [x] 输出：serde_json::Value：schema_version=2、mode="extract"、materials/groups/questions、coverage/issues/unmatched_answers 空数组、sources/source_pages。第 100 题分页循环取全部题目；空题组的 group 不输出。
- [x] 错误：DB/JSON 解析异常转 Database；无 Validation。
- [x] 事件：无事件。
- [x] DB 读写：只读 questions（按 created_at,id 分页）、qbank_materials、qbank_groups/qbank_group_materials/questions、qbank_sources；逐题读 provenance_json 拼 source_refs/answer_source_refs/section_path。
- [x] 取消/并发：只读。
- [x] 时间/ID：字段顺序按 serde_json 结构；题目 variant_parent_local_id 取 questions.parent_id。

## 命令 `qbank_export_paper_docx`

<!-- BEGIN GENERATED:cmd:qbank_export_paper_docx -->
- Rust：`src-tauri/crates/dstu-qbank/src/qbank_practice/export.rs:228` · sync
- 前端：app（1 处，例 `src/components/practice/paperExport.ts:398`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：title: string, blocks: PaperBlock[]
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:qbank_export_paper_docx -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_export_portable`

<!-- BEGIN GENERATED:cmd:qbank_export_portable -->
- Rust：`src-tauri/src/commands.rs:1633` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:412`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：PortableExport · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_export_portable -->

- [x] 输入：examId（commands.rs:1634-1644）。
- [x] 输出：PortableExport：base64（ZIP 标准 Base64）、name=`question-bank-{exam_id}.zip`；ZIP 含 document.json、manifest.json、assets/{hash}。
- [x] 错误：`导出缺少源资产: {hash}`（NotFound）、`便携题库超过200MB安全限制，请减少来源资产后导出`、`源资产哈希校验失败，已停止导出`（Validation），文件读取异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：调用 export_document 后递归收集 hash/blob_hash（64 位十六进制）；按 blobs.relative_path 读取 vfs_blobs 下文件，按 hash 升序写入 ZIP（Deflated）；manifest.assets 列出 hash 与路径。
- [x] 取消/并发：只读；单次同步导出，无锁。
- [x] 时间/ID：资产以 SHA-256 校验；ZIP 条目时间戳固定 1980-01-01。

## 命令 `qbank_generate_mock_exam`

<!-- BEGIN GENERATED:cmd:qbank_generate_mock_exam -->
- Rust：`src-tauri/src/commands.rs:8106` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2276`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GenerateMockExamRequest
  - 结果：MockExamSession · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_generate_mock_exam -->

- [x] 输入：request.exam_id、config（duration/type_distribution/difficulty_distribution/total_count/shuffle/include_mistakes/tags，question_bank_service.rs:2338-2459）。
- [x] 输出：MockExamSession：config 规范化、question_ids、answers/results 空对象、score/correct_rate=null。
- [x] 错误：`无法根据配置选出足够的题目`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 questions 随机选题（include_mistakes=false 排除 review 状态），不落库。
- [x] 取消/并发：只读。
- [x] 时间/ID：id=randomUUID；started_at RFC3339。

## 命令 `qbank_generate_paper`

<!-- BEGIN GENERATED:cmd:qbank_generate_paper -->
- Rust：`src-tauri/src/commands.rs:8168` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2359`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GeneratePaperRequest
  - 结果：GeneratedPaper · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_generate_paper -->

- [x] 输入：exam_id、config（title/type_selection/difficulty_filter/tags_filter/shuffle/include_* /export_format，qbank_practice.rs:2760-2895）。
- [x] 输出：GeneratedPaper：题目完整保留答案/解析，total_score=题数，export_path=null（同源 :2909-2930）。
- [x] 错误：`试卷标题须为 1–200 字符`、`每份试卷最多 500 题`、`题型 X ... 仅有 N 题，需要 M 题`、`无法根据配置选出题目`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：读 questions（随机选题），写 qbank_papers（含 device_id）同源 `save_paper` :172-183。
- [x] 取消/并发：选题只读；保存单条 INSERT。
- [x] 时间/ID：created_at 当前 RFC3339；id=randomUUID。

## 命令 `qbank_get_activity_heatmap`

<!-- BEGIN GENERATED:cmd:qbank_get_activity_heatmap -->
- Rust：`src-tauri/src/commands.rs:8018` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1963`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetActivityHeatmapRequest
  - 结果：ActivityHeatmapPoint[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_activity_heatmap -->

- [x] 输入：request.exam_id（可选）、year（question_bank_service.rs:2062-2152）。
- [x] 输出：ActivityHeatmapPoint[]：date/count/correct_count/level(0-4，阈值 0/1-3/4-6/7-10/11+)。
- [x] 错误：`年份无效`（year 不在 1970..=9999），DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 answer_submissions JOIN questions，无提交的存量题按 questions.last_attempt_at 兜底，`DATE(...,'localtime')`。
- [x] 取消/并发：只读。
- [x] 时间/ID：日期按本地时区归日；不改时间。

## 命令 `qbank_get_authoring_draft`

<!-- BEGIN GENERATED:cmd:qbank_get_authoring_draft -->
- Rust：`src-tauri/src/commands.rs:1386` · sync
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：jobId: string
  - 结果：QuestionAuthoringDraft · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_authoring_draft -->

- [x] 输入：jobId（commands.rs:1387-1397）。
- [x] 输出：QuestionAuthoringDraft：job_id/exam_id/document/status/version/metadata。
- [x] 错误：`未找到题目草稿`（NotFound），DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 qbank_import_jobs。
- [x] 取消/并发：只读。
- [x] 时间/ID：version 为 OCC 令牌。

## 命令 `qbank_get_check_in_calendar`

<!-- BEGIN GENERATED:cmd:qbank_get_check_in_calendar -->
- Rust：`src-tauri/src/commands.rs:8193` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2381`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetCheckInCalendarRequest
  - 结果：CheckInCalendar · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_check_in_calendar -->

- [x] 输入：request.exam_id（可选）、year、month、daily_target（可选，question_bank_service.rs:2969-3168）。
- [x] 输出：CheckInCalendar：days（仅有活动的日期）/streak_days/month_check_in_days/month_total_questions/month_focus_seconds。
- [x] 错误：`月份必须在 1-12 之间`、`年份无效`，DB 异常 Database；番茄钟读取失败按 0 处理（同源 warn 兜底）。
- [x] 事件：无事件。
- [x] DB 读写：只读 answer_submissions/questions 与 pomodoro_records（work+completed/interrupted，local 日聚合）。
- [x] 取消/并发：只读；streak 基于全部历史回溯最多 3700 天。
- [x] 时间/ID：target=max(1,daily_target ?? 10)；今天/昨天用本地日期；streak 规则同 compute_streak_days。

## 命令 `qbank_get_daily_practice`

<!-- BEGIN GENERATED:cmd:qbank_get_daily_practice -->
- Rust：`src-tauri/src/commands.rs:8147` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2337`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetDailyPracticeRequest
  - 结果：DailyPracticeResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_daily_practice -->

- [x] 输入：request.exam_id、count（question_bank_service.rs:2615-2760）。
- [x] 输出：DailyPracticeResult：date/exam_id/question_ids/daily_target/completed_count/correct_count/source_distribution/is_completed。
- [x] 错误：`每日一练题目数量必须大于 0`、`题目集中没有题目`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读：当日进度（submissions 为主、last_attempt_at 兜底）+ 按错题/新题/复习题/随机四段选 ID，选完不回写。
- [x] 取消/并发：只读；排除今日已答题，题目不足时最后回补已答题（同源步骤 5）。
- [x] 时间/ID：date 为本地日期；复习题阈值=Utc now-7 天 RFC3339。

## 命令 `qbank_get_generation_task`

<!-- BEGIN GENERATED:cmd:qbank_get_generation_task -->
- Rust：`src-tauri/src/qbank_generation.rs:27` · async
- 前端：app（2 处，例 `src/features/chat/plugins/blocks/qbankQuestionsBlock.tsx:81`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：taskId: string
  - 结果：GenerationTaskView | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_generation_task -->

- [x] 输入：taskId 字符串不 trim；qbank_generation/mod.rs:233-243。
- [x] 输出：无记录 null；GenerationTaskView camelCase，不含 request_json/stream_event；task_repo.rs:78-114,344-370。坏 JSON 数组整体降为空，负计数归零，未知状态 queued。
- [x] 错误：AppError Database，查询错误为 `Database error: 出题任务表操作失败: <sqlite>`；task_repo.rs:124-126；mod.rs:241-243。
- [x] 事件：读取不发事件；mod.rs:233-244。
- [x] DB 读写：vfs.db/qbank_generation_tasks 按 id 查询，只读；task_repo.rs:163-176。
- [x] 取消/并发：无取消点，单条同步查询；同上。Host storage 为必需注入服务。
- [x] 时间/ID：原样返回 i64 毫秒时间及已有 ID，不生成；task_repo.rs:364-366。

## 命令 `qbank_get_history`

<!-- BEGIN GENERATED:cmd:qbank_get_history -->
- Rust：`src-tauri/src/commands.rs:7910` · async
- 前端：app（1 处，例 `src/components/QuestionHistoryView.tsx:202`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string, limit?: integer(u32) | null
  - 结果：QuestionHistory[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_history -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_get_knowledge_stats`

<!-- BEGIN GENERATED:cmd:qbank_get_knowledge_stats -->
- Rust：`src-tauri/src/commands.rs:8041` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetKnowledgeStatsRequest
  - 结果：KnowledgePoint[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_knowledge_stats -->

- [x] 输入：request.exam_id（可选，question_bank_service.rs:2157-2244）。
- [x] 输出：KnowledgePoint[]：tag/total/mastered/in_progress/review/new_count/mastery_rate/correct_rate，按 total DESC 限 10。
- [x] 错误：DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 questions, json_each(questions.tags)，聚合 attempt_count/correct_count（同源 SQL）。
- [x] 取消/并发：只读。
- [x] 时间/ID：mastery_rate=(mastered+in_progress*0.5)/total*100 四舍五入；correct_rate=total_correct/total_attempts*100 四舍五入。

## 命令 `qbank_get_knowledge_stats_with_comparison`

<!-- BEGIN GENERATED:cmd:qbank_get_knowledge_stats_with_comparison -->
- Rust：`src-tauri/src/commands.rs:8055` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1983`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetKnowledgeStatsRequest
  - 结果：KnowledgeStatsComparison · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_knowledge_stats_with_comparison -->

- [x] 输入：request.exam_id（可选，question_bank_service.rs:2249-2261）。
- [x] 输出：KnowledgeStatsComparison：current=get_knowledge_stats，previous=[]（Rust TODO 同语义）。
- [x] 错误：DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：同 get_knowledge_stats，只读。
- [x] 取消/并发：只读。
- [x] 时间/ID：无时间字段。

## 命令 `qbank_get_learning_trend`

<!-- BEGIN GENERATED:cmd:qbank_get_learning_trend -->
- Rust：`src-tauri/src/commands.rs:7989` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1940`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: GetLearningTrendRequest
  - 结果：LearningTrendPoint[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_learning_trend -->

- [x] 输入：request.exam_id（可选）、start_date、end_date（question_bank_service.rs:1925-2018）。
- [x] 输出：LearningTrendPoint[]：逐日补齐（含零值），attempt_count/correct_count/correct_rate。
- [x] 错误：`开始日期格式无效，应为 YYYY-MM-DD`/`结束日期格式无效，应为 YYYY-MM-DD`/`开始日期不能晚于结束日期`/`日期范围过大（最多支持约 10 年）`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 answer_submissions JOIN questions（同源 SQL），不做 last_attempt_at 兜底（Rust 同）。
- [x] 取消/并发：只读。
- [x] 时间/ID：日期区间按传入 YYYY-MM-DD 逐日展开；日界线 localtime。

## 命令 `qbank_get_paper`

<!-- BEGIN GENERATED:cmd:qbank_get_paper -->
- Rust：`src-tauri/src/qbank_practice.rs:80` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:129`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string
  - 结果：GeneratedPaper · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_paper -->

- [x] 输入：id（qbank_practice.rs:705-709）。
- [x] 输出：GeneratedPaper。
- [x] 错误：`Paper not found`（NotFound），DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 qbank_papers（deleted_at IS NULL）。
- [x] 取消/并发：只读。
- [x] 时间/ID：不改时间。

## 命令 `qbank_get_practice`

<!-- BEGIN GENERATED:cmd:qbank_get_practice -->
- Rust：`src-tauri/src/qbank_practice.rs:33` · sync
- 前端：app（2 处，例 `src/api/practiceApi.ts:96`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, submitted: boolean
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_practice -->

- [x] 输入：id、submitted（qbank_practice.rs:587-599）。
- [x] 输出：submitted=true 返回 PracticeAttempt，否则 PracticeDraft（JSON 值）。
- [x] 错误：`Practice draft not found`/`Practice attempt not found`（NotFound），DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 qbank_practice_attempts（deleted_at IS NULL）或 qbank_practice_drafts。
- [x] 取消/并发：只读，无锁。
- [x] 时间/ID：不改时间字段。

## 命令 `qbank_get_question`

<!-- BEGIN GENERATED:cmd:qbank_get_question -->
- Rust：`src-tauri/src/commands.rs:7675` · async
- 前端：app（7 处，例 `src/components/practice/BatchPracticeWorkspace.tsx:385`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string
  - 结果：Question | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_question -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_get_question_by_card_id`

<!-- BEGIN GENERATED:cmd:qbank_get_question_by_card_id -->
- Rust：`src-tauri/src/commands.rs:7689` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, cardId: string
  - 结果：Question | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_question_by_card_id -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_get_source_images`

<!-- BEGIN GENERATED:cmd:qbank_get_source_images -->
- Rust：`src-tauri/src/commands.rs:8515` · async
- 前端：app（1 处，例 `src/components/ImageCropDialog.tsx:86`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：SourceImageInfo[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_source_images -->

- [x] 输入：examId（commands.rs:8515-8580）。
- [x] 输出：SourceImageInfo[]（camelCase）：blobHash/dataUrl/pageIndex；dataUrl=`data:{mime};base64,{bytes}`，MIME 按魔数 PNG/JPEG/WEBP，其余按 image/png。
- [x] 错误：`题目集不存在`（NotFound）；获取题目集/读取任务失败转 Database；缺失 blob/文件读取失败逐项跳过不报错。
- [x] 事件：无事件。
- [x] DB 读写：读 exam_sheets.metadata_json.source_image_hashes；为空时回退 preview_json.pages[].blob_hash（保持顺序、不去重）；按 blobs.relative_path 读取 vfs_blobs 下文件。
- [x] 取消/并发：同步只读；无锁。
- [x] 时间/ID：pageIndex 为哈希数组下标（0 起）；blob 缺失不影响其他图片。

## 命令 `qbank_get_source_page`

<!-- BEGIN GENERATED:cmd:qbank_get_source_page -->
- Rust：`src-tauri/crates/dstu-qbank/src/qbank_source_view.rs:339` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, sourceId: string, page?: integer(u32) | null
  - 结果：SourcePageView · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_source_page -->

- [x] 输入：examId、sourceId、page?: u32|null（qbank_source_view.rs:339-352）。
- [x] 输出：SourcePageView（snake_case）：source_id 为请求的数据库 id；page 原样返回（0 归一为 null，不存在时仍返回请求页）；blob_hash/width/height 仅来自真实页；text 为页文本或原生文本；available_pages 为描述符真实页号升序去重。
- [x] 错误：`题目集或来源标识为空`（Validation）；`题目集不存在或已删除`、`来源不存在或不属于该题目集`（NotFound）；`来源描述无效: ...`、`原始文件页图索引无效: ...`（Database/Validation）。
- [x] 事件：无事件。
- [x] DB 读写：只读 exam_sheets（含软删除校验）、qbank_sources.descriptor_json、files（id 或 resource_id，含 preview_json 缓存页图）。
- [x] 取消/并发：只读；不做语义猜测，缺少页时不合成页 1。
- [x] 时间/ID：页号 1 起；图片附件仅 page 1 提供 blob，PDF/DOCX 不把文档字节当页图。

## 命令 `qbank_get_stats`

<!-- BEGIN GENERATED:cmd:qbank_get_stats -->
- Rust：`src-tauri/src/commands.rs:7868` · async
- 前端：app（2 处，例 `src/hooks/useQuestionBankSession.ts:357`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：dstu_vfs__vfs__repos__question_repo__QuestionBankStats | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_get_submissions`

<!-- BEGIN GENERATED:cmd:qbank_get_submissions -->
- Rust：`src-tauri/src/commands.rs:7925` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string, limit?: integer(u32) | null
  - 结果：AnswerSubmission[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_get_submissions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_grade_practice_manually`

<!-- BEGIN GENERATED:cmd:qbank_grade_practice_manually -->
- Rust：`src-tauri/src/qbank_practice.rs:112` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:126`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, questionId: string, correct: boolean
  - 结果：PracticeAttempt · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_grade_practice_manually -->

- [x] 输入：id、questionId、correct（qbank_practice.rs:1060-1122）。
- [x] 输出：更新后的 PracticeAttempt：结果状态 correct/incorrect、score、job=done；源题或提交不存在时 source_available=false（同源）。
- [x] 错误：`Result not found`、`Cannot grade an unanswered question`、`Practice attempt not found`，DB 异常转 Database。
- [x] 事件：无事件（Rust 此命令不 emit）。
- [x] DB 读写：事务：读 attempt，更新 submission verdict 与 questions 计数/状态，更新 qbank_practice_jobs 与 attempt 文档。
- [x] 取消/并发：事务内一致写；mastery 写入用同连接；review plan 因 review lane 无接口暂未创建（报告）。
- [x] 时间/ID：updated_at/submitted 判定时间用当前 RFC3339。

## 命令 `qbank_legacy_audit`

<!-- BEGIN GENERATED:cmd:qbank_legacy_audit -->
- Rust：`src-tauri/src/commands.rs:1542` · sync
- 前端：app（1 处，例 `src/components/QuestionImportAuditPanel.tsx:158`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：LegacyMigrationAudit · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_legacy_audit -->

- [x] 输入：examId（commands.rs:1543-1554）。
- [x] 输出：LegacyMigrationAudit：canonical_marker/canonical_question_count/source_version/audit_version/pages/cards/migratable_card_ids 与 matched/unmatched/ambiguous/deleted/invalid/suppressed 计数；150+ 卡片不截断。
- [x] 错误：`目标题目集不存在`（NotFound），DB/JSON 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 exam_sheets.preview_json/metadata_json 与 questions（含已删除行）；按 card_id 或 id 精确映射，不看 label/content。
- [x] 取消/并发：只读。
- [x] 时间/ID：source_version/audit_version 为 SHA-256（JSON 序列化后）；canonical_marker 取 metadata.question_document_version==2。

## 命令 `qbank_legacy_migrate_selected`

<!-- BEGIN GENERATED:cmd:qbank_legacy_migrate_selected -->
- Rust：`src-tauri/src/commands.rs:1555` · sync
- 前端：app（1 处，例 `src/components/QuestionImportAuditPanel.tsx:166`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, cardIds: string[], expectedVersion: string
  - 结果：LegacyMigrationReceipt · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_legacy_migrate_selected -->

- [x] 输入：examId、cardIds、expectedVersion（commands.rs:1556-1575）。
- [x] 输出：LegacyMigrationReceipt：committed/idempotent/job_id/migrated_card_ids/question_ids/imported_count/audit_version_before/audit_version_after。
- [x] 错误：`请选择要迁移的历史题目卡片`/`迁移选择包含重复的卡片 ID`/`卡片 ID 不能为空`/`审计结果中不存在卡片`/`卡片 ... 当前不可迁移`/`所选历史卡片无法迁移: ...`（Validation）；`历史导入审计已变化...`（Conflict）；`目标题目集不存在`（NotFound）；DB 异常 Database。
- [x] 事件：成功后 `qbank://changed` `{exam_id,reason:"legacy_migrated"}`（commands.rs:1565-1572）。
- [x] DB 读写：Immediate 事务：审计 → 幂等重放 → 版本校验 → 由 preview 卡片构造 QuestionDocument → qbank_import_jobs/qbank_authoring_service save+commit（questions/qbank_materials/qbank_groups/qbank_sources/stats/exam_sheets）→ 回写新题 card_id 与 provenance_json.legacy_migration/legacy_preview → 重新投影预览并与原始预览并集合并 → refresh_stats。
- [x] 取消/并发：同一选择已提交时按 provenance 标记幂等返回（即使版本旧）；已迁移题被删除则 Conflict，不从快照重建；任何失败整事务回滚。
- [x] 时间/ID：job id=qjob_+nanoid；迁移时间戳 RFC3339；metadata.idempotency_key=`legacy-migrate:{exam_id}:{sha256(card_ids)}`。

## 命令 `qbank_list_authoring_drafts`

<!-- BEGIN GENERATED:cmd:qbank_list_authoring_drafts -->
- Rust：`src-tauri/src/commands.rs:1398` · sync
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/ExamContentView.tsx:1976`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：QuestionDraftSummary[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_authoring_drafts -->

- [x] 输入：examId（commands.rs:1399-1409）。
- [x] 输出：QuestionDraftSummary[]：仅 ready/needs_review/partial，按 created_at DESC，question_count=json_array_length(document_json,'$.questions')。
- [x] 错误：DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 qbank_import_jobs JOIN exam_sheets（exam 未删除）。
- [x] 取消/并发：只读。
- [x] 时间/ID：created_at 原样。

## 命令 `qbank_list_generation_tasks`

<!-- BEGIN GENERATED:cmd:qbank_list_generation_tasks -->
- Rust：`src-tauri/src/qbank_generation.rs:37` · async
- 前端：app（1 处，例 `src/hooks/useQbankAiGeneration.ts:70`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, limit?: integer(usize) | null
  - 结果：GenerationTaskView[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_generation_tasks -->

- [x] 输入：examId 不 trim；limit 缺省/null 为 20，上限 100，保留 0；qbank_generation/mod.rs:247-259。
- [x] 输出：GenerationTaskView[]，按 created_at DESC，无附加 tie-break；task_repo.rs:180-204。坏 JSON 和状态同 get。
- [x] 错误：AppError Database，与 get 同映射；mod.rs:257-259；task_repo.rs:124-126。
- [x] 事件：无；mod.rs:247-260。
- [x] DB 读写：vfs.db/qbank_generation_tasks WHERE exam_id，LIMIT；task_repo.rs:188-198。
- [x] 取消/并发：无取消点，单条同步查询；同上。Host storage 为必需注入服务。
- [x] 时间/ID：原样返回已存储毫秒时间和 ID；task_repo.rs:364-366。

## 命令 `qbank_list_mistakes`

<!-- BEGIN GENERATED:cmd:qbank_list_mistakes -->
- Rust：`src-tauri/src/commands.rs:7600` · async
- 前端：app（1 处，例 `src/features/learning-hub/mistakeBook/mistakeBookApi.ts:102`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ListMistakesRequest
  - 结果：MistakeListResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_mistakes -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_list_papers`

<!-- BEGIN GENERATED:cmd:qbank_list_papers -->
- Rust：`src-tauri/src/qbank_practice.rs:72` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:128`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：GeneratedPaper[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_papers -->

- [x] 输入：examId（qbank_practice.rs:692-703）。
- [x] 输出：GeneratedPaper[]，按 created_at DESC，且 deleted_at IS NULL。
- [x] 错误：DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 qbank_papers。
- [x] 取消/并发：只读。
- [x] 时间/ID：created_at 原样。

## 命令 `qbank_list_practices`

<!-- BEGIN GENERATED:cmd:qbank_list_practices -->
- Rust：`src-tauri/src/qbank_practice.rs:42` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:116`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：scopeId: string, submitted: boolean, offset?: integer(u32) | null
  - 结果：PracticeSummary[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_practices -->

- [x] 输入：scopeId、submitted、offset（qbank_practice.rs:601-662）。
- [x] 输出：PracticeSummary[]，标题/模式/题数/已答/正确/待批改/状态；最多 200 条，updated_at 取数据库行值（:609-658）。
- [x] 错误：DB 异常转 Database；精确 JSON 解码失败同样转 Database。
- [x] 事件：无事件。
- [x] DB 读写：读 qbank_practice_attempts（按 created_at,id DESC）或 qbank_practice_drafts（按 updated_at,id DESC）。
- [x] 取消/并发：只读。
- [x] 时间/ID：updated_at 原样返回数据库值。

## 命令 `qbank_list_questions`

<!-- BEGIN GENERATED:cmd:qbank_list_questions -->
- Rust：`src-tauri/src/commands.rs:7572` · async
- 前端：app（7 处，例 `src/components/QuestionFavoritesView.tsx:130`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: ListQuestionsRequest
  - 结果：QuestionListResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_questions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_list_structure`

<!-- BEGIN GENERATED:cmd:qbank_list_structure -->
- Rust：`src-tauri/src/commands.rs:1530` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:309`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：QuestionBankStructure · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_list_structure -->

- [x] 输入：examId（qbank_management.rs:155-274）。
- [x] 输出：QuestionBankStructure：materials（id/content/images/source_refs/version）与 groups（id/exam_id/label/position/version/material_ids/question_ids）。
- [x] 错误：`目标题目集不存在或已删除`（NotFound）、`来源页面缺少blob_hash` 仅在刷新预览时；DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 exam_sheets/qbank_materials/qbank_groups/qbank_group_materials/questions，按 position/created_at 排成员。
- [x] 取消/并发：只读。
- [x] 时间/ID：version 取 qbank_* 的 local_version，作为 OCC 令牌。

## 命令 `qbank_rebuild_fts_index`

<!-- BEGIN GENERATED:cmd:qbank_rebuild_fts_index -->
- Rust：`src-tauri/src/commands.rs:7664` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1520`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：（无）
  - 结果：integer(u64) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_rebuild_fts_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_refresh_stats`

<!-- BEGIN GENERATED:cmd:qbank_refresh_stats -->
- Rust：`src-tauri/src/commands.rs:7896` · async
- 前端：app（3 处，例 `src/hooks/useQuestionBankSession.ts:490`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：dstu_vfs__vfs__repos__question_repo__QuestionBankStats · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_refresh_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_remove_question_image`

<!-- BEGIN GENERATED:cmd:qbank_remove_question_image -->
- Rust：`src-tauri/src/commands.rs:8727` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string, imageId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_remove_question_image -->

- [x] 输入：questionId、imageId（commands.rs:8728-8763）。
- [x] 输出：null。
- [x] 错误：`题目不存在`（NotFound）、获取/更新失败转 Database。
- [x] 事件：无事件。
- [x] DB 读写：读 questions 后按 id 过滤 images，再以 UpdateQuestionParams.images 整体回写 images_json（触发 updated_at/content_hash 更新）。
- [x] 取消/并发：读改写非事务单连接同步；imageId 不存在时保持原数组仍执行更新（同 Rust）。
- [x] 时间/ID：updated_at 由 update_question 规则刷新。

## 命令 `qbank_reparse_report`

<!-- BEGIN GENERATED:cmd:qbank_reparse_report -->
- Rust：`src-tauri/src/commands.rs:1576` · sync
- 前端：app（1 处，例 `src/components/QuestionImportAuditPanel.tsx:177`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, jobId?: string | null
  - 结果：ReparseReport · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_reparse_report -->

- [x] 输入：examId、jobId?: string|null（qbank_legacy_reconcile.rs:476-490；commands.rs:4174-4187）。jobId 缺省时选该题目集最近的可复核草稿：status IN (ready,needs_review,partial,committed) 或 metadata.reparse_resolution 为对象，且 metadata.reparse_import 不存在，按 updated_at DESC,id DESC 取一条。
- [x] 输出：ReparseReport：exam_id/job_id/job_version/report_version/canonical_marker/canonical_question_count/items/canonical_only/changed_count/new_count/deleted_count/ambiguous_count/resolved/resolution。item 状态取 unchanged|changed|new|deleted|ambiguous|unmapped，携带 source_key、canonical_question_id、canonical_revision、候选 ID、字段级 before/after 与 allowed_actions；已复核草稿的 allowed_actions 置空并说明只返回已保存结果。
- [x] 错误：`目标题目集不存在`、`当前题目集没有可复核的导入草稿`（NotFound）；`草稿不属于目标题目集`（Validation）；读取草稿/来源/正式题目或回执反序列化失败转 Database。
- [x] 事件：无事件（只读）。
- [x] DB 读写：读 exam_sheets.metadata_json/preview_json、qbank_import_jobs、qbank_sources、questions（含软删除行）与 files/blobs（图片存在性由 resolve 校验）。来源槽按 sha256(JSON.stringify([[qbank_source_id,page|null],...], section_path, original_label)) 计算；报告版本为草稿文档/元数据/正式题目映射的 SHA-256。
- [x] 取消/并发：单连接只读；不写库、不加锁。
- [x] 时间/ID：job_version 取草稿 version；report_version 为不透明哈希，前端仅用于 resolve 的期望版本。

## 命令 `qbank_reparse_resolve`

<!-- BEGIN GENERATED:cmd:qbank_reparse_resolve -->
- Rust：`src-tauri/src/commands.rs:1590` · sync
- 前端：app（1 处，例 `src/components/QuestionImportAuditPanel.tsx:189`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string, jobId: string, decisions: ReparseDecision[], expectedReportVersion: string
  - 结果：ReparseResolveReceipt · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_reparse_resolve -->

- [x] 输入：examId、jobId、decisions: ReparseDecision[]、expectedReportVersion（qbank_legacy_reconcile.rs:494-705；commands.rs:4189-4207）。decisions 按 local_id 升序归一化，缺省项自动 keep_existing；replace_existing 必须带非空 expected_revision，其他 action 的 expected_revision 强制置 null。
- [x] 输出：ReparseResolveReceipt：exam_id/job_id/applied/imported_question_ids/replaced_question_ids/kept_local_ids。导入新题时保留正式题目身份；替换保留原 id/card_id/作答历史；已复核草稿的原决策重试返回持久化回执。
- [x] 错误：`目标题目集不存在`、读取草稿失败（NotFound）；`草稿不属于目标题目集`、`复核内容无效: ...`、`复核题目图片不可用: ...`、`题目 X 不允许操作 action（状态 status）`、`题组/变式题不能单独导入为新题`、`多个草稿题目使用同一新增来源槽，不能猜测身份`、`替换操作必须携带 expected_revision`、`同一正式题目不能在一次复核中被重复替换`（Validation）；`重解析报告已变化，请重新载入后再确认操作（未修改任何内容）`、`该草稿已完成复核，不能改变已确认的选择；请创建新草稿`、`该草稿已取消或不可复核，请重新载入`、`题目版本已变化，请重新载入后再替换`、`草稿已被其他操作修改，未应用任何复核选择`、`待替换的正式题目已删除；请显式恢复原题而不是重建身份`（Conflict）；数据库失败转 Database。
- [x] 事件：成功提交后发出 `qbank://changed`，payload `{exam_id, reason: "reparse_resolved"}`。
- [x] DB 读写：同一 Immediate 事务内：读 exam_sheets/qbank_import_jobs/qbank_sources/questions/files；全量决策预校验后才写入。keep 只记录；import_as_new 新建单题草稿并提交（保留来源槽仅限 status=new 且有 source_key，其他情况清空来源引用避免窃取槽位），写 provenance.reparse；replace_existing 按 expected_revision 校验后更新题干/选项/答案/解析/题型/难度/标签/结构化数据/图片（空图片保留原图），保留 id/card_id/source_key 与 answer_submissions。有导入或替换时刷新 canonical preview、合并原 preview 证据、失效内容索引并刷新统计。最后写草稿 metadata.reparse_resolution、非 committed 状态置 cancelled、version+1；若 exam_sheets.import_state_json 指向该草稿则清空，否则原样保留。
- [x] 取消/并发：`BEGIN IMMEDIATE` 外层事务；草稿 version 与 metadata.reparse_resolution IS NULL 作为 UPDATE 条件，任一被并发修改则整笔回滚并报冲突。任一步 SQL 失败均回滚题目、子草稿、preview 与回执。
- [x] 时间/ID：新题/回执使用 now()（RFC3339），导入新题的幂等键为 reparse-import:{exam_id}:{job_id}:{local_id}:{report_version}；替换写入 applied_at/previous_revision。

## 命令 `qbank_reset_progress`

<!-- BEGIN GENERATED:cmd:qbank_reset_progress -->
- Rust：`src-tauri/src/commands.rs:7940` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1882`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：examId: string
  - 结果：dstu_vfs__vfs__repos__question_repo__QuestionBankStats · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_reset_progress -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_reset_questions_progress`

<!-- BEGIN GENERATED:cmd:qbank_reset_questions_progress -->
- Rust：`src-tauri/src/commands.rs:7954` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/ExamContentView.tsx:1818`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionIds: string[]
  - 结果：BatchResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_reset_questions_progress -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_resolve_authoring_route`

<!-- BEGIN GENERATED:cmd:qbank_resolve_authoring_route -->
- Rust：`src-tauri/src/commands.rs:1467` · async
- 前端：app（1 处，例 `src/components/ExamSheetUploader.tsx:431`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：modelConfigId?: string | null, requiresVision: boolean
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_resolve_authoring_route -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_resume_practice_grading`

<!-- BEGIN GENERATED:cmd:qbank_resume_practice_grading -->
- Rust：`src-tauri/src/qbank_practice.rs:96` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:127`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：（无）
  - 结果：null · 注入：app-handle, state
<!-- END GENERATED:cmd:qbank_resume_practice_grading -->

- [x] 输入：无参数（qbank_practice.rs:744-757）。
- [x] 输出：null。
- [x] 错误：DB 异常按 Rust 静默忽略（warn）；重调度不抛错。
- [x] 事件：无事件。
- [x] DB 读写：扫描 qbank_practice_drafts 中 deadline 非空的 document_json，对每个草稿注册/复用内存 deadline 定时器（去重）。
- [x] 取消/并发：幂等：已在 deadlineTimers 中的 id 不重复调度；插件卸载时清理全部定时器。
- [x] 时间/ID：deadline 解析失败则跳过；到点延迟 +3 秒与 Rust 一致。

## 命令 `qbank_retry_practice_grading`

<!-- BEGIN GENERATED:cmd:qbank_retry_practice_grading -->
- Rust：`src-tauri/src/qbank_practice.rs:101` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:124`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, questionId: string
  - 结果：PracticeAttempt · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:qbank_retry_practice_grading -->

- [x] 输入：id、questionId（qbank_practice.rs:1027-1058）。
- [x] 输出：更新后的 PracticeAttempt：目标 result.status=pending、error=null，attempt.status 按 refresh_status 重算。
- [x] 错误：`请在发起练习的设备上重试 AI 批改`、`Result not found`（NotFound）、`Only failed grading can be retried`、练习不存在（NotFound），DB 异常 Database。
- [x] 事件：无事件（Rust 调用 start_grading，不直接 emit）。
- [x] DB 读写：事务：读 qbank_practice_attempts，更新 document_json/local_version/updated_at；UPSERT qbank_practice_jobs(attempt_id,question_id) 为 queued 并清 error。
- [x] 取消/并发：origin_device_id 必须等于当前设备；仅 failed 可重试；LLM 队列执行器未迁移，任务保持 queued（见报告）。
- [x] 时间/ID：job id=`{attempt_id}:{question_id}`；updated_at 为 RFC3339 UTC。

## 命令 `qbank_review_authoring_draft`

<!-- BEGIN GENERATED:cmd:qbank_review_authoring_draft -->
- Rust：`src-tauri/src/commands.rs:1410` · sync
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：jobId: string, expectedVersion: integer(i64), coverage?: Value[] | null, issues?: Value[] | null, unmatchedAnswers?: Value[] | null
  - 结果：QuestionAuthoringDraft · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_review_authoring_draft -->

- [x] 输入：jobId、expectedVersion、coverage/issues/unmatchedAnswers（可空，commands.rs:1411-1431）。
- [x] 输出：更新后的 QuestionAuthoringDraft：version+1、status 按 complete_document/needs_review 重算。
- [x] 错误：`CONFLICT: 草稿已提交或版本变化，请重新读取`、`coverage 必须为真实 {source_id,page,status} 列表`、`复核不能删除来源覆盖范围`、题目文档校验错误，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：Immediate 事务：读 qbank_import_jobs，更新 document_json/status/version/updated_at。
- [x] 取消/并发：expectedVersion 乐观锁；校验失败整事务回滚。
- [x] 时间/ID：updated_at 为 RFC3339 UTC。

## 命令 `qbank_save_practice`

<!-- BEGIN GENERATED:cmd:qbank_save_practice -->
- Rust：`src-tauri/src/qbank_practice.rs:25` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:100`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: SavePracticeRequest
  - 结果：PracticeDraft · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_save_practice -->

- [x] 输入：request.id/revision/answers/marked_ids/current_index/elapsed_seconds（qbank_practice.rs:338-391）。
- [x] 输出：更新后的 PracticeDraft：revision+1、空白答案被过滤（同源 :370-377）。
- [x] 错误：`Practice changed in another window; reload before saving`（revision 不匹配或更新 0 行）、`Answer does not belong to this practice`、`Answer exceeds size limit`、`Invalid question index`，DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：读 qbank_practice_drafts，按 `id AND revision` 条件更新 document_json/revision/updated_at（:383-389）。
- [x] 取消/并发：乐观锁 revision；更新 0 行按 Rust 语义报 Validation。
- [x] 时间/ID：updated_at 为 RFC3339 UTC。

## 命令 `qbank_search_questions`

<!-- BEGIN GENERATED:cmd:qbank_search_questions -->
- Rust：`src-tauri/src/commands.rs:7641` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:1497`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: SearchQuestionsRequest
  - 结果：QuestionSearchListResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_search_questions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_start_timed_practice`

<!-- BEGIN GENERATED:cmd:qbank_start_timed_practice -->
- Rust：`src-tauri/src/commands.rs:8081` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2253`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: StartTimedPracticeRequest
  - 结果：TimedPracticeSession · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_start_timed_practice -->

- [x] 输入：request.exam_id、duration_minutes、question_count（question_bank_service.rs:2276-2328）。
- [x] 输出：TimedPracticeSession：uuid、question_ids、started_at、计数字段初值。
- [x] 错误：`题目数量必须大于 0`、`限时时长必须大于 0 分钟`、`题目集中没有题目`，DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 questions 随机抽 ID，不落库。
- [x] 取消/并发：只读。
- [x] 时间/ID：id=randomUUID；started_at=当前 RFC3339 UTC。

## 命令 `qbank_submit_answer`

<!-- BEGIN GENERATED:cmd:qbank_submit_answer -->
- Rust：`src-tauri/src/commands.rs:7817` · async
- 前端：app（4 处，例 `src/features/learning-hub/apps/views/media/mediaCheckpoints.ts:110`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: SubmitAnswerRequest
  - 结果：SubmitAnswerResult · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_submit_answer -->

- [x] 输入：SubmitAnswerRequest；空白 regrade_submission_id 视为未指定；命中显式改判时忽略 user_answer；override 命令层与服务层各 warn 一次（commands.rs:7818-7850）。
- [x] 输出：SubmitAnswerResult；幂等 client_request_id 返回原提交；未判定同答案 override 走改判而非新增。
- [x] 错误：题目/改判提交不存在为 NotFound；掌握度服务缺失为 Configuration 且整个答案事务回滚。
- [x] 事件：无事件；提交后更新 `qbank-practice-updated` 由练习命令负责。
- [x] DB 读写：答案、submission、统计、掌握度事件同事务；提交后创建/推进复习计划（失败 warn）并回流 learner profile。
- [x] 取消/并发：同步事务；客观题掌握度必写，主观题 is_correct=null 不写掌握度。
- [x] 时间/ID：submitted_at/updated_at 为 RFC3339 UTC；本地日期用于复习计划到期比较。

## 命令 `qbank_submit_mock_exam`

<!-- BEGIN GENERATED:cmd:qbank_submit_mock_exam -->
- Rust：`src-tauri/src/commands.rs:8126` · async
- 前端：app（1 处，例 `src/stores/questionBankStore.ts:2311`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: SubmitMockExamRequest
  - 结果：MockExamScoreCard · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_submit_mock_exam -->

- [x] 输入：request.session（question_ids/answers/results/started_at/ended_at，question_bank_service.rs:2463-2600）。
- [x] 输出：MockExamScoreCard：total/answered/correct/wrong/unanswered/correct_rate/time_spent/type_stats/difficulty_stats/wrong_question_ids/comment/completed_at。
- [x] 错误：`Invalid started_at` 为 Validation；ended_at 解析失败回退 epoch（Rust warn 同）；DB 异常 Database。
- [x] 事件：无事件。
- [x] DB 读写：只读 questions 批量取详情，不写库。
- [x] 取消/并发：只读；不新增 attempt/submission。
- [x] 时间/ID：correct_rate 用 f64 四舍五入；类型/难度键用 Rust Debug 名（SingleChoice/Easy 等）；completed_at 当前 RFC3339。

## 命令 `qbank_submit_practice`

<!-- BEGIN GENERATED:cmd:qbank_submit_practice -->
- Rust：`src-tauri/src/qbank_practice.rs:53` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:111`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, revision: integer(i64)
  - 结果：PracticeAttempt · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:qbank_submit_practice -->

- [x] 输入：id、revision（qbank_practice.rs:401-566）。
- [x] 输出：PracticeAttempt：逐题自动判分/待批改、提交快照、status=grading|needs_review|completed、elapsed_seconds 按 deadline 修正（同源 :430-550）。
- [x] 错误：revision 不匹配 `Practice changed before submission; reload before submitting`；草稿 NotFound；DB 异常 Database。
- [x] 事件：提交成功后 `ctx.backendEvents.emit("qbank-practice-updated", attempt.id)`，对应 Rust `app.emit`（:664-674）；AI 批改队列完成事件暂未实现。
- [x] DB 读写：事务：读草稿、写 answer_submissions、更新 questions、写 qbank_practice_attempts/qbank_practice_jobs、删除草稿；已提交同 id 幂等返回。
- [x] 取消/并发：同一草稿重复提交返回既有 attempt，不重复计分；主观题只入队 qbank_practice_jobs，LLM 批改执行器仍阻塞（报告）。
- [x] 时间/ID：submitted_at=当前 RFC3339；elapsed 用 deadline 剩余时间反推。

## 命令 `qbank_toggle_favorite`

<!-- BEGIN GENERATED:cmd:qbank_toggle_favorite -->
- Rust：`src-tauri/src/commands.rs:7854` · async
- 前端：app（5 处，例 `src/components/practice/BatchPracticeWorkspace.tsx:534`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：questionId: string
  - 结果：Question · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_toggle_favorite -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `qbank_update_group`

<!-- BEGIN GENERATED:cmd:qbank_update_group -->
- Rust：`src-tauri/src/commands.rs:1501` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:317`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：groupId: string, label: string, questionIds: string[], materialIds: string[], expectedVersion: integer(i64)
  - 结果：Value · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_update_group -->

- [x] 输入：groupId/label/questionIds/materialIds/expectedVersion（qbank_management.rs:283-462）。
- [x] 输出：GroupUpdateResult（序列化为 JSON Value）：更新后的 group、removed_question_ids、solo_group_ids。
- [x] 错误：`题组成员为空或重复`/`题组材料关联重复`/`子题不存在、已删除或不属于目标题目集`/`子题已属于其他题组，请先从原题组移出`/`材料不存在、已删除或不属于目标题目集`/`CONFLICT: 题组版本已变化，请重新载入`，DB 异常 Database。
- [x] 事件：成功且版本匹配后 `qbank://changed` `{exam_id,reason:"group_updated"}`（commands.rs:1502-1529）。
- [x] DB 读写：Immediate 事务：校验版本/成员/材料；移除成员时按原组材料创建 solo 组并写 qbank_group_materials；更新 questions.group_id/group_position、qbank_groups、关联材料；写 question_history；刷新 preview/stats/resources 索引。
- [x] 取消/并发：expectedVersion 乐观锁，任何校验失败整事务回滚；移除有材料依赖的子题时迁移到 solo 组而不复制材料内容。
- [x] 时间/ID：stamp 为当前 RFC3339；solo 组/关联行 ID 为 qgroup_/qgm_ + 16 位 nanoid。

## 命令 `qbank_update_material`

<!-- BEGIN GENERATED:cmd:qbank_update_material -->
- Rust：`src-tauri/src/commands.rs:1432` · sync
- 前端：app（1 处，例 `src/api/questionBankApi.ts:239`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：materialId: string, content: string, expectedVersion: integer(i64)
  - 结果：QuestionMaterial · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:qbank_update_material -->

- [x] 输入：materialId、content、expectedVersion（commands.rs:1433-1452）。
- [x] 输出：QuestionMaterial：id/content/images/source_refs/version。
- [x] 错误：`材料内容不能为空`、`CONFLICT: 材料版本已变化或材料不存在`，DB 异常 Database。
- [x] 事件：成功后 `qbank://changed` `{reason:"material_updated",material_id}`（commands.rs:1444-1450）。
- [x] DB 读写：事务更新 qbank_materials.content/local_version/updated_at，并把所属 exam 的 resources.index_state 置 pending。
- [x] 取消/并发：expectedVersion 乐观锁。
- [x] 时间/ID：updated_at 为 RFC3339 UTC。

## 命令 `qbank_update_paper`

<!-- BEGIN GENERATED:cmd:qbank_update_paper -->
- Rust：`src-tauri/src/qbank_practice.rs:85` · sync
- 前端：app（1 处，例 `src/api/practiceApi.ts:131`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：id: string, title?: string | null, deleted: boolean
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_update_paper -->

- [x] 输入：id、title（可选）、deleted（qbank_practice.rs:711-731）。
- [x] 输出：null；标题 trim 后同步 config.title。
- [x] 错误：`Invalid paper title`（空或 >200 字符）、`Paper not found`，DB 异常转 Database。
- [x] 事件：无事件。
- [x] DB 读写：读后更新 qbank_papers 的 title/document_json/deleted_at/updated_at/local_version+1。
- [x] 取消/并发：事务内读改写。
- [x] 时间/ID：updated_at 为 RFC3339 UTC；deleted=true 把同一时间写入 deleted_at。

## 命令 `qbank_update_question`

<!-- BEGIN GENERATED:cmd:qbank_update_question -->
- Rust：`src-tauri/src/commands.rs:7740` · async
- 前端：app（4 处，例 `src/components/QuestionInlineEditor.tsx:700`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: UpdateQuestionRequest
  - 结果：Question · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:qbank_update_question -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `rename_exam_sheet_session`

<!-- BEGIN GENERATED:cmd:rename_exam_sheet_session -->
- Rust：`src-tauri/src/commands.rs:980` · async
- 前端：none
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: RenameExamSheetSessionRequest
  - 结果：RenameExamSheetSessionResponse · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:rename_exam_sheet_session -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `resume_question_import`

<!-- BEGIN GENERATED:cmd:resume_question_import -->
- Rust：`src-tauri/src/commands.rs:1285` · async
- 前端：app（1 处，例 `src/components/ExamSheetUploader.tsx:1054`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：sessionId: string, importId?: string | null
  - 结果：QuestionImportDraftResponse · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:resume_question_import -->

- 状态：**已注册**。旧 checkpoint 三条视觉分支见 `src/question-import-legacy-vision.ts`（L18 `questionImportVision`）；L11 `ensureFileForBlobWithConn` 待发布（BLOCKERS）。
- [x] 入口：TS `src/question-import-commands.ts::resumeQuestionImport` → `resumeV2` → `resumeLegacy`。
- [x] 分支表：读状态失败 Database「读取导入状态失败: …」/ 缺失 NotFound；JSON 且 `schema_version` 为整数 2：有 source_bundle → 解码（Validation）
  → resolve config → 指纹不一致 Configuration「恢复任务的模型配置已变化…」→ runDocument → 保存草稿；否则 job_id 缺失 Validation →
  读草稿 + 题目集（NotFound）。其余 → `parseCheckpoint`（「解析导入状态失败: …」）→ DocxVlmDirectDone 收尾 / DocxVlmDirect、Docx*、
  Visual → `LegacyVisionResume`（L18）/ 纯文本分块恢复（断点块跳过、空内容题跳过、写库失败 warn 计数、首个失败原因、全失败 Database）。
- [x] 取消/并发（commands.rs:1286-1350）：import_id 原值（仅过滤空白）登记，占用 →「该恢复任务仍在运行」；无 id 时令牌不可外部取消；
  取消 →「题目解析恢复已取消」；finally 无条件移除登记。
- [x] 事件：`question_import_progress` 附 import_id（v2 分支不发事件，与 Rust 一致）。
- [x] 日志：恢复导入 info、恢复 DOCX VLM 直提 info、恢复纯文本 info、块解析失败 warn、保存题目失败 warn、保存 checkpoint 失败 warn、
  统计刷新失败 warn、rebuild_preview 读取/更新失败 warn。
- [x] 测试：`tests/question-import-resume.test.ts`（host.invoke：v2 三分支、2.0 非整数、NotFound、占用、纯文本、DocxVlmDirect(Done)、DOCX 原生、Visual-First 并发/失败/取消）；no_questions_error 两条 Rust 用例在 `tests/question-import.test.ts`。

## 命令 `update_exam_sheet_cards`

<!-- BEGIN GENERATED:cmd:update_exam_sheet_cards -->
- Rust：`src-tauri/src/commands.rs:957` · async
- 前端：app（1 处，例 `src/api/questionBankApi.ts:607`）
- 契约：`contracts/ipc/L14-qbank.json`
  - 参数：request: UpdateExamSheetCardsRequest
  - 结果：UpdateExamSheetCardsResponse · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:update_exam_sheet_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `qbank_generation_task_event`

<!-- BEGIN GENERATED:event:qbank_generation_task_event -->
- 事件名 `qbank_generation_task_event`，常量 `QBANK_GENERATION_TASK_EVENT`
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_generation/events.rs:16`（emit）
<!-- END GENERATED:event:qbank_generation_task_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `qbank-export-paper`

<!-- BEGIN GENERATED:event:qbank-export-paper -->
- 事件名 `qbank-export-paper`
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_practice/export_bridge.rs:46`（emit）
<!-- END GENERATED:event:qbank-export-paper -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `qbank-practice-updated`

<!-- BEGIN GENERATED:event:qbank-practice-updated -->
- 事件名 `qbank-practice-updated`
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_practice.rs:671`（emit）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_practice.rs:788`（emit）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_practice.rs:955`（emit）
<!-- END GENERATED:event:qbank-practice-updated -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `qbank://changed`

<!-- BEGIN GENERATED:event:qbank://changed -->
- 事件名 `qbank://changed`
- 发送点：`src-tauri/src/chat_v2/tools/qbank_executor.rs:1436`（emit）
<!-- END GENERATED:event:qbank://changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `review://changed`

<!-- BEGIN GENERATED:event:review://changed -->
- 事件名 `review://changed`
- 发送点：`src-tauri/src/chat_v2/tools/review_executor.rs:224`（emit）
<!-- END GENERATED:event:review://changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `event_name`

<!-- BEGIN GENERATED:event:expr:event_name -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs:28`（emit）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs:55`（emit）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs:70`（emit）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs:103`（emit）
<!-- END GENERATED:event:expr:event_name -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `qbank_grading_stream_{stream_session_id}`

<!-- BEGIN GENERATED:event:fmt:qbank_grading_stream_{stream_session_id} -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs:88`（emit）
<!-- END GENERATED:event:fmt:qbank_grading_stream_{stream_session_id} -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 验收问题处理（2026-11-04 续作，R5 ACCEPTANCE）

- [x] Q1：`question-service`/`practice-service`/`practice-grading-queue` 已按 D1
  开事务并把同一 `SqlExecutor` 交给 L15 `mastery.*WithConn`；提交后
  reviewPlan/learner profile 保持 best-effort。`tests/submit-learning-loop.test.ts`
  覆盖错题计划、到期推进、改判与无 mastery 回滚。
- [x] Q4：`question-service.ts` 逐项读取 catch、业务更新失败 Database 文案包装；
  `tests/questions.test.ts` 经真实命令覆盖。
- [x] Q5：`structurallyEqual` 在任一值为数组时要求两边都是数组；真实命令历史回归
  覆盖键序等价、`[]` vs `{}`、`[1]` vs `{"0":1}`。
- [x] Q6：`tests/mastery-correction-contract.test.ts` 按 Rust 原名移植两条
  `mastery_qbank_correction.rs` 用例，断言首判 total/wrong/score、锁定链长 1、
  纠正链长 2、同向重放幂等与 r1 未 tombstone。
- [~] Q2：取消错误已由 `stream.complete(true, null)` 以非空 AppError 传播，
  `runSingleShotGrading` 返回 `error !== null`，`llmPracticeGrader` 抛
  `PracticeGradingFailure`，`runGradingQueue` 只写失败草稿；回归见
  `tests/llm-grading-transport.test.ts::complete_verdict_followed_by_cancel_is_reported_as_failure`
  与 `tests/practice-grading-queue.test.ts::run_grading_queue_does_not_commit_a_verdict_delivered_before_cancel`。
  已显式 `maxRetries: 0`、120s header/idle、拒绝 nonStream 回退；`reasoning_chars`
  因 L02 只发布 `reasoningBytes` 暂置 0，登记 BLOCKERS，**未签完全等价**。
- [x] Q7：测试 fixture 改为复用真实迁移模板后，
  `npx vitest run -c vitest.host.config.ts host/plugins/qbank`（作业
  `20261104091956-250d70`）37 files / 241 passed / 2 skipped / Errors 0 / 退出码 0。
  2 skipped 是 F7 `nativeImage.resizeRgba/encode` 未合入 main 的能力用例，另有
  同路径 nativeImage 契约替身用例常驻执行。
- [x] Q8 四原语消费（WP-165）：main `33d1323a9` 已提供
  `updateAiFeedback`/`updateAiAnalysis`/`markAsModified`/`updateContentHash`；
  qbank 经 `host.questions` 传原 conn/now，删除四个 writer 与私有 hash；不再等待旧接口。
  本项仅为该批改路径 owner 消费，回填/typed 残差不签全域等价。
- [~] Q3：命令层取消/日志已按 Rust；生成 runner 已接线并登记 token
  （`src/generation-runner.ts`），本项状态待复核签收。
