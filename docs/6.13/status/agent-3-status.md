# 代理 3 状态文档（round 2）—— 文档解析与阅读

> 第一轮上下文见 `docs/6.12/status/agent-3-status.md`（Unit A–I、F1–F16、X1–X7、收尾会话 A3-X4/X5/C2/X1/X2 已落地）。
> 本轮严格按 `docs/6.13/agent-3.md` 优先级推进：P1 G1 死代码、P2 B1 性能、P3 C4/F4/I1。
> feed_id = **F-R5FDK**（接力会话请勿重新注册，直接 feed-poll / interactive_feedback）。

## 当前状态

**用户已对 D1–D5 拍板「全都干」，落地完成，验证中**（2026-06-13）：
- D4/F4：`llm_structurer.rs:align_by_label` 加 `used` 去重守卫 —— 已改。
- D3/C4：删除死方法 `OcrEngineType::supports_grounding()`；`factory.rs` 两个 Paddle 引擎 `supports_grounding` 改 false + 去掉 V1「支持坐标输出」描述 —— 已改。
- D2/B1：`page_rasterizer.rs` 合并 `render_pdf_pages`+`store_rendered_pages` 为 `render_and_store_pdf_pages`（逐页渲染→入库→丢字节），删除 `RenderedPage` 中转结构 —— 已改。
- D1/G1：删除 `multimodal/retriever.rs`(593) + `reranker_service.rs`(233) + `vector_store.rs`(813)；`page_indexer.rs` 瘦身为仅 `AttachmentPreview` 系列结构 + 反序列化测试（1543→约 86 行）；`mod.rs` 去掉两个 `pub mod` 与 `PageIndexer` 再导出 —— 已改。
- D5/I1：维持现状（风险可接受），无代码改动。

验证：使用隔离目标目录 `src-tauri/target-agent3` 跑 `cargo check`（避开与其他代理共享默认 target 的锁竞争）。前端无改动（C4 仅数据驱动徽章，无 .ts 改动），故无需 typecheck/lint。
**✅ 验证通过**：`cargo check` exit 0；本组改动文件（llm_structurer / page_rasterizer / ocr_adapters / multimodal）零 error 零 warning；总警告 94（≤ README 基线 100，实为下降——删死代码 + 清掉 page_rasterizer 的 `warn` 未用导入各减若干）。
> 首跑（target-agent3 冷构建）exit 101，17 个 error 全在 `src/debug_commands.rs`（缺 `DebugRawMistakeRecord` 类型，系其他代理并发改动的瞬时破损，与本组无关）；其后该代理已自行修复，增量重跑 exit 0。最后更新：2026-06-13。

## 本轮任务调研结论

### P1 — G1 死代码清理（multimodal/，~3100 行）

**引用核查结论（全仓 grep + mod.rs 声明核对，确认为死代码）：**

| 文件/符号 | 行数 | 状态 | 证据 |
|-----------|------|------|------|
| `multimodal/retriever.rs`（`MultimodalRetriever`） | 593 | **死**（未编译） | `mod.rs` 无 `pub mod retriever;`，全仓零引用（仅 `vfs/indexing.rs:4688` 一句过时注释提及） |
| `multimodal/reranker_service.rs`（`MultimodalRerankerService`/`RerankableItem`/`SimpleRerankItem`） | 233 | **死** | 仅被 `retriever.rs`（死）+ 自身测试引用 |
| `multimodal/vector_store.rs`（`MultimodalVectorStore`/`MultimodalPageRecord`/`SearchResult`） | 813 | **死** | 仅被 `retriever.rs`（死）+ `page_indexer.rs` 的 `PageIndexer`（死）+ 自身测试引用 |
| `multimodal/page_indexer.rs::PageIndexer`（struct+impl+`PageToIndex`+`DOCUMENT_INSTRUCTION`） | ~1490/1543 | **死** | `PageIndexer::new`/`with_progress` 全仓无调用方；真实索引在 `vfs/multimodal_service.rs`。G3（全 unchanged 卡 indexing）随此消除 |

**必须保留（非死代码）：**
- `page_indexer.rs` 中 `AttachmentPreview` / `AttachmentPreviewPage` / `TextbookPreview`(=别名)：被 `vfs/multimodal_service.rs:24,586` 使用（反序列化 preview_json）。**只删 PageIndexer，保留这些结构体**，文件缩到约 50 行。
- `multimodal/types.rs` 的 `VLRerankerResult` / `VLEmbeddingInputItem`：被 `llm_manager/rag_extension.rs:330` 使用 → `types.rs` 整体保留。
- `embedding_service.rs` / `embedding_chunker.rs` / `types.rs`：VFS 依赖，保留。

**与代理 2（向量层）边界澄清**：本仓有**两个** `vector_store`——
- 顶层 `src/vector_store.rs`（`VectorStore` trait）+ `lance_vector_store.rs` + `vfs/lance_store.rs`：**代理 2 的向量层，全仓在用，不动**。
- `multimodal/vector_store.rs`（`MultimodalVectorStore`）：本组域内，仅服务于已死的 retriever/PageIndexer。
- `mod.rs:27` 注释「vector_store // llm_manager 依赖」**有误**：llm_manager 只依赖 `types::VLRerankerResult`，不依赖 `MultimodalVectorStore`。
- 结论：删除 `multimodal/vector_store.rs` **不影响代理 2**。仍按 agent-3.md 要求在本文档登记，请代理 2 复核无异议。

**待用户确认**：体量大（3 文件整删 + 1 文件大幅瘦身 + mod.rs 改声明），属破坏性删除，按 README 3.3 登记等确认。确认后分步删除，每步 `cargo check`。

### P2 — B1 page_rasterizer.rs:render_pdf_pages（性能，中风险重构）

**现状**：`render_pdf_pages`（page_rasterizer.rs:82）先把**全部页**的 JPEG 字节 push 进 `Vec<RenderedPage>`（104/141），再由 `store_rendered_pages`（154）逐页入 Blob。300DPI 500 页峰值 0.5–1.5GB；文件头注释「渲染后立即释放，只保留页面图片」与实际不符。

**安全性确认**：调用方 `question_import_service.rs:987 stage1_rasterize` 在 `tokio::task::spawn_blocking` 中整体调用 `rasterize_pdf`；`VfsBlobRepo::store_blob` 是同步（rusqlite）。**两阶段拆分只是内部结构，并非 async/sync 边界**——可安全改为「边渲染边入库」，每页渲染后立即 store_blob 并丢弃 JPEG 字节，峰值降到单页级。

**方案（先出方案，待确认）**：
- 方案 A（推荐）：新增 `render_and_store_page(page, config, vfs_db) -> PageSlice`，`rasterize_pdf` / `rasterize_docx` 改为循环内「渲染→入库→丢字节」，删除 `Vec<RenderedPage>` 中转。`render_pdf_pages` 不再纯 CPU（会触 DB），但因已在 spawn_blocking 内，安全；更新文件头注释。
- 影响：内部结构调整，对外签名 `rasterize_pdf/docx -> RasterizerResult` 不变；2 处 `store_rendered_pages` 调用点（pdf:78 / docx:300）一并改。属中风险，需 `cargo check` + 评审。

### P3 — 登记/收口项

**C4 — paddle.rs grounding 不一致**：
- `OcrEngineType::supports_grounding()`（types.rs:70，Paddle 返回 true）**全仓无方法调用方**（`.supports_grounding()` 零命中）→ 该方法本身是死代码。
- 能力实际通过 `factory.rs:engine_info_list()` 的硬编码 `OcrEngineInfo.supports_grounding=true`（Paddle，75/85）暴露给前端（`cmd/ocr.rs` → `supportsGrounding`），与 `paddle.rs:build_prompt` 注释「PaddleOCR-VL 不原生支持 grounding」矛盾。
- 引擎选择不依赖此标志（Structured 排序走 `is_dedicated_ocr`/`is_import_preferred`），故仅为「UI 展示诚实性」问题。
- **待用户取舍**：①把 Paddle 的 `OcrEngineInfo.supports_grounding` 改 false（更诚实，但 Paddle 确能碰运气出部分结构化）；②保留 true 但改描述/注释为「非原生、尽力而为」；并顺手删除死方法 `OcrEngineType::supports_grounding()`。

**F4 — llm_structurer.rs:align_by_label 回退重复分配**：
- 位置回退（215–221）按 `parsed[i]→result[i]` 填空，但 `parsed[i]` 可能已被 label 匹配分配给 `result[j]`（j≠i），导致该 parsed 项重复进两题、真正未匹配项被丢。低概率（仅 label 错位且数量恰好相等时）。
- **建议（待确认是否值得做）**：加 `used: Vec<bool>` 标记 label 已消费的 parsed 项，位置回退只用未消费项依序填未匹配槽。改动小、自包含、低风险。倾向于修。

**I1 — DOMPurify 两条观察（sanitizeRenderedDom.ts）**：
- ① `ADD_URI_SAFE_ATTR:['src']` 跳过 src 协议校验：所列允许标签（img/source/svg）的 src 即便 javascript: 也不执行；实测用途是放行 blob:/data:image 预览图。风险可接受，删除收益小且可能误伤 blob: 图。
- ② 渲染→消毒极窄未消毒窗口：docx/pptx-preview 走 DOM API 构建、不从内容造 script，innerHTML 注入的 script 也不自动执行。风险可接受。
- **结论建议**：确认风险可接受、维持现状（可选加固=改为消毒后再 set innerHTML 的源头消毒，但改造面大、收益低，不建议）。

## 待用户决策项（汇总）

| # | 项 | 类型 | 用户决策（2026-06-13「全都干」）→ 落地 |
|---|----|------|------|
| D1 | G1 删除死代码（retriever/reranker_service/vector_store 整删 + page_indexer 瘦身 + mod.rs） | 破坏性删除 | ✅ 已落地（R2-5/6/7） |
| D2 | B1 改边渲染边入库（方案 A） | 中风险重构 | ✅ 已落地（R2-4） |
| D3 | C4 Paddle supports_grounding | 产品取舍 | ✅ 取「改 false + 删死方法 + 改描述」（R2-2/3）；徽章 `coordinate_positioning` 系硬性能力声明，故选 false 而非保留 true |
| D4 | F4 align_by_label 加去重守卫 | 低风险修复 | ✅ 已落地（R2-1） |
| D5 | I1 维持现状 | 风险确认 | ✅ 维持，无改动 |

## 第二轮扩大审阅（用户「继续深入扩大审阅」，2026-06-13）

已逐文件深审本组核心「文档→图像→OCR→结构化」链，**结论：整体高度健壮，round1 + 收尾会话的修复均在位**，未发现新的 P0/P1 运行时破损。逐文件结论：

| 文件 | 复审结论 |
|------|----------|
| `llm_structurer.rs` | parse_llm_response 取首 `[`～末 `]`（ASCII 边界安全），解析失败优雅降级；align_by_label 已加去重守卫（R2-1）。✅ |
| `pdf_ocr_service.rs` | run_backend_worker 成熟（取消/暂停/退避重试/熔断/poison 恢复/JoinSet abort）；渲染线程逐页落盘（内存安全）。发现 2 个死方法（见 N1）。✅ |
| `document_parser.rs` | is_zip_magic_bytes 有 `len<4` 守卫；PDF 加密检测 min/saturating_sub/`>8192` 守卫齐全；EPUB/DOCX 的 `[1..]`/`[..=i]` 均由 starts_with/rfind(ASCII) 守卫；zip-bomb 检测先 4 字节魔数预筛。`with_capacity(entry.size())` 已被前置 `MAX_SINGLE_ENTRY_SIZE`(500MB) 限幅（见 N2，低）。✅ |
| `deepseek_ocr_parser.rs` | grounding 线性扫描 + safe_slice（UTF-8 安全），bbox 解析/越界/反转处理稳健，测试充分。✅ |
| `cross_page_merger.rs` | F2 相邻页守卫：页按序遍历，`page_idx - last_page` 不下溢。✅ |
| `figure_extractor.rs` | F1 entry-API 缓存 + 只读图头取尺寸；页面索引越界、裁切失败均跳过计数。✅ |
| `vlm_grounding_service.rs` | `[f64;4]` 定长数组（索引不 panic）；crop clamp/NaN(`as u32`饱和)/下溢守卫齐全（F5）；truncate_utf8 边界安全（F3）；`Value["x"][0]` 索引对 serde_json 返回 Null 不 panic；JSON 解析多级回退。✅ |
| `TextbookPdfViewer.tsx` | 发现工具栏移除后遗留的未用 handler（死代码，见 N3）；blob URL 生命周期写在 useMemo 里（见 N4，Tauri 生产环境无 StrictMode 双调用，按现状可接受）。 |

### 扩大审阅发现（待用户定夺）

| # | 文件/位置 | 类型 | 描述 | 倾向 |
|---|-----------|------|------|------|
| N1 | `pdf_ocr_service.rs:856,897` | 死代码 | `init_pdfium`/`render_page_to_image` 带 `#[allow(dead_code)]`「保留供未来使用」，全仓无调用方（真实逻辑已内联进 spawn_blocking）。约 65 行 | ✅ 已删（R2-9）+ 清孤立 Manager 导入 |
| N5 | `src/components/DocumentViewer.tsx` | 死代码 | **扩大审阅新发现**：整个 292 行组件全仓零 importer（聊天预览用的是另一个 `InlineDocumentViewer`）；round1 标"通过"但未察觉其未被引用。内含 `<iframe src={url}>` 无 sandbox 的潜在隐患（url 可为外链/data:），随删除一并消除 | ✅ 已删（R2-10），typecheck 0 error |
| N2 | `document_parser.rs:388,837` | 健壮性 | `Vec::with_capacity(entry.size()/file.size())` 信任 ZIP 中央目录声明大小；388 已被 500MB 单条目上限前置限幅，837(DOCX 取图) 同受 zip-bomb 检查前置约束 | 低，可加 `.min(cap)` 双保险，或维持 |
| N3 | `TextbookPdfViewer.tsx` | 死代码 | `previousPage/nextPage/handleZoomIn/handleZoomOut/isPageSelected/handleClearSelection/onDocumentLoadSuccess/onDocumentLoadError` 约 8 处未用（工具栏已下放到 EnhancedPdfViewer）。**纠缠**：删 zoom→setScale 未用、删 loadSuccess/Error→error/isLoading/scale state + tracker 字段 + error JSX 全部连带，属整体级联重构 | 暂缓（纠缠大、零报错，待确认后整体清）|
| N4 | `TextbookPdfViewer.tsx:83-108` / `PdfReader.tsx:50-66` | 代码味道 | blob URL create/revoke 写在 useMemo 中（应属 useEffect）；卸载/换文件已各自清理，Tauri 生产无双调用，无实活 bug | 维持（登记）|
| N6 | `ocr_adapters/mod.rs:171,191` | 一致性(轻) | `Glm4vOcrAdapter::build_prompt(Grounding)` 要 bbox_2d 坐标，但 `parse_response` 把整段响应当单一 region(无 bbox) — 仅当该 adapter 的 Grounding 模式被直接调用才有影响；当前结构化/grounding 走 vlm_grounding_service，故不触发 | 维持（登记备查）|

### 扩大审阅批次2（已审）
- `ocr_adapters/mod.rs`（Glm4v/GenericVlm adapter）：纯文本透传，supports_mode 一致；GLM4V grounding prompt/parse 轻度不一致（N6，不触发）。✅
- `ocr_adapters/system_ocr/macos.rs`：Vision OCR 逐 observation 以 `\n` 连接（**无 C2 同型 bug**），objc 自动释放池/空指针守卫齐全。✅
- `multimodal/embedding_chunker.rs`：CJK 标点判定 + 前缀匹配 token 限制 + 安全裕量，UTF-8 安全。✅
- `pdf_protocol.rs`：A1 Range 限幅（`end.min(start+CAP-1)`）、A2 CORS 精确匹配、路径 canonicalize + 扩展名/存在校验齐全。✅
- `DocumentViewer.tsx`：死组件，已删（N5）。

### 尚未深审（可继续）
`pdfium_utils.rs`、`ocr_circuit_breaker.rs` 复审、`multimodal/embedding_service` 复核(G2 后)、前端 `ImageViewer.tsx`/`ImageCropDialog.tsx`/`ExamPageImage.tsx`/`CroppedExamCardImage.tsx` 复核、`usePdfLoader`/`usePdfProcessingProgress` hooks、`EnhancedPdfViewer.tsx` 深审。

## 跨组问题（本轮新增）

| # | 涉及文件 | 问题 | 建议归属 |
|---|----------|------|----------|
| R2-X1 | `vfs/indexing.rs:4688` | 注释「如需多模态检索，请使用 MultimodalRetriever」指向已删除的死模块（G1 已删 retriever.rs），应同步删该过时注释 | 代理 2（vfs） |
| R2-X2 | `src/debug_commands.rs` | 本组 cargo check 首跑 exit 101，17 个 error 全在此文件（缺 `DebugRawMistakeRecord` 类型 + 连带 E0282 推断失败），系并发改动瞬时破损；重跑已 exit 0（当事代理已自修）。仅登记备查，非本组问题 | 错题/调试命令相关代理（agent 4 或当事代理） |

## 已实施的优化（round 2）

| # | 改动文件 | 说明 | 验证 |
|---|----------|------|------|
| R2-1 (F4) | `llm_structurer.rs` | align_by_label 加 `used: Vec<bool>` 标记 label 已消费 parsed 项；位置回退改为「依序取未消费项填未匹配槽」，杜绝重复分配/丢项 | ✅ cargo check exit 0 |
| R2-2 (C4) | `ocr_adapters/types.rs` | 删除死方法 `OcrEngineType::supports_grounding()`（全仓 `.supports_grounding()` 零调用） | ✅ cargo check exit 0 |
| R2-3 (C4) | `ocr_adapters/factory.rs` | PaddleOcrVl/PaddleOcrVlV1 的 `OcrEngineInfo.supports_grounding` true→false（与 paddle.rs build_prompt「不原生支持 grounding」一致）；去掉 V1 描述里「支持坐标输出」；徽章不再误称坐标定位 | ✅ cargo check exit 0 |
| R2-4 (B1) | `page_rasterizer.rs` | `render_pdf_pages`+`store_rendered_pages` 合并为 `render_and_store_pdf_pages`：逐页渲染→立即写 Blob→丢 JPEG 字节，峰值内存从「全部页」降到单页；删 `RenderedPage` 中转结构；pdf/docx 两调用点统一；更新文件头注释 | ✅ cargo check exit 0 |
| R2-5 (G1) | `multimodal/{retriever.rs, reranker_service.rs, vector_store.rs}` | 整文件删除（共 1639 行死代码：retriever 未编译、reranker_service/vector_store 仅服务于死的 retriever+PageIndexer） | ✅ cargo check exit 0 |
| R2-6 (G1) | `multimodal/page_indexer.rs` | 删除死的 `PageIndexer`（struct+impl+PageToIndex+DOCUMENT_INSTRUCTION）及其全部 use；仅保留 VFS 依赖的 `AttachmentPreview`/`AttachmentPreviewPage`/`TextbookPreview` + camelCase 反序列化测试（1543→约 86 行） | ✅ cargo check exit 0 |
| R2-7 (G1) | `multimodal/mod.rs` | 移除 `pub mod reranker_service;`/`pub mod vector_store;` 与 `PageIndexer` 再导出；更新清理说明注释 | ✅ cargo check exit 0 |
| R2-8 (顺手) | `page_rasterizer.rs` | 删除未使用导入 `warn`（pre-existing 基线警告，本组域内文件，顺手清掉，减一条警告） | ✅ cargo check exit 0 |
| R2-9 (N1) | `pdf_ocr_service.rs` | 删除死方法 `init_pdfium`/`render_page_to_image`（#[allow(dead_code)]「保留供未来使用」，全仓无调用方，逻辑已内联进 spawn_blocking）+ 同步移除孤立的 `Manager` 导入 | ✅ cargo check exit 0（警告 94→92） |
| R2-10 (N5) | `src/components/DocumentViewer.tsx`（删整文件 292 行） | 扩大审阅发现：全仓零 importer（聊天用的是另一个 InlineDocumentViewer），为死组件；内含 iframe 无 sandbox 的潜在隐患随删除一并消除 | ✅ npm run typecheck exit 0、0 error |
