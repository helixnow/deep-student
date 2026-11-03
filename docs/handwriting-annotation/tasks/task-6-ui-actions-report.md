# Task 5/6 UI action gate

Status: **IMPLEMENTED — main verification passed**

## Shared Ink host

`src/features/ink/LazyInkEditor.tsx` now supplies default Ask AI and export handlers only when no caller callback is supplied. The editor itself still owns finish-stroke/flush sequencing and passes the frozen page/revision to the handler.

- Ask AI renders a frozen PNG through the existing `renderInkSnapshot` API wrapper and calls the existing `useReferenceToChat` flow with `sourceType: 'image'`, the artifact VFS file ID, and `image/png` metadata. It does not reference `.dsink` JSON or send a prompt/model request.
- Export presents PNG/PDF selection. PNG exports the current page; PDF requests the ordered page IDs from the current Ink manifest. Both use `vfs_ink_export`, then dispatch the existing `learningHubOpenResource` event with the resulting file path.
- Caller-provided `onAskAi`/`onExport` remain authoritative; the host does not add a second editor flush.

Focused behavior tests click Ask AI and export controls and assert the render/reference, ordered PDF export, and open-event calls in `src/features/ink/__tests__/LazyInkEditor.actions.test.tsx`.

## Source annotation first-gate tests

Added test-first contract scaffolding:
- `src/features/ink/actions.ts` resolves the selected file via `dstu.get`, requires its managed `resourceId`, invokes `vfs_ink_prepare` once with `{ request: { source_resource_id, operation_id } }`, and opens the returned stable Ink document ID through `onOpenApp`. It refuses unsupported preview modes and nodes without a managed ID.
- `src/features/ink/__tests__/actions.test.ts` covers managed-ID resolution, the exact prepare payload/open result, and the missing-ID guard.
- `LearningHubContextMenu` exposes `手写批注` only for PDF, image, DOCX, and PPTX resources. `SidebarContextMenu` routes it to the shared helper, so desktop and touch menus share the same flow.
- `src/features/learning-hub/components/__tests__/LearningHubContextMenu.ink.test.tsx` clicks the real menu item and asserts a single prepare call uses the DSTU node’s managed `resourceId`, then opens the returned Ink document.

## Main verification evidence

- `docs/handwriting-annotation/verification/ink-integration-units-r14.log`: Vitest completed with **11 test files passed, 63 tests passed**, including source action, menu integration, shared Ink host, restore/card, and Ink unit coverage.
- `docs/handwriting-annotation/verification/typecheck-r13.log`: `tsc --noEmit -p tsconfig.json` completed with exit code 0 (no diagnostics).

No further tests or builds were run in this handoff. No InkEditor, backend, converter, or storage changes were made.
