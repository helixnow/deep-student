# L13b migration handoff

> Superseded by [QUALITY-REPORT.md](QUALITY-REPORT.md) for protocol-v2 acceptance.
> The earlier 157 registrations / 63 proposed ports below are historical, not a
> production-completion claim. Current wiring input has 56 ports and eight pending
> rows. Table-owner maintenance calls now require an explicit upstream service;
> the preserved SQL implementations are exercised only by the test provider.

## Status (2026-11-04)

- `meta.lane = L13-vfs-api`; 157/160 non-DSTU command adapters registered. Registration is **not** a claim that every upstream runtime is available.
- Still unported: `vfs_upload_attachment`, `vfs_upload_file`, `vfs_download_paper`. These require the attachment upload/staged-file lifecycle and transactional PDF-preview/blob saga described below.
- All authored changes are under `host/plugins/vfs-handlers/`. Main was merged before the feature commits; coordinator WIP checkpoints also contain parts of each unit.
- 16 test files / 153 tests passed. Evidence: `vitest-results.json`.
- `npm run typecheck:host`: passed.
- `npm run migration:boundaries:strict`: global failure (249 violations: 213 console-log, 36 empty-catch); **zero violations in this lane**. Five cross-plugin imports in the integration harness have explicit boundary-allow explanations.
- `npm run migration:ledger -- --check --no-write`: global failure (0 command problems, 341 test mapping problems, 0 orphan registrations). No `dstu-vfs` test mapping problems. Main/coordinator updates changed global coverage during execution.
- Read-only ledger diagnostic: full L13 has 191/214 command A (89.3%), 128/381 test A (33.6%). L13b's new mappings are in `TESTMAP-report.md` for the coordinator to apply to `host/plugins/vfs/TESTMAP.md`.

## Completed units in this continuation

- Resource references: 3 commands, all 27 `ref_handlers.rs` tests, PDF/image injection modes, OCR byte-length selection, compressed page-image preference, essay sessions, retrieval snippet fallback, bounded batch resolution.
- Unified index administration: 7 command adapters; four Rust reset tests plus rollback-on-resource-write-failure coverage. Unit reset uses one IMMEDIATE transaction. Index deletion retains orphan-queue cleanup and per-modality partial-failure results.
- Five media cache/OCR/text-chunk commands, two resource status/diagnostic commands, and `filestream_check_access` using F2's `app.pdfStreamAllowedDirs` request.
- Eleven mindmap command adapters with an unpublished-service contract and tests; seven attachment/config commands (four config commands use real L11 folders and local repository SQL; three attachment commands need L11's attachment service).
- Ported the five remaining handlers.rs embedding/RAG/multimodal DTO tests. Explicit multimodal query mode now removes the other modality, and flat scores retain Rust f32 precision.
- Updated L12 service injection to `vfsIndex` / `retrieval`; consumed its newly published Lance diagnostic/delete and multimodal methods. Connected L18's newly published `docs` service and installed its real plugin in the integration harness.
- Replaced the prior hardcoded vector-ready flag with the actual F7 `vector` provider presence. Vector write commands reject before mutating/claiming rows in Lance-less hosts.

## Remaining runtime dependencies / minimal interfaces

| Owner | Required publication | Affected paths |
|---|---|---|
| L11 | `vfsMindmaps: MindmapService` from `src/mindmaps.ts` (create/get/content/version history/restore/update/delete/list/favorite) | 11 mindmap commands; tested using `tests/mindmaps.test.ts` service double; no production implementation substituted |
| L11 | `vfsAttachments: AttachmentService` from `src/attachments.ts` (`getById`, `resolveFileId`, `getContent`, `getContentBounded`, `deleteAttachment`) | attachment metadata/content/delete; tested using `tests/attachments.test.ts` service double |
| L12 | `vfsUnitBuilder: UnitBuilderService.syncResourceUnits(SyncUnitInput): VfsIndexUnit[]` from `src/index-admin.ts` | `vfs_sync_resource_units`; adapter tested, real builder still absent |
| L12 | `multimodal.processPendingBatch(limit): Promise<[success, failed]>` | mm/both unified batch indexing; minimal `MultimodalBatchService` plus test double |
| L14/L16 | `qbank@1.contextForRefs(examId)` returning the canonical JSON document (`schema_version`, `exam_id`, `materials`, `groups`, `questions`), or publish an equivalent API | exam reference resolution; minimal `QbankRefReader` in `src/ref-needs.ts`, tested in `tests/refs.test.ts`. Existing canonical-text method is not equivalent to Rust's JSON context |
| L02 | `callModel2RawPrompt` (`src/llm-needs.ts`) | todo AI breakdown |
| L02 | `getEmbeddingModelConfig`, `adoptDefaultMultimodalEmbedding` public service methods | embedding defaults/readiness currently use the local Rust fallback chain in `src/embedding.ts` |
| L02/L12 | real multimodal page/source embedding pipeline | `vfs_multimodal_index`, `vfs_multimodal_index_resource`; methods are published but L12 currently throws a missing-pipeline error |
| F7 | live `vector` provider | vector write commands correctly reject while absent |
| L17 | note deletion consumer registration | this lane publishes `vfs.hooks@1`; downstream note-delete continuations must register |

The unpublished dependency names above are proposals, not aliases for existing providers. Coordinate their final names before integration. Production paths fail explicitly when these services are absent; references retain Rust's per-item `found:false` recovery.

## Three remaining upload commands

- `vfs_upload_attachment`: needs L11 `VfsAttachmentRepo` upload variants (`maxUploadSizeBytes`, `uploadWithFolder`, `uploadBytesWithFolder`, `uploadMediaStreamWithFolder`), F2 staged-upload take/read-bounded/disposal, created-resource hooks, and L12 unit synchronization. Preserve media streaming (4 GB limit), staged upload precedence, reused-file resume behavior, compression readiness and PDF classification. Do not replace this with a base64-only upload.
- `vfs_upload_file`: needs the full byte/staging/blob saga and `render_pdf_preview` integration through published L11/L18 APIs. L18 document text parsing is now available, but that alone does not implement the upload's preview/OCR/index state transitions and compensation.
- `vfs_download_paper`: needs the download-policy and PDF-preview/blob saga, including concurrent dedupe compensation, index retry marking and asynchronous PDF pipeline startup.
- `index_service.rs::tests::sync_resource_units_uses_single_pool_connection` remains unported until the real unit builder is published; the adapter double does not prove this invariant.

## Rust behavior retained / issues for coordinator

- Cache statistics inspect only preview `blob_hash`; cache clearing accepts both snake_case/camelCase. `filesReset` counts operations, so one file can be counted more than once. Freed bytes are reference sizes, not a verified physical-space delta.
- OCR display uses `[OCR_FAILED]`, while normalized reference OCR uses `__OCR_FAILED__`. OCR display `charCount` and extraction thresholds count UTF-8 bytes.
- Resource index list and aggregate MM fallback differ. The legacy folder filter joins `resources.id = folder_items.item_id`. `stateFilter` affects only the list. Diagnostics accept but ignore `resourceId` and include deleted resources, matching Rust.
- Resource reference counts stop collecting once maxItems is reached; totalCount need not describe all requested ids. Essay sessions prioritize the `essay_session_` prefix over `essay_`.
- Attachment metadata accepts `att_`/`file_`, delete accepts only `att_`, content additionally accepts `tb_`/`img_`/`res_`. Ordinary content read failures return `{found:false,error}`, while id/lookup/img-size failures reject.
- No cross-lane TESTMAP, contracts, kernel, platform, or repository implementations were edited to close dependencies.

## Commit trail

- Previously completed units: `dabd1f20c`, `ed924507c`, `219b1ce2c`, `f23b2c271`, `4a02185d1`, `69d383157`.
- This continuation's verified unit commits include `b875a1e3e` (references) and `bf619bd88` (index/cache wiring); coordinator WIP commits contain their preceding implementation edits. The final continuation commit contains this handoff, mapping report and final command wiring.
