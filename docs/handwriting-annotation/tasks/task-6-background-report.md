# Task 6 background and source-highlight handoff

Implementation snapshot is ready for main-owner verification; this worker did not run tests, builds, installs, or agents.

## Changed files

- `/home/xutao/deepstudent/deep-student/src/features/ink/background.ts` — shared `loadInkBackground(pageRef)` handles blank backgrounds and VFS PNG backgrounds; enforces MIME, declared/decoded byte-size, PNG signature/IHDR, 2048-edge and 16-million-pixel bounds; returns an idempotent bitmap-disposal lease.
- `/home/xutao/deepstudent/deep-student/src/features/ink/sourceHighlights.ts` — source highlight wire conversion, normalized coordVersion 2 scaling, finite/positive rectangle validation and clipping, render-only composition before handwritten page objects. The editor composes the highlights into its background, so its canonical `InkPage` and save payload remain unchanged.
- `/home/xutao/deepstudent/deep-student/src/features/ink/renderBridge.ts` — render bridge uses the shared PNG loader for image and prepared `pdf_page` backgrounds (no raw-PDF parsing); source highlights are composed ahead of Ink objects and both the bitmap lease and temporary composed canvas are released in `finally`. Adds main-webview frozen-render-input retrieval.
- `/home/xutao/deepstudent/deep-student/src/features/ink/InkEditor.tsx` — replaces the prior raw-PDF/image background effect with shared loading; for resource-backed documents it requests frozen inputs after manifest readiness, composes only the returned source highlights, and releases leases/canvases on replacement or cleanup. It does not add synthetic highlights to the editable page.
- `/home/xutao/deepstudent/deep-student/src-tauri/src/ink_bridge.rs` — exposes the behavior-preserving crate-private flush helper and existing frozen-input loader/types to sibling jobs; adds a main-webview-only bounded frozen-render-input command backed by the existing frozen snapshot loader, without creating/publishing a render job.
- `/home/xutao/deepstudent/deep-student/src-tauri/src/lib.rs` and `/home/xutao/deepstudent/deep-student/src-tauri/permissions/application-commands.toml` — register and permit the snapshot command.
- `/home/xutao/deepstudent/deep-student/tests/ct/ink/InkRenderBridgeHarness.tsx` — prepared portrait fixture requests a 160-pixel long edge while the 64x48 image fixture retains 64.
- `/home/xutao/deepstudent/deep-student/tests/ct/ink/renderBridge.spec.tsx` — samples ink-over-source at (20,20), inside the highlight, and expects the independent gray multiply result `[110, 110, 221, 255]`.

## Verification selectors for main owner

- `tests/ct/ink/renderBridge.spec.tsx` — especially `renders prepared PDF-page PNG bytes in the editorless bridge and keeps normalized source highlight under Ink`.
- `tests/ct/ink-editor/inkEditor.spec.tsx` — run the existing PDF-backed editor/source-highlight coverage if selected in the main suite.

The saved RED evidence is `/home/xutao/deepstudent/deep-student/docs/handwriting-annotation/verification/task-6-prepared-pdf-red.log`. No GREEN test/build claim is made; main owner retains all execution and review.

## Handoff note

The new editor snapshot invoke must be supplied by the CT backend mock for resource-backed editor coverage; production command registration and response DTO are present. Main owner should relay any compile or CT failures before follow-up edits. Synthetic source highlights are rendered in a composed background only, not persisted as Ink objects.
