---
phase: 04-implement-windowed-loading-for-markdown-editor
reviewed: 2026-06-29T10:10:00Z
status: clean
depth: standard
files_reviewed: 19
findings:
  critical: 0
  warning: 0
  info: 0
  total: 0
reviewer: Codex orchestrator fallback
fallback_reason: "gsd-code-reviewer subagent was spawned but did not complete after two 5-minute waits; it was shut down and the orchestrator completed the same scoped review."
---

# Phase 04 Code Review

## Scope

Reviewed the Phase 04 source and test files from the plan summaries:

- `src/features/notes/markdownWindow.ts`
- `src/features/notes/markdownWindowSettings.ts`
- `src/features/settings/components/MarkdownEditorWindowSettings.tsx`
- `src/features/settings/components/GeneralTab.tsx`
- `src/locales/en-US/settings.json`
- `src/locales/zh-CN/settings.json`
- `src/locales/en-US/notes.json`
- `src/locales/zh-CN/notes.json`
- `src/components/crepe/types.ts`
- `src/components/crepe/CrepeEditor.tsx`
- `src/features/notes/NotesCrepeEditor.tsx`
- `src/features/learning-hub/apps/views/NoteContentView.tsx`
- `tests/vitest/notes/markdownWindow.test.ts`
- `tests/vitest/notes/markdownWindow.settings.test.ts`
- `tests/vitest/notes/MarkdownEditorWindowSettings.source.test.ts`
- `tests/vitest/notes/NotesCrepeEditor.windowing.test.tsx`
- `tests/vitest/learning-hub/NoteContentView.windowing.test.tsx`
- `tests/vitest/notes/windowedMarkdownSourceContracts.test.ts`
- `tests/vitest/notes/windowedMarkdownPerformanceContract.test.ts`

## Findings

No critical, warning, or info findings were identified in the reviewed scope.

## Review Notes

- `NoteContentView` keeps the backend contract as a whole-document `dstu.getContent(path)` read, projects only a visible markdown window for Crepe, and composes partial saves through `composeWindowedSave` before `dstu.update`.
- Load-more expansion appends original hidden content to the current edited prefix, so user edits in the mounted window are not replaced by the original prefix.
- External refresh and conflict restore reproject loaded markdown for editor events while retaining full-content refs for later save composition.
- `NotesCrepeEditor` keeps the DSTU editor key stable by note id, expands through `setMarkdown`, suppresses autosave for programmatic updates, guards duplicate scroll-triggered loads, and restores selection best-effort.
- The settings row persists the clamped shared setting key and, per plan, does not dispatch live note/editor refresh events.
- The added tests cover helper behavior, setting persistence, editor expansion behavior, Learning Hub save/refresh/conflict flows, source contracts, and large-note bounded payload contracts.

## Verification Referenced

- `npm test -- tests/vitest/notes/markdownWindow.test.ts tests/vitest/notes/markdownWindow.settings.test.ts tests/vitest/notes/MarkdownEditorWindowSettings.source.test.ts tests/vitest/notes/NotesCrepeEditor.windowing.test.tsx tests/vitest/learning-hub/NoteContentView.windowing.test.tsx tests/vitest/notes/windowedMarkdownSourceContracts.test.ts tests/vitest/notes/windowedMarkdownPerformanceContract.test.ts` - passed, 7 files / 34 tests
- `npm run check:i18n` - passed; existing hardcoded Chinese statistics remain non-blocking
- `npm run typecheck` - passed
- `git diff --check` - passed
