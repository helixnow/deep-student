# L12 原生接口需求

依据 `lance_vector_store.rs`、`vfs/lance_store.rs`、`vfs/unified_retriever.rs`、`vfs/pdf_processing_service.rs`。
本文件只声明依赖形状与行为要求；本 lane 不自行引入原生 npm 包，测试使用内存/SQLite 替身。

## F7 `vector` / 本 lane `lanceEngine`（分支已实现，待合入 main）

本 lane 已提供业务服务 `lanceEngine`（`src/lance-engine.ts`），把 F7 的 `vector` 适配为
`LanceEngineService`。F7 的真实 provider 位于分支 `ds-mig/F7-native` 的
`host/platform/vector/index.ts`，服务为 `vector.connect(path): Promise<VectorConnection>`；
main 的 `host/platform/vector/api.ts` 仍只有基础成员，因此 L12 暂用字段一致的本地结构
类型 `LanceVectorColumn`。已适配/需要 F7 保证的语义：

- `LanceConnection.tableNames()`：返回目录中实际存在的表名（覆盖 Matryoshka 截断维度
  与遗留 `chat_embeddings`/`kb_chunks_v2_d*` 表）。
- `openTable(name)`：F7 对缺失表抛库错（不是返回 `null`）；L12 先查 `tableNames()`
  再打开，读取/优化路径据此跳过缺失表。
- `createTableWithSchema(name, columns)`：列名/类型/可空性由调用方给出；`vector` 列必须
  同时带 `dimension` 与 `nullable`。L12 传完整 schema：VFS profile 用
  `vfsLanceTableColumns(dim)`（Rust `build_schema`，`lance_store.rs:882-901`），
  遗留 KB 用 `legacyKbTableColumns(dim)`（`lance_vector_store.rs:1295-1311`）。
  **不再探测/调用旧 `createTable(name, dimension)`**；provider 缺少
  `createTableWithSchema` 时明确报错。
- `dropTable(name)`、`hasTableDirectory(name)`：`hasTableDirectory` 必须区分
  “目录存在但表不可打开”与“已彻底删除”，用于 retired profile sweep。
- `LanceTable.countRows()`、`schema()`（字段名 + Arrow 类型）、
  `addColumns([[name, valueSql], ...])`。
- `LanceTable.add(rows)` 采用普通 append（Rust 2026-07 起由
  `merge_insert(&["embedding_id"])` 改为 append，`lance_store.rs:1007-1017`）；
  `delete(filter)` 使用与 Rust 相同的 SQL filter 语法。
- `query({ filter?, columns?, limit? })`：无向量扫描/任意列投影；L12 的
  `scanMetadata()` 使用 `query({ columns: ['metadata'] })`，不要求专用 scan 方法。
- `search(vector, { column, metric, limit, filter?, columns?, bypassVectorIndex?,
  refineFactor? })` 返回原始 `_distance`；
  `fullTextSearch(text, { columns?, filter?, limit })` 返回原始 `_score`。两者都返回
  `VectorRow`，不是 `VfsLanceSearchResult`；`metadata`→`metadata_json` 与 score 业务映射
  由 L12 负责。L12 按 Rust `extract_search_results_hybrid` 顺序回退
  `_relevance_score` → `1 - _distance` → `_score` → `0.0`。
- Int64 列（如 `generation`）在 Node 绑定中是 `bigint`；L12 适配层接受 `number` 或
  `bigint`，内部保持 `bigint` 精确表示，generation 匹配/比较/过滤不经 `Number`，
  也不拒绝合法 i64；只有真正的 IPC 边界才转 `Number`。`chunk_index` 是独立 `i32`
  字段，按 int32 范围校验，不复用 i64 安全整数规则。
- `createIndex(columns, kind)`：`btree` / `bitmap` / `fts-ngram` / `cosine-ivf-pq`；
  FTS 为 Rust 的 ngram2..4（非 prefix）。索引版本/度量不匹配时 optimizer 需能重建。
- `optimizeAll({ olderThanDays?, deleteUnverified? })`：npm 0.22.1 的 `native.d.ts` 只
  暴露 all 动作，**不支持** Rust 的独立 Compact/Prune/Index，该缺口已上报 C2。L12 仅在
  整表 all-actions 使用它（Rust `optimize_table_by_name`：prune 7 天、
  `delete_unverified=false`）；单 `compact/prune/index` 在只有 `optimizeAll` 的 provider
  上明确报错，不把三种动作映射成 all。legacy chat/KB 带 prune 参数的独立优化路径因此
  在 F7 上显式失败并记录 warn，待 C2 原生绑定补齐。
- 连接按数据库路径缓存，可被多个短生命周期 store 复用；删除/写入需容忍并发 optimize。

**待接线**：F1 需生成 `dstu.vector` profile；F7 分支合入 main 后，把 `vector` 从
`optionalService` 移入 `inject`，并把 L12 的本地 `LanceVectorColumn` 替换为
`api.ts` 的正式 `VectorColumn`；同时复核 FTS score、optimizeAll 与 `openTable` 语义。
在合入前不声称 main 已可消费 `vector`。

## F7 `nativePdfium`

- 已由 F7 发布 `host/platform/native/pdfium`（`@embedpdf/pdfium` WASM），可在 Node/utility
  直接使用，不依赖 Electron。`tests/native-pdfium.test.ts` 用真实两页 PDF 锁定
  `extractText` 页间 `\f`、`pageCount` 与页文本。
- 原 PDF 文本提取（保持页序与 PDFium 引擎），逐页渲染与渲染进度回调；不得替换为 pdf.js。
- 渲染输出交给图片压缩 worker；页数/页索引与 Rust `ProcessingProgress` 对齐。
- `npm` 包内嵌 PDFium `chromium/7689`，与 Rust `pdfium_7350` 的渲染字节不作逐字节
  保证；文本调用与 rust `PdfPageText::all()` 对齐。

## F7 图片处理 / F3 FileManager

- F3（`ds-mig/F3-storage`，最小 job 12 例通过；分支 `5bed80423` 已把正式接口写入
  `host/platform/storage/api.ts`）发布 `ImageQualityService`，经 `ctx.imageQuality` 消费：
  - `adjustImageQualityBytes(bytes, visionQuality, codec): Promise<Uint8Array>`；
  - `adjustImageQualityBase64(base64Data, visionQuality, codec): Promise<string>`；
  - `codec` 类型 `ImageQualityCodec = { dimensions; resizeAndEncodeJpeg }`，即
    `ctx.nativeImage`。覆盖 high/low/medium/auto、500 KB no-op、invalid/编码失败保原字节。
  main 尚未合入该接口；L12 不从 `file-manager.ts` 私有跨层 import，也不复制策略。
- F7（`ds-mig/F7-native`）的 `NativeImage` 已发布
  `encode(input: RgbaImage, { format: 'png' | 'jpeg', quality? })`、
  `resizeAndEncodeJpeg(bytes, { maxDimension, quality })`、
  `encodeJpegWithinLimit`、`resizeTriangleJpeg` 等编码能力；main 目前仍只有
  `dimensions`/`decodeRgba`。
- 过渡状态：`pdf-runtime.ts` 仍调用 L12 本地 `image-codec.ts`（`sharp` 线性缩放、
  白底 flatten、手写 PNG/CRC），与 F3 策略/F7 原生编码不是同一语义，**不算等价**。
  待 F3 正式 API + F7 集成后，真实 PDF 链改为
  `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)` 与
  `ctx.nativeImage.encode(rgba, { format: 'png' })`，删除本地平行策略/编码器。
  D5 像素 PSNR 未验项保留（F3 分支注明 F7 的 `resizeAndEncodeJpeg` 仍是 RGBA8+sharp，
  逐字节 JPEG 等价测试 pending）。
- 取消语义：获取 CPU/编解码许可后若已取消，不读取文件；编解码一旦启动必须持有许可直到完成，取消只在读取前与编码后检查（`pdf_processing_service.rs:464-491`）。
- 压缩质量档位与 Rust 的 `low` 映射一致；失败以异常返回，由调用方转为 `Image compression task failed: {error}`。

### 遗留 Lance 接口：按实际调用区分（2026-11-05更正）

F7的schema/query/fullTextSearch等已main，不能继续把全部未迁移方法归为F7阻塞。
独立compact/prune/index缺口仍有效；活跃chat维护/检索需逐方法核对生产调用及提供方。
Rust lib.rs:1652-1654启动时的optimize_chat_tables/optimize_kb_tables仍活跃。

旧KB trait/migration另有明确退役证据：vector_store.rs:1-9说明无外部多态调用；
lance_vector_store.rs:3633-3642的auto_migrate_if_needed标注死入口。故不因原文件属于
L12就恢复该迁移入口。两个旧KB测试已按main可见的C2审批e4680aa8a改为obsolete:dead-in-rust，
测试断言保留、不skip，不删除已发布legacyKb接口。此裁定不能外推
给活跃的VfsLanceStore.clearAll(modality)或聊天维护。

## L13 `vfs/media_index.rs`（未发布，跨 lane 缺口）

`vfs/indexing.rs` 与 `vfs/unified_retriever.rs` 都调用 `vfs/media_index.rs`（该文件的 Rust 测试归属
`host/plugins/vfs`，即 L13）。L13 目前尚未在 `api.ts` 发布等价接口，因此本 lane 不做本地复制：

- 索引：`unit_time_ranges` / `range_for_unit` / `segment_metadata_json` 未接线。若 L11 已创建
  `text_source='transcript'` 的 unit，本 lane 仍会写入 `page_index=unit_index` 的向量并正常检索，
  但 `vfs_index_segments.metadata_json` 为 `null`（缺 `{"startMs","endMs"}`）。
- 检索：`attach_media_time_ranges` 未接线。媒体命中仍返回文本/资源信息，但 `RetrievalIdentity.timeRange`
  保持 `null`，且不会用 `files.id` 回填 `sourceId`。
- unit 创建：本 lane 的 `VfsUnitIndexService` 已按 `media_index.rs::build_windows`
  用 L11 `mediaTranscripts.listSegments` 生成 ~90 秒/800 字时间窗 unit
  （`text_source='transcript'`），再经 L11 `embeddingUnits.syncUnits` 写入；不复制 L13
  的 `refresh_transcript_index`。
- 转写任务调度：L18 通过 `mediaTranscriber` hook 接入 L12 的
  `pdf.startPipeline`/`isRunning`/`cancelMedia`；转写完成后的非空文本由本 lane 调用
  `indexing.indexResource` 刷新时间窗索引。`refresh_transcript_index` 仍属 L13。
- L18 状态（2026-11-04）：责任分支 `fdb013829`/`cadffc2e7` 已发布候选
  `MediaTranscriberCordisService`，`transcribe({fileId,tempDir,imported,signal,
  onProgress}) → {transcriptChars,doneSegments,totalSegments,failedSegments}`，
  `onProgress` 含 `stage/percent` 与可选 `segments`；`index.ts` provide
  `mediaTranscriber` 并注册 `media_transcribe_start`。main 尚未合入，L12 的
  `runMedia` 已按同一签名懒解析，缺失时明确失败；合入后即用真实转写，不复制
  ASR/persist，也不把 C1 的 2 文件 25 passed 当作真实组合验证。

L13 发布检索侧接口后，本 lane 应在 `repository/media-index.ts` 直接调用：
`unitTimeRanges`、`rangeForUnit`、`segmentMetadataJson`、`attachMediaTimeRanges`，
不得保留本地实现。

## L02 LLM / OCR / Embedding

本 lane 以 `EmbeddingRuntime` 作为最小依赖面，待 L02/L11 发布后替换为正式接口：

- `getEmbeddingModelConfig(): Promise<{ id, model }>`：返回当前启用的 embedding 模型配置。
- `callEmbeddingApi(texts, modelId): Promise<number[][]>`：批量调用，顺序与输入一致，失败抛错；本 lane 负责重试/计数校验。
- `modelFingerprintForConfig(config, modality): string`：与 `embedding_dim_repo::model_fingerprint_for_config` 相同的 transport/model 指纹。
- 检索规划另需：模型配置列表（enabled/isEmbedding/isMultimodal/isReranker/isImageGeneration/baseUrl/providerType/providerScope/apiProtocol/modelAdapter）、共享 OCR 并发槽（Rust `MAX_OCR_CONCURRENCY=4`）、OCR 引擎推断（`OcrAdapterFactory::infer_engine_from_model`）、多模态观察调用、rerank 调用。
- `MultimodalInput` 在 L02 发布前由本 lane 本地定义同形接口；正式接口发布后应直接复用。
- 已接线（main）：`llm`（`getApiConfigs`/`getModelAssignments`/`getModel2Config`/
  `decryptApiKey`）、`llmEmbeddingModels`（文本/VL 模型配置与指纹来源）、
  `llmOcrModels` + `llmOcrHedge`（自由文本 OCR 候选与 hedge 竞速）、
  `llmStreaming`（图片观察）。缺失时文本/多模态索引明确失败，FTS/词法检索仍可用。
- 仍待 main 发布：`embedding@1` 的 `callEmbeddingApi`/`callMultimodalEmbeddingApi`
  传输与 `llmRerank` 提供方。缺失时向量/多模态路径显式失败，rerank 保留 RRF 顺序；
  不沿用旧 L05 `obsolete21` 的“全局阻塞”说法，也不把分支候选当 main 可消费。
- L11 `vfsRepo` 已随 `7b7136676` 合入 main，`questions.getQuestion/listQuestions` 等
  owner 已绑定用于 `indexQuestion` / `indexExamQuestions`；缺失时明确报
  `L11 vfsRepo questions service is not available`。

## L11/L13 仓储与资源读取

- embedding dimension/profile/unit/segment 生命周期仓储（profile 状态、generation、ledger 校验、ANN 状态、retired sweep）。L11 已发布 `vfsRepo`，包含 `embeddingDims`、`embeddingUnits`、`embeddingSegments`、`indexStates`、`indexingConfig`、`questions` 等；生产路径已绑定并使用这些 owner。仍缺本 lane 退役表清理所需的
  `retiredProfileTableCandidates`/`tableHasOnlyUnreferencedRetiredProfiles`/`optimizeTableNames`
  查询。PDF/媒体 owner setters 已在 `ds-mig/L11-vfs-repos` 分支发布
  （`updatePdfExtractedText`、`updatePdfPreview`、`updatePdfPreviewOnly`、
  `updatePdfOcrPages`、`updateCompressedBlobHash`、`cancelProcessing`、
  `markProcessingRecovered`、`setProcessingError`、`updateProcessingProgress`、
  `applyProcessingStatus`、`files/exams.applyMultimodalIndexState`、
  `resources.saveOcrTextForFile`），但 main 尚未合入；L12 已改为 **owner 必需**：
  缺少 setter 时明确报“待 L11 合入”，不再保留本地 SQL fallback。仍缺的精确方法只有
  `resources.saveOcrTextIfEmptyWithConn`（Rust `indexing.rs:1082`/`3485`，条件写且
  不改 `updated_at`；缺失时 L12 跳过 best-effort 缓存）、
  `setExtractedTextByResource` 与 `canonicalContext`（见 `SPEC.md` 的仅剩缺口表）。
  R12-03 不关闭。
- `VfsIndexService::syncResourceUnits` 的 unit builder：本 lane 已在 `src/unit-builders.ts`
  按 `unit_builder.rs` 完整实现并发布 `vfsUnitBuilder`，表写入走 L11 `vfsRepo.embeddingUnits`；
  背景索引器通过 `syncResourceUnitsForResource` 接线。`media_index.rs` 的时间窗逻辑在本 lane
  仅实现 unit 创建部分（`unit-time-ranges` 检索附加信息仍待 L13 发布）。
- blob/资源/文件读取：`resources`（type/source_id/metadata_json/deleted_at/index_state）、`folder_items` canonical membership、`blobs.relative_path`、`notes/files/exam_sheets/translations/mindmaps/essays` 标题查询。
- `VfsDatabase.blobsDir()` 等价的绝对路径（本 lane 用 `storage.locations.activeDir + '/vfs_blobs'` 对齐 `host/plugins/vfs`）。
- OCR 页面解析、unit builders、PDF 处理流水线事件发送。跨 lane 只 import 对方 `api.ts` 或 `contracts/`，经 Cordis inject。
