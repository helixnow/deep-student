# Task0/9 — Office固定整页转换风险测试与适配

Independent browser-only converter slice. Repo `/home/xutao/deepstudent/deep-student` feature branch. read first `reviews/conversion-risk-findings.md` for already-known library paths; do not re-explore whole repo. Scope only `src/features/ink/prepare/office.ts`, `tests/ct/ink-office/` and task-9-office-report.md. Do not touch shared ink types/renderer/tests/ct/ink or Rust. No new deps/config.

## Role/gate

Child writes tests and code, main runs tests/reviews. FIRST tests+minimal compiling converter scaffold (structured CONVERSION_FAILED result)→NEEDS_RED_VERIFICATION STOP. Main then allows implementation. No tests/build/install/nested-agent/commit/push execution. Use existing JSZip/docx-preview/pptx-preview/snapdom. Keep work scoped, no library-wide archaeology.

## Interface

`convertOfficePages(bytes: ArrayBuffer, format:'docx'|'pptx', options?: {signal?:AbortSignal,max_pages?:number,max_pixels_per_page?:number}) -> Promise<{pages:Array<{png:Blob,width:number,height:number}>,warnings:string[],converter_version:string}>`.

Options may only LOWER caps: max500 pages, max16M pixels/page, max2048 long edge for default snapshots (UI/export can later override controlled profile via render). Errors structured with code (`UNSUPPORTED_FORMAT`,`CONVERSION_FAILED`,`CANCELLED`,`LIMIT_EXCEEDED`) small message, not contents. max_pages actual pages not truncate silently. All DOM/resources cleaned in finally, callbacks bounded, no network/external asset fetch (sanitize OOXML external links/assets, do not execute scripts). Unknown/legacy/encrypted format explicit refusal. Staging host attached offscreen nonzero size, not hidden/display:none. Process pages serially to avoid whole-document canvas memory.

DOCX className ink-docx, breakPages true, ignoreHeight false, honor explicit/saved pagebreaks. Existing generated DOM/styles sanitizers reused for fonts/styles/URLs; relative/bundled image blob/data accepted, external URIs no fetch. Capture section pages, white paper, preserve measured aspect ratio. Await fonts/images/layout readiness with timeout and abort. Missing fonts warning (at least general local-preview quality warning; detect known absent fixture family if feasible). No claim native Office high fidelity.

PPTX mode slide, preview+slideCount, iterate renderSingleSlide(i), wait for each slide chart SVG/images/fonts before capture, sanitize at correct time not before async library init. Capture actual slide wrapper, preserve aspect ratio/order; finally destroy. Hard failure if missing pages/content, not just first slide.

Each output PNG via snapdom, bounded capture with font embed/resources already loaded. converter_version pinned string including library versions/config; parent service combines with source_hash for conversion_revision later, do not add storage here.

## Initial real CT fixtures/tests

Generate self-created OOXML using installed JSZip in test helper (no downloaded/user docs). Small 2-page DOCX explicit pagebreak with distinct text, table and PNG image; 2-slide PPTX distinct text+image; chart slide readiness test can be second batch. Existing sample office tests elsewhere may have minimal fixture builders to reuse but no new deps.

Tests run real converter (not mocked capture), assert 2 pages, output PNG signature/dimensions/aspect ratios, pixel samples/content differ and bottom marker visible (not viewport screenshot). Test empty/malformed/abort/max_pages without partial success. Need first compiled expected red success tests before production implementation; refusals won't prove red against constant error stub. Put CT Harness in tests/ct/ink-office. Use existing Tauri/i18n mocks only if needed, no app mount. Report selectors and limitations; no test runs by child.
