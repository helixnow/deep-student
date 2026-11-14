# W10 progress (round 2)

## Task 1 — VFS / chat `__change_log` drift (done: analysis, handoffs)

Server read-only scan of all 1221 G3 compares (`runs/full`), comparing the A1 and B
`__change_log` `(table_name, operation)` sequences per call:

- 623 equal, 487 not equal **with identical change-log sequences**, 111 with real sequence divergence.
- Identical-sequence drift (e.g. `media.library.list_limits`, 21 rows A == B in order) is
  normalization only: `changed_at` = `datetime('now')` (1 s) collapses into fewer placeholder
  groups on the faster B side, and `record_id` placeholder numbering shifts. Handoff: X7 g3-normalize.
- Divergent, owner W10, deterministic (A1 == A2):
  - 13 chat scenarios: Rust A1/A2 fail the first `chat_v2_upsert_streaming_block` with
    `no such table: chat_v2_blocks` after inserting the message row; TS succeeds. A-side defect. Handoff: X7.
  - 18 chatanki + 2 chat-pipeline workspace + 1 streaming: B logs
    `cannot get required service "storage"|"chatSession" in inactive context` in the X7 checkout
    (707d49c4a), so no LLM request and the error-path `saveResults` also fails (warn level is not
    exported in B logs). A local replay of the exact args on this branch reaches the LLM fetch and does not
    reproduce. Handoff: X7/W02.
- Divergent, nondeterministic (A1 != A2): anki `document_tasks` worker race, memory resources UPDATE, media.

## Task 3 — test isolation (done: cbc1387)

`createPaths` without `env` fell back to the real `process.env.HOME`, so device-id legacy lookup
read/migrated the real `~/Library/Application Support/deep-student/.device_id`. Under Vitest, a home
inside the real user home is now sandboxed to `<dataDir>/.test-home`; `globalAgentsRoot` refuses the
real home. Out of scope `homedir()` users handed off: backup paths/manager, storage/locations,
agent-workspace, chat-pipeline/index.ts:274.

## Task 2 — cancel-path persistence (done: a0add59)

- cancel-after-partial: change-log sequence A == B; only `meta_json` differed. Fixed: serde
  `MessageMeta` field order, `None` omitted, `auxiliaryMultimodalConfigId: null` dropped.
  Intentional deviation: unknown meta keys are kept (Rust drops them).
- workspace.cancel / send-errors: TS cancel checkpoints match `pipeline.rs` execute_internal
  (before config resolve, after history, select around compile, early llm_content, before tools);
  pre-pipeline user save is unconditional on both sides. Rows are identical; the drift is G3
  capturing right after each IPC while the B pipeline is still preparing (cancel IPCs land before
  "User message saved immediately"). Handoff X7: capture after stream terminal event.

## Task 4 — small items

- notes review revision exact i64 (400b631).
- `anki_decks.config_json` `525600.0`: writer is `review/repository/fsrs.ts` writeConfigJson
  (`JSON.stringify`); Rust `json!(Vec<f64>)` for learning/relearning steps, fsrs_params,
  desired_retention. Anki seam only stores the string. Handoff: review owner.
- AnkiConnect probe: environment. Rust io::Error prints host errno (macOS 61, Linux 111);
  TS matches. Test now uses host `ECONNREFUSED` (f06470f).

## Task 5 — final runs (done)

- chat, chat-pipeline, notes, anki, chatanki, vfs, vfs-repos, sync, platform/time, platform/paths,
  e2e/streaming: 440 files, 4502 passed / 1 failed (macOS `/private/var` canonical path in
  notes-import test, fixed in 5ca1800f, file rerun 8/8).
- `tsc -p tsconfig.host.json`: 0 errors. boundaries: 0 violations.

## Next

- None for W10; handoffs listed above.

# W10 progress (round 6)

- Anki facades for W22 chatanki: `getAnkiAgentLibraryCard` (dc89e276); `anki.pipeline`
  pause/resume/cancel/buildRetryTaskForDocument/getTask/updateTaskStatus and the sync facades
  `templateModelName`/`syncOptionsFromSettings`/`readSyncOptions`/`addNotesToAnkiDetailed`/
  `writeAnkiExportReceipts` (9a895678). IPC commands share `src/document-pipeline.ts`.
- Lossless JSON now lives in `host/platform/util/lossless-json.ts`; `sync/api.ts` re-exports the
  same values (ea6df02d). W05 can repoint the llm-providers imports and drop the 3 PENDING_EDGES.
- W07 leaves (ddff47dd): `isVirtualUri`/`rejectDoubleEncodedVirtualUri` from `storage/file-names.ts`
  in anki export, anki chatanki adapters, sync transfer-commands; anki-gold-set `rustTrim` from
  `util/portable.ts`. Not done: notes `command-utils.ts` (`classifyPath`) and notes
  `transfer-commands.ts` (`copyFileVerified`) have no file-names equivalent; the sync `ioMessage` →
  `ioMessageFor(error, posix)` switch needs `ctx.app.platform` threaded through ~10 fs-bound
  signatures in 7 files (`process.platform` would add scanner findings), so it waits for sync on ctx.files.
- vfs `buildNumberedSources` (9a409bf3): module is Node-free; `VfsService.buildNumberedSources`
  carries the same function, so memory can take it from `ctx.get('vfs')` and import only types.
- Tombstone `pathModifiedAfter` callers await a `boolean | Promise<boolean>` port (059a3d92).
- Skipped (owner not published yet): anki_media `getPersistentAppDataDir` (W14 storage api.ts);
  notes switch to `storage/node.ts` asset helpers (W14 node.ts).
- Chat mobile closure: blocked on W02. Value imports of agent-workspace/agent-skills/
  agent-orchestration `api.ts` remain in 9 chat files (the 7 listed plus `index.ts` and
  `continue-actions.ts`). Only `api.ts` is a published entry, and none of these values has a portable
  entry; see the round-6 report for the per-symbol list.

# W10 progress (round 7)

- `ExamRepo.markQuestionDocumentCompleted(conn, examId)` (4568d54c): the
  `qbank_authoring_service.rs:534` statement verbatim; one `exam_sheets` UPDATE, `updated_at` untouched,
  other metadata keys kept as stored text, missing row is a no-op. `qbank/src/ports.ts` `ExamSheetsPort`
  picks it (2474ab85, task-assigned one-liner in W03's path). W03: replace the `upsertExamSheet` +
  `clearImportState` pair in `markExamCompleted` with `exams.markQuestionDocumentCompleted(db, examId)`.
- Executors get the chat-pipeline context as `ctx.services`. Property access there only resolves
  chat-pipeline's `inject` (`nativeTokenizer`, `chatSession`, `settings`, `storage`, `vfsRepo`,
  `agentVfsResolver`), its own `chatPipeline`, and root services (`logger`, `app`, `backendEvents`);
  everything else throws "without inject". Fixed in vfs:
  - VL rerank blob lookup (5f0fe400): page images silently fell back to text-only.
  - resource_read/list/search, folder_list, all mindmap tools, mindmap_import (183582dd): every call failed
    with `cannot get property "vfsDatabase" without inject`; attachment_read returned a parse-failure string
    for documents (`services.docs`). Reads go through `src/tools/tool-services.ts` (`ctx.get`, Rust's
    "VFS database not available" when absent).
  - Desktop-profile wiring tests: `tests/retrieval-profile-wiring.test.ts` (multimodal_search) and
    `tests/resource-profile-wiring.test.ts`; both failed before the fix. Unit tests pass the root context,
    where property access always works, so they could not catch this.
  - Rest of W10 paths scanned: notes/chat/anki/sync/chatanki executors and helpers read only injected or
    root services. Out of lane: `backup/src/governance-tool.ts:496,540,579,589` (`services.backup`,
    `services.sync`) — same pattern, handoff W08.
- copyFileVerified from `storage/node.ts` in notes transfer-commands and anki apkg export (2e866db6).
- Still blocked: chat mobile closure (W02 portable entries); notes asset helpers and `classifyPath` need
  `storage/node.ts` exports, anki_media needs `getPersistentAppDataDir` (W14); sync/chat `ioMessage`
  deferred to the ctx.files migration (main agent).

# W10 progress (round 8)

- #28 (W12 smoke ⑥, 12 withheld tools): cause is registration, not schema/permission/mode. chat-pipeline
  advertises only names with an executable non-General executor (RF-W02-executable-only-tool-face). On the
  round-8 tree only `builtin-chatanki_{run,start,control,sync}` are withheld: control/sync are on W22's branch,
  run/start need `anki.pipeline.startDocumentProcessingWithId` + `cancelStreaming` (published 44d922fb,
  `chatanki_executor.rs:8296-8480`). `chat/tests/desktop-tool-face-wiring.test.ts` (bf8f2a89) loads the
  official desktop profile and checks every frontend skill tool except `PENDING` is advertised.
- #27 (vfs side): `unified_search` works under the desktop profile, and an answer citing `[记忆-N]` resolves
  through `chatPipeline.extractCitedMemoryNoteIds` to the memory note, which `memory.recordUsed` tags
  `_used:1` (b985c3df, `tests/retrieval-profile-wiring.test.ts`).
- vfs portable entry (f24ebece, 7ceb751c): `vfs/portable.ts` holds every public type and the Node-free values;
  `api.ts` re-exports it and keeps 32 desktop-only values (DSTU commands, `vfsRepositories`,
  `readSchemaVersion`, unit index), so the surface is unchanged. nanoid/paths/serde-json scanner no longer use
  Node; vfs util imports go to `util/portable.ts`. `tests/portable-entry.test.ts` pins the closure and both lists.
  - Reach: `vfs/api.ts` closure 25 → 22 Node files (vfs own 26 → 23). Measured by temporarily repointing all
    non-test importers to `portable.ts`: the `vfs/api.ts` gateway drops for all 7 plugins, `vfs-handlers/api.ts`
    goes 23 → 14 for media, memory is left with `platform/storage/api.ts` only. No plugin becomes ready alone.
  - Cross-plugin importers cannot switch yet: `boundary-rules.mjs:47-50` publishes only `api.ts`. Every value
    any lane branch imports from `vfs/api.ts` is in `portable.ts` (checked on all 30 `assault/*` branches).
- Migration (after W09 publishes `portable.ts`; replace `vfs/api.ts'` with `vfs/portable.ts'`, nothing else):
  - W02 `agent-orchestration/src/session-tool-executor.ts:15` (`createdEvent`, `noteToDstuNode`).
  - W05 `browser/src/index-webpage-executor.ts:20` (`fileToDstuNode`).
  - W04 `media/src/media-commands.ts:7`, `media/src/register-bilibili.ts:6`, `translation/index.ts:13`,
    `translation/repository/translations.ts:14`, `translation/src/tool_executor.ts:22-23`, and `VfsError` in
    `vfs-handlers/src/{files,paths,embedding,pdf,notes,resources,refs,search,errors,upload-file}.ts`,
    `vfs-handlers/repository/upload-savepoint.ts`.
  - W03 `memory/src/insight-recall-executor.ts:16`, `academic-search-executor.ts:13` (or
    `ctx.get('vfs').buildNumberedSources`, available now).
  - W10 `chat/repository/vfs-folders.ts` (`MAX_FOLDER_*`).

# W10 progress (round 9, audit round; INT 390f244b merged as 184f62e9)

- V09-P1-3 (ledger) done: `StartupFinalizerRegistry.register()` returns a disposer; options `late: 'throw'|'skip'|'run'`
  (default throw) and `signal` (abort = disposer; passes through the service.ts wrapper unchanged) (5f4df9a8).
  Red before fix: `startup-finalizers-lifecycle.test.ts` 13 failed / 1 passed (late skip threw
  FINALIZER_LATE_REGISTRATION, `dispose is not a function`, fake-plugin reinstall threw
  `startup finalizer "fixture.finalizer-reload.startup" registered after runStartupFinalizers() started`). Green 14/14.
  notes backfill + startup sweep and anki recovery use `{ late: 'skip', signal }` (17b19523); red before:
  notes "unloading notes before startup drops both finalizers" and anki "unload before startup withdraws" both
  `expected [ '<name>' ] to deeply equal []`.
  Interface handoff: `.reports/W10-handoffs/finalizer-interface.md` (W08 backup, W02 agent-orchestration, W04 vfs-index,
  W03 qbank; W07 service.ts and W14 api.ts/storage-mobile wrapper patches).
  276b8d3e later moved the note-links backfill out of the finalizers into the startup sweep (see W29 below), so notes
  now registers only `NOTES_STARTUP_SWEEP_FINALIZER`; the reinstall test expects that one name.
- Audit items (red = the test with only the source change reverted):
  - V09-P2-2 chat unload (6d47b0fc): unload cancels every stream and waits ≤ 2 s for tracked tasks. Red: both
    `unload-streams.test.ts` cases `expected false to be true` (no abort seen / unload returned before settle).
  - V04-08 (da7cc0c9): `page-load-started` releases the reloading webview's editor leases (lib.rs:487-491), by
    webview label only. Red: `{ remainingB: 1, ended: 0 }` vs `{ remainingB: 0, ended: 1 }`.
  - V01-07 (4ec3244b): notes registers its agent tool executors inside the `agentTools` inject scope. Red:
    `expected [ 'CanvasToolExecutor', …(2) ] to deeply equal []` after unload.
  - V02-01 (814c8c13): `todo_get_active_summary` items keep `dueDate`/`dueTime` as null. Red: contract violation
    `must have required property 'dueTime' at /todayItems/0`.
  - V05-01/03/05 (a8f9332f), V07 P2-2 (53a9b0e4, RF-W10-legacy-chat-migration-marker-table), S01 L3 (6a0f0764,
    RF-W10-notes-import-attachment-inflate-limits), V08-07 (fda2d617), V09 P3-1 (21c62f48). The V09 P3-1 test landed
    in fda2d617 together with V08-07; its fix is 21c62f48. Red: V05 4 failures (friendly HTTP text, AI响应超时 →
    Truncated, 600 s cap, decryptApiKey leaves Streaming); V07 `Schema fingerprint drift detected at v20261005`;
    S01 3 failures (ratio cap, schema 3 rollback, per-archive total); V08-07 `DataCloneError`; V09 P3-1 unload
    returned before the worker threads exited.
  - V05-02 is W01's (`CommandError.message`); confirm after it merges.
- Handoffs taken (INT 2be7ed80 merged as f4ae53f0):
  - W32 blob paths (1ffcf09b, RF-W10-blob-path-containment, kind rust-bug): `getBlobPath` returns null and warns,
    `storeBlob`/`cleanupBlob`/vfs `storeBlobWithConn` refuse, for a stored `relative_path` that is absolute, has
    `..`, or crosses a symlinked directory. New `BlobRepository.resolveBlobPath`. Red: 4 failures in
    `vfs-repos/tests/blobs.test.ts` + `vfs/tests/blob-path-containment.test.ts`.
  - R01 (7f896802): `ExamRepo.setImportStateRaw` = `qbank_legacy_reconcile.rs:695-699` (text as is, `updated_at`
    untouched, missing row ignored). Red: `setImportStateRaw is not a function` ×3.
  - W29 (276b8d3e): the note-links backfill runs last in the startup sweep, under the same permit, also when the
    connection failed, and not at all when the permit is busy (lib.rs:3646-3768). Red: 5 failures incl. "busy permit
    also skips the backfill". Changed assertions: the sweep call lists gain a trailing `'backfill:released=0'`; the
    no-connection test now also expects the backfill; `notes-repo` calls `backfillNoteLinksAtStartup()` directly.
  - W29 (e2048480): a startup gate that never opens still runs the sweep (Rust does not wait). Red:
    `expected false to be true`.
  - W02 (211a9d69): `chat_v2_goal_resume` spawns the continuation after a real resume (goal_handlers.rs:167). Red:
    `expected false to be true`.
  - W02 (b6df53c0): `chatSession.activeGoalRuntime()` returns the GoalRuntime of chat's own send binding (undefined
    while unbound); BLOCKERS.md L06 line updated to `chat.send@1`.
  - W21 (e2c81cdb): `check-corpus.mjs` accepts a scenario-level `llm` script name and skips `*.provider.json`.
  - W07 (f87d01e2): anki media root is `getPersistentAppDataDir()`. Red: `只能读取已导入的卡片媒体`.
  - W14 (78b43189): notes imports the deletion queue from `platform/storage/node.ts`.
  - W03 (49e07378): `utcNow()` uses `orderedNowEpochNanos()`. Red: four equal `…21.907+00:00` stamps. W03 must flip
    `qbank/tests/question-import-resume.test.ts:401` `it.fails` → `it`.
  - W22 (3d045d75): `chatBlocks.upsertBlock` appends the block id to the message and inserts the orphan placeholder
    message (chatanki_executor.rs:14592-14727). Red: `expected [] to deeply equal [ 'block-upsert-old', …(1) ]`.
  - W22 (373ba5f1): `templates.listAll()` = get_all_custom_templates without the command prefix. Red:
    `templates.listAll is not a function`.
  - W22 (bd5f2ab1): `anki.apkgExporter` (`exportMultiTemplateReport`, `sanitizeFilenameWithExtension`). Red:
    `Cannot read properties of undefined (reading 'sanitizeFilenameWithExtension')`.
  - W22 (4e49169a): control/sync are claimed on INT; PENDING keeps only run/start (W22 branch), and the second test
    now names control/sync explicitly. Empty PENDING once W22 lands.
  - W22 (946156dd): `chat/api.ts` exports `decodeVfsContextRefData`. Red: `decodeVfsContextRefData is not a function`.
- Not done: `Question.structured_data` lossless parse (cross-lane consumers; json-value.ts keeps atoms off IPC);
  `BlobRepo.readBlobBytes` (optional); W04 portable values (wait on `boundary-rules.mjs:48-50`); `classifyPath`
  (W14 has not published it); generation-critic `callAnkiRoutedRawPrompt` (not in INT); W07 rename retry
  (`paths/rename-retry.ts` 433dac40 not in INT); `files.original_path` fallback in `vfs-repos/repository/files.ts:664-665`
  (follow-up); upsertBlock still keeps existing content/toolInput/citations where Rust's upsert writes NULL (follow-up).
