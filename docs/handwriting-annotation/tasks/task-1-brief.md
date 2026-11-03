# Task 1 — `.dsink` 格式与验证契约（先测试、等待主 agent）

Read this first — this is your requirements, with the exact values to use verbatim.

Repo `/home/xutao/deepstudent/deep-student`, branch `feat/handwriting-annotation-chat`. Plan `docs/handwriting-annotation/implementation-plan.md`, Task1. Spec `docs/handwriting-annotation/design.md` (if not created yet, original `docs/superpowers/specs/2026-11-02-handwriting-annotation-chat-design.md`).

## Role and stop gate

You are the implementation hand. Main agent is the architect/reviewer/test runner. No nested agents, no tests/build/install execution, no commit/push, no broad refactor. FIRST write the positive fixture parse/round-trip tests and minimal compiling API/type scaffolding returning a structured unimplemented error for parsing. Return NEEDS_RED_VERIFICATION and STOP; no validation implementation until main sends GREEN_IMPLEMENTATION_ALLOWED. A compile error from missing modules is not an intended red test. After the positive parse tests are green, add rejection tests against permissive validators in small behavior groups, STOP for main's red verification, then implement only the authorized group. Constant-Err stubs do not prove rejection tests work: do not add/claim negative validation red coverage against such stubs. Do not mutate unrelated tests. Production scaffolding must remain minimal to express the intended interface.

Scope ONLY:
- `src-tauri/crates/dstu-vfs/src/vfs/ink/{mod.rs,types.rs,validate.rs,tests.rs}`
- one `pub mod ink;` registration in `vfs/mod.rs`
- `src/features/ink/types.ts` (types only, no behavior)
- `tests/fixtures/ink/{ink-manifest-v1.json,page-v1.json}`
- `docs/handwriting-annotation/tasks/task-1-report.md`
No operations/storage/UI/Chat code yet. Keep total implementation focused (<800 new lines excluding tests if practical).

## Contract

Stable IDs are opaque strings, not file paths. Format constants: INK_MIME = `application/vnd.deepstudent.ink+json`, INK_EXTENSION=`dsink`, schema_version=1.

Serde JSON snake_case matches TS exactly. Use deny_unknown_fields on request/domain structs (not arbitrary raw serde Value). Validate all loaded untrusted JSON. Define `InkError { code: InkErrorCode, message: String }`, serialize codes SCREAMING_SNAKE_CASE; initial codes INVALID_ARGUMENT, LIMIT_EXCEEDED, UNSUPPORTED_SCHEMA. Do not add dependencies, use existing serde/serde_json/thiserror.

Required models (choose straightforward Rust names with matching TS exported names):
- `InkManifest { schema_version: u32, document_id: String, revision: String, title: String, source: InkSource, pages: Vec<InkPageRef>, last_operation: Option<InkOperationReceipt> }`.
- InkSource tagged by `kind`: `blank` or `resource { resource_id: String, source_hash: String, conversion_revision: String }`.
- `InkPageRef { page_id: String, width: f64, height: f64, background: InkBackground, page_blob_hash: String }`.
- background tagged by kind: `blank { ruling: Blank|Lined|Grid }`, `image { blob_hash:String }`, `pdf_page { blob_hash:String, source_page_index:u32 }`. Background blob freezes bytes, no arbitrary URL/path. Hashes SHA256 lowercase hex64. PDF page index zero-based. No metadata snapshots of source revision inside mutable source backpointer.
- `InkOperationReceipt { operation_id, input_hash, previous_revision: Option<String>, result_revision: String }`.
- `InkPage { schema_version:u32, page_id:String, objects:Vec<InkObject> }`.
- `InkObject { id:String, author: User|Ai, created_at:i64, content: InkObjectContent }` tagged content.kind.
- stroke content: `{kind:'stroke', samples:Vec<InkSample>, style:InkStrokeStyle}`; InkSample x,y,pressure f64 and elapsed_ms Option<f64>; style `tool: Pen|Highlighter, color:String, width:f64, pressure_enabled:bool`.
- text: `{kind:'text', rect:InkRect, text:String, font_size:f64, color:String}`; font family fixed to system sans renderer, no HTML/font URL field.
- rect/ellipse/region_highlight: `{kind,rect:InkRect,color:String,width:f64}`; arrow `{kind,from:InkPoint,to:InkPoint,color:String,width:f64}`.
- InkRect x/y/width/height are LOGICAL PAGE coordinates, not normalized. Public tool normalized ops deferred to subsequent task; prevent confusion. All geometry finite and inside page bounds.

Interfaces:
- `parse_manifest(bytes:&[u8]) -> Result<InkManifest,InkError>` checks bytes, serde then validate.
- `validate_manifest(manifest:&InkManifest) -> Result<(),InkError>`.
- `parse_page(bytes:&[u8], page_ref:&InkPageRef) -> Result<InkPage,InkError>` checks bytes, serde then validate.
- `validate_page(page:&InkPage, page_ref:&InkPageRef) -> Result<(),InkError>`.

Limits chosen by main for v1 (document in module and TS constants if useful):
- manifest max1MiB, page JSON max8MiB; document pages1..500; dimension each 1..16384.
- nonempty stable IDs max128 chars; disallow control chars, slash/backslash, whitespace-only; do NOT overconstrain specific existing ID prefix.
- title nonempty max256 Unicode chars; revision nonempty max128.
- page objects<=10000; total stroke samples<=100000 per page; stroke has >=1 sample; sample coords finite inside 0..page width/height, pressure0..1; optional elapsed_ms finite>=0 and nondecreasing within stroke.
- styles widths >0 <=256; text font_size 1..256; color #RRGGBB or #RRGGBBAA hex only. Text max10000 Unicode chars; ordinary strings may contain markup-like text since renderer must treat as plain text, do not reject '<' as script.
- geometries positive rect widths/heights, entirely within page; arrows endpoints inside page; created_at>=0.
- unique page IDs within manifest, object IDs within page; page_ref page_id must match loaded page.
- resource source requires nonempty valid resource_id, source_hash hex64, conversion_revision nonempty. All page blob and background hashes hex64.
- if receipt exists, input_hash hex64, operation_id valid, result_revision equals manifest.revision; previous_revision optional nonempty. No error message includes raw file contents/large payload.

## Tests to write first

Use one hand-built small valid manifest/page fixture, no production builder computing expected values. Load fixtures in tests via include_bytes!(path calculated from CARGO_MANIFEST_DIR); TS/Rust consumer uses identical wire JSON. Mutation-focused tests for successful fixture parse, unsupported schema, unknown field rejected, too many pages/dimensions, duplicate page IDs, invalid hashes, title/ID limits, receipt revision mismatch, round-trip serialization contract, mismatched page identity, duplicate objects, nonfinite and out-of-bounds coordinates, invalid pressure/elapsed order, empty stroke, invalid width/color/font, object/sample budget, text treated as plain content. Don't allocate gigabytes to test size caps. Test the behavior, not source-text snapshots.

Report only modified files, test selectors for main, red expectation, unmade decisions. Don't claim tests passed since you cannot run them; main will run. Do not proceed to repository/storage operations.
