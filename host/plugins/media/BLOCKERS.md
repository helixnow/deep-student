# L18 v2 跨 lane 阻塞（2026-11-04）

本文件只列外部缺口；自有实现/测试不足列 LANE v2 盘点，不冒充阻塞。
已合 main 的 F1 raw/x-binary 支持不再列缺口；F7 PDFium/Audio 已有，不再报“无 PDFium”。

| ID | owner / 所需面 | Rust 与当前证据 | 影响 |
|---|---|---|---|
| L18-B01 | L11 `files.setMediaExtractedTextWithConn(conn,id,text:string|null)`、`files.relinkOriginalPathWithConn(conn,id,path,updatedAt)` | `media/pipeline.rs::write_transcript_text` 只更新 extracted_text；`src/cmd/textbooks.rs:745-752` 只更新 original_path/updated_at。当前 `vfs-repos/types/files.ts:24-82` 无等价面；`updatePdfExtractedText` 额外改 page_count/updated_at，不可替代。L18 `repository/media-commands.ts:42` 与 `textbook-files.ts:24` 当前越权，需 owner 接缝迁出 | import/ASR/Bili/relink。不能暴露任意 SQL，不拆原事务 |
| L18-B02 | L02 raw prompt/VLM/OCR 调用 | `llm/api.ts:207` 仅 LLMManager 配置；`LlmOcrHedge:99-104` 返回字符串，不含卡片。main 新增 `llmOcrModels.getOcrConfigsByPriority`（`llm/api.ts:70`）与 `llmOcrRegions.parse`（:91-95，内容→卡片），但页级远程调用（Rust `exam_engine.rs:733` `call_deepseek_ocr_page_raw`，4xx/5xx 状态 details）与全局 `OCR_CIRCUIT_BREAKER`（`llm/src/ocr_circuit_breaker.ts` 未经 api 导出）仍缺，L18 不应复制熔断状态。需 `callModel2RawPrompt(prompt,forceJson,callerType,task)`、`callRawPromptWithConfigIdAndImages(configId,prompt,images,callerType)`、VLM 配置选择、`testOcrWithEngine`、`callOcrPageWithFallback(...)->ExamSegmentationCard[]`（见 native-needs） | handout 两命令、test_ocr_engine、PDF OCR 四命令。自有会话编排仍归 L18 |
| L18-B03 | 协调者依赖 `jpeg-js@0.4.4`/`pngjs@7.0.0` 安装与批准；D5 PSNR | F7 `fe9ae8b83` 已在 main：`cropRgba`/`resizeRgba`/`resizeDimensions`/`encode` 公开（`native/image/api.ts`），exam-sheet 裁剪已切换（`883fdf40a`）。但 `encode-worker.mjs:10` 需要 `jpeg-js`/`pngjs`，root 无此包（`native/NEEDS.md:127,222`）→ 生产 PNG/JPEG 编码报 MODULE_NOT_FOUND | `compress_image`（实现在 `8a3f71537`，已撤出）；exam-sheet 裁剪生产写 PNG 同样失败（测试注入 `tests/helpers/png.ts`）；4 个图片 pending |
| L18-B04 | F7 binary Office extraction/writer/editor | main `native/index.ts:18,35` 仅提供 nativeOfficeText；office/api 声明的 NativeOffice 未 provide；writer 在 F7 候选，DOCX/PPTX edit 不能用 generate 冒充 | parse 两命令、notes_export_docx、textbooks_add Office；8 个 Office pending |
| L18-B05 | L22 StreamContext 持久化/图片 pin 与 F3 FileManager 公共接口 | `integration/api.ts:36-47` 仅 TempSessionIdentity；Rust `src/commands.rs:356-404` 需 temp session image paths + pin/unpin；FileManager owner 声明为 F3 (`integration/api.ts:17`) | pin_images/unpin_images；教材文件管理。需核已有 noteAssets 可覆盖部分，不能泛称全缺 |
| L18-B06 | L13 transcript index 候选集成 | 第二次 merge `1e4900abb` 已带入 L12 media runtime（`src/pdf-runtime.ts`），不再列 L12 hook 缺失。main `vfs/api.ts` 尚无 mediaIndex/unitIndex；L13 分支 `ds-mig/L13-vfs-api`（`0d7a484e5`）`vfs/api.ts:69,127` 已发布，L13 `tests/media-index.test.ts` 经本 lane `ctx.mediaTranscriber.transcribe(imported=true)` 验证（L13 作业 `20261104112543-8ed64e` 10 passed）。剩余为 C2 窄 provide 集成，不是 API 未发布 | 时间窗索引在 main 上仍不可达；20 段 ASR 后刷新时机由本 lane `pipeline.ts` 负责，L13 用例不覆盖 |
| L18-B07 | F7 系统 OCR 原生绑定（L01 `setSystemOcrBinding`，macOS Vision / Windows OCR） | Rust `src/cmd/ocr.rs:681-697` 在 system_ocr 时调 `perform_system_ocr`。L18 已改用 L01 导出的 `performSystemOcr`（`llm-providers/api.ts:91`），但 main 上没有任何 F7 模块注册 `SystemOcrNativeBinding`，所以支持平台上也报 `不支持的功能: System OCR native binding is not registered`（经 `OcrError.toAppError`），`test_ocr_engine` 返回 `success:false`，不冒充成功 | `test_ocr_engine` 的 system_ocr 分支；L02 `callOcrPageWithFallback` 的系统 OCR 整页兜底同样依赖 |

请求协调者：将 B01 两个窄 owner 方法交 L11；确认 B02/B03/B04/B06 候选集成时间；为
`test_pdfium_status` 的 WASM 诊断字段差异指定裁定/复核。`ACCEPTANCE.md` 缺失，待 R1 补审。

全仓 strict 作业 `20261104105954-f3904f` exit 1：4 项在 L13
`repository/{create.ts:41,folders.ts:22,resources.ts:126,update.ts:33}`；本 lane 没有违规。

## 2026-11-04 22:55 CST 复核（主线负责 6 条：pin_images/unpin_images/textbooks_add/compress_image/parse_document_from_base64/parse_document_from_path）

在 main `306eb8bbb` 上逐条复核，6 条仍无法按 Rust 语义完整实现，均未注册（不注册空壳/子集）。

| 命令 | 精确缺口（owner） | 复核证据 |
|---|---|---|
| `compress_image` | F7：`nativeImage.encode` 的 worker 依赖 `jpeg-js`/`pngjs`，root 未安装、未获批；D5 已批准 `sharp`。需 F7 把 encode 切到已批准依赖，或由协调者批准并安装两个包 | `node -e "require.resolve('jpeg-js')"`、`require.resolve('pngjs')` 在主仓库均为 MODULE_NOT_FOUND；`host/platform/native/image/encode-worker.mjs:8-10`。Rust `crates/dstu-media/src/cmd/media.rs:54-149` 需 decode→Triangle resize→JPEG(q clamp 10..95) |
| `parse_document_from_path` / `parse_document_from_base64` | F7：`NativeOffice.extractText(fileName,bytes)` 已在 `office/api.ts:3-6` 声明但 `native/index.ts:42-58` 未 provide `nativeOffice`。缺 docx-rs、calamine（xlsx/xls/xlsb/ods）、pptx-to-md、rtf、html2text(from_read 80 列) 等价抽取 | Rust `dstu-docs/src/document_parser.rs:859-905` 分派 13 种格式；本 lane `src/document-parser.ts` 已完成 txt/md/epub/代码类/加密/ZIP Bomb/Base64，PDF 可走 `nativePdfium`，其余格式缺引擎 |
| `textbooks_add` | 依赖上行 parse 引擎（`textbooks.rs` 非 PDF 分支调用 `extract_paged_text_from_bytes`/`extract_text_from_bytes`）；F3 需公开 `resolve_file_info`/`is_opaque_document_id`/`get_file_size`/`hash_file_sha256`/`read_all_bytes_bounded`（URI/SAF 三层解析） | `host/platform/storage/unified-file-manager.ts` 仅导出 extractFileName/classifyPath 等，无 resolveFileInfo/isOpaqueDocumentId/getFileSize；Rust `src/cmd/textbooks.rs:114-700` |
| `pin_images` / `unpin_images` | L22：需 `modify_temp_session` 等价面：内存未命中时 `get_temp_session_record(temp_id)`（缺失→NotFound「临时会话不存在」）、修改 `pinned_images`、`persist_temp_session_to_db`；`withTempSessions` 只有内存 Map，无 DB 读/写 | `host/plugins/integration/api.ts:37-48`；Rust `src/commands.rs:248-285,356-395`。设置表 `pinned_images:<tempId>` 写入本 lane 可用 `ctx.settings` 完成，但会话持久化必须由 temp_sessions owner 提供 |

已发送协调消息：F7-native（encode 依赖、nativeOffice provide）、L22-app-commands（temp session 读写面）、F3-storage（文件信息解析面）。

## 2026-11-05 04:10 CST 复核（主线）
- 已解除：L18-B03（compress_image，pngjs/jpeg-js 已在 main）、L18-B05 的 pin/unpin 部分（L22 `modifyTempSession` 已在 main）、L18-B04（F7 nativeOffice 8 种 WASI 引擎已在 main，parse_document ×2 已注册）、L18-B02 的 handout/OCR 部分（L02 `llmRawPrompt@1`/`llmOcrPages@1` 已在 main）。
- 剩余唯一未注册命令 `textbooks_add`（`src/cmd/textbooks.rs:114-700`），代码与 15 条测试已备，等 L11：
  1. main 上 `VfsReposService.attachmentProcessing`（目前只在 `ds-mig/L11-vfs-repos` `index.ts:131`），且 `renderPdf` 增加 `progress?: (currentPage, totalPages) => void`（透传 `pdf-preview.ts::renderPdfPreview`），用于 Rust :447-470 的逐页 rendering 进度事件；
  2. `files` 表两个窄写方法：`updateTextbookOcrPagesJson`（:631-641，不改 updated_at）与 `markTextbookRenderError`（:644-654）。现有 `updatePdfOcrPages`/`setProcessingError` 会多写列，不能复用。
  已经 coord 投递给 L11（2026-11-05 04:05）。
## L18-B-VLM-1：L02 未发布 dstu-vision 需要的三个纯函数（2026-11-05 H3）
- `vlm_grounding_service.rs` 调用 `ZhipuAdapter::supports_thinking_static`（:433/:558/:745）、`sanitize_url_for_log`（:452/:783）、
  `single_shot_stream::is_retryable_http_status`（:829）。L02 已实现（`host/plugins/llm/src/adapters/zhipu.ts`、`src/audit.ts`、
  `src/single_shot_stream.ts`），但 `host/plugins/llm/api.ts` 未导出。
- 处理：逐字内置于 `src/l02-unpublished.ts`；请求 L02 在 api.ts 导出 `supportsThinkingStatic` / `sanitizeUrlForLog` /
  `isRetryableHttpStatus`，导出后删除副本。

## 2026-11-05 textbooks_add 接线
- `textbooks_add` 已实现并注册（`src/textbooks-add.ts`），依赖 L11 新发布的 `vfsRepo.attachmentProcessing.renderPdf(..., progress)` 与
  `textbooks.updateTextbookOcrPagesJson` / `textbooks.markTextbookRenderError`（分支 `ds-mig/L11-vfs-repos`）。L11 进 main 前本分支类型检查不过，
  属预期；本 lane 不再自带这两条 `files` UPDATE。

## 2026-11-06 WP-107：L18-B01 已解除
- L11 WP-020（main `9a0b540f8`）发布 `files.setMediaExtractedTextWithConn(conn,fileId,text|null)`；relink 用已有同义 owner
  `textbooks.setOriginalPathWithConn(conn,id,path)`（内部生成 `%Y-%m-%dT%H:%M:%S%.3fZ`），上表 B01 所写的 `relinkOriginalPathWithConn` 不再需要。
- 三处转写写点与 relink 已切到 owner，本地 `repository/media-commands.ts::setFileExtractedText`、
  `repository/textbook-files.ts::updateTextbookOriginalPath` 已删除。上表 B01 行保留作历史记录。

## 2026-11-06 WP-138 范围复核
- main `a3bcecd4e` 已含 WP-105 的 receiver 关闭、WP-163 精确整除与 WP-204 的公开 MediaError。
  生产 PDF OCR 页调用/双 worker 在 `src/pdf-ocr-service.ts`，`index.ts:286-315` 接线，L02
  `llmOcrPages.callOcrPageWithFallback` 为正式公开面。本窄包没有上游接口阻断。
- 本包只恢复单 task 的 JoinSet 处理及 upload Started WARN；上文历史 OCR 供方缺口不再用于阻塞这两处修复。
