# Task 6 UI entry and frontend boundary handoff

Status: **READY for main-owned rerun**

## Completed

- `/src/features/ink/index.ts` exposes the Ink viewer registration, lazy editor entry, types/constants, and lazy bridge/action/API entry points. Feature consumers use public entry points rather than Ink implementation paths.
- `/src/features/ink/DstuFileViewer.tsx` accepts `EditorProps` (path only), resolves the actual node through `dstu.get(path)`, dispatches Ink using `canonicalMime`/MIME and filename extension via `isInkFile`, and lazy-falls back to `FileViewerWrapper` for ordinary files.
- `/src/features/ink/registerDstuFileViewer.ts` replaces `editorRegistry.file.editor` idempotently with the lazy DSTU viewer. `/src/App.tsx` invokes registration synchronously at module startup and retains lazy bridge registration.
- Cross-feature imports in Ink actions/office preparation and Learning Hub preview, menu, type, and creation call sites were routed through the owning public barrels. Learning Hub sanitizer exports go through the existing `sanitizers.ts` barrel and `learning-hub/index.ts`.
- `/src/dstu/editors/FileViewerWrapper.tsx` now imports `cn` from `@/utils/cn`.
- `/src/dstu/editors/__tests__/FileViewerWrapper.inkRouting.test.tsx` exercises the registry editor with only `path` and a mocked `dstu.get`. `/src/features/ink/__tests__/LazyInkEditor.actions.test.tsx` uses the typed app-event listener helper and cleanup. The Learning Hub creation test mocks the public Ink API.

## Verification handoff

No tests, typecheck, lint, build, install, or other execution were run by this owner. Main reported `frontend-layers-final-r1` and `typecheck-r2` passed. The integration r2 registry test failed because `@/dstu` was mock-hoisted to only `{ dstu }`; the registry test now imports `loadEditorComponent` directly from `@/dstu/editorRegistry`, and the shared resource-creators test's `@/dstu` mock now partially preserves the real barrel. Main's shard 1 log then exposed two unrelated integration misses: its source contract now filters sidebar directory entries to files before reading, and both locales now include display names for all six built-in Ink tool keys. Please rerun those focused tests/main shards against this snapshot.

## Touched paths

- `/home/xutao/deepstudent/deep-student/src/App.tsx`
- `/home/xutao/deepstudent/deep-student/src/dstu/editors/FileViewerWrapper.tsx`
- `/home/xutao/deepstudent/deep-student/src/dstu/editors/__tests__/FileViewerWrapper.inkRouting.test.tsx`
- `/home/xutao/deepstudent/deep-student/src/features/ink/DstuFileViewer.tsx`
- `/home/xutao/deepstudent/deep-student/src/features/ink/registerDstuFileViewer.ts`
- `/home/xutao/deepstudent/deep-student/src/features/ink/index.ts`
- `/home/xutao/deepstudent/deep-student/src/features/ink/actions.ts`
- `/home/xutao/deepstudent/deep-student/src/features/ink/prepare/office.ts`
- `/home/xutao/deepstudent/deep-student/src/features/ink/__tests__/LazyInkEditor.actions.test.tsx`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/index.ts`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/apps/views/sanitizers.ts`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/apps/views/FileContentView.tsx`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/apps/views/filePreviewResolver.ts`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/types.ts`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/sidebar/SidebarContextMenu.tsx`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/sidebar/resourceCreators.ts`
- `/home/xutao/deepstudent/deep-student/src/features/learning-hub/sidebar/__tests__/resourceCreators.ink.test.ts`
- `/home/xutao/deepstudent/deep-student/tests/vitest/learning-hub/inlineFolderCreationContract.test.ts`
- `/home/xutao/deepstudent/deep-student/src/locales/zh-CN/mcp.json`
- `/home/xutao/deepstudent/deep-student/src/locales/en-US/mcp.json`
