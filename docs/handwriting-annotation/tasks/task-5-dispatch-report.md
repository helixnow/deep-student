# Task 5 — Resource file dispatch

Status: **IMPLEMENTED — awaiting main verification**

- `.dsink` extension and `application/vnd.deepstudent.ink+json` are resolved to `ink` ahead of stale explicit `text` metadata and generic JSON MIME; inference and normalization recognize `ink`.
- Learning Hub `FileContentView` dispatches ink files to the shared lazy `InkEditor`, passing the stable DSTU node ID as `documentId`.
- Direct DSTU `FileViewerWrapper` uses that same resolver and lazy editor, passing the loaded node ID (with path ID fallback) as `documentId`; no new DSTU node type was added.
- Workbench preview-shell mode includes `ink` and continues to use the shared resolver; no separate Workbench editor was added.
- Added resolver, FileContentView, direct-wrapper, and shared-shell routing coverage.

No tests, build, or install commands were run, per request. Main should run the focused tests and compile/typecheck.
