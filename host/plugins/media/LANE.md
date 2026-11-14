# L18-media-docs：媒体与文档

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L18-media-docs（媒体与文档） |
| 目录 | `host/plugins/media/` |
| Rust 范围（lanes.md） | dstu-media、vision、docs、src/media、tts、voice、heic，cmd 下的 ocr、handout、textbooks，以及 office 类工具 |
| 主要提供 | `media@1`、`docs@1`、`ocr@1` |
| 主要消费 | F7 |
| 特别注意 | bilistream 协议；PDF OCR 会话的暂停、恢复、跳页 |
| 规模（本目录） | 37357 行 · 62 个文件 · 74 个命令（前端调用 50） · 243 个测试 |
| 规模（整条 lane，inventory） | 37357 行 · 62 个文件 · 74 个命令（前端 50） · 243 个测试 |
| 契约 | [`contracts/ipc/L18-media-docs.json`](../../../contracts/ipc/L18-media-docs.json) |
| 服务草稿 | [`contracts/services/DRAFT-L18-media-docs.md`](../../../contracts/services/DRAFT-L18-media-docs.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-docs/src/document_parser.rs` | 4840 | 34 |  |
| `src-tauri/crates/dstu-docs/src/docx_handout.rs` | 520 | 5 |  |
| `src-tauri/crates/dstu-docs/src/lib.rs` | 15 | 0 |  |
| `src-tauri/crates/dstu-docs/src/pdfium_utils.rs` | 384 | 2 | 1 |
| `src-tauri/crates/dstu-media/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-media/src/cmd/media.rs` | 149 | 0 | 1 |
| `src-tauri/crates/dstu-media/src/host.rs` | 50 | 0 |  |
| `src-tauri/crates/dstu-media/src/lib.rs` | 30 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/asr.rs` | 951 | 12 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili.rs` | 1959 | 12 | 4 |
| `src-tauri/crates/dstu-media/src/media/bilibili_auth.rs` | 650 | 7 | 4 |
| `src-tauri/crates/dstu-media/src/media/bilibili_lifecycle.rs` | 101 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_stream.rs` | 1458 | 16 | 1 |
| `src-tauri/crates/dstu-media/src/media/bilibili_stream/linux.rs` | 359 | 2 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge.rs` | 786 | 6 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/bridge_server.rs` | 735 | 3 | 5 |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/grpc.rs` | 189 | 2 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/mod.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/native.rs` | 213 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/policy.rs` | 118 | 1 |  |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/session.rs` | 494 | 3 | 1 |
| `src-tauri/crates/dstu-media/src/media/bilibili_transport/types.rs` | 135 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/commands.rs` | 786 | 5 | 6 |
| `src-tauri/crates/dstu-media/src/media/decoder.rs` | 508 | 4 |  |
| `src-tauri/crates/dstu-media/src/media/ledger.rs` | 699 | 3 |  |
| `src-tauri/crates/dstu-media/src/media/library.rs` | 857 | 6 | 2 |
| `src-tauri/crates/dstu-media/src/media/mod.rs` | 171 | 3 |  |
| `src-tauri/crates/dstu-media/src/media/pipeline.rs` | 774 | 3 |  |
| `src-tauri/crates/dstu-media/src/media/resample.rs` | 303 | 5 |  |
| `src-tauri/crates/dstu-media/src/media/subtitle.rs` | 414 | 6 |  |
| `src-tauri/crates/dstu-media/src/media/transcriber_hook.rs` | 177 | 0 |  |
| `src-tauri/crates/dstu-media/src/media/transcript.rs` | 89 | 2 |  |
| `src-tauri/crates/dstu-media/src/media/vad.rs` | 462 | 7 |  |
| `src-tauri/crates/dstu-media/src/media/wav.rs` | 165 | 2 |  |
| `src-tauri/crates/dstu-media/src/voice_input.rs` | 1353 | 13 |  |
| `src-tauri/crates/dstu-vision/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-vision/src/cross_page_merger.rs` | 113 | 0 |  |
| `src-tauri/crates/dstu-vision/src/exam_sheet_service.rs` | 1878 | 2 |  |
| `src-tauri/crates/dstu-vision/src/figure_extractor.rs` | 176 | 0 |  |
| `src-tauri/crates/dstu-vision/src/lib.rs` | 31 | 0 |  |
| `src-tauri/crates/dstu-vision/src/llm_structurer.rs` | 438 | 1 |  |
| `src-tauri/crates/dstu-vision/src/page_rasterizer.rs` | 475 | 0 |  |
| `src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs` | 1442 | 0 |  |
| `src-tauri/crates/dstu-vision/src/vlm_grounding_service.rs` | 1731 | 10 |  |
| `src-tauri/src/chat_v2/tools/document_processing_executor.rs` | 563 | 8 |  |
| `src-tauri/src/chat_v2/tools/docx_executor.rs` | 673 | 6 |  |
| `src-tauri/src/chat_v2/tools/image_generation_executor.rs` | 927 | 7 |  |
| `src-tauri/src/chat_v2/tools/media_executor.rs` | 673 | 6 |  |
| `src-tauri/src/chat_v2/tools/office_fidelity_executor.rs` | 1352 | 14 |  |
| `src-tauri/src/chat_v2/tools/office_output.rs` | 591 | 5 |  |
| `src-tauri/src/chat_v2/tools/pptx_executor.rs` | 743 | 5 |  |
| `src-tauri/src/chat_v2/tools/textbook_pdf_executor.rs` | 1408 | 6 |  |
| `src-tauri/src/chat_v2/tools/xlsx_executor.rs` | 813 | 7 |  |
| `src-tauri/src/cmd/handout.rs` | 224 | 2 | 5 |
| `src-tauri/src/cmd/ocr.rs` | 790 | 0 | 14 |
| `src-tauri/src/cmd/textbooks.rs` | 838 | 0 | 4 |
| `src-tauri/src/heic_decoder.rs` | 143 | 0 | 1 |
| `src-tauri/src/media/commands.rs` | 44 | 0 | 2 |
| `src-tauri/src/media/ledger.rs` | 37 | 0 | 3 |
| `src-tauri/src/media/mod.rs` | 48 | 0 |  |
| `src-tauri/src/tts.rs` | 220 | 0 | 3 |
| `src-tauri/src/voice_input.rs` | 38 | 0 | 1 |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（74）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `add_ocr_engine` | `src/cmd/ocr.rs:447` | async | app | src/features/chat/readiness/autoAssignModel.ts:255<br>src/features/settings/components/OcrEngineCard.tsx:198 | (configId: string, model: string, name: string, engineType?: string \| null) → boolean ! AppError |
| `cancel_pdf_ocr_session` | `src/commands.rs:787` | async | none | — | (sessionId: string) → boolean ! AppError |
| `compress_image` | `crates/dstu-media/src/cmd/media.rs:54` | async | none | — | (sourcePath?: string \| null, bytesBase64?: string \| null, maxEdge?: integer(u32) \| null, quality?: integer(u8) \| null, outputMode?: string \| null) → CompressImageResult ! string |
| `convert_heic_to_jpeg` | `src/heic_decoder.rs:78` | async | app | src/utils/heicConversion.ts:192 | (（无）) → Response ! AppError |
| `get_available_ocr_models` | `src/cmd/ocr.rs:154` | async | app | src/features/chat/readiness/autoAssignModel.ts:189<br>src/features/chat/readiness/autoAssignModel.ts:231<br>src/features/chat/readiness/autoAssignModel.ts:280<br>…共 6 处 | (（无）) → AvailableOcrModelResponse[] ! AppError |
| `get_image_as_base64` | `src/commands.rs:8493` | async | app | src/components/crepe/features/imageUpload.ts:20<br>src/utils/configApi.ts:13<br>src/utils/configApi.ts:18 | (relativePath: string) → string ! AppError |
| `get_ocr_engine_type` | `src/cmd/ocr.rs:56` | async | app | src/features/settings/components/ModelsTab.tsx:214 | (（无）) → string ! AppError |
| `get_ocr_engines` | `src/cmd/ocr.rs:38` | async | app | src/features/settings/components/OcrEngineCard.tsx:87 | (（无）) → OcrEngineInfoResponse[] ! AppError |
| `get_ocr_prompt_template` | `src/cmd/ocr.rs:137` | async | none | — | (engineType: string, mode: string) → string ! AppError |
| `get_ocr_thinking_enabled` | `src/cmd/ocr.rs:70` | async | app | src/features/settings/components/OcrEngineCard.tsx:96 | (（无）) → boolean ! AppError |
| `get_pdf_ocr_temp_dir` | `src/commands.rs:875` | async | none | — | (（无）) → string ! AppError |
| `get_recent_document_tasks` | `src/commands.rs:7062` | async | none | — | (limit?: integer(u32) \| null) → DocumentTask[] ! AppError |
| `handout_cancel` | `src/cmd/handout.rs:129` | async | app | src/features/media-handout/api.ts:54 | (requestId: string) → null ! AppError |
| `handout_llm_complete` | `src/cmd/handout.rs:74` | async | app | src/features/media-handout/api.ts:33 | (prompt: string, jsonMode?: boolean \| null, requestId?: string \| null) → string ! AppError |
| `handout_release` | `src/cmd/handout.rs:135` | async | app | src/features/media-handout/api.ts:58 | (requestId: string) → null ! AppError |
| `handout_vlm_caption` | `src/cmd/handout.rs:96` | async | app | src/features/media-handout/api.ts:45 | (prompt: string, imageBase64: string, mime?: string \| null, requestId?: string \| null) → string ! AppError |
| `infer_ocr_engine_from_model` | `src/cmd/ocr.rs:106` | async | none | — | (model: string) → string ! AppError |
| `init_pdf_ocr_session` | `src/commands.rs:727` | async | none | — | (pdfName?: string \| null, pdfBase64: string, totalPages: integer(usize)) → string ! AppError |
| `media_bilibili_auth_status` | `crates/dstu-media/src/media/bilibili_auth.rs:461` | async | app | src/features/learning-hub/apps/views/media/bilibiliAccount.ts:55 | (（无）) → BiliAccountStatus ! string |
| `media_bilibili_bridge_approve` | `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:523` | async | none | — | (connectionId: string) → null ! string |
| `media_bilibili_bridge_disconnect` | `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:529` | async | none | — | (（无）) → null ! string |
| `media_bilibili_bridge_pair` | `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:509` | async | none | — | (（无）) → PairingView ! string |
| `media_bilibili_cancel` | `crates/dstu-media/src/media/bilibili_transport/session.rs:440` | async | app | src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:230 | (taskId: string) → null |
| `media_bilibili_create` | `crates/dstu-media/src/media/bilibili.rs:1212` | async | app | src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:204 | (input: string, page?: integer(u32) \| null, lan?: string \| null, taskId?: string \| null) → BiliCreateResult ! string |
| `media_bilibili_import_subtitle` | `crates/dstu-media/src/media/bilibili.rs:1311` | async | app | src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:217 | (resourceId: string, input: string, page?: integer(u32) \| null, lan?: string \| null, taskId?: string \| null) → TranscriptView ! string |
| `media_bilibili_link_get` | `crates/dstu-media/src/media/bilibili.rs:1353` | async | app | src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:228 | (resourceId: string) → BiliLinkDescriptor ! string |
| `media_bilibili_login_qr_poll` | `crates/dstu-media/src/media/bilibili_auth.rs:500` | async | app | src/features/learning-hub/apps/views/media/bilibiliAccount.ts:61 | (qrcodeKey: string) → BiliLoginPoll ! string |
| `media_bilibili_login_qr_start` | `crates/dstu-media/src/media/bilibili_auth.rs:488` | async | app | src/features/learning-hub/apps/views/media/bilibiliAccount.ts:58 | (（无）) → BiliLoginQr ! string |
| `media_bilibili_logout` | `crates/dstu-media/src/media/bilibili_auth.rs:529` | async | app | src/features/learning-hub/apps/views/media/bilibiliAccount.ts:65 | (（无）) → null ! string |
| `media_bilibili_probe` | `crates/dstu-media/src/media/bilibili.rs:1172` | async | app | src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:198 | (input: string, page?: integer(u32) \| null, taskId?: string \| null) → BiliProbeView ! string |
| `media_bilibili_stream_quality` | `crates/dstu-media/src/media/bilibili_stream.rs:512` | async | app | src/features/learning-hub/apps/views/media/bilibiliAccount.ts:198 | (fileId: string, qn?: integer(u32) \| null, epoch?: integer(u32) \| null, attempt?: integer(u32) \| null) → StreamQualityView ! string |
| `media_bilibili_transport_configure` | `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:494` | async | none | — | (config: TransportSettings__De) → null ! string |
| `media_bilibili_transport_status` | `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs:485` | async | app | src/features/learning-hub/apps/views/media/bilibiliTransport.ts:39 | (（无）) → TransportView ! string |
| `media_chapters` | `src/media/ledger.rs:19` | async | app | src/features/learning-hub/apps/views/media/mediaChapters.ts:47 | (resourceId: string) → MediaChapter[] ! string |
| `media_checkpoints` | `src/media/ledger.rs:11` | async | app | src/features/learning-hub/apps/views/media/mediaCheckpoints.ts:93 | (resourceId: string) → MediaCheckpoint[] ! string |
| `media_library_list` | `crates/dstu-media/src/media/library.rs:410` | async | app | src/features/media-studio/api.ts:219 | (limit?: integer(u32) \| null) → MediaLibraryItem[] ! string |
| `media_progress_get` | `crates/dstu-media/src/media/commands.rs:533` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:305 | (resourceId: string) → MediaProgressRow \| null ! string |
| `media_progress_set` | `crates/dstu-media/src/media/commands.rs:544` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:309 | (resourceId: string, positionMs?: integer(i64) \| null, durationMs?: integer(i64) \| null, watchedDeltaMs?: integer(i64) \| null, finished?: boolean \| null) → MediaProgressRow ! string |
| `media_related_notes` | `crates/dstu-media/src/media/library.rs:440` | async | app | src/features/media-studio/api.ts:223 | (resourceId: string) → MediaRelatedNote[] ! string |
| `media_study_ledger` | `src/media/ledger.rs:27` | async | app | src/features/media-studio/api.ts:229 | (resourceIds: string[], includeCardIds?: boolean \| null) → MediaStudyLedger[] ! string |
| `media_transcribe_cancel` | `crates/dstu-media/src/media/commands.rs:366` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:287 | (resourceId: string) → TranscriptStatusView ! string |
| `media_transcribe_estimate` | `src/media/commands.rs:19` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:278 | (resourceId: string) → TranscribeEstimate ! string |
| `media_transcribe_start` | `src/media/commands.rs:28` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:283 | (resourceId: string) → TranscriptStatusView ! string |
| `media_transcript_export` | `crates/dstu-media/src/media/commands.rs:504` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:301 | (resourceId: string, format: string, dest: string) → TranscriptExportResult ! string |
| `media_transcript_get` | `crates/dstu-media/src/media/commands.rs:382` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:291 | (resourceId: string) → TranscriptView ! string |
| `media_transcript_import` | `crates/dstu-media/src/media/commands.rs:422` | async | app | src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:296 | (resourceId: string, path: string) → TranscriptView ! string |
| `notes_export_docx` | `src/cmd/handout.rs:146` | async | app | src/features/notes/noteDocxExport.ts:72 | (spec: Value) → string ! AppError |
| `parse_document_from_base64` | `src/commands.rs:4121` | async | app | src/components/TranslateWorkbench.tsx:607 | (fileName: string, base64Content: string) → string ! string |
| `parse_document_from_path` | `src/commands.rs:4093` | async | none | — | (filePath: string) → string ! string |
| `pause_pdf_ocr_session` | `src/commands.rs:802` | async | none | — | (sessionId: string) → boolean ! AppError |
| `pin_images` | `src/commands.rs:356` | async | none | — | (tempId: string, images: string[]) → boolean ! AppError |
| `process_pdf_ocr` | `src/commands.rs:774` | async | none | — | (request: PdfOcrRequest) → PdfOcrResult ! AppError |
| `remove_ocr_engine` | `src/cmd/ocr.rs:527` | async | app | src/features/chat/readiness/autoAssignModel.ts:217<br>src/features/settings/components/OcrEngineCard.tsx:173 | (configId: string) → boolean ! AppError |
| `resume_pdf_ocr_session` | `src/commands.rs:814` | async | none | — | (sessionId: string) → boolean ! AppError |
| `save_available_ocr_models` | `src/cmd/ocr.rs:356` | async | app | src/features/settings/components/SiliconFlowSection.tsx:1006 | (models: SaveOcrModelRequest[]) → boolean ! AppError |
| `save_pdf_to_temp` | `src/commands.rs:891` | async | none | — | (pdfBase64: string, fileName: string) → string ! AppError |
| `set_ocr_engine_type` | `src/cmd/ocr.rs:88` | async | none | — | (engineType: string) → boolean ! AppError |
| `set_ocr_thinking_enabled` | `src/cmd/ocr.rs:76` | async | app | src/features/settings/components/OcrEngineCard.tsx:365 | (enabled: boolean) → boolean ! AppError |
| `skip_pdf_ocr_page` | `src/commands.rs:829` | async | none | — | (sessionId: string, pageIndex: integer(usize)) → boolean ! AppError |
| `start_pdf_ocr_backend` | `src/commands.rs:846` | async | none | — | (pdfPath: string, pdfName?: string \| null, renderDpi?: integer(u32) \| null) → string ! AppError |
| `test_ocr_engine` | `src/cmd/ocr.rs:612` | async | app | src/features/settings/components/OcrEngineTestPanel.tsx:127 | (request: OcrTestRequest) → OcrTestResponse ! AppError |
### Bilibili 命令的实现与已知差异（2026-11-04）

`media_bilibili_probe` / `media_bilibili_create` / `media_bilibili_import_subtitle` /
`media_bilibili_stream_quality` 已注册。`src/bilibili-attempt.ts` 实现出口选择、账号代次、
native/proxy/browser_bridge 路由、重试与 60 秒任务截止；`src/bilibili-link-items.ts` 实现
原子写入/复用链接条目；`src/bilibili-playback.ts` 实现按 `(条目, qn, epoch, attempt)` 复用播放会话。
`bilibili.rs` 的 3 个 pending 测试（含 live）已全部移植，`bilibili_stream.rs` 的 live 测试也已移植。

已知差异（不影响命令语义，但未达到逐字节等价）：

- `media_bilibili_stream_quality` 返回真实流地址：macOS/Linux `bilistream://localhost/{fileId}?qn=…&e=…&a=…`，Windows
  `http://bilistream.localhost/...`；`src/bilibili-protocol.ts` 在 Host 注册 `bilistream`，复用播放会话与
  Range/过期刷新/错误语义。前端仍保留自定义协议地址作为后端不可用时的回退；
- Rust `pipeline::refresh_index` 会立即重建转写时间窗词法单元；`index.ts` 优先调用 L13
  `ctx.vfs.mediaIndex.refreshTranscriptIndex(ctx.vfs.database, ctx.vfs.unitIndex, fileId)`，
  当前 main 尚未合并该 API 时回退到 `vfsIndex.indexing.indexResource` 并记录警告；
- `bilibili-live.test.ts` 默认跳过（`DS_BILIBILI_LIVE=1` 才执行），未做真实联网验证；
- `tests/bilibili-protocol.test.ts` 覆盖 OPTIONS/405/400、首块 64 KiB、后缀 Range、CDN 过期刷新一次、
  二次过期 502 与错误事件、HEAD 总长度、24s 超时；真实 B 站 CDN 仍未在目标平台联网验证。

| `test_pdfium_status` | `crates/dstu-docs/src/pdfium_utils.rs:192` | sync | none | — | (（无）) → object ! string |
| `textbooks_add` | `src/cmd/textbooks.rs:114` | async | app | src/dstu/adapters/textbookDstuAdapter.ts:178<br>src/utils/chatApi.ts:354 | (sources: string[], folderId?: string \| null) → Textbook[] ! AppError |
| `textbooks_relink` | `src/cmd/textbooks.rs:700` | async | app | src/features/learning-hub/apps/views/TextbookContentView.tsx:580 | (id: string, newPath: string) → Textbook ! AppError |
| `textbooks_update_bookmarks` | `src/cmd/textbooks.rs:821` | async | app | src/api/vfsFileApi.ts:129 | (id: string, bookmarks: Value[]) → boolean ! AppError |
| `tts_check_available` | `src/tts.rs:25` | async | app | src/utils/tts.ts:32 | (（无）) → boolean ! AppError |
| `tts_speak` | `src/tts.rs:59` | async | app | src/utils/tts.ts:116 | (text: string, lang?: string \| null, rate?: number \| null, volume?: number \| null) → null ! AppError |
| `tts_stop` | `src/tts.rs:93` | async | app | src/utils/tts.ts:130 | (（无）) → null ! AppError |
| `unpin_images` | `src/commands.rs:384` | async | none | — | (tempId: string) → boolean ! AppError |
| `update_ocr_engine_priority` | `src/cmd/ocr.rs:403` | async | app | src/features/chat/readiness/autoAssignModel.ts:320<br>src/features/settings/components/OcrEngineCard.tsx:118<br>src/features/settings/components/OcrEngineCard.tsx:139<br>…共 4 处 | (engineList: UpdateOcrPriorityItem[]) → boolean ! AppError |
| `upload_pdf_ocr_page` | `src/commands.rs:747` | async | none | — | (sessionId: string, page: PdfOcrPageInput) → null ! AppError |
| `validate_ocr_model` | `src/cmd/ocr.rs:113` | async | none | — | (model: string, engineType: string) → ValidateOcrModelResponse ! AppError |
| `vfs_get_file_blob_path` | `src/cmd/textbooks.rs:785` | async | app | src/features/learning-hub/apps/views/FileContentView.tsx:466<br>src/features/learning-hub/apps/views/ImageContentView.tsx:251<br>src/features/learning-hub/apps/views/ImageContentView.tsx:356<br>…共 8 处 | (id: string) → string \| null ! AppError |
| `voice_input_transcribe` | `src/voice_input.rs:21` | async | app | src/voice-input/providerRegistry.ts:29 | (request: VoiceInputTranscribeRequest) → VoiceInputTranscribeResponse ! AppError |

### 发出的事件（6）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `dstu:change` | 字面量 | src/cmd/textbooks.rs:76 (emit) |
| `media_bilibili_playback_error` | 字面量 | crates/dstu-media/src/media/bilibili_stream.rs:835 (emit) |
| `pdf_ocr_progress` | 字面量 | crates/dstu-vision/src/pdf_ocr_service.rs:388 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:414 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:440 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:463 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:486 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:499 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:640 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:701 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:729 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:751 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:1165 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:1169 (emit) |
| `pdf-annotations:changed` | 常量 `PDF_ANNOTATIONS_CHANGED_EVENT` | src/chat_v2/tools/textbook_pdf_executor.rs:1040 (emit) |
| `textbook-import-progress` | 字面量 | src/cmd/textbooks.rs:156 (emit)<br>src/cmd/textbooks.rs:452 (emit) |
| `dstu:change:{}` | 动态（format!） | src/cmd/textbooks.rs:70 (emit) |

### 契约中的事件（6，`contracts/ipc/L18-media-docs.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `dstu:change` | 否 | DstuWatchEvent \| object | src/cmd/textbooks.rs:76 (emit) |
| `dstu:change:{}` | 是 | DstuWatchEvent \| object | src/cmd/textbooks.rs:70 (emit) |
| `pdf-annotations:changed` | 否 | object \| object | src/chat_v2/tools/textbook_pdf_executor.rs:1040 (emit) |
| `media_bilibili_playback_error` | 否 | object | crates/dstu-media/src/media/bilibili_stream.rs:835 (emit) |
| `pdf_ocr_progress` | 否 | object \| object \| object \| object \| object \| Value | crates/dstu-vision/src/pdf_ocr_service.rs:388 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:414 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:440 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:463 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:486 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:499 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:640 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:701 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:729 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:751 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:1165 (emit)<br>crates/dstu-vision/src/pdf_ocr_service.rs:1169 (emit) |
| `textbook-import-progress` | 否 | TextbookImportProgress | src/cmd/textbooks.rs:156 (emit)<br>src/cmd/textbooks.rs:452 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

### v2 接手盘点（2026-11-04，新会话）

已读取历史，保留既有实现；合入 main 后类型检查作业 `20261104094925-454278` exit 0，
插件测试 `20261104094925-43b1a8` exit 0，60 files passed / 1 skipped，352 passed / 2 skipped。
`ACCEPTANCE.md` 尚不存在，不能把没有复核报告解释为通过。以下是接手审读发现与待核实范围，
旧 SPEC 勾选、TESTMAP ported 和 ledger A 都不构成 v2 签收。

八类编号对应 standard-v2 §1：①接线 ②所有权 ③serde ④错误日志 ⑤真实测试 ⑥完整性
⑦运行时 ⑧独立复验。表中“待核”不是通过；所有行的⑧均待复核人签收。
路径除 Rust/host 前缀外相对本目录；行号为接手时版本。

| 命令/模块 | 八类自查结果与计划 | 证据 |
|---|---|---|
| `tts_check_available`, `tts_speak`, `tts_stop` | ①已注册；②无库写；③kernel 入参；④⑤⑥⑦待核平台进程退出及日志；⑧待签 | `index.ts:185-188`, `src/tts.ts:1-150` |
| `get_ocr_engine_type`, `get_ocr_thinking_enabled`, `set_ocr_thinking_enabled` | ①已注册；②settings owner；③字符串配置；④⑥读错回退需对 Rust；⑤现有入口测试；⑦无 await；⑧待签 | `index.ts:189-208`, `src/ocr-settings.ts:640` |
| `get_ocr_engines`, `get_ocr_prompt_template`, `infer_ocr_engine_from_model`, `validate_ocr_model`, `set_ocr_engine_type` | ①已注册；②无越权写；③enum/string/kernel；④⑤⑥需逐引擎比对；⑦平台系统 OCR 条件待签；⑧待签 | `index.ts:209-218`, `src/ocr-settings.ts` |
| `get_available_ocr_models`, `save_available_ocr_models`, `add_ocr_engine`, `remove_ocr_engine`, `update_ocr_engine_priority` | ①已注册；②settings owner；③持久化解码器已有、需核 null/default/u32；④迁移日志待补审；⑤⑥旧 tests 待断言对照；⑦await 交错待核；⑧待签 | `index.ts:198-241`, `src/ocr-settings.ts:331-644` |
| `cancel_pdf_ocr_session`, `pause_pdf_ocr_session`, `resume_pdf_ocr_session`, `skip_pdf_ocr_page` | **M04** ①⑥⑦命令与 ocr 服务各持有一个控制状态且无生产创建会话；②内存；③kernel；④⑤需同状态测试；⑧待签 | `index.ts:244-252`, `src/service.ts:248-267` |
| `get_pdf_ocr_temp_dir`, `save_pdf_to_temp` | ①入口存在；②本域文件；③严格 Base64；④错误前缀已有；⑤入口测试；⑥⑦writable app-data 与 base/slot 根待核；⑧待签 | `index.ts:253-255`, `src/pdf-ocr-sessions.ts:49-75` |
| `get_image_as_base64`, `vfs_get_file_blob_path` | ①入口存在；②只读；③路径/字段待核；④已映射 AppError；⑤入口测试；⑥⑦同步文件读取、路径根待整改；⑧待签 | `index.ts:256-271`, `src/image-base64.ts:103`, `repository/textbook-files.ts:8-14` |
| `convert_heic_to_jpeg` | ①raw 入口已接 F7；②无写；③raw 校验；④桌面拒绝；⑤入口测试；⑥桌面范围；⑦跨进程证据未签；⑧X2-R05 待复验 | `index.ts:278-292`, `tests/heic.test.ts`, `host/kernel/API.md:79-88` |
| `test_pdfium_status` | ①接 F7；②无写；③输出 map；④诊断内失败；⑤真实 WASM 测试；⑥Rust 原生候选路径与 WASM 的差异需裁定；⑦平台差异未签；⑧待签 | `src/pdfium-status.ts`, Rust `pdfium_utils.rs:192-340` |
| `get_recent_document_tasks` | ①已注册；②只读；③DB 状态解码待核；④Database 映射；⑤入口测试；⑥⑦i64/同步 SQL 待核；⑧待签 | `index.ts:293-301`, `repository/document-tasks.ts` |
| `media_library_list`, `media_related_notes`, `media_chapters`, `media_checkpoints`, `media_study_ledger` | ①已注册；②只读；③JSON/时间精度待核；④查询错误待核；⑤旧仓储测试需入口增强；⑥trim/排序需 Rust 对照；⑦D3 精度待核；⑧待签 | `index.ts:314-325,431-449,533-557`, `src/media-library.ts:75`, `src/ledger.ts:93` |
| `media_progress_get`, `media_progress_set` | ①已注册；②L11 owner；③kernel i64 与仓储 number 接缝需 D3 审核；④数据库失败映射待核；⑤入口测试已有；⑥饱和运算待核；⑦D3；⑧待签 | `index.ts:361-381`, `src/media-commands.ts:187-215` |
| `media_transcript_get` | **M01** ①已接但⑥运行态写死 false；③progress JSON 无校验断言；④SQL 失败可落 panic 待核；②只读；⑤新增运行态入口测试；⑦状态快照；⑧待签 | `index.ts:388`, `src/media-commands.ts:73`; Rust `media/commands.rs:390` |
| `media_transcript_import`, `media_bilibili_import_subtitle` | **M01/M02** ①⑥文件导入漏 startPipeline，取消异常未映射；②直接 UPDATE files；③导入解析；④日志顺序错误；⑤补入口故障/副作用测试；⑦先读文件再取消；⑧待签 | `index.ts:413-428,954-960`, `repository/media-commands.ts:42`; Rust `media/commands.rs:433-478` |
| `media_transcript_export` | ①注册；②本域输出；③parse format；④错误映射；⑤已有入口；⑥统一文件写入默认行为待核；⑦同步 IO 与 trim 待整改；⑧待签 | `index.ts:391-409`, `src/media-commands.ts:140` |
| `media_transcribe_start`, `media_transcribe_cancel`, `media_transcribe_estimate`, `mediaTranscriber` | **M01/M02/M05** ①提供者已接，L12 hook 未 main；②pipeline 直接写 files；③状态结构待核；④cancel/DB 错误待修；⑤提供者测试；⑥分支待逐条；⑦ASR 调度 Date.now 代 Instant；⑧待签 | `index.ts:459-531,779-790`, `src/asr-runner.ts:113-200`, `src/pipeline.ts` |
| `textbooks_update_bookmarks`, `textbooks_relink` | **M02** ①已注册；②relink 越权 UPDATE files；③bookmarks kernel Value；④错误分层已有；⑤入口测试；⑥⑦同步大文件 hash/read、时间格式待核；⑧待签 | `index.ts:558-650`, `repository/textbook-files.ts:24` |
| `media_bilibili_auth_status`, `media_bilibili_login_qr_start`, `media_bilibili_login_qr_poll`, `media_bilibili_logout` | ①已注册；②secure store owner；③session JSON 解码待核；④日志/best-effort 待逐条；⑤已有 HTTP/入口测试；⑥cookie/nav 全分支待核；⑦网络默认行为待核；⑧待签 | `index.ts:655-659,1008-1025`, `src/bilibili-account.ts` |
| `media_bilibili_probe`, `media_bilibili_create`, `media_bilibili_link_get`, `media_bilibili_cancel` | **M02/M05** ①已注册；②创建经 L11 但文本投影越权；③描述严格解码已有；④fallback/index 语义待核；⑤HTTP/入口测试；⑥新建/复用待核；⑦墙钟 deadline/cache 待替换；⑧待签 | `index.ts:661-679,832-964,995-1007`, `src/bilibili-attempt.ts:194-559` |
| `media_bilibili_stream_quality`, `bilistream` | **M05** ①协议已注册；②只读；③Range/path 解码已有；④吞事件错误理由需 Rust 核实；⑤协议用例已有；⑥Linux 分块待核；⑦TTL/elapsed 用墙钟；⑧待签 | `index.ts:683-715,965-994`, `src/bilibili-protocol.ts:274-305`, `src/bilibili-playback.ts:34` |
| `media_bilibili_transport_status`, `media_bilibili_transport_configure`, `media_bilibili_bridge_pair`, `media_bilibili_bridge_approve`, `media_bilibili_bridge_disconnect` | **M05** ①已注册；②settings owner；③bridge JSON 待逐字段；④错误字符串；⑤socket 测试；⑥配对/恢复分支待核；⑦lease 用墙钟，close 未 await；⑧待签 | `index.ts:181,1026-1070`, `src/bilibili-bridge-hub.ts:193-385` |
| `voice_input_transcribe` | ①入口已有；②usage 经 F3；③request/kernel，响应 JSON 待核；④usage 错误 warn；⑤入口与 HTTP 测试；⑥协议分支待核；⑦超时/单调 latency 待核；⑧待签 | `index.ts:1080`, `src/voice-input.ts`, `src/asr-backend.ts:122-144` |
| `handout_cancel`, `handout_release` | ①命令已有但业务完成命令尚缺；②内存；③kernel；④无 Err；⑤Rust 同名测试；⑥取消/释放待入口核对；⑦registry 生命周期待核；⑧待签 | `index.ts:1094-1097`, `src/handout.ts` |
| `docs`, `media` 公共 helper 服务 | **M03** ①provide 可达不等于有业务消费者：工具 execute 尚缺；②工具交付写入未做；③结构待核；④⑤部分只测 helper；⑥完整 executor 自有待办，不是上游阻塞；⑦ZIP/哈希同步；⑧待签 | `src/service.ts:52-244`, `api.ts:95-153,256-311`, Rust `src/chat_v2/tools/*_executor.rs` |
| `ocr` | **M04** ①四方法无条件抛错仍 provide；②两套状态；③无真实解码；④错误谎称缺 pdfium；⑤无生产页流测试；⑥自有编排未做；⑦会话生命周期未做；⑧待签 | `src/service.ts:246-267`; F7 已 provide `nativePdfium` |
| `examSheetSession` | ①L14 消费；②经 L11；③encode as unknown as JsonValue 待核；④日志待对照；⑤12 个服务测试；⑥crop 尚需 F7；⑦同步文件/图像；⑧待签 | `src/exam-sheet-service.ts:242-243`, `index.ts:352-360` |
| 未注册的 14 命令 | ①未注册，⑤无完成声明；②③④⑥⑦仍需自有实现；真正依赖点见 BLOCKERS，不以依赖未 main 为由停止业务编排；⑧待签 | `compress_image`, `handout_llm_complete`, `handout_vlm_caption`, `init_pdf_ocr_session`, `notes_export_docx`, `parse_document_from_base64`, `parse_document_from_path`, `pin_images`, `process_pdf_ocr`, `start_pdf_ocr_backend`, `test_ocr_engine`, `textbooks_add`, `unpin_images`, `upload_pdf_ocr_page` |

处理顺序：先 M01 生产 transcript 状态/取消/导入调度，再 M02 owner 接缝（缺符号立即升级），
随后 M04 会话编排、M05 单调时钟及 M03 工具真实入口。独立报告未到之前使用自查 ID
`L18-M01`…，不能伪称 reviewer finding 已关闭。SPEC §2 清单随每个单元补齐。
X4 W07/W08/W17 仍需处理；新版 main 已有 F1 x-binary raw return（`host/kernel/API.md:79-88`），
因此旧文中“F1 返回能力仅候选”失效，Android 继续 Rust，桌面 raw 跨进程未验证。
完整 Rust 逐函数/逐断言复核尚未完成；这部分属于本 lane 自有工作，不列为跨 lane 阻塞。

### v2 排雷清单（X6 基线 `2ee9a9cbe` 候选，核验于 `bd64e1ff5`）

C2 冻结报告 `0119143715c0bab2d8f698b7c1d58651358e85be` 的稳定 ID 已并入下表首列；X6-PR/AP/LP 仅人工候选。
owner 依 C2 `037376b1e`/X6-OWN-C2-20261104：`files` 归 L11（vfs-repos）。

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。
这是候选线索，不是全部缺陷；[info] 与计数类只作人工线索，逐处核对，不按数量补 expect。

| ID（复用优先） | 门禁 / 位置 | 当前核验 | Rust 证据 | 状态 |
|---|---|---|---|---|
| R1-MD-01 / L18-M02 / L18-B01 / X6-SW-0008 | single-writer `repository/media-commands.ts:42` foreign-table-write files；:42 duplicate-repository [info] | 已迁出（WP-107）：本地 `setFileExtractedText` 已删；`src/pipeline.ts:312`、`src/media-commands.ts:210`（空串→NULL）与 `src/bilibili-link-items.ts:200`（`join("\n")` 原值）改调 L11 `files.setMediaExtractedTextWithConn` | `pipeline.rs:331-341`、`commands.rs:404-419`、`bilibili.rs:1002-1016,1027-1047` | 待 C2 复核（R2 M05） |
| R1-MD-01 / L18-M02 / L18-B01 / X6-SW-0009 | single-writer `repository/textbook-files.ts:24` | 已迁出（WP-107）：本地 `updateTextbookOriginalPath` 与 `utcMillisTimestamp` 已删；`index.ts:708` 改调 L11 `textbooks.setOriginalPathWithConn`（同义 owner，WP-020），外层 `更新 original_path 失败: ` 包装保留 | `src/cmd/textbooks.rs:741-753` | 待 C2 复核（R2 M05） |
| L18-M01 / X6-UD-0051 | unchecked-decode `src/media-commands.ts:73` json-parse-assertion | 已修：`parsePercent` 现为 unknown → object/percent 数字检查，无断言 | `commands.rs:204-210` | 代码 `a34d959a6`（已在 main），测试 `a274d4094` |
| X6-decode-media-exam-sheet-service-242 | unchecked-decode `src/exam-sheet-service.ts:242-243` double-assertion [info] | 编码方向（本 lane 产出的 `JsonRecord` → L11 `JsonValue` 参数），不是解码路径；类型面差异 | — | 待办（低）：让 `encodeMetadata/encodePreview` 返回 JsonValue 子类型以去掉断言，不改输出 |
| X6-PR-0065/0066/0067 | prod-reachable `tests/asr-runner.test.ts` Cancellation/MAX_CONSECUTIVE_SEGMENT_FAILURES/runAsrJobsWith | 误报：`src/pipeline.ts:21,429,486` 生产调用；常量在 `asr-runner.ts:221` 使用 | `asr.rs:395-530` | 无需修改 |
| X6-PR-0068 | prod-reachable `tests/asr-backend.test.ts` HttpAsrBackend | 误报：`index.ts:813` 生产构造（L18-M05 起带用量） | `transcriber_hook.rs:153` | 无需修改 |
| R1-MD-04 / R1-MD-06 / X6-AP-0316…0320 | assert-parity `tests/document-parser.test.ts:29,35,41,304,323` | 误报：Rust `is_ok()`+`unwrap()` 合为一条 TS 返回值断言（抛错即失败）；R1 已核 29/35/41/323；304 EPUB 为 MD-04 语义问题 | `document_parser.rs:4187-4377` | MD-04 依赖 B04；不补无意义 expect |
| X6-AP-0321 | assert-parity `bilibili-link-items:110` | 实缺 `assert!(info.is_link_item())`（`bilibili.rs:1914`） | `bilibili.rs:1910` | 已补 `isLinkItem(created.info)` |
| X6-AP-0322 | assert-parity `bilibili-bridge-hub:121` | 误报：两次 `contains("credit")` 与 `contains("cancel")` 由 `until(...)`（超时抛错）强制 | `bridge.rs:695-757` | 无需修改 |
| X6-AP-0323 | assert-parity `media-ledger:64` | 实缺：`media_learning_summary` 未移植，5 条断言（`ledger.rs:644-651`）缺失 | `ledger.rs:265-319,555-699` | 已移植 `repository/media-ledger.ts::mediaLearningSummary`，经 `ctx.media.mediaLearningSummary` 公开；测试经服务入口补 5 条。调用方 `learning_overview_executor.rs:250`（memory lane）尚未接入 media 段，需其自行接入 |
| X6-AP-0324 | assert-parity `media-library:75` | 误报：Rust JSON 段 `lastWatchedAt.is_null()` 由 TS `toBeNull()`（TS 对象即线上形态）覆盖 | `library.rs:499-551` | 无需修改 |
| X6-AP-0325 | assert-parity `asr-models:18` | 误报：循环覆盖 3 条 `is_err` | `voice_input.rs:1054` | 无需修改 |
| X6-AP-0326…0346 | assert-parity `office-executors:49-104,208`、`office-fidelity:121`、`office-output:36` | 未逐条核 | 各 Rust 同名测试 | 待办：多数随 B04 |
| X6-LP-0176…0198 / R1-MD-06 | log-parity [info]：`document-parser`、`api.ts`、`bilibili-account/playback/stream/bridge-server`、`repository/*`、`index.ts` | 未逐条核；R1-MD-06 已指出 OCR 清理/迁移 info 缺失 | `src/cmd/ocr.rs:170-173,217-240` 等 | OCR 部分已修：`ocr-settings.ts` 改用 L01 `llm-providers/api.ts`（解析/工厂/校验/提示词）与 L02 `llm/api.ts`（迁移、停服判定、SYSTEM_OCR_CONFIG_ID），补 ocr.rs:172/217/239/261 四条 info；顺带修复本地 GLM 正则 ASCII `\d` 与 Rust Unicode `\d` 的差异。其余 LP 候选未逐条核 |
| R1-MD-02 / R1-MD-03 | transcript_get running；import 读失败先于取消 | R1 在 main 复验签收（报告 `020765b15`/`804419498`，merge `a17989895`，门禁作业 `20261104120904-53776d`） | `commands.rs:383-394,432-455` | 已签收；只签这两项 |
| R1-MD-05 | 同步 IO：字幕导入全量读、导出同步写、relink 200MB 同步哈希/读、docs `extractTextFromPath` 先全读 | 字幕/导出/relink 已改 fs/promises 有界读与 write_text_file（`3ad812d19`）；docs 路径入口改 read_file_safely 次序（本节后续提交） | `unified_file_manager.rs:206-245,375-384`；`document_parser.rs:803-854` | 部分：解析/导出 CPU 仍在 Host 线程（无 worker），EPUB 解压同步；`checkPdfEncryptionFromPath` 仍同步读 |
| X2-R22 / X2-D01 | media_transcribe_cancel / media_checkpoints / media_study_ledger 非 MediaError 异常成 HandlerPanic | cancel 已修（`a34d959a6`）；ledger 两条本轮修为纯字符串 | `commands.rs:375-377`；`ledger.rs:255-257,466-476` | ledger 修复见本节后续提交 |

### 未注册命令的阻塞证据（2026-11-04）

以下命令未在 `meta.commands` 声明，也未注册；它们依赖的上游接口尚未发布，按
`quality.md` 要求不以空实现/占位结果注册。其余 60 个命令已注册并通过命令级测试。

| 命令 / 测试 | 阻塞点 | 证据 |
|---|---|---|
| `compress_image`；`vlm_grounding_service.rs` 的 `test_prepare_docx_image_resizes_and_enforces_hard_output_limit`、`test_crop_figure_*`；`textbook_pdf_executor.rs` 的 `compresses_large_page_images_below_output_limits` | 需要图片解码后的 Lanczos3 缩放、裁剪与 JPEG/PNG 编码；main 的 F7 `NativeImage` 仅发布尺寸读取与 RGBA 解码，`encode`/`cropRgba`/`cropFigure`/`resize*` 仅存在于未合并的 `ds-mig/F7-native` | `host/platform/native/image/api.ts`（main 仅 `dimensions`/`decodeRgba`）；`git show ds-mig/F7-native:host/platform/native/image/api.ts`；`host/plugins/media/native-needs.md` 的 Image/HEIC 条目 |
| `handout_llm_complete`、`handout_vlm_caption`、`test_ocr_engine`、`init_pdf_ocr_session`、`process_pdf_ocr`、`start_pdf_ocr_backend`、`upload_pdf_ocr_page` | 需要 L02 的原始 prompt（含 JSON 模式/取消、usage 记录）、VLM 配置与 `call_ocr_page_with_fallback`（带 bbox 卡片）；`LLMManager` 只发布配置/选择/取消流，没有 `callRawPrompt`/VLM/带卡片 OCR 方法。仓库内 `src/completion.ts::callRawPrompt` 属 L02 内部实现，不能跨插件导入；`llmOcrHedge` 只返回字符串 | `host/plugins/llm/api.ts:42-66,99-105`（`LLMManager`/`LlmOcrHedge` 方法清单）；`host/plugins/llm/src/completion.ts`（未在 `api.ts` 导出） |
| `notes_export_docx`、`parse_document_from_base64`、`parse_document_from_path`、`textbooks_add`；`docx_handout.rs` 3 个测试、`docx_executor`/`pptx_executor`/`xlsx_executor` 的 g06 测试、`document_parser.rs` 的 2 个 xlsx 测试 | 需要 Office ZIP/XML 生成与编辑；main 的 `host/platform/native/office/api.ts` 虽声明 `NativeOffice.extractText/extractTables`，但 `host/platform/native/index.ts` 未 provide `nativeOffice`（仅 `nativeOfficeText`）；未合并的 `ds-mig/F7-native` 有 `nativeOfficeWriter.generateDocx/generatePptx/generateXlsx`、`editXlsxCells`、`readXlsxSpec/readXlsxTables/readXlsxMetadata/replaceXlsxText` 候选，但 DOCX/PPTX 编辑仍无候选，生成不等于编辑；XLSX 读取/编辑接入前仍需容器安全与保真度门禁，目标平台安装/验证未签收。`textbooks_add` 还需要 PDF 预览渲染与 F3 文件管理。L18 保留这些业务命令与测试的所有权 | `host/platform/native/office/api.ts`（main 仅抽取）；`git show ds-mig/F7-native:host/platform/native/office/{api,writer}.ts`；`host/plugins/media/src/docx-handout.ts`（仅有 `decodeImageData`/`fitEmu`）；`host/plugins/media/native-needs.md` 的 Office 条目 |
| `pin_images`、`unpin_images` | 需要 L22 的 StreamContext 读取/修改/持久化；当前只发布临时会话身份 Map | `host/plugins/integration/api.ts:40-47`（`TempSessionIdentity`/`withTempSessions`） |
| `test_pdfium_status`（2026-11-04 已实现，见下文专节） | Host 用 `nativePdfium.open` 实测 WASM PDFium 的最小 PDF 加载/解析；Rust 的原生库候选路径不适用于 Host，故不伪造 `candidate_N` | `src/pdfium-status.ts`、`tests/pdfium-status.test.ts`；`host/platform/native/pdfium/api.ts` |

D9 已批准 `docx@9.15.2`、`pptxgenjs@4.0.1` 与既有 `exceljs@4.4.0`；F7 分支已移除私有 Office 依赖，并以共享依赖通过 `office-docx`/`office-generation` 两个文件 6 个用例（作业 `20261104071755-c2ff13`，exit 0）。但 main 的 package/打包安装、提供方接线、容器/保真度门禁与目标平台验证仍不由本 lane 完成；不把“依赖批准”或“分支候选测试”当作 Office 生成/编辑已完成。

### F7 候选接口交接（2026-11-04）

- **整数像素裁剪**：未合并的 `ds-mig/F7-native` 已发布
  `nativeImage.cropRgba(input: RgbaImage, bbox: ImagePixelRect): RgbaImage`；`ImagePixelRect` 是
  u32 整数 `{x,y,width,height}`，按 `image 0.24.9` 的 `crop_dimms` 语义裁剪：坐标取
  `min(x,width)`/`min(y,height)`，范围取 `min(requested,remaining)`，保留 0 宽/0 高与完全越界
  的 0x0，不强制 1px、不往返归一化、不把负宽取绝对值。F7 报告 Node 作业
  `20261104071616-5c130f` 与 Electron 作业 `20261104071617-c8597a` 各 5 passed、exit 0。
- **切换条件**：当前 main 的 `host/platform/native/image/api.ts` 仍只有 `dimensions`/`decodeRgba`，
  因此本 lane 暂时保留 `src/rgba-crop.ts` 做精确像素复制，并只把 PNG 编码委托给
  `nativeImage.encode`；L18 生产代码不手写 CRC/deflate/PNG。待 F7 合入 main 且依赖裁定到位后，
  改为 `const cropped = nativeImage.cropRgba(decoded, pixels)`，检查返回的 `width`/`height`：
  create `< 4` →「新增题目的分割框过小」，create 0 →「新增题目的分割框无效」，adjust 0 →
  「调整后的分割框无效 (0 宽或高)」，再 `nativeImage.encode(cropped, {format:'png'})`；随后删除
  `src/rgba-crop.ts` 并更新裁剪/编码测试。当前 `package.json` 不含 `pngjs`，L18 不导入该未批准候选；
  PNG 只经 F7 Context 编码，D5 的 PSNR 门禁仍未由本 lane 签收。
- **Office 生成/读取**：F7 分支的 `NativeOfficeWriter` 还提供
  `generateDocx/generatePptx/generateXlsx`、`editXlsxCells`、`readXlsxSpec`、`readXlsxTables`、
  `readXlsxMetadata`、`replaceXlsxText`。这些仍是未合并候选；DOCX/PPTX 编辑没有候选，生成不冒充
  编辑；XLSX 读取/编辑接入后仍须先跑容器大小/加密/ZIP 炸弹与保真度门禁，再做目标平台验证。

### Bilibili 命令的实现与已知差异（2026-11-04）

`media_bilibili_probe` / `media_bilibili_create` / `media_bilibili_import_subtitle` /
`media_bilibili_stream_quality` 已注册。`src/bilibili-attempt.ts` 实现出口选择、账号代次、
native/proxy/browser_bridge 路由、重试与 60 秒任务截止；`src/bilibili-link-items.ts` 实现
原子写入/复用链接条目；`src/bilibili-playback.ts` 实现按 `(条目, qn, epoch, attempt)` 复用播放会话。
`bilibili.rs` 的 3 个 pending 测试（含 live）已全部移植，`bilibili_stream.rs` 的 live 测试也已移植。

已知差异（不影响命令语义，但未达到逐字节等价）：

- `media_bilibili_stream_quality` 返回真实流地址：macOS/Linux `bilistream://localhost/{fileId}?qn=…&e=…&a=…`，Windows
  `http://bilistream.localhost/...`；`src/bilibili-protocol.ts` 在 Host 注册 `bilistream`，复用播放会话与
  Range/过期刷新/错误语义。前端仍保留自定义协议地址作为后端不可用时的回退；
- Rust `pipeline::refresh_index` 会立即重建转写时间窗词法单元；`index.ts` 优先调用 L13
  `ctx.vfs.mediaIndex.refreshTranscriptIndex(ctx.vfs.database, ctx.vfs.unitIndex, fileId)`，
  当前 main 尚未合并该 API 时回退到 `vfsIndex.indexing.indexResource` 并记录警告；
- `bilibili-live.test.ts` 默认跳过（`DS_BILIBILI_LIVE=1` 才执行），未做真实联网验证；
- `tests/bilibili-protocol.test.ts` 覆盖 OPTIONS/405/400、首块 64 KiB、后缀 Range、CDN 过期刷新一次、
  二次过期 502 与错误事件、HEAD 总长度、24s 超时；真实 B 站 CDN 仍未在目标平台联网验证。

### `mediaTranscriber` 提供者（2026-11-04）

L12 媒体任务调度器通过 `ctx.get('mediaTranscriber')` 调用本 lane；接口与 L12
`MediaTranscriberService` 一致（`fileId/tempDir/imported/signal/onProgress` →
`{transcriptChars,doneSegments,totalSegments,failedSegments}`）。`api.ts` 导出类型，
`index.ts` 注册 Cordis 服务并加入 `meta.provides`；`media_transcribe_start` 已注册。

- 实现：`src/media-transcriber.ts`（服务、ASR 后端构建、24 小时 spool 清理）、
  `src/pipeline.ts::transcribeResource`（queued → decode → vad → asr → 写转写文本）。
  解码、ASR、段持久化、`files.extracted_text` 与 `media_progress.duration_ms` 均由本 lane 完成；
  L12 只负责任务状态/事件、`imported` 判定与转写后的向量索引。
- imported：以 `mediaTranscripts.planInfo(...)[1] === 'import'` 为准；导入字幕只写转写文本并调用
  L13 `refreshTranscriptIndex`，不构建 ASR 后端、不占单飞槽。
- 索引：提供者只调用 L13 `vfs.mediaIndex.refreshTranscriptIndex`；最终 `indexResource` 由 L12
  `runMedia` 在 `transcriptChars > 0` 时调度，本 lane 不再替 L12 建调度 hook。
- 错误：ASR 配置错误映射 `AsrFatal`；取消映射 `MediaError('Cancelled')`；数据库/解码错误沿用
  `MediaError` 代码与文案。
- 测试：`tests/media-transcriber.test.ts` 3 个用例，含 Rust 同名
  `transcribe_resource_end_to_end_with_mock_asr_and_resume`、
  `transcription_is_single_flight_and_cancellable_while_queued`；`tests/media-commands.test.ts`
  断言插件发布 `mediaTranscriber`，并覆盖导入字幕的提供者路径与 `media_transcribe_start` 调度视图。
- 运行边界：当前 main 的 L12 `PdfProcessingService` 仍没有 `PdfStageRuntime` 媒体运行时；命令与
  提供者已可单测，真实 `startPipeline` 调度要等 L12 合并其候选 `runMedia` hook。未做目标平台
  ASR 网络签收。

### `convert_heic_to_jpeg`（2026-11-04）

- 注册：`index.ts` 注册并加入 `meta.commands`；契约 `L18-media-docs.json:210-235` 的 raw Request /
  `x-binary` 未改，前端仍按 `invoke<ArrayBuffer>('convert_heic_to_jpeg', bytes)` 调用。
- 输入：Host 已通过 `CallContext.payload` 暴露 raw invoke 载荷（无具名参数），本命令读取
  `Uint8Array`/`ArrayBuffer` 后交给 F7 `nativeHeic.convertToJpeg(body)`；JSON 载荷按 Rust
  `heic_decoder.rs:53-77` 的同一文案拒绝。静态链路上 `electron/shell/runtime.ts:276-297`
  把 raw 载荷作为 `args` 交给 Host；**真实 Electron 跨进程/跨平台 raw invoke 尚未验证**，
  本轮只在 `createTestHost` 中验证了 raw 载荷与桌面拒绝，不据此签收平台等价。
- 行为：只消费 F7 的桌面拒绝分支，逐字保留 `HEIC_INVALID_INPUT: expected raw binary request body`、
  `HEIC_INVALID_INPUT: empty image body`、`HEIC_INVALID_INPUT: image exceeds 50 MB` 与
  `HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android`。
  不接 libheif，不把桌面拒绝改成成功。
- Android 成功路径：Electron Host 目标为桌面，不实现 Kotlin 解码；桌面分支不产生成功值，
  因此不伪造 `ArrayBuffer` 成功，也不用 JSON 对象替代 raw。返回能力现状需区分：
  main 的 `electron/raw-bytes.ts` 已支持 `{__dstuRawBytes}` 信封（`read_file_bytes` 在用），
  但插件命令的公开 helper 仍未发布；F1 候选分支的 `host/kernel/commands.ts:72-97,237`
  另有 `x-binary` 的 `Uint8Array`/`ArrayBuffer` 直接返回与 raw 信封分支（**未合 main**）。
  若未来 Android Host 成为目标，先等 F1 该候选进入 main，再由本 lane 接 F7/Android provider。
- 测试：`tests/heic.test.ts` 覆盖 JSON、空 raw、`Uint8Array`/`ArrayBuffer` 桌面拒绝。

### `test_pdfium_status`（2026-11-04）

- 注册：`index.ts` 注册并加入 `meta.commands`；实现 `src/pdfium-status.ts`。
- 输出：`exe_path`/`exe_dir` 取 `process.execPath` 与其目录（JSON 转义形式对齐 Rust `{:?}`）；
  `load_result`/`parse_test` 由 F7 `nativePdfium.open(MINIMAL_PDF)` 的真实结果生成。
- 平台差异：Rust 诊断原生 `libpdfium` 候选路径（`pdfium_utils.rs:238-340`）并加载动态库；Host 的
  PDFium 是 WASM 适配器，没有原生库候选，故不输出伪造的 `candidate_N`。这不是成功占位：
  `load_result=OK`/`parse_test=OK, pages=1` 来自真实打开与页数读取，失败时写 `FAIL: {message}`。
- 错误：与 Rust `Result<HashMap, String>` 的“诊断总是 Ok、失败写进结果”一致；`nativePdfium`
  未提供时写 `FAIL: nativePdfium service not available`。
- 测试：`tests/pdfium-status.test.ts` 两个用例（真实 WASM provider 成功；缺失 provider 不抛异常）。

### `examSheetSession` 提供者（2026-11-04）

L14-qbank 的三个命令（`get_exam_sheet_session_detail` / `update_exam_sheet_cards` /
`rename_exam_sheet_session`）由 L14 注册；本 lane 提供 Cordis 服务 `examSheetSession`
（`api.ts::ExamSheetSessionService`，`index.ts` 加入 `meta.provides`），不注册这三个命令。

- 实现：`src/exam-sheet-service.ts`（VFS 读取、正式题目投影、资产归档、串行更新、重命名）、
  `src/exam-sheet-model.ts`（preview/metadata 编解码与 bbox 归一化/像素换算）、
  `src/rgba-crop.ts`（main 尚未发布 F7 `nativeImage.cropRgba` 时的临时精确像素裁剪；切换条件见上节）；
  PNG 编码调用 F7 `nativeImage.encode`，测试夹具编码器仅在 `tests/helpers/png.ts`，
  生产不保留第二套编码器。
- 错误：`ExamSheetSessionError.appError` 携带 Rust `AppError` 线缆值（`code`/`message`）；
  L14 若只透传 `AppError`，可直接读取该字段。
- 语义边界：正式题目存在或 metadata 有 `question_document_version` 时禁止改兼容预览；
  删除已关联错题卡片拒绝；`exam_name` 缺失/`null` 表示清空（Rust 重命名命令语义）；
  更新按 session 进程内串行，跨进程无锁。
- 测试：`tests/exam-sheet.test.ts`（12 个服务/插件用例，含 Context `nativeImage.encode` 消费与裁剪编码失败上下文 + Rust 同名
  `card_only_updates_keep_the_existing_name`、`explicit_names_rename_and_blank_names_clear`）。

### 语音输入用量记录（2026-11-04）

`voice_input_transcribe` 通过 F3 `host/platform/storage/llm-usage.ts` 写入
`llm_usage_logs`：`caller_type=voice_input`、`provider_id/model/config_id`、0/0 token、
`token_source=heuristic`、`duration_ms` 为请求耗时；端点解析失败与请求失败都记录，
失败错误为 `AppError.message`（缺省 `Unknown error`）。写库异常仅记录警告，不影响转写结果。
测试：`tests/voice-input.test.ts`（recorder 载荷）与 `tests/voice-usage.test.ts`
（真实 sqlite 插入）。

### 当前状态与下一步（2026-11-04 续作会话）

**基线**：本分支已合入 main（merge `24a42996a`，main 基线 `3b2758d7a`）。续作会话在
Linux 新机器上重跑：`npm run typecheck:host` 作业 `20261104083630-7c7fbe` 退出码 0；
`npx vitest run -c vitest.host.config.ts host/plugins/media` 作业 `20261104083630-5b822c`
59 个文件通过、1 个跳过（`bilibili-live.test.ts` 等待 `DS_BILIBILI_LIVE=1`），
`350 passed | 2 skipped`，退出码 0。HEIC 用例包含在该次运行中。加入
`test_pdfium_status` 后复跑作业 `20261104091447-158d25`：60 个文件通过、1 个跳过，
`352 passed | 2 skipped`，退出码 0。

**已完成（本轮可核对）**：

- `convert_heic_to_jpeg` 已注册（`index.ts:147`、`:270-290`），消费
  `CallContext.payload` 的 raw bytes，交给 F7 `nativeHeic.convertToJpeg` 完成 Rust
  桌面分支校验并返回逐字一致的 `HEIC_INVALID_INPUT*` / `HEIC_UNSUPPORTED_PLATFORM`；
  未接 libheif，未把桌面拒绝改成成功。测试 `tests/heic.test.ts`（JSON、空 raw、
  `Uint8Array`、`ArrayBuffer`），见上文专节。C1 08:55Z 审阅 `9c743b267`/`962465d64`
  后确认这是新增候选接线；真实跨进程 raw 与 Android 成功仍未签收。
- ASR 与 `mediaTranscriber` 提供者、Bilibili 四命令 + `bilistream` 协议、
  `examSheetSession` 提供者、voice usage、OCR 设置、PDF OCR 会话控制、
  `get_image_as_base64`/exam-sheet 的真实 `paths` 注入均已在既有提交中完成。
- `test_pdfium_status` 已用现有 F7 `nativePdfium.open` 实现（`src/pdfium-status.ts` +
  `tests/pdfium-status.test.ts`），实测 WASM provider 的最小 PDF 加载/解析；不伪造原生库
  `candidate_N`，见下文专节。
- 生产 PNG 编码已统一走 F7 `nativeImage.encode`，`src/png.ts` 已删除；
  测试夹具编码器仅在 `tests/helpers/png.ts`。
- 本地 `rustTrim` 副本已删除，`exam-sheet-model.ts` 复用 `host/platform/util`。

**ledger 现状**（`migration/ledger.json` 刷新后）：本 lane 命令 74 个，A 级 60 个
（81.1%），未注册 14 个；Rust 测试 243 个，A 级 231 个（95.1%），pending 12 个。
TESTMAP.md 的生成表头仍是旧的 “pending 166 / ported 77”，实际行与 ledger 以行内容为准
（12 行 pending）；下次 scaffold `--refresh` 会重建表头。

**剩余未注册命令与真实阻塞证据**（均为 main 当前缺口的符号，不是“本 lane 未做”）：

| 命令 | 阻塞点（main 当前） | 证据 |
|---|---|---|
| `compress_image`；`textbook_pdf_executor.rs::compresses_large_page_images_below_output_limits`；`vlm_grounding_service.rs` 的 3 个 crop/limit 测试 | `host/platform/native/image/api.ts` 只有 `dimensions`/`decodeRgba`；无 Lanczos3 resize、无 JPEG/PNG encode。F7 的 `encode`/`cropRgba` 仅在 `ds-mig/F7-native`，main 未合入 | `host/platform/native/image/api.ts`；`git show ds-mig/F7-native:host/platform/native/image/api.ts` |
| `notes_export_docx`；`docx_handout.rs` 的 3 个 pending；`docx/pptx/xlsx_executor` 的 4 个 g06 | `host/platform/native/office/api.ts` main 只有抽取接口且 `native/index.ts` 只 provide `nativeOfficeText`；无 `nativeOfficeWriter`。F7 分支的 `generateDocx/generatePptx/generateXlsx/editXlsxCells` 未合入；DOCX/PPTX 编辑仍无候选 | `host/platform/native/office/api.ts`；`host/platform/native/index.ts:18,33`；`git show ds-mig/F7-native:host/platform/native/office/api.ts` |
| `parse_document_from_path` / `parse_document_from_base64`；`document_parser.rs` 的 2 个 xlsx pending | 需要 Office 文本/表格抽取（`nativeOffice.extractText/extractTables`）。main 未 provide `nativeOffice`，仅 `nativeOfficeText`；F7 分支接口未合入。PDF 分支可走 `nativePdfium.extractText`，但命令必须对 DOCX/XLSX/PPTX 同样等价，不能只注册子集 | 同上；`host/platform/native/pdfium/api.ts` |
| `handout_llm_complete` | L02 `api.ts` 没有 `callModel2RawPrompt` / `call_model2_raw_prompt_opts`。`callRawPrompt` 只在 `host/plugins/llm/src/completion.ts`（api.ts 未导出，跨插件不得 import src） | `host/plugins/llm/api.ts`；`host/plugins/llm/src/completion.ts:188` |
| `handout_vlm_caption` | L02 `api.ts` 没有“指定 config_id + images 的 raw prompt”方法，也没有 Rust `VlmGroundingService::get_vlm_config` 的公开对应面 | `host/plugins/llm/api.ts`（`ImagePayload` 类型存在但无调用方法） |
| `test_ocr_engine` | L02 `api.ts` 没有 `testOcrWithEngine`；`llmOcrHedge` 是区域 OCR 的 prepare/run，语义不等于 Rust 的单引擎测试（含系统 OCR 分支与临时文件） | `host/plugins/llm/api.ts:99-105`；Rust `src/cmd/ocr.rs:612-733` |
| `init_pdf_ocr_session`、`process_pdf_ocr`、`start_pdf_ocr_backend`、`upload_pdf_ocr_page` | Rust `pdf_ocr_service.rs` 需要 `LLMManager::call_ocr_page_with_fallback()` 返回带 bbox 的 `Vec<ExamSegmentationCard>`（页面事件 `page_result.blocks`）；main L02 只发布 `llmOcrModels` 配置面和 `llmOcrHedge`（`prepareCandidates`/`runPrepared` 只返回字符串，无卡片/bbox、无同样的系统 OCR/熔断/重试语义）。`get_pdf_ocr_model_config` 本身可由 `llmOcrModels.getOcrModelConfig()` 等价替代，不是缺口；F7 `nativePdfium.render` 已可用 | `host/plugins/llm/api.ts:99-105`；Rust `src-tauri/crates/dstu-vision/src/pdf_ocr_service.rs:670,1020`；`src-tauri/crates/dstu-llm/src/llm_manager/exam_engine.rs:685` |
| `pin_images`、`unpin_images` | L22 只发布 `withTempSessions(Map<TempSessionIdentity>)`，没有 StreamContext 读取/修改/持久化面 | `host/plugins/integration/api.ts:40-47` |

| `textbooks_add` | 需要 Office/PDF 预览渲染（`nativePdfium.render` 已有）+ VFS 教材写入 + `PdfProcessingService.startPipeline`（已有）+ F3 `unified_file_manager` 的 URI 解析/大小/哈希公开面；main 未发布该 F3 服务，且本命令 838 行包含渲染进度、事件、恢复/挂载分支，不能用空实现注册 | `host/plugins/integration/api.ts`（无 file manager）；`host/plugins/vfs-index/api.ts:217-229`；Rust `src/cmd/textbooks.rs:114-700` |

**下一步顺序**（待对应接口合入 main 后）：

1. F7 `nativeImage.encode` + `cropRgba` 合入 main：切换 exam-sheet 裁剪到 `cropRgba`、删除
   `src/rgba-crop.ts`，再注册 `compress_image` 并移植 4 个图片 pending 测试。
2. F7 `nativeOffice.extractText/extractTables` 合入 main：注册 `parse_document_from_path` /
   `parse_document_from_base64`，补 2 个 xlsx pending。
3. F7 `nativeOfficeWriter` 合入 main：先 `notes_export_docx`、再 3 个 docx_handout pending；
   DOCX/PPTX 编辑（2 个 g06）需 F7 新增候选后再做。
4. L02 发布 raw prompt / VLM / OCR 测试与 `get_pdf_ocr_model_config` 后：`handout_*`、
   `test_ocr_engine`、四个 PDF OCR 命令。
5. L22 发布 StreamContext 面后：`pin_images`/`unpin_images`。
6. F3 file manager 公开面后：`textbooks_add`。（`test_pdfium_status` 已于 2026-11-04 用现有 `nativePdfium.open` 实现。）
7. 每个单元按「先移植 Rust 测试 → 实现 → 接入 → 最小集 job → 提交」推进；跨平台行为
   （Android HEIC、macOS/Windows 原生）无目标环境时不签收。

### 2026-11-04 22:55 主线复核（6 条）
pin_images、unpin_images、textbooks_add、compress_image、parse_document_from_base64、parse_document_from_path：均仍阻塞，未注册，证据见 BLOCKERS.md 同日“22:55 复核”节。OCR 5 条由 H1（ds-mig/L18-media-docs-h1）、handout 两条与 notes_export_docx 由 H2（ds-mig/L18-media-docs-h2）负责。

### 2026-11-04 23:25 向 L14 发布栅格化与 DOCX 带图抽取（自检通过 a04c7f571）
- `pageRasterizer` 服务（`api.ts::PageRasterizerService`，`src/page-rasterizer.ts`）：`rasterizePdfCancellable(base64, signal?)` 对应 `page_rasterizer.rs::rasterize_pdf_cancellable`（pdfium-render target_width 2550 / maximum_height 4200 的 f32 尺寸算法、JPEG q75、逐页写 L11 `vfsRepo.blobs.storeBlob`、逐页前检查取消、Rust 错误文案与类型）；`rasterizeImages(content)` 对应 `rasterize_images`（单个/JSON 数组、Data URL、头部探测尺寸、1.2 亿像素上限、`detect_image_format`）。错误为 `CommandError(AppError)`。
- `docs.extractDocxWithImages(bytes)`（`src/docx-images.ts`）：对应 `document_parser.rs::extract_docx_with_images`，按 docx-rs 0.4.19 读取模型（局部名分派、run 内 `w:`/`mc:`/`v:` 前缀、sdt/sectPr/Fallback/文本框不出字、drawing 末个 pic 生效、`replace_escaped`），rels 图片表与各上限一致。已知差异：docx-rs 对样式/编号/批注/属性值解析失败的报错路径未复现（只复现包/文档读取的 `Failed to read from zip.`/`Failed to read xml.`）。
- 测试：`tests/page-rasterizer.test.ts`（10，经 `host.ctx.pageRasterizer`，含真实 nativePdfium 渲染）、`tests/docx-images.test.ts`（5，经 `host.ctx.docs`）。Rust 无对应单测，均为生产入口契约测试。作业 `20261104150640-69c438`；lane-gate 作业 `20261104151551-d87d9c`、`20261104151706-*`。
- 合并说明：H2（`a648399df`）曾被提前合入（`b5b2fa99f`），已用 `32a36b38b` revert；pngjs/jpeg-js（或 F7 sharp 编码）进 main 且 H2 测试转绿后，需先 `git revert 32a36b38b` 再合 H2。H1 等 L02 OCR 接口进 main。
- 6 条命令：pin/unpin 待 L22 `modifyTempSession`（分支 `780b9b9e6`）进 main；compress_image 待 F7 sharp 编码（分支 `9252ace96`）进 main；parse_document_* 与 textbooks_add 仍缺 F7 nativeOffice 抽取与 F3 文件信息接口。

### 2026-11-04 23:50 notes_export_docx 与 compress_image 合入（自检通过 da11716b2，基线 main 1e893eb61）
- `notes_export_docx`：先 `git revert 32a36b38b`（撤销对 H2 的 revert），再合 `ds-mig/L18-media-docs-h2`（`6dd6f9cad`）；main 已有 pngjs/jpeg-js（D10 `4525e11ac`），`tests/notes-export-docx.test.ts` 5 条全绿。
- `compress_image`（`crates/dstu-media/src/cmd/media.rs:54-149`）：`src/compress-image.ts` 经 F7 `nativeImage` 解码 → `resizeDimensions` 包围盒 + Triangle 缩放（不放大，max_edge `.max(1)`）→ JPEG（quality clamp 10..=95，jpeg-js 丢弃 alpha 同 `to_rgb8`）；sourcePath 优先、file 模式写 `dstu_compressed_<uuid simple>.jpg`；Rust 错误文案逐条一致，错误为纯字符串。测试 `tests/compress-image.test.ts` 4 条经 `host.invoke`（作业 `20261104153506-f3a204`）。
- BLOCKERS L18-B03 的 compress_image 部分已解除。
- 仍未注册：`pin_images`/`unpin_images`（等 L22 `modifyTempSession` 进 main，分支 `a4d9acb09`）；`parse_document_from_path`/`parse_document_from_base64`/`textbooks_add`（等 F7 `nativeOffice` 与 F3 文件信息接口）；`init_pdf_ocr_session`/`process_pdf_ocr`/`start_pdf_ocr_backend`/`upload_pdf_ocr_page`/`test_ocr_engine`（H1 分支，等 L02 OCR 接口）；`handout_llm_complete`/`handout_vlm_caption`（等 L02 在 `llm` 服务发布 `callModel2RawPromptOpts`/`callRawPromptWithConfigIdAndImages`，main 与 `ds-mig/L02-llm-manager` 均无）。

### 2026-11-05 00:30 pin/unpin 合入；DocumentParser 格式补齐（自检通过 0cdcdf576，基线 main 677f6727c）
- `pin_images`/`unpin_images`（`src/commands.rs:356-395`）：`src/pin-images.ts` 经 L22 `appCommandState.modifyTempSession`（main 已有），NotFound 先于设置写入传播；`pinned_images:<id>` 设置镜像失败忽略（Rust `let _ =`）。`tests/pin-images.test.ts` 5 条，真实 integration 插件 + 迁移后的 `temp_sessions`；会话 None 按 `skip_serializing_if` 省略字段（作业 `20261104160519-4e047c`）。
- DocumentParser（`dstu-docs/src/document_parser.rs`）：pdf 经 F7 `nativePdfium`（bytes 门禁名 `document.pdf`、path 用真实名并先查 metadata 大小）；csv 经 `nativeOfficeText`；json = serde_json `preserve_order` + `to_string_pretty`（`src/text-formats.ts`，数字 ryu）；xml = quick-xml 0.37 `trim_text` Text/CDATA 扫描（错误即停、无文本返回原文）；docx/pptx/rtf/html/xlsx/xls/xlsb/ods 先跑 L18 门禁（bytes：`document.docx`/`presentation.pptx`；excel 仅 xlsx/xlsb/ods 门禁；path 用真实名、excel 错误前缀“无法打开Excel文件”）再调 F7 `nativeOffice`；引擎缺失时为 UnsupportedFormat。`docs.extractPagedTextFromBytes` 发布（pptx/epub）。`extractTextFromBytes/Base64` 改为 async。测试 `tests/document-formats.test.ts` 7 条（真实 F7 引擎），`document-parser.test.ts` 35 条（作业 `20261104161447-4bf655`）。
- 已知差异：excel path 入口 Rust 用 `open_workbook_auto(path)`（按扩展名分派），F7 引擎为 bytes 嗅探；仅影响扩展名与内容不符的文件。pdfium 加载失败的 PdfiumError Debug 文本不逐字一致。
- 未注册：`parse_document_from_path/base64` 等 F7 `nativeOffice` 的 xlsx/xls/xlsb/ods/html 引擎进 main（main 当前 `formats` 只有 docx/pptx/rtf，不注册子集）；`textbooks_add` 等 F3 文件信息接口进 main；handout 两条等 L02 `llmRawPrompt` 进 main（代码与 8 条测试已备，作业 `20261104155238-48d6e0`）；OCR 5 条等 L02 OCR 接口与 H1。

### 2026-11-05 03:40 handout ×2、parse_document ×2、OCR ×5 合入；DocumentParser 去重
- `handout_llm_complete`/`handout_vlm_caption`（`src/cmd/handout.rs:74-127`）：L02 `llmRawPrompt@1`（main）；`get_vlm_config` 由本 lane 移植（`vlm_grounding_service.rs:1364-1494`，`src/handout-llm.ts`）。`runCancellable` 改为惰性启动，取消/完成后落败一方不再产生 unhandled rejection。`tests/handout-llm.test.ts` 8 条（作业 `20261104192718-2f5ec0`）。
- DocumentParser 去重：主线（`5f91218b0`/`0cdcdf576`）与 H2（`d1db951dd`/`71ac84afe`）并行做了同一批工作。合并 H2 时逐项取舍，只保留一份：`text-formats.ts`、`document-parser.ts`、`document-commands.ts` 与测试取 H2（quick-xml 错误 Display 文案、DOCTYPE 名检查、测试更全）；从主线保留 `docs.extractPagedTextFromBytes`、Excel path 入口错误前缀改写（`无法解析Excel数据`→`无法打开Excel文件`）；main 的 F7 已提供 8 种 WASI 引擎，删除 `OfficeEngineUnavailableError` 分支，引擎缺失测试改为真实 xlsx/html 与 pptx 分页测试。主线的 `parse-commands.ts` 草稿未入库。
- `parse_document_from_path`/`parse_document_from_base64` 已注册（`src/commands.rs:4094-4146`）。
- OCR 5 条（`init_pdf_ocr_session`/`start_pdf_ocr_backend`/`upload_pdf_ocr_page`/`process_pdf_ocr`/`test_ocr_engine`）：合入 H1（`83e4275bb`，对齐 L02 `llmOcrPages@1`）；系统 OCR 原生绑定见 BLOCKERS L18-B07（F7）。
- media 全量测试 69 文件 426 通过（作业 `20261104193716-5222f9`），tsc `20261104193616-ad1309`。
- 剩余：`textbooks_add`（F3 文件信息接口已进 main，移植进行中）。
### 2026-11-05 textbooks_add 已注册（命令 A 级收尾）
- `textbooks_add`（`src/cmd/textbooks.rs:114-700`）：`src/textbooks-add.ts`，注册于 `index.ts`（`159fbc8ae`）。`files` 两条窄写、PDF 预览进度均经 L11 所有者接口（`textbooks.updateTextbookOcrPagesJson`/`markTextbookRenderError`、`attachmentProcessing.renderPdf(..., progress)`，L11 `78b205e51` 已进 main）。事件按裁定全局广播（Tauri 2 `Window::emit`）；保留 Rust 重复导入返回恢复前快照的行为。
- 测试 `tests/textbooks-add.test.ts` 16 条，全部走 `host.invoke('textbooks_add')`（作业 `20261104220614-89e125`）。
- merge main `42a0f9e4a` 后 lane-gate 自检全部通过（`40f502506`）。本 lane 命令已全部注册。
- 待办（不在本次范围）：`textbooks_relink` 的 `dstu:change*` 仍发给调用窗口，按同一裁定应改为全局广播。
### 2026-11-05 H3：`questionImportVision` 提供者（dstu-vision Stage 2–5，供 L14 `resume_question_import` 旧 checkpoint）
- 分支 `ds-mig/L18-media-docs-h3`。服务 `ctx.questionImportVision`（`api.ts::QuestionImportVisionService`，
  `questionImportVisionService = {name:'questionImportVision',version:'1.0.0'}`），实现 `src/question-import-vision.ts`。
- `analyzePageByBlob` / `analyzeSinglePage` / `describeImage`（`vlm_grounding_service.rs:349/367/487`）：候选 = `handout-llm.ts`
  的 `get_vlm_config_candidates`（同一份移植），逐个 failover；请求经 L02 `llmStreaming.singleShotCompletion`。
- `extractDocxQuestionsStream`（:596）：图片预检/缩放/JPEG 85→55 经 F7 `nativeImage`；请求经 L02 `providerAdapterForConfig` +
  `prepareProviderRequest`（Codex OAuth 走 L01 `llmCodexAuth.sendStreamWithSingleRefresh`），SSE = 平台 `SseEventBuffer`，
  增量解析 = L02 `IncrementalJsonArrayParser`；重试 3^n 秒、120s 空闲超时、16MB 字节预算、回调中止、完整解析回退逐分支对照。
- `mergePages`（cross_page_merger.rs:26）、`extractFigures`（figure_extractor.rs:29，裁切 = `nativeImage.cropFigure`，
  blob/文件 = L11 `vfsRepo.blobs.storeBlob` / `files.createFile`）、`structureQuestions`（llm_structurer.rs:63，经 L02
  `llmQuestionParsing.parse`；批结果按 serde_json `Value` 精确再序列化）、`loadPageImageBytes`（page_rasterizer.rs:443）、
  `decodeVlmPageAnalysis` / `encodeVlmPageAnalysis`（checkpoint `vlm_page_results` 的 from_str/to_string）。
- 类型（serde 字段名/序）：`VlmPageAnalysis` / `VlmQuestion` / `VlmFigure` / `VlmExtractedQuestion` / `MergedQuestion` /
  `QuestionWithFigures` / `StructuredQuestion`，均在 `api.ts`。
- 测试：`tests/question-import-vision.test.ts`（经 `host.ctx.questionImportVision`；移植 Rust 测试
  `test_prepare_docx_image_resizes_and_enforces_hard_output_limit`、`test_crop_figure_default_bbox_yields_minimal_crop`、
  `test_crop_figure_inverted_and_out_of_range_bbox`、`reusable_batch_result_distinguishes_failure_from_success`）。
- 已知差异（如实记录）：①流式路径的题目对象来自 L02 `IncrementalJsonArrayParser`（JS 数值），`image_indices` 中 `1.0`
  这类浮点字面量会被当作整数接受（Rust `from_value::<usize>` 拒绝）；完整文本解析路径（`parse_*_response`、checkpoint）
  使用 `parseJsonDocument` 精确区分。②DOCX 流式请求用全局 `fetch`（Rust 自建 reqwest，connect timeout 30s；undici 默认
  connect timeout 10s）。③`&s[start..=end]` 在 `]` 位于 `[` 之前时 Rust 会 panic，TS 返回空串后按解析失败处理。
- 依赖 L02 未发布的纯函数：`ZhipuAdapter::supports_thinking_static`、`sanitize_url_for_log`、`is_retryable_http_status`
  暂按 L02 实现逐字内置于 `src/l02-unpublished.ts`（见 BLOCKERS.md L18-B-VLM-1），发布后改为引用。
  `DIFFICULTY_RUBRIC`（F4 dstu-core）同理内置于 `src/prompt-contracts.ts`。
### 2026-11-05 F4 Value/arbitrary_precision 消费（L18 四诊断闭环）
- 正常组合树：先合 F4 完整 provider `71f7a3d10`（merge `8c50204ec`），再合真实 owner 分支
  `ds-mig/L14-qbank`（含 L22 `f300427bf`、L14 `34402a1ff`/`1eb1fef75`，merge `c2539a6bf`），
  不用复制文件；主机 `tsconfig.host.json` 作业 `20261105095410-7a6441` exit 0。
- `text-formats.prettyJson`、`vlm-serde.serializeJsonNode`、`vlm-serde.valueFromNode` 全部消费 F4 正式面
  `jsonNumberToRawJSON` / `stringifyJsonValue`；删除本 lane 的 raw 正则 formatter、atom 类型识别与自定义
  clone，不维护第二套 formatter。
- `valueFromNode` 只把“整数 token 且落在 JS safe integer”投影为 number；小数/指数/超 2^53 整数保留 F4
  raw atom，因此 `1.234567890123456789`、`1e-400`、`9007199254740993` 经 `JSON.stringify` 均逐字保真。
  旧 `alignByLabel` 的自定义深拷贝同时删除（Rust clone 不可观察，调用方不修改）。
- 数制依据（locked serde_json `1.0.149`，`src-tauri/Cargo.lock:11347-11349`）：`de.rs:1027-1050`
  `scan_exponent` 写小写 `e` 且无符号时补 `+`；`number.rs:350-366` `Display` 在 arbitrary_precision 下写
  存储的 raw；`de.rs:938-1000` 把整数拼写 `-0` 解析为 `i64(0)`。生产 app 同时依赖 `dstu-docs` 与
  `dstu-vision`（`src-tauri/Cargo.toml:314,329`），后者显式开 `arbitrary_precision`
  （`dstu-vision/Cargo.toml:34-37`），Cargo 特性统一使 `document_parser.rs:4075-4086` 的
  `Value` + `to_string_pretty` 输出 `1e+2`/`0`（非 ryu `100.0`/`-0.0`）。typed from_str 仍拒绝非有限
  数字，两者未混用。
- 未闭合的真实跨 lane 边界：`StructuredQuestion.json` 在进程内已逐字保真，但 qbank
  `question_import_progress` 把 `item.json` 交给 `ctx.backendEvents.emit`；kernel
  `host/kernel/json.ts::toWireJson` 会把 `JSON.rawJSON` 原子复制成普通 `{rawJSON:"…"}` 对象
  （`findNonJson` 也不会拒绝），即高精度数在 IPC 事件上会逃逸成对象。需要 kernel/F1 owner 在
  `toWireJson` 识别 raw atom（或 qbank 在 emit 前用 Value 文本/等价无损线格式），本 lane 不越权改
  kernel/qbank 实现。L18 自有返回面（Cordis service）不直接走该 IPC 序列化。
- 测试：`tests/json-value-numbers.test.ts`（任意精度/高精度小数/from_value vs from_str/usize），
  `document-formats.test.ts` 保留原断言并记录上述 Rust 依据；定向 3 文件 31 passed（作业
  `20261105095315-5f5484`，exit 0）。
### 2026-11-06 WP-105 upload OCR worker 退出关闭接收端（D1-L18-M04）
- Rust：`run_worker` 按值持有 `mut page_rx`（`dstu-vision/src/pdf_ocr_service.rs:880`），配置失败
  `return`（:903-920）、正常结束（:1153 后函数返回）、panic 展开都会 drop 它；`add_page` 的
  `page_tx.send(prepared).await`（:150-153）随即返回 Err → `AppError::new(Unknown, "OCR session closed")`。
- TS 原先只在 backend 的 `renderChannel`（`src/pdf-ocr-service.ts` 原 :615）调 `closeReceiver`；upload worker
  任何退出都不关接收端，第 33 页起的 `upload_pdf_ocr_page` 永久挂起。现在 `startSession` 对
  `runWorker(...).catch(崩溃日志).finally(closeReceiver)`，三条退出路径统一关闭，顺序为 Completed/崩溃日志 → 关闭。
- 测试（`tests/pdf-ocr-service.test.ts`，经 `init_pdf_ocr_session` + `upload_pdf_ocr_page` 真实命令与真实
  `BoundedChannel`）：正常结束 / 配置失败 / 异常退出三条各自先让第 33 次上传阻塞在满通道上（图片已落盘、
  promise 仍 pending），worker 退出后断言它与下一次上传都以 `{error_type:'Unknown',message:'OCR session closed',details:null}`
  拒绝，且被拒页图片仍已保存。修复前 3 条全红（作业 `20261105171605-b1f41d`）。
- 当时差异（现由 WP-138 修复，见下）：Rust JoinSet 隔离单页 task panic；TS 原 `Promise.all` 会冒泡成
  worker 崩溃、不发 Completed。WP-105 异常退出用例现改从外层 finished logger 故障触发，原关闭断言/预算全部保留。
### 2026-11-06 WP-106 media_progress 预期数据库错误回到 database-failed（D1-L18-M03）
- Rust：`commands.rs:533-567` 每一步都 `map_err(err)`：`load`（`pipeline.rs:114-137`：`get_conn_safe()?` 经
  `From<VfsError>`，查询非 NoRows 错误 → `Database(rusqlite Display)`）、`get_conn_safe().map_err(|e| err(e.into()))`
  （:540,:555）、`get/set_progress_with_conn(..).map_err(|e| err(e.into()))`；`mod.rs:82,93-117` 统一输出
  `{"code":"database-failed","message":..}`。
- TS 原先 `mediaFailure` 只认 MediaError/BiliRequestError，VfsError、StorageError、VfsRepositoryError 都被
  kernel 当成 HandlerPanic。现在 `src/media-commands.ts` 只在这三个位置转换已知类型：`mediaConn` 转
  VfsError，`loadMediaFile` 转 StorageError，progress 读写转 VfsError/VfsRepositoryError；其余异常原样抛出。
  `loadMediaFile` 被其他命令共用，它们的同类 SQL 失败也随之按 Rust 报 database-failed。
- 测试（`tests/media-commands.test.ts`，真实命令 + F3 存储 + L11 MediaTranscriptRepo）：连接 Maintenance/Pool、
  写触发器 RAISE、列类型错误、media_progress 表缺失、files 表缺失逐步断言原 message；写失败后旧行不变；
  缺失文件仍先报 NotFound；TypeError/RangeError/普通 Error 仍是 HandlerPanic。修复前红（作业 `20261105175137-c8a60a`）。

### 2026-11-06 WP-163 mediaLearningSummary watchedMinutes 精确整数除法（R2 N2）
- Rust：`ledger.rs:265-319` 用 `row.get::<_, i64>(4)` 读 watched_ms，`:317` 算 `watched_ms.max(0) / 60_000`（i64 截断除法）。
- TS 原先先把 watched_ms 读成 Number 再 floor：9007199254799999 → 150119987580，Rust 得 …579（R2 VERIFY-009 已复现）。
  现在 `repository/media-ledger.ts` 的查询带 `safeIntegers`，bigint 上算 `max(0)/60000n` 再转 number（最大
  153722867280912，小于 2^53，无损）。SQL、筛选、`ORDER BY updated_at DESC`、LIMIT、错误抛出都没变。
- 同一行的其它 i64 列保持原投影：position/duration 先 `int()` 投成 Number，再 `/1000` 并饱和到 u32
  （2^53 以内精确；超过时结果已在 u32::MAX 处饱和），`lastWatchedAt` 仍按 f64 投影；REAL/TEXT 输入仍走原 Number 路径
  （类型错误语义不在本包范围）。
- 测试 `tests/media-ledger.test.ts` 用例 `WP-163 …`（经 `ctx.media.mediaLearningSummary`）：N2 反证值、59999/60000/119999
  边界、i64::MAX、普通值 1920000→32、排序。改回旧表达式后该用例红（作业 `20261105193123-3175d2`，期望 …579 实得 …580）。

### 2026-11-06 WP-204 公开生产 MediaError（供 L12 WP-192 N1）
- `api.ts` 直接重导出 `src/errors.ts` 的生产类；L12 可以仅从公开 API 导入并识别 provider 拒绝值，读取 `code/message/toPayloadString`。
- 行为与来源见 SPEC「提供者服务 mediaTranscriber」；测试经真实注册服务触发 ASR 缺配置与 pipeline 取消，未替换错误映射。
- 本包不修改 TESTMAP 去向：实际行统计 pending 7、ported 236（生成表头为历史统计）。WP-138/110/167 留待后续工作包；WP-163 保留。

### 2026-11-06 WP-138：OCR 单任务隔离与 Started WARN
- 开工正常 fast-forward 到 main `a3bcecd4e`，WP-163/204 的完整历史已保留；本包无新增跨 lane 接口需求。
- 语义源为 `dstu-vision/src/pdf_ocr_service.rs`：upload 达到总页数时 :1094-1097 静默 drain；通道关闭/取消的
  最终 drain :1111-1117 及 backend :798-804 才记 task panic ERROR。`OcrTaskSet` 保留已完成结果至 drain，
  按完成次序记录异常并继续；`ocrTask` 原业务错误仍按重试/PageFailed 计数，不把 panic 计入 failed_pages。
- upload Started 直接发送，失败记 :896 的 WARN `[PDF-OCR] Emit error: ...` 再继续；backend Started 的
  `let _ =`（:576）及其它进度事件继续按原规则处理。Completed/finished INFO 仍在 drain 后。
- 测试直接走已接线生产类的公开 startSession/addPage（真实文件/真实 channel）及真实 Host 命令，
  未替换 worker/ocrTask/join；L02/F7 端口提供可控输入。bbox getter 故障发生在生产卡片映射中，
  与 provider 拒绝的 AppError 分开验证。raw 同步记录事件与 logger，断言 panic → 其它页 → Completed。
- 覆盖：最终/总页数两种 drain、backend 混合 panic/业务失败/成功、提前完成的全部任务失败、取消保留旧页且
  晚页不发事件、Started 发送失败后的正常/配置失败分支；WP-105 三条满通道关闭断言与既有 OCR 回归继续执行。
- 已有 Rust 源无本文件单测，TESTMAP 去向保持 pending 7 / ported 236；这是生产分支测试证据，未签全域/平台等价。
