# W03 第三轮进度

## 1. L17 inflight 吸收（完成 `f56d88f`）

- [x] `git apply --3way .transfer/inflight/L17-memory-research.patch`，单独提交并注明来源（WP-170/WP-208/WP-272）。
- [x] TESTMAP hunk 未吸收（规则：不改 TESTMAP），交接给账本负责人。

## 2. 剩余执行器（完成）

名称、`sensitivityLevel`、并发类与 `src-tauri/src/agent_wiring/roster.rs` 对齐，统一经 `agentTools.registerToolExecutors` 注册。

- [x] `LearningOverviewExecutor`（`ab0b771`、`905fc7b`）：`learning_overview` / `pomodoro_today_stats` / `pomodoro_daily_stats`。
- [x] `InsightRecallExecutor`、`KnowledgeExecutor`（`123efb8`）：`insight_recall`、`knowledge_extract`；
  `recordInsightEventIdempotent` 把 hidden 映射为 `'none'`（CHECK 约束，Rust 同），修复静默事件被 OR IGNORE 吞掉。
- [x] `AcademicSearchExecutor`（`30e1ae6`）：`arxiv_search` / `scholar_search`；arXiv 8s，失败回退 OpenAlex 30s，
  经 `llmHttp`（代理与网络策略）；测试用本地 `node:http` 假服务器。
- [x] `PaperSaveExecutor`（`40985de`）：`paper_save` / `cite_format`；NDJSON 进度、sha256 去重、Unpaywall、
  50MB 上限、批量 5 篇；依赖 `paperLibrary` 端口（`PaperLibraryPort`）。

## 3. memory_write 写序（结论：非 memory 缺陷，已加回归钉 `683d722`）

- 同步阶段 1–9 行 `__change_log` 与 Rust 一致（`tests/memory-write-change-log.test.ts`）。
- G3 第 10/11 行顺序差异来自 `trigger_immediate_index` 与 `spawn_post_write_maintenance` 的任务调度竞争；
  第 19 行 `markIndexed` 取决于 vfs-index `indexResource` 成功与否。交接 vfs-index 与差分 harness 静默处理。

## 4. REVIEW_CONFLICT（完成 `36647a2`，有意偏离 Rust）

- `review_suspend/resume/delete` 保留结构化 `REVIEW_CONFLICT`（Rust anyhow context 会遮蔽）；代码注释已写明。

## 5. qbank `instanceof ExamSheetSessionError`（跳过）

- `media/api.ts` 未导出 `ExamSheetSessionError`，保持现状；交接 media。

## 6. 验证

- qbank + review + memory：135 文件 / 934 测试全部通过。
- 全量 `tsc --noEmit -p tsconfig.host.json`：0 错误。
- boundaries（qbank/review/memory/llm）：531 文件，0 违规。

## 交接

- L02 发布 `callUnifiedModel2`；L16 提供 `pendingMemoryCandidates` writer。
- vfs 发布实现 `PaperLibraryPort` 的 `paperLibrary` 服务（逻辑在 `vfs/src/download-paper.ts`、`upload-file.ts`），可导出 `buildNumberedSources`。
- media 导出 `ExamSheetSessionError`。
- vfs-index：`indexResource` 结果与 `vfs_index_units` 文本差异（Rust 为空、TS 有文本）。
- `knowledge_extract` 无前端 schema。

## Round 4 (2026-11-07)

- qbank: ExamSheetSessionError 改 instanceof（3d3d3019）。
- review 可移植化（7ece5a16, 1316078e）：自身闭包 Node-free；mobile profile 被 anki/api.ts（card-utils）与 llm/api.ts 值 barrel 阻塞，未加入。
- review config_json 按 serde_json(arbitrary_precision+preserve_order) 写回（4066b4cd）；W13 serde-compat 落地后替换 src/config-json.ts。
- memory：create_draft 顺序对齐 Rust（107c0f7d）；提供 insightHints 服务（5fe43ec7），chat-pipeline 尚未接线。
- 交接：chat-pipeline insightHints 接线、llm_usage_logs 写入、W09 knowledge_extract 前端 schema、portability baseline 中 qbank/memory 13 条 NEW。

## Round 5–7（摘要）

- 第五轮：serde-compat 的 rust-sampler 实测对照（f32/f64、`Value::to_string`）；qbank 授权指纹、memory promotion_fingerprint、幂等键与 Rust 逐字节一致；qbank/memory 可移植化 13 条 NEW 清零；`fsrs_review_logs.state_before_json` 按 serde_json 拼写。
- 第六轮：G3 分诊（见下）；qbank AI 解析回填改单条条件 UPDATE（a899df7e）；单例→实例（fbf4af2a）；qbank `apply()` 拆分（7fe42944）；paper_save 下载走 `ctx.http`（d5959a4e）；memory 发布 prompt 运行时接口（9dafa760）。
- 第七轮（fb0f6b3f、231d4906）：memory 决策角色改从 `llmRawPrompt` 解析；4 个 G3 场景输入修正（A 侧报错即 Rust 正确行为）。

## Round 8

- essay_grading 回复按 Rust f32 拼写上线（b4e1240a）：`overall_score` 经 `gradingScoreToWire`（52.0）；评分模式命令的 `total_max_score`、`score_dimensions[].max_score` 经 `f32Atom`（30.0、33.3）。
- RF-W03-paper-save-public-destination（6e73471b、fc911e06）：本机地址一律拒绝。原判断"`destination:'public'` 已拒回环，localhost 例外是死代码"不成立——net-policy `isSafeRemoteUrl` 对回环放行。因此改为请求前拒绝本机地址，并以 `redirect:'manual'` 逐跳跟随（10 跳、整链 60 s），每跳先拒本机地址。RF 改回 proposed 待复审。
- 残差：只经 DNS 解析到回环的域名仍可通过，需 `ctx.http` 支持 `public` + `allowLoopback:false`（交接 W14）。

## G3 分诊

### 时序差异（不改代码，不加归一化）

- **`memory_write` 多出的 `resources.index_state='indexed'` UPDATE**（主代理第八轮裁决）：B 侧 immediate index 在命令返回前同步执行，无 embedding 时直接标记 indexed；Rust 的 tokio 任务在 A 侧取快照时尚未写入。属调度时序差异，不改代码，不在 harness 加归一化。
- `memory_write` 第 10/11 行 `__change_log` 顺序：`trigger_immediate_index` 与 `spawn_post_write_maintenance` 的调度竞争（第三轮结论，回归钉 683d722）。

### 环境或随机噪声（第六轮分类）

FSRS/SM-2 fuzz（scheduledDays、间隔、next_review_date、dueForecast、averageRetrievability）；随机 id 及内嵌 id 的报错文本；随机组卷；`changed_at` 标签顺序；耗时字段；docx zip 字节；Rust HashMap 键序；insight 两次 `now()` 的纳秒差；"fetch failed" 类传输错误文本；quick_assistant 设置（B 侧无窗口壳）；索引进行中的中间状态。

### 已修复

- `memory.write_smart.fact_llm_decision` B 侧报错：决策角色服务名错误（231d4906）。
- `qbank_get_history` `__change_log` B-only：回填改单条条件 UPDATE（a899df7e）。
- review/memory 4 个场景输入错误（fb0f6b3f）；A 侧待主代理重录：review.study-time.validation-errors、review.essay.builtin-override-save-alias-reset、memory.write_batch.default_study_and_overrides、memory.write_batch.invalid_item_mid_batch。

### 残差：`qbank_commit_authoring_draft` 的 exam_sheets UPDATE 行数（第八轮重新核对，交接 W10）

- 第六轮记为"B 比 Rust 少一行 exam_sheets UPDATE"。第八轮按代码逐条核对后，结论相反：**B 多一行**。本机无 A 侧 trace，方向以下一次 G3 为准。
- Rust（`qbank_authoring_service.rs:532-534`）提交尾部写 2 行 exam_sheets UPDATE：`refresh_canonical_preview_with_conn` 的 preview UPDATE，以及一条 `UPDATE exam_sheets SET metadata_json=json_set(COALESCE(metadata_json,'{}'),'$.question_document_version',2),status='completed',import_state_json=NULL WHERE id=?1`（不改 `updated_at`）。
- B（`qbank/repository/authoring.ts` `markExamCompleted`）把后一条拆成 `exams.upsertExamSheet`（重写 exam_name/status/metadata/preview/updated_at）加 `exams.clearImportState`，共 3 行。题目侧 INSERT、UPDATE 及 `trg_questions_updated_at` 嵌套 UPDATE 两边一致；resources 因哈希不变两边都不写。
- 最终行状态只有 `updated_at` 不同（B 为 clearImportState 时刻，Rust 停在 preview 写入时刻），另外 B 会重新序列化 metadata_json 的其余键。
- 修法：exam_sheets 归 vfs-repos（single-writer），现有 ExamRepo 方法无单条语句可组合。交接 W10：新增 `ExamRepo.markQuestionDocumentCompleted(conn, examId)`，原样执行上述 Rust SQL，并加入 qbank `ExamSheetsPort` 的 Pick；之后 W03 把 `markExamCompleted` 改为调用它，并补 change_log 行序测试。

## Round 9

- memory 来源编号改用 `ctx.get('vfs').buildNumberedSources`（2af7dbbe）：两个执行器经 `deps.numberSources()` 取服务函数，未挂载 vfs 服务时在写任何 ledger 事件之前报错；桌面 profile 接线测试 `memory/tests/vfs-numbering-desktop-wiring.test.ts`。
- memory 去 Node（9d5ae5e4）：`repository/vfs.ts` 的哈希改用 `platform/crypto/sync.ts`，`hpias-research.ts` 的 `Buffer.byteLength` 改用 `utf8ByteLength`，`write-store.ts` 去掉 `node:timers/promises`。mobile-readiness 中 memory 的 own 从 3 降到 0，gateways 从 2 降到 1，`vfs/api.ts` 已不再是网关，只剩 `platform/storage/api.ts` 的 `defineQuery`（交接 W14）。
- qbank 旧 preview 写回（62d3690b）：`encodeToolPreview` 原先用 `structuredClone`，遇到无损 previewJson 的 `JSON.rawJSON` 原子会抛错，旧卡片的 `extra_metadata`/`source_info`/`raw_model_response` 只要含小数，`qbank_submit_answer`/`qbank_reset_progress` 就失败。现改为逐层复制；`ExamCardBBox`（models.rs:300，f32）按 serde 的 f32 文本输出（bbox、resolved_bbox，以及 rebuild_preview/question_to_card 的默认 `0.0`）。
- qbank canonical 预览与旧卡片迁移（cfe4faa8）：`refreshCanonicalPreview` 的 `structuredClone` 在 Rust 写出的 preview 上必然抛错（bbox 至少是 `0.0`），导致 `qbank_legacy_migrate_selected`、reparse resolve 和 authoring commit 失败。改用 `cloneJsonValue`，并按 Value 读取 options/structured_data/images/provenance/descriptor（qbank_helpers.rs:46）。`rawPreview` 与 `readDraft` 改为无损解析，幂等比较按 Value 进行（qbank_authoring_service.rs:99），`validate_structured` 的 numeric 分支按 `as_f64` 语义（qbank_document.rs:326）。
- 任务 2（`markQuestionDocumentCompleted`）：INT fd621db5 尚无该方法，本轮跳过。W10 分支已有 4568d54c（ExamRepo）和 2474ab85（qbank ports Pick）；进入 INT 后，W03 把 `repository/authoring.ts:197` 的 `markExamCompleted` 改为调用它，并补 change_log 行序测试。
- 观察：`question-import-resume.test.ts` 的 Visual-First 并发用例在 qbank 目录级运行中偶发失败 1 次；单跑 4/4 通过，第二次目录级运行 404/404 通过，原因未定位。

## Round 10

- Visual-First 偶发失败定位（b14105ef）：vfs-repos `repository/timestamps.ts:21` 的 `utcNow()` 取 `nowEpochNanos()`，墙钟毫秒不前进时亚毫秒位被钳位，同批题目 `created_at` 并列，`listQuestions` 的 `ORDER BY created_at, id` 退化为按随机 id 排序。冻结 `Date.now` 的确定性用例以 `it.fails` 钉住；本地把 `utcNow()` 改为 `orderedNowEpochNanos()` 后该文件 18/18 通过。修复属 W10 路径，已交接，改后 W03 把用例翻为 `it`。
- 无损数字排查，每处先红后绿：
  - `list_exam_sheet_sessions` 的 metadata（c8aea622）：stats 按 `QuestionBankStats`（models.rs:382）解码，键序按 models.rs:259，f64 用 `f64Atom`，整数拒绝 `3.0` 与越界值。
  - reparse（ed4c3ed1）：`loadCanonicalRows` 按 Value 读取，Rust 写出的 `2.50` 与草稿相同即判 unchanged，`changes.before` 保留原文；resolve 不再重写外来 `import_state_json`。原实现会丢 `1.0`、`0.10` 和大整数，遇到非法 JSON 时整笔回滚。
  - 复制题目集（8c9c7bea）：`copy_authoring_entities` 的 `source_refs_json` 按 Value 重映射；解析失败仍抛 `SyntaxError`，文案改为 serde_json Display。
  - 便携导出与导入（a8f2264a）：images、source_refs、descriptor、provenance、`Question.structured_data` 按 Value 读取，非法 provenance 读作 Null，不再中断导出；导入按 `from_slice::<Value>` 解析 manifest 和 document。
  - numeric 判分与校验（4123d941）：`answer_value`、`tolerance` 按 `Value::as_f64` 读取，原子数字也参与判分；非有限值读作 None，与 arbitrary_precision 下的 `as_f64` 一致。
  - 来源页合并（fbabb40f）：再次从同一来源提交时，旧 descriptor 按 Value 读入后写回，`72.0`、`1.50`、`1e-2` 原样保留。
  - `fromStr`（6e24893f）：改为无损解析。typed 整数字段拒绝 `2.0`，报错文案与 serde_json `JsonUnexpected` 一致；练习试卷 `Question.structured_data` 原样保留。
- 已排查、无需修改：工具参数的 structuredClone（参数为普通值）；`remapEntityReferences` 与 `collectHashes` 只读原子；`question-service` 的 `structurallyEqual` 两侧都来自 vfs-repos 普通值。
- 未改，仅记录：`qbank_list_structure` 的材料 bbox 按 f64 输出 `1` 而 Rust 输出 `1.0`；Rust 在 typed 解析失败时报错，TS 回退 `[]`。数值精度无损失。

## Round 11

- qbank 移动端就绪（`scan.mjs --mobile-readiness`）：own 28 → 12，gateways 仍为 5（都不在 W03 路径）。
  - 310f21f9：`node:path` 改用 `platform/util/path.ts`；小输入的 `createHash` 改用 `crypto/sync.ts`；`randomUUID` 改用 WebCrypto 全局；`Buffer` 的 byteLength、compare、base64 改用 `util/portable.ts` 和 `crypto/encoding.ts`；`perf_hooks` 改用全局 `performance`。同时修掉 legacy-service resolve 的 empty-catch 边界违规（来自 ed4c3ed1）。
  - 07e32304：图片 MIME 探测与 Rust 对齐，先红后绿。`guess_image_mime` 按严格 STANDARD 解码前 24 字符（pipeline.rs:1046），原实现用 Node 宽松解码，会接受空白、URL-safe 字符和缺填充。`qbank_get_source_images` 按原始字节判 RIFF/WEBP 且要求 `len > 12`（commands.rs:8575），原实现用 Node 的 `'ascii'` 解码，会去掉高位，把 `D2 C9 C6 C6` 认成 `RIFF`。
  - 8e8430d2：试卷 DOCX 图片解码与 `docx_handout::decode_image_data` 对齐，先红后绿：去掉 `char::is_whitespace` 字符后严格解码，拒绝非规范尾位和 U+FEFF，接受 U+0085；输出改为 `Uint8Array`（`Packer.toArrayBuffer`）。
- 剩余 12 个 own 文件：
  - `legacy.ts` 的 `hashValue`：`reportVersion` 会哈希整份草稿文档，输入大小由用户数据决定。按 `crypto/sync.ts` 的规则应改用异步 `ctx.crypto`，但 reconcile 在同步事务里，本轮不改。
  - 其余 11 个文件是同步 fs、zlib 和 CSV 流程，按 SYNC-FS-PLAN 需迁到异步 `ctx.files`，并给宿主和测试注入 `files`，属多文件改造。
- 合入 INT fe5feb68（batch 4）后：
  - 297fe38f：`markExamCompleted` 改为调用 `exams.markQuestionDocumentCompleted`（W10 4568d54c/2474ab85），一条 json_set UPDATE，与 qbank_authoring_service.rs:534 一致。change_log 行序测试先红后绿：exam_sheets 只有 preview、completion 两条 UPDATE，metadata 里的 `1.50` 和大整数按原文保留。原实现会多一条 UPDATE。
  - 45ae451c：paper_save 下载加 `allowLoopback: false`（W14 1088849f），解析到回环的域名在首跳和每一跳都被拒绝。真实策略用例传入 `resolveHost`，先红后绿；RF-W03-paper-save-public-destination 的残留项改为已解决。
  - 46718d9d：memory 的 `StorageError` 改从 `storage/errors.ts` 导入。
- 就绪度（INT fe5feb68 合入后）：review 0/0（就绪）；qbank own=12、gateways=3（paths/compat.ts、unified-file-manager.ts、util/node.ts）；memory 0/1，只剩 5 个仓储文件从 `storage/api.ts` 取 `defineQuery`。W14 45b3692a（`storage/query.ts`）尚未进 INT，进 INT 后改为从 query.ts 导入即可到 0/0。
- Visual-First 绊线仍为 `it.fails`：INT 中 vfs-repos `utcNow()` 仍取 `nowEpochNanos()`。

## Round 12

- 合入 INT 390f244b（8a3abf5c）。开工与每次合入后核对：W14 45b3692a 不在 INT，memory `defineQuery` 改道暂缓；INT `utcNow()` 仍为 `toRfc3339()`，Visual-First `it.fails` 不翻。
- 便携包导入（c8d91183、2a570c14）：
  - 读包移出 node:zlib，改用 platform zip core，按 zip 0.6.6 的 `by_index` 顺序报错，加密、本地头、压缩方式、CRC 文案与 Rust 一致；
  - S01-M1：声明大小累计到 200 MiB 上限；
  - RF-W03-portable-zip-actual-size-bound：实际解压字节计入同一预算；
  - 导入改为 async，拆出 `portable-shared.ts`、`portable-zip.ts`、`portable-import.ts`，export.ts 只剩导出侧。
- V05-04 全部 5 项，每项先红后绿：
  - review `get_stats` 两条统计查询去掉 Host 独有前缀，与 `AppError::database(e.to_string())` 一致（499439f5）；
  - qbank 练习 deadline 损坏时透传 chrono `ParseError` 原文（5d040cf3）。新增 `src/chrono-rfc3339.ts`，测试覆盖 chrono 0.4.41 `test_rfc3339` 全部向量，并与 platform/time `parseRfc3339` 做 1000+ 输入的一致性对照；
  - `qbank_delete_group` 非法 mode 由内核契约层按 tauri `InvalidArgs` + serde 原文拒绝，处理器分支不可达，加测试钉住（6f68248d）；
  - 便携包文本见上。
- V03-04（d01f6e32、b0f6cf31）：execute_generation_task 调用顺序测试；RF-W03-qbank-generation-save-failure-terminal-event，保存失败后补发终态事件。
- V03-05 及同类：`quick-assistant://shown`（61bb4ad4）、`hpias_event`（77d5766c）、`essay_grading_stream_*`（89512dbe）改回全局 `emit`，与 Tauri 2 `Window/WebviewWindow::emit` 一致。原测试断言窗口级 target，断言的是偏差，已纠正。
- V09 P2-3（e460cea7、7d1cece0）：qbank 卸载时取消在途生成会话与题目导入。
- W07 交接（2fd258a9）：CSV 的 io::Error 文案改为 `ioMessageFor(e, ctx.app.platform)`；qbank gateways 3 → 1，只剩 `unified-file-manager.ts`。
- SEC-E05 暂缓：W01 2919cc58 已在 INT，但 INT `electron/main.ts:270` 的全局快捷键事件尚未带 `native: true`（W06 2d9ca210 已改，未进 INT）。此时要求 `source.native` 会让真实快捷键失效，待 W06 进 INT 后再改。

## Round 12（续，566c8c49 之后）

- V08-04：
  - review 抛出的 AppError（裸值或 CommandError）文案取 message（99485bff）；
  - qbank `QbankServiceError.message` 改为 AppError 的 Display（f44f8e47）。本地 `instanceof Error ? .message` helper、日志、内核 panic 兜底不再出现 `{"error_type":…}`；`serviceCall` 走 `appError`，不受影响。qbank 外无引用。
- 合入 INT 2be7ed80（9c472533）。合入后：W14 45b3692a 已在 INT，memory `defineQuery` 改从 `storage/query.ts` 导入（4e51f325，就绪度 memory 0/1 → 0/0）；INT `utcNow()` 仍为 `toRfc3339()`，Visual-First `it.fails` 不翻；W06 原生快捷键仍未进 INT，SEC-E05 继续暂缓。
- f64 拼写（7ae5df62、6cc5006a、cd968d4a）：
  - `qbank_list_structure` 的 images/source_refs 按 serde 解码，损坏 JSON 报 `Database` + serde 原文；
  - `SourceRef.bbox` 在 IPC 与工具输出写 `1.0`；
  - 工具输出的 correct_rate、relevance_score、学习趋势、知识点统计、模考成绩单 rate 均按 `json!` 的 f64 拼写；
  - 其余 IPC 命令的 f64 需内核按契约 `x-float: f64` 统一处理，已写交接。
- qbank 移动端 own 12 → 9（7a8f27eb、de380f82、e68b37b6）：
  - 裁图、增强统计、来源图片改走 `ctx.files`；
  - 桌面行为不变；
  - 每项都有桌面与 OPFS 测试。
- INTEGRATION-NOTES:329：六个探针核对 `qbank_create_question` 校验文案，与 Rust/tauri 一致。arbitrary_precision 下 "number" 措辞正确，无需改动。
- W12 #31（4b74fcc5）：
  - 写后维护移植分类刷新（`refresh_all_categories`：种子分类 + 文件夹路径、`__cat_path:<urlencode>__` 系统笔记、`_member:` 成员标签、索引禁用）与日志 → 画像晋升（`run_promotion_throttled`：近 7 天日志、指纹守卫、失败回滚节流）；
  - 隐私模式全部跳过；
  - frequency=off 时进化周期也按 24h 运行，与 Rust 一致；
  - 语义去重（semantic_dedup.rs，800 行）未移植，保留一次性告警；
  - 维护链的终止 catch 在插件停用后不再留下未处理的 rejection。
  - 断言纠正：
    - `post-write.test.ts` 原断言 "promotion pass skipped"，断言的是缺陷；
    - `smart-fact-decision.test.ts` 的调用计数只统计事实决策 prompt：分类摘要与 Rust 一样共用决策角色；
    - `delete-index-purge.test.ts` 提供决策角色，并在切片前等写入的维护跑完。
- S01-1245 #2（aeb26679）：arXiv 属性值按 `from_utf8_lossy` 保持原样，不解码；支持单引号属性；空 href 的 pdf 链接不覆盖已有 URL，与 Rust 一致。
- 拆分：memory `service.ts` 1326 → 1112 行，抽出 `extraction-store.ts`（压缩前 flush 与自动提取）。
- 合入 INT 1d1fdb78（efc2bfa8，无冲突，W03 路径无变化）。INT `utcNow()` 仍为 `toRfc3339()`，Visual-First `it.fails` 不翻；fcbf9bf8 只覆盖浏览器 surface-host，原生快捷键仍无 `native: true`，SEC-E05 继续暂缓。
- 拆分：
  - review `repository/fsrs.ts` 1041 → 847，统计与记忆曲线读取抽到 `fsrs-stats.ts`，serde JSON helper 抽到 `fsrs-json.ts`（5038ebbd）；
  - qbank `qbank-tools-questions.ts` 996 → 755，作答、下一题、重置进度抽到 `qbank-tools-progress.ts`，preview 读写 helper 移入 `qbank-tool-preview.ts`（e786ec45）；
  - 均为原样搬移，无行为变化。
- 边界门禁：4b74fcc5 的 `daily_log::list_recent` SQL 写在 `src/`，触发 `sql-outside-repository`；已移入 `repository/vfs.ts`（9b6a0b7a）。
- 仍超 800 行：memory `service.ts` 1112（门面类，再拆需分组委托，留后续）、qbank `legacy.ts` 905（含 `hashValue`，不动）、review `fsrs.ts` 847。

## Round 13

- 开工合入 INT 065a68f3（ba09d071，E 趟已在：W10 b6693579/5f4df9a8、W02 be279661、W01 6e4d9c7f）。W03 路径里 INT 只改了一行：6800b072 把 `question-import-resume.test.ts:401` 的 `it.fails` 翻成 `it`（INT `utcNow()` 已取 `orderedNowEpochNanos()`），本轮不再重复。W06 546132c3 不在 INT，SEC-E05 继续暂缓。
- W22 交接（e6d2b289）：`review/api.ts` 导出 `mediaFileName`。新增 `review/tests/api-exports.test.ts`，扫描所有插件对 `review/api.ts` 的值导入，逐个断言已发布，并断言与源模块是同一个对象。旧代码上 3 例红。
- AL-07/AL-15（82da8705）：qbank 启动恢复 finalizer 改为 `{ late: 'skip', signal }`，卸载时撤回，去掉 `finalizerNames()` 守卫。V09-P1-3 用例在旧代码上红：卸载后名字仍在。

### 语义去重设计（semantic_dedup.rs → `src/semantic-dedup.ts`）

已有：纯函数层（`buildDedupPrompt`、`parseDedupResponse`、`validateMergeDecision`、`extractTagCount`），Rust 的 6 个单测已对照。本轮补上编排层，Rust 逐函数对照如下：

| Rust | TS | 说明 |
|---|---|---|
| `run_throttled`（:108-159） | `runSemanticDedupThrottled(host, frequency, throttle)` | 间隔取 `semantic_dedup_interval_minutes × 60000`；aggressive 取 `max(间隔/3, 30 分钟)`。节流器 `SemanticDedupThrottle` 每个服务实例一个，和 `EvolutionThrottle`、`PromotionThrottle` 一样（Rust 是进程级 static）。失败回滚计时器，记 `[SemanticDedup] Throttled pass failed (non-fatal): …`；reviewed 或 merged 大于 0 时记 info |
| `run_dedup_pass`（:162-242） | `runSemanticDedupPass` | 先查隐私模式（`get_config()?` 出错时整轮失败），`semantic_merge_max_pairs=0` 时关闭；预算取 `min(max_pairs, 10)`；先取积压，没有积压再抽查；连续 2 次 LLM 失败提前结束 |
| `process_candidate`（:246-430） | `processCandidate` | 返回 `[结果, 是否调过 LLM]`。系统笔记直接 Skipped，不摘标签；归档、空内容（Rust `trim`）、无相似候选、LLM 判 keep、护栏拒绝：摘标签，算 Kept；读取、检索、更新失败，或删除侧失败：Skipped，不摘标签；LLM 失败、超时 60 s、解析失败：LlmFailed |
| `list_review_backlog`（:437-448） | `repository/vfs.ts listDedupReviewBacklog` | SQL 放在 repository（boundaries 门禁），`tags LIKE '%"_needs_dedup_review"%' ORDER BY updated_at ASC LIMIT ?` |
| `sample_recent_facts`（:452-460） | `sampleRecentFacts` | 取 `list(None, limit×3, 0)`，筛 fact 且未归档，取前 limit 条 |
| `remove_review_tag` / `merge_keeper_tags`（:463-547） | 同名函数 | 读 tags 用 `getNoteTagsJson`（同 Rust `.ok()`），写走 L10 `rewriteTagsWithoutTouchingUpdatedAtWithConn`，不推进 updated_at。写入失败按 Rust 文案记 warn |
| `log_merge_audit`（:550-591） | `logMergeAudit` | source 为 `semantic_dedup`，operation 为 `semantic_merge`，event 为 `SEMANTIC_MERGE`，extra_json 为 `{"deletedNoteId","deletedTitle"}` |

依赖的 MemoryService 能力，经 `SemanticDedupHost` 注入：
- `read`：返回带 tags 的 VfsNote 和内容，限于记忆根内，同 Rust `read`；
- `searchForPurpose(content, 5, 'internal_dedup')`；
- `updateById(…, 'semantic_dedup')`、`delete(…, 'semantic_dedup')`：source 类型放宽到 `MemoryOpSource`，行为不变；
- `list`、`getConfig`、`getEvolutionTuning`；
- 审计；
- L02 出口 `memoryDecisionCompletion()`：取不到 provider 时，按 Rust 调用时报错处理，算 LlmFailed。

LLM 超时用 `setTimeout` 加 `AbortController`（Web 标准，可移植，不新增依赖）：到点 abort 传给 provider 的 signal，相当于 Rust drop future。测试只用现有 `createMemoryDecisionDouble` 替身，不发真实请求。

接线：`service.ts` `runPostWriteMaintenance` 在晋升之后、非隐私模式下调用，去掉“未移植”告警。

## 第六轮遗留项（第八轮状态）

- 移动端就绪网关均不在 W03 路径：memory 需 W14 把 `defineQuery` 移到可移植叶子（`StorageError` 已在 `storage/errors.ts`），`vfs/api.ts` 归 W10；qbank 的 `paths/compat.ts`、`unified-file-manager` 归 W07，`util/node.ts` 按设计属桌面，llm/llm-providers `api.ts` 归 W05。
- `qbank_commit_authoring_draft` 残差：已定位根因，见上，交接 W10。
