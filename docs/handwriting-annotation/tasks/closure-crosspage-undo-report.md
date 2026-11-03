# Closure cross-page undo regression — RED confirmed, minimal fix

Status: RED reproduced by main, minimal production guard applied in `InkEditor.tsx`. Tests are frozen. Main owns the 25-test CT GREEN run. No commit.

## RED evidence

`docs/handwriting-annotation/verification/closure-crosspage-undo-red-r1.log`

- Command: `playwright test -c playwright-ct.config.ts tests/ct/ink-editor/inkEditor.spec.tsx --grep "page-1 undo stack" --workers=1`
- Result: exit 1, `1 failed`
- Failure: after clicking `ink-undo`, `hasRedPixelAt(canvas, 48, 130)` stayed false at spec line 851, confirming the stale page-1 snapshot replaced the newly loaded remote object.

## Fix applied

`src/features/ink/InkEditor.tsx` remote-epoch effect now clears the whole per-document histories map:

```ts
if (seenRemoteReloadRef.current === docState.remoteReloadSequence || !pageId) return;
seenRemoteReloadRef.current = docState.remoteReloadSequence;
historiesRef.current.clear();
setHistoryRevision((revision) => revision + 1);
```

All pages' undo/redo snapshots are relative to the pre-epoch canonical document, so none may survive a remote reload, even when made on another page. Ordinary navigation only changes `pageId`, not `remoteReloadSequence`, so the equality guard still returns early and does not clear local navigation history.

## Selector

Playwright CT test (25th in file):

`does not let a page-1 undo stack replace a remote AI change made while page 2 is open`

File: `tests/ct/ink-editor/inkEditor.spec.tsx` (appended after `treats OPERATION_STATE_UNKNOWN as a read-required conflict instead of offering retry`).

Existing UI selectors used:

- `ink-page-canvas` (`data-page-id`)
- `ink-active-stroke-canvas`
- `ink-page-previous`, `ink-page-next`
- `ink-editor-save-state`
- `ink-undo`

## Precise fixture scenario

1. Mount `InkEditorHarness saveMode="success"` (initial page 2).
2. Click `ink-page-previous`; assert canvas `data-page-id=ink-editor-ct-page-1`.
3. Draw one real pointer stroke on page 1; assert saved and `ink-undo` enabled. This creates the page-1 undo stack in `InkEditor`'s `historiesRef`.
4. Click `ink-page-next`; assert back on `ink-editor-ct-page-2`, saved and clean.
5. In the page, call the existing harness backend:
   - `backend.readPage('ink-editor-ct-page-1')`
   - `backend.advanceRemotePage('ink-editor-ct-page-1', { ...page, objects: [...page.objects, remotePageOneStroke] })`
   - then call the existing `window.__INK_EDITOR_EMIT_CHANGED__('ink-editor-ct-document', backend.readManifest().revision)`.
   Remote object: `id: 'remote-page1-stroke'`, `author: 'ai'`, red pen stroke at `y=130`.
6. Poll `getCalls`/`getPageCalls` +1 to prove the `ink:changed` handler refetched the manifest and page 2 while page 2 was current.
7. Click `ink-page-previous`; assert page 1 and saved. Poll that backend page 1 contains `remote-page1-stroke` and canvas pixel `(48,130)` is red.
8. If `ink-undo` is enabled, click it. Require `remote-page1-stroke` still present in backend page 1 and the red pixel still visible.

This accepts either intended fix: invalidate page-1 history (undo disabled), or make undo object-safe (remote object survives). On current code the stale page-1 undo is enabled after step 7; clicking it writes the pre-remote page-1 snapshot and removes `remote-page1-stroke`, so the post-click poll fails.

## Root path exercised

- Original bug: `src/features/ink/InkEditor.tsx` kept `historiesRef` keyed by page, but the remote-reload effect deleted only the currently displayed `pageId`. A page-1 stack survived a remote reload on page 1 while page 2 was displayed, then undo wrote the stale page-1 snapshot over the remote AI object.
- Trigger: `src/features/ink/useInkDocument.ts` `ink:changed` refetches the current manifest/current page and increments `remoteReloadSequence` even when the changed page was another page open elsewhere.
- Fix: the epoch effect now clears every page history on a sequence change; navigation alone does not change the sequence.

## Notes

- Test file frozen as written; `InkEditorHarness.tsx` and `fixtures.ts` are unchanged.
- Production change limited to `src/features/ink/InkEditor.tsx` plus this report.
- No tests run by this agent, no subagents, no commit, no network. Main owns the 25-test CT GREEN run.
