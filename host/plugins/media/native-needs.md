# F7 native interfaces required by L18

No native package is imported by this lane. The following are needed before the dependent commands can be registered with their complete Rust behavior.

- **PDFium** (`dstu-docs/pdfium_utils.rs`, `dstu-vision/page_rasterizer.rs`, `pdf_ocr_service.rs`): load bytes/path, page count, per-page text, page size, render RGB/RGBA at a supplied DPI or target dimensions, JPEG encoding, bounded per-page lifetime, cancellation between pages. Text extraction must use PDFium, with `\f` page separators. Backend OCR uses 150 DPI default, maximum 300; page rasterizer uses 300 DPI. Also expose library load diagnostic information for `test_pdfium_status`.
- **Image / HEIC** (`dstu-media/cmd/media.rs`, `heic_decoder.rs`, `vlm_grounding_service.rs`): decode supported formats to RGBA/RGB, dimensions, Lanczos3 resize, triangle thumbnail, crop, PNG and JPEG encode with supplied quality; HEIC decode must preserve the Rust RGB-to-JPEG path. `convert_heic_to_jpeg` is registered and consumes raw IPC bytes via `CallContext.payload`; the desktop Host delegates validation/rejection to `nativeHeic` and must not use libheif to turn it into a success path. Android JPEG success and a plugin-facing raw-byte response channel remain unimplemented (F1/transport + Android target).
- **Audio** (`media/decoder.rs`): Symphonia-equivalent probing and streaming decoded interleaved samples, sample rate/channel layout, packet timestamp and decode errors. Resampling/VAD/WAV remain TypeScript lane logic; do not substitute ffmpeg's resampling/VAD silently.
- **Office** (`document_parser.rs`, `docx_handout.rs`): ZIP entry access with size/compression metadata; XML and HTML-to-text parsing; DOCX/PPTX/XLSX/EPUB/RTF extraction and generation/edit capabilities. Safety gates and output limits remain in the lane. Required equivalence is Rust text/structure, not generated ZIP bytes. Existing JS package availability alone is not evidence of matching calamine/umya/docx-rs/pptx-to-md behavior.

Cross-lane requirements additionally include L02 LLM/OCR model configuration, raw prompt calls and usage accounting; L11 media-transcript/blob/file/textbook repositories; L12 `PdfProcessingService` media task scheduling around the L18 `mediaTranscriber` provider; L13 VFS media hooks and upload finalization; F3 FileManager's writable app-data root, PDF/image saving, image pinning and image reading. Public API imports only; unavailable capabilities must not be replaced by successful empty results.

Exact L02 surface still needed by L18's remaining commands (main `host/plugins/llm/api.ts`):

- `callModel2RawPrompt(prompt, forceJson, callerType, task)` — handout_llm_complete; must keep failover, provider quirks and usage accounting inside L02.
- `callRawPromptWithConfigIdAndImages(configId, prompt, images, callerType)` + VLM config selection — handout_vlm_caption.
- `testOcrWithEngine(pagePath, engineType, configId?)` — test_ocr_engine (including the system OCR branch).
- `callOcrPageWithFallback(pagePath, pageIndex, taskType) -> ExamSegmentationCard[]` — PDF OCR page blocks (`ocr_text` + bbox). `llmOcrHedge.runPrepared` returns only text and is not a substitute.

Exact F1 state for HEIC: raw request injection is on main (`CallContext.payload`, shell `electron/shell/runtime.ts:276-297`); main command results use the `{__dstuRawBytes}` envelope (`electron/raw-bytes.ts`), while direct `x-binary` `Uint8Array`/`ArrayBuffer` results exist only in the unmerged `host/kernel/commands.ts:72-97,237` candidate. The desktop HEIC branch always rejects, so it does not depend on the candidate; Android success is not part of the Electron target and remains unsigned.
