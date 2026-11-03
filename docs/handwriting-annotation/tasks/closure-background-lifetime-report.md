# Closure: prepared-background save/redraw lifetime fix

Date: 2026-11-03. Subagent report. Production fix implemented after main-agent RED; this subagent did not run tests, build, typecheck or commit.

## Root cause

`vfs_ink_save_page` success replaces `manifest` and `pageRef` object identities (`src/features/ink/useInkDocument.ts:270`, `:288-297`). The `InkEditor` background effect depends on those identities (`src/features/ink/InkEditor.tsx:161`), so it re-ran and its cleanup immediately called `bitmap.close()` on the published `ImageBitmap`. React runs all passive-effect destroys before any creates in the same commit, so `InkPageView`'s redraw effect still held the old `background` prop while its canvas effect ran (`src/features/ink/InkPageView.tsx:139-141`); `renderer.ts:298` then called `drawImage` on the closed bitmap and threw `InvalidStateError`, which the `ink-editor` ErrorBoundary surfaced as `errors.loadFailed` ("Could not load this page.").

Blank pages were unaffected because `loadInkBackground` returns a no-op lease with no bitmap (`src/features/ink/background.ts:22`). Unannotated PDF and image pages both publish a raw `ImageBitmap`; the existing highlighted-PDF fixture masked the bug because its composed canvas is not closable.

## Design (minimal, no new dependencies)

- `InkEditor` state now owns the published background as the existing `InkBackgroundLease` type (same `{ background?, dispose() }` shape; no duplicate interface), state at `InkEditor.tsx:51`. The `background` prop is `publishedBackground?.background` (`:300`).
- Disposal is moved to a dedicated effect: `useEffect(() => () => publishedBackground?.dispose(), [publishedBackground])` (`:158-162`), with a comment explaining the ownership. React only calls that cleanup when the lease is replaced/cleared and committed, or on unmount, i.e. after the child's prop has been detached. The old bitmap therefore stays usable for the in-between redraw that previously crashed.
- The loading effect (`:108-156`) no longer disposes the published lease in its cleanup; it only sets `cancelled = true`. It still publishes `undefined` when starting a new load, but that close is deferred to the bundle effect's commit.
- Ownership transfer is explicit: after `loadInkBackground` resolves and the cancellation check passes, `owned = lease; lease = undefined;` (`:132-133`). The published lease's `dispose()` closes the owned lease and, when present, the composed highlight canvas (`:135-146`), guarded against double disposal. A late async result that is cancelled before publish is disposed immediately (`:127-130`); failures dispose the never-published lease and only show the background error if not cancelled (`:147-150`).
- Revision-dependent behavior is unchanged: the effect keeps `[documentId, docState.status, docState.pageRef, docState.manifest]` deps, so `vfs_ink_get_render_inputs`, source highlights and frozen-revision checks still refresh on every revision change.
- Background limits (4 MiB, edge 2048, 16M pixels), PNG/base64 validation and native source closure are untouched. Canvas draw errors are not caught or suppressed.

## Touched paths

- Production: `src/features/ink/InkEditor.tsx`
- Tests (frozen earlier, unchanged by this fix):
  - `tests/ct/ink-editor/inkEditor.spec.tsx`
  - `tests/ct/ink-editor/InkEditorHarness.tsx`
  - `tests/ct/ink-editor/fixtures.ts`
- This report.

## Verification to be run by main agent

Externally witnessed RED before this fix: 3 failed (`closure-background-red-r2.log`), image/PDF save tests saw alert count 1 vs 0 after the backend save completed, navigation lost the canvas to the ErrorBoundary.

Expected after fix: the three new CT tests pass (background visible, stroke saved, editor remains, no load-failed alert, background and added-stroke pixels persist; navigation does not use a disposed background), plus the existing 52 browser checks, Ink unit tests, full front-end shards, typecheck and lint ratchet. Android diagnostics remain for the main agent.

## Ownership notes

- During a replacement commit the previous background can remain painted for one commit while the new page renders; it is detached/cleared in the next commit before its lease is disposed. No close-before-detach path remains.
- A lease accepted into state but never React-committed (e.g. unmount/supersede in the same batch) has no effect cleanup. It holds no persistent ref, cache or timer once the update queue is processed, so it becomes unreachable and is reclaimed by browser GC. This is the accepted bounded residual; no ref-based resource manager or extra test was added for this theoretical batch. Cancelled async results are still closed explicitly, and committed leases are closed by the published-state effect on replace/clear/unmount.
- React 18 StrictMode's initial mount double-invoke is safe here: the lease is `undefined` at mount, and only the loading effect re-runs, disposing its cancelled first result.
