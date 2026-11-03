# Task 4 — editor core first slice

Status: **FOCUSED_EDITOR_CT_GREEN; READY pending main lint rerun**. Main ran `playwright test -c playwright-ct.config.ts tests/ct/ink-editor/inkEditor.spec.tsx`; evidence: `docs/handwriting-annotation/verification/ink-editor-r16.log` reports exit 0 and `24 passed (35.9s)`. The sole later source edit is the narrowly scoped InkEditor history-effect dependency fix (`pageId` binding) reported by focused ESLint; main owns rerunning editor CT and lint.

## First-slice behavior

`tests/ct/ink-editor/inkEditor.spec.tsx` covers:

1. Load the requested page, draw a pointer stroke onto a real HTML canvas, verify pixels, save, and reopen.
2. On revision conflict, retain local ink visibly and through editor remount.
3. On save failure after the document is hidden, retain and restore the draft after remount.
4. After an offline draft is persisted, advance the remote revision with a human stroke, then remount; require conflict status, `EDITOR_BUSY` on flush, no retry-save action, and no save that erases the remote human stroke.
5. Treat `OPERATION_STATE_UNKNOWN` as read-required conflict state: retain the draft, block flush, and do not offer retry save.
6. Select pen/highlighter, color, and width, then verify saved stroke styles and real canvas pixels.
7. Erase a whole stroke and verify undo/redo changes real canvas pixels and saved page content.
8. Navigate between pages, append a blank page, and rename; assert revisioned API request payloads and resulting backend manifest state.
9. Zoom the page while asserting samples remain in logical page coordinates.
10. Verify touch input is ignored by default and accepted only after enabling touch drawing.
11. Load an image page background through the VFS blob API and verify real canvas pixels (currently owned by the render-bridge worker; see `ink-ct-integration-r5.log` for the outstanding failure).
12. Dispatch `pagehide` with an active pointer stroke while visibility remains visible; require backend persistence and successful remount recovery.
13. Simulate IndexedDB open failure; require storage-error status, no claim that a durable draft was kept, and no CAS save.
14. Verify the highlighter preview is a transparent active-only layer, composed with multiply over a completed blue stroke (blue-over-blue remains exact blue), samples active blue over white as `[127,127,255,255]`, and matches final pixels after pointerup at the same endpoint/pressure.
15. Refetch on matching `ink:changed` by document ID, ignore wrong-document events, and refetch rather than trusting payload revision.
16. Preserve a dirty active pointer stroke on external `ink:changed` and enter conflict without overwriting remote page state; main's active conflict CT is covered by direct synthetic pointer events so UI clicks do not release pointer capture.
17. Invalidate page undo history after a clean external change reload so undo cannot overwrite externally added objects; main's `ink-editor-r14.log` reported this as RED, and the hook exposes a remote-reload sequence for the editor to clear only that page's history.
18. In `save-echo` mode, emit `ink:changed` before save response resolves and verify two rapid successful strokes do not self-conflict; passed in the r16 focused editor CT run.

The harness uses self-constructed manifest/page fixtures and `setCtInvokeHandlers` as an in-memory revision-CAS transport boundary; it does not mock the renderer. Stable selectors are `ink-page-canvas` and `ink-editor-save-state`; test-only lifecycle controls are `ink-editor-unmount` and `ink-editor-remount`.

## Implementation

- `src/features/ink/drafts.ts` — IndexedDB-backed draft journal with document/page keying, sequence-aware discard, and injectable storage interface.
- `src/features/ink/editorSession.ts` — application-level document-scoped session registry, `flushInkEditor(documentId)`, `EDITOR_BUSY` result, and lifecycle draft persistence.
- `src/features/ink/useInkDocument.ts` — requested manifest/page loading, draft recovery, IndexedDB-before-CAS saves, serialized document saves, stale-sequence protection, conflict latch/draft retention, offline state, retry and explicit remote reload.
- `src/features/ink/InkPageView.tsx` — shared renderer for completed and active strokes (including pressure/highlighter styles), pointer coalescing/capture, pen by default with explicit touch drawing, logical page coordinates, zoom/pan and whole-object eraser hit-testing.
- `src/features/ink/InkToolbar.tsx` / `InkEditor.tsx` — pen/highlighter, color/width, eraser, undo/redo, page navigation, append/rename, zoom/pan, touch drawing, AI/export callbacks after flush, localized accessible labels, isolated error boundary and session/lifecycle registration.
- `src/features/ink/useInkDocument.ts` — revision-checked page selection, append and rename; page save remains serialized with existing base-revision guards.
- Image and PDF page backgrounds load through `vfs_get_blob_base64`, with byte/pixel limits; PDF page rasterization uses existing `pdfjs-dist`.
- `src/locales/{en-US,zh-CN}/ink.json` and `src/i18n.ts` — bilingual strings and namespace registration.

`api.ts` and `types.ts` were not modified in this pass. Page saves and page append/rename use their existing `inkApi.savePage`, `appendPage`, and `rename` APIs.

## Not verified / next review

The focused editor CT suite is green per `ink-editor-r16.log`. Broader lint, typecheck, and final regression remain main's responsibility. Pan is exposed through directional controls plus native touch panning; hardware palm-rejection remains unverified. This slice does not add arbitrary color pickers, ruling selection, or zoom presets.
