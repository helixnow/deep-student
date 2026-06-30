# 代理 3（round 2）—— 文档解析与阅读

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-3-status.md`（Unit A–I、F1–F16、X1–X7）。

## 已完成（收尾会话，勿重做）
- A3-X4 `paper_save_executor`（截断 panic，原跨代理 1）已修。
- A3-X5 `multimodal/embedding_service.rs`：死降级链修复（VLEmbedding 不可用时不再回退到永久弃用模式，给出准确报错）。
- C2 `ocr_adapters/system_ocr/windows.rs`：改 `Lines()` 逐行 `\n` 连接 + `Cargo.toml` 加 `Foundation_Collections` feature。
- X1/X2 `llm_manager/exam_engine.rs`：新增 `cancel_probe()`（配置错误早退释放探针不计失败）；`call_ocr_page_with_fallback` 接入熔断器。

## 本轮任务（按优先级）

### P1 — 死代码清理（G1，需与代理 2 确认 vector_store 边界）
- [ ] `multimodal/retriever.rs`（未在 `mod.rs` 声明、全仓无引用）、`PageIndexer`（`page_indexer.rs`，`PageIndexer::new` 无调用方，真实索引在 `vfs/multimodal_service.rs`），连带 `vector_store.rs`/`reranker_service.rs` 的 PageIndexer 专用路径 ~130KB。先与代理 2 在状态文档确认 `vector_store` 由哪边拥有，再删。每删一处 `cargo check`。
  - 顺带 G3：`page_indexer.rs:index_pages` 全 unchanged 时 mm_index_state 卡 indexing（随 G1 一并消除）。

### P2 — 性能（中风险重构，先出方案再做）
- [ ] **B1** `page_rasterizer.rs:render_pdf_pages`：全部页面 JPEG 先驻内存再入库（300DPI 500 页峰值 0.5–1.5GB）。改边渲染边入库需调整两阶段结构；调用方 `question_import_service` 在 `spawn_blocking` 中整体调用，可安全改。出方案 + 影响评估。

### P3 — 低优先级登记项（确认或收口）
- [ ] **C4** `ocr_adapters/paddle.rs`：`supports_grounding()` 对 Paddle 返回 true 但 build_prompt 注释称不原生支持；看 `pdf_ocr_service` 引擎排序后定论（要么改 false，要么文档化"碰运气"行为）。
- [ ] **F4** `llm_structurer.rs:align_by_label`：label 匹配失败回退可能把已匹配 parsed 项重复分配（概率低）。评估是否值得加去重守卫。
- [ ] **I1** DOMPurify 两条观察：`ADD_URI_SAFE_ATTR:['src']` 是否多余；渲染→消毒间极窄未消毒窗口。确认风险可接受或加固。

## 验证
`cargo check`；前端阅读器改动 `npm run typecheck`/`lint`；`cargo test ocr|pdf|document_parser|multimodal`（若可跑）。
> Windows OCR 改动（C2）已加 `Foundation_Collections` feature，本机 `cargo check` 已过；若在非 Windows 机器，该代码在 `cfg(windows)` 下不编译，属正常。
