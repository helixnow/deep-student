# G2: three core flows, real A vs real B (2026-11-06)

Machine-readable index: `manifest.json` (scenario sha256, raw sha256 and byte size of every trace and compare, result
summary). Each scenario directory holds xz copies (`xz -dc X.json.xz` gives the exact bytes whose sha256 is in the manifest):
`A1.json.xz`, `A2.json.xz` (two independent A takes), `B.json.xz`, `compare.json.xz` (A1 vs B), `A1-A2.json.xz` (A1 vs A2).
Full run directories (SQLite files, logs, profraw) stay in gitignored `fixtures/differential/wp043/runs/g2/`.

| Flow | Scenario (owner corpus on main, same file for A and B) | Steps | A/B outcome kinds |
|---|---|---|---|
| ① chat streaming (X5 mock LLM) | `host/e2e/streaming/wave0/streaming.scenarios.json` `chat.stream.success.answer` | 4, waitAfter `stream_complete` | equal |
| ② notes CRUD + DB final state | `host/plugins/notes/equivalence/history.json` `notes.history.chain.create_edit_list_get_restore_current` | 14 | equal |
| ② notes delete | same file, `notes.history.trash.history_survives_soft_delete` | 14 | equal |
| ③ review session | `host/plugins/review/equivalence/fsrs-lifecycle.v0.json` `review.rate.preview-good-undo` | 15 | equal |

## How each side ran

- A: instrumented Tauri binary from build `20261106023719-bc16bc` (D-156 identifier `com.deepstudent.differential` through
  build-time `TAURI_CONFIG`), `scripts/electron-migration/record/g3-run-a.mjs`, one process per take on a fresh X3 seed copy.
  Each request body is checked to be byte-identical to `argsRaw`. The raw custom-protocol response is the outcome. One
  `.profraw` is kept per process; there is no line-coverage figure until llvm-cov is installed.
- B: real TS Host process (`host/kernel/main.ts`, official `host/profiles/desktop.json`, Electron HostSupervisor protocol)
  through `scripts/electron-migration/record/g3-run-b.mjs`. No shell requests occurred in these flows.
- Both sides use the X5 mock LLM on fixed port 47110, so `${llm.baseUrl}` resolves to identical input bytes.
- Events: B records every Host event (`eventScope.kind = all`). A records what a frontend can hear. That is contract events
  plus `listen()`/`once()` names in `src/`, with id-derived channels such as `chat_v2_session_<id>`, `chat_v2_event_<id>` and
  `dstu:change:<path>` subscribed from the step that holds the id. The comparator rebuilds A's derived channels from B's own
  ids at the same step/field/pointer and lists every other event under `eventsOutOfScope`.

## Result

No normalization is applied (`normalization: []`), so all four compares are `equal: false`. Each compare reports only the
first difference per step and kind, so every count below is a lower bound.

- Value differences: every args, outcome and event difference reported comes from random ids (`sess_*`, `note_*`, card UUIDs)
  or wall-clock timestamps, which then propagate into later args. A1 vs A2 shows the same counts by kind. This proves those
  fields are nondeterministic in A itself. It does not prove B equals A beyond them.
- Structural database differences: none of these appear between A1 and A2, except the `mistakes.db` schema in the trash
  scenario. They are B-vs-A findings:
  - B creates `app-data/deep-student/sync/sync_state.db`, outside the identifier directory. A has no such file.
  - `chat_v2.db`: A has table `chat_v2_compaction_memory_flushes`; B does not.
  - `mistakes.db`: B creates `rag_documents` and `rag_document_chunks` in the chat flow; A does not. Schema/index sets differ.
  - A has WebKit's `hsts-storage.sqlite` under the identifier directory. This file belongs to the webview, not the app. It is
    left in the comparison until C2 rules on it.
- Out-of-scope events: B emits `chat_v2_event_<session>_var_<message>_run_<run>_*` (usage/id/start). These derive from a run
  id that only appears inside another event payload, and the product frontend listens to none of them. B also emits
  `dstu:change:/<new note>` during the create step, before any frontend could know the path.

Decision needed from C2: an id/timestamp normalization that the two A takes justify (WAVE0 §3). Until then, these flows
cannot pass.
