# L01 external dependencies (v2, updated 2026-11-05 for WP-017)

Only external dependencies are listed. Self-owned audit work (serde/log maps) is tracked in LANE.md.

| Item | Owner / required interface | Evidence in current main | Remaining condition |
|---|---|---|---|
| V2-02 / X6-UD-0040 exact stream usage consumer | L02/L03/F3: see [USAGE-PRECISION.md](USAGE-PRECISION.md) for minimal Usage-only public type and same-batch production/SQL/wire changes | After merge main `5b1b19055`, F3 `storage/api.ts:668-680` publishes LlmUsageService and `storage/index.ts:157-165` actually provides `llmUsage`; missing-provider condition is resolved. L02/L03 still need the exact Host-value chain | Lossless Usage through Host hooks/snapshots, exact Rust u32 narrowing before calling the existing owner recorder, and real SQL/final-wire verification. Do not re-request an already published F3 service or equate its availability with complete precision integration |
| V2-02 / X6-UD-0040 ToolCall cross-owner numeric handoff | Actual aggregation / execution / final-boundary owners assigned by C1/architecture; see [TOOLCALL-PRECISION.md](TOOLCALL-PRECISION.md). L01 api.ts adds `cloneProviderToolCall` / `stringifyProviderToolCall`; no event-union change | Standard OpenAI arguments strings remain intact in L01; confirmed standard parse loss is L02 tool_calls.ts:81. Nonstandard objects require metadata-aware copy/serialization before losing numeric facts; providing exact helpers does not make existing consumers use them | Owner consumes the minimum seam or agrees a ToolCall-specific lossless contract. Do not independently dispatch parked L02 or edit its files. Unknown pre-parsed args_json/unreviewed protocols remain unknown; lack of chatToolRuntime and full model→L05 chain is not signed by adapter tests |
| L01-02 native OCR | C2/F7: real `SystemOcrNativeBinding.performSystemOcr(Uint8Array): Promise<string>` | `src/ocr/system.ts:11,36`; no system OCR implementation under `host/platform/native` | Actual macOS Vision / Windows.Media.Ocr bridge wired in production and validated on those platforms |
| Multimodal runtime | L02: `isMultimodalRagConfigured`, `callMultimodalEmbeddingApi`, `callMultimodalEmbeddingApiWithConfig`, `callEmbeddingApi`, `callOcrModelRawPrompt` | Required interface `src/multimodal/embedding-service.ts:270-279`; not published in `host/plugins/llm/api.ts` | Real runtime published through L02 api.ts and used by production indexing |
| Attachment preview exact decoding consumer | L12: call `ctx.llmMultimodal.parseAttachmentPreviewJson(previewJsonText)` (or the same function exported from L01 api.ts); input stored `preview_json` string, output `AttachmentPreview` with bigint usize; errors keep `invalid attachment preview: ...` and exact `JsonSyntaxError` cause | main `967f43c75`: `vfs-index/src/multimodal-service.ts:583` still calls its own `parsePreviewJson`. Rust `dstu-vfs/src/vfs/multimodal_service.rs:1378-1395` reads typed text, propagates serde detail, then casts page_index as i32 | L12 consumes the text seam, preserves the error detail and performs its Rust i32 narrowing without prior Number rounding; real indexing regression remains L12-owned. L01 WP-017 covers the actual provided service, not this downstream chain |

Resolved, no longer blocking: shared SSE trailing-CR handling (F4 `d1d251987` on main;
`host/platform/util/sse-buffer.ts:330` removes all trailing CR). No L01 change needed.

Resolved F4 dependency (WP-017): `git show main:host/platform/util/api.ts` and
`git show main:host/platform/util/json-exact.ts` at main `967f43c75` confirm JsonReader,
`skipIgnoredValue(): void`, `endArray(): void`, `readEnumVariant(expected?): string`.
L01 now drives the public reader for ordered preview fields, aliases and positional structs.
The corrected deep-unknown regression is active in `tests/codex-integer-width.test.ts`;
execution/review evidence is recorded in LANE.md / PENDING.md, rather than waiting for F4 again.

R1 L02-01 has signed the specified Model2/OCR shared-prepare branches (C1 receipt).
Do not reopen those paths or describe them as wholly undelivered. Main send image prefetch/auth
and 03.b.1 (`a72ef7dee`/`bf6479dc8`) also remain signed in their specified scopes; this does not
sign usage persistence or the missing high-level multimodal runtime.

No new native/npm dependency is requested.
Dependency status: main `4525e11ac` D10 officially approves `pngjs@7.0.0` and
`jpeg-js@0.4.4` (both in root package.json). The earlier sharp-candidate/withdrawn-request
message is historical only. F7 remains parked; adoption, installation, GLib/PSNR evidence
belong to C2/F7, not this lane. No package installation or image algorithm change made here.
