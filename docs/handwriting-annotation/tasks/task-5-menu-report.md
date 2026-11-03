# Task 5 — Learning Hub handwriting-note menu

Implemented a single **Handwritten note / 手写笔记** creation action in the shared desktop Finder create menu, the mobile create menu, and the Learning Hub context menu (including folder-targeted context actions). Workbench Files already hosts the same Learning Hub sidebar, so it inherits these shared menu changes.

The handler in `src/features/learning-hub/sidebar/resourceCreators.ts` calls `inkApi.create` with a localized title, blank ruling, 794×1123 dimensions, a UUID operation ID, and the current/context folder ID. It then refreshes/selects and opens a file resource using the manifest's stable `document_id`; it does not call `createEmpty` for ink. Service failures are logged and surfaced as a localized notification.

Added `src/features/learning-hub/sidebar/__tests__/resourceCreators.ink.test.ts` covering the create payload, stable-ID resource callback, refresh, exclusion of `createEmpty`, and rejected-service handling. The required initial RED run was performed before production changes: both tests failed because `handleNewInk` did not exist. No tests or builds were run after implementation, as instructed. The requested error-path case is present as a rejected `inkApi.create` stub; compile/build verification remains unrun.

Added only the required menu and create success/error labels to `src/locales/en-US/learningHub.json` and `src/locales/zh-CN/learningHub.json`. No editor, API, Rust, node type, or new view changes were made.
