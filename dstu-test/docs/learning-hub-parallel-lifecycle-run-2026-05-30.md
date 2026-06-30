# Learning Hub Parallel Lifecycle Run - 2026-05-30

## Purpose

Use multiple Codex subagents to drive five isolated real Tauri windows and test the actual lifecycle experience of Learning Hub learning applications.

## Environment

- Repo: `<deep-student-repo>`
- Pool: `learning-apps-05`
- Instances: 5 running Tauri app bundles
- Coordination: `tauri-lab` leases plus `agent targets` and `agent verify`
- Entry point: real UI operations through Computer Use
- Assertions: tauri-lab evidence snapshots, logs, SQLite checks, and UI observations after UI actions

## Assignments

| Agent | Owner | Instance | Focus |
| --- | --- | --- | --- |
| A | `learning-agent-a-notes-mindmap` | `learning-apps-05-01` | Notes and mind map lifecycle |
| B | `learning-agent-b-exam` | `learning-apps-05-02` | Exam/question-set lifecycle |
| C | `learning-agent-c-translation-essay` | `learning-apps-05-03` | Translation and essay lifecycle |
| D | `learning-agent-d-doc-previews` | `learning-apps-05-04` | Textbook/document preview lifecycle |
| E | `learning-agent-e-shell` | `learning-apps-05-05` | Finder shell, folders, search, tabs |

All agents confirmed their assigned exact `.app` path with `agent targets` and `agent verify` before Computer Use actions. Parent `lease audit --json` stayed clean during the run.

## Results

### Agent A - Notes And Mind Map

Status: partial pass.

- Passed: first-run agreement, Learning Hub navigation, note creation, note title/content editing, close and reopen persistence.
- Passed: mind map creation, adding a child node, close and reopen basic persistence.
- Blocked: Markdown import through macOS file picker. The fixture file was selected and previewed, but the `Open` button stayed disabled.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-01/2026-05-30T04-22-21-985Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-01/2026-05-30T04-23-22-924Z`

### Agent B - Exam

Status: partial pass.

- Passed: first-run agreement, Learning Hub navigation, empty exam creation, close and reopen.
- Passed: `exam_sheets`, `resources`, and `folder_items` records were created.
- Passed: empty import state is understandable; parse button is disabled before file selection.
- Passed: `All question sets` filters the created empty exam.
- Blocked: practice, wrong-answer, manage, stats, favorites, and topic flows cannot be fully tested from an empty exam because the UI depends on existing questions.
- Finding: empty exam has no visible manual "add first question" path. The user appears forced into import/recognition first.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-22-12-777Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-22-40-834Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-23-04-104Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-23-49-664Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-26-18-072Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-02/2026-05-30T04-26-51-948Z`

### Agent C - Translation And Essay

Status: partial pass with two failures.

- Passed: translation resource creation and panel discovery.
- Passed: translation input enables the translate button; the agent did not click it to avoid external model/network calls.
- Passed: essay resource creation and panel discovery.
- Passed: essay input enables the grading button; the agent did not click it to avoid external model calls.
- Finding: translation draft text is lost after closing and reopening the resource. SQLite still showed empty `source` and `translated` fields.
- Finding: essay text became polluted with a reversed-looking prefix after an unexpected navigation to Settings and back. This needs focused reproduction to separate product behavior from Computer Use/focus behavior.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-22-12-138Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-22-29-894Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-23-17-444Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-25-40-756Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-26-24-901Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-29-25-423Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-03/2026-05-30T04-30-32-074Z`

### Agent D - Textbook And Document Preview

Status: partial pass.

- Passed: imported two local fixtures through real UI:
  - `/tmp/deep-student-learning-fixtures/agent-d/agent-d-textbook.md`
  - `/tmp/deep-student-learning-fixtures/agent-d/agent-d-table.csv`
- Passed: Markdown textbook opens and shows the rich-text preview toolbar.
- Passed: CSV table opens and shows table preview.
- Passed: search for `table` filters the list to the CSV resource.
- Passed: closing back to the list preserves both resources.
- Finding: pressing Enter on a list item did not open it; it entered a drag state and showed `Dragging was cancelled.`
- Finding: Recent view was inconsistent, showing empty at one point and later showing recent entries with timestamps.
- Blocked: "save to local" entry was not located.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-04/2026-05-30T04-23-59-520Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-04/2026-05-30T04-26-12-282Z`

### Agent E - Finder Shell

Status: partial pass with shell findings.

- Passed: folder creation.
- Passed: entering folder and breadcrumb display.
- Passed: creating two notes inside the folder.
- Passed: DB checks showed two `notes` and two `folder_items` under the folder.
- Passed: tab lifecycle for two notes: open, switch, close, return to grid.
- Passed: search for `Shell-E-Note-2` filtered to one visible result.
- Passed: quick access for notes, all files, and textbook empty state.
- Finding: Recent did not show newly created/opened notes and stayed at `0 items` in this run.
- Finding: after creating a folder, the grid initially showed `1 item` but no visible card until switching view/navigation.
- Observation: CJK literal typing through Computer Use did not enter the full Chinese folder name; ASCII settable value worked.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-05/2026-05-30T04-22-05-701Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-05/2026-05-30T04-22-33-937Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-05/2026-05-30T04-24-02-872Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-05/2026-05-30T04-25-36-344Z`
- `~/Library/Application Support/tauri-lab/evidence/learning-apps-05-05/2026-05-30T04-28-49-210Z`

## Cross-Cutting Findings

1. Recent view is inconsistent across agents. Agent E saw newly created/opened notes missing from Recent; Agent D saw Recent empty at one point and later populated.
2. File picker/import paths are fragile. Markdown import selected a valid file but could not enable Open; textbook fixture import did succeed in another instance.
3. Empty exam lifecycle lacks a visible manual first-question path, blocking non-import practice lifecycle coverage.
4. Keyboard activation on document list items can enter drag cancellation instead of opening the resource.
5. Translation draft input is not persisted on close/reopen before translation is executed.
6. Grid/list refresh can show item counts before item cards become visible.

## Follow-Up Tests

- Focused Recent-view reproducibility with controlled create/open/close timing.
- Focused file-picker behavior for Markdown import versus textbook import.
- Seeded exam with one synthetic question, then test practice, wrong answers, management, stats, favorites, topics, and reset/delete confirmation boundaries.
- Translation draft autosave expectation decision: either persist drafts or warn before close.
- Essay input corruption reproduction with slower text entry and controlled navigation.
- Keyboard contract: Enter should open selected resource, not start drag.

## Data Image Follow-Up

After this run, `tauri-lab` gained a reusable data-image flow. A smoke image was created from Agent E's shell instance:

```sh
npm run tauri-lab -- image create lh-shell-seed \
  --from-instance learning-apps-05-05 \
  --scope home \
  --description "Learning Hub shell seed with folder, notes, search/tab state smoke data" \
  --force \
  --json
```

The image was applied to `image-smoke-01` with `instance create ... --image lh-shell-seed`, then started successfully. SQLite verification showed `resources=2` and `folder_items=2`, and Computer Use opened directly to the main app without the first-run agreement page. This confirms seeded Learning Hub state can be reused for future lifecycle runs.

Smoke evidence:

- `~/Library/Application Support/tauri-lab/evidence/image-smoke-01/2026-05-30T04-56-22-441Z`

## Second Parallel Run - 15 Learning Instances Plus Cloud Reserve

Later on 2026-05-30, a second deeper run used the richer
`model-rich-deepseek-v4pro-seed` image and the existing `dstu-stress` pool.
The parent agent applied the image to `dstu-stress-01` through
`dstu-stress-15`, started the pool, then assigned fixed leases to five
subagents. A sixth cloud-sync subagent used `dstu-stress-16` as a reserve
window.

Coordination results:

- `lease audit --json` showed 16 active leases and no failures during the run.
- Each subagent received only exact `.app` paths and ran `agent targets` plus
  `agent verify --require-running` before Computer Use.
- Parent cleanup stopped all 16 `dstu-stress` instances, stopped the WebDAV
  fixture used by the cloud-sync reserve, and cleared all active leases.
- No code was edited, staged, committed, or reverted during this test pass.

### Assignment

| Agent | Owner | Instances | Focus |
| --- | --- | --- | --- |
| A | `codex-lr-agent-1` | `dstu-stress-01..03` | Question-set lifecycle, emphasized |
| B | `codex-lr-agent-2` | `dstu-stress-04..06` | Documents, folders, notes, import, preview |
| C | `codex-lr-agent-3` | `dstu-stress-07..09` | Translation, essay, mind map |
| D | `codex-lr-agent-4` | `dstu-stress-10..12` | Search, filters, sorting, move/delete state |
| E | `codex-lr-agent-5` | `dstu-stress-13..15` | Conversation linkage and resource references |

### Question Sets - Deep Coverage

Status: pass, with medium UX/data-quality findings.

Covered:

- Create a question set from Learning Hub.
- Empty question-set state and disabled practice/analysis affordances.
- Document recognition import and generated question list.
- Question-set rename.
- Manual question creation with options, answer, explanation, tags,
  difficulty, and notes where visible.
- Practice, answer submission, correct/wrong feedback, AI explanation,
  wrong-question and pending-review status.
- Search, delete confirmation cancel/confirm, management table entry.
- Add question set to conversation context.
- Restart persistence for question count, wrong count, pending-review state,
  and answer records.

SQLite checks:

- `dstu-stress-01`: valid questions `3`, answer records `1`.
- `dstu-stress-02`: valid questions `3`.
- `dstu-stress-03`: valid questions `2`, answer records `1`.

Findings:

1. After renaming a question set, the list/toast shows the new name but the
   detail tab/header can still show the old name `新题目集 2`.
2. Re-importing the same document can create duplicate questions without a
   warning or deduplication.
3. The repeated-import toast said `成功导入 3 道题目` for a two-question file,
   which looks like total question count rather than imported count.
4. The edit affordance for existing questions is not visually stable. The
   card accessibility name contained `edit`, but the visible row menu exposed
   history, favorite, reset progress, and delete rather than a clear edit path.
5. Empty question sets guide strongly toward file import; the manual first
   question path is easy to miss.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-01/2026-05-30T09-47-35-424Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-02/2026-05-30T09-56-44-587Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-03/2026-05-30T10-01-26-115Z`

Not fully covered:

- CSV question import.
- Bulk edit.
- Standalone review-plan details.
- Deep edit of existing questions, because the visible edit entry was not
  reliably discoverable in this UI pass.

### Documents, Folders, Notes, Import, Preview

Status: pass for import/preview/edit basics, with folder placement defects.

Passed:

- Folder creation and rename.
- Note creation, title/body edit, tag, favorite.
- Markdown import via real macOS file picker.
- Markdown table rendering.
- Delete to trash and restore.
- `.txt` import with preview and extracted text.
- `.csv` import with preview and extracted text.

Findings:

1. Folder context menu `在此新建笔记` created the note at root instead of in
   the selected folder. SQLite `folder_items.folder_id` was `NULL`.
2. Dragging a note to a folder showed a dropped message, but the note did not
   move and SQLite still showed root placement.
3. The default grid view can show a blank main area while the footer says
   `9 个项目`; switching to list view makes items visible.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-04/2026-05-30T09-45-49-609Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-05/2026-05-30T09-45-49-746Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-06/2026-05-30T09-45-49-679Z`

### Translation, Essay, Mind Map

Status: pass, with minor instability.

Passed:

- Translation empty input disables action.
- Real translation generated Chinese output; edit, save, copy, and export
  cancel path worked. SQLite `translations` contained two rows.
- Essay empty input disables grading.
- Real essay grading returned `95/100`; copy and export cancel path worked.
  SQLite `essay_sessions` and `essays` each contained two rows.
- Mind map create, add child node, inline rename, delete confirmation, and
  persistence worked. SQLite `mindmaps` contained two rows and
  `mindmap_versions` contained eight rows.

Findings:

- Mind map resource-list rename entered an unstable editable state.
- A settings-page misclick produced a model-list `401 "Api key is invalid"`
  log line, unrelated to the main learning-app flows.
- Startup logs repeatedly included a path traversal warning for `.skills`;
  no functional impact was observed in this run.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-07/2026-05-30T09-26-39-683Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-08/2026-05-30T09-53-47-266Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-09/2026-05-30T09-53-47-330Z`

### Search, Filters, Move, Delete, State Consistency

Status: pass for main actions, with several list-state UX findings.

Passed:

- Title search, Chinese/English search, case variants, special-character no
  result, and empty-search restore.
- Type filters for notes, question sets, essays, translations, and mind maps.
- Existing multi-level folder navigation.
- Selection toolbar with move, delete, and add-to-conversation actions.
- Move of an essay resource to `LR-folder-renamed`, verified in SQLite.
- Delete, trash restore, restart persistence, verified in SQLite.

Findings:

1. Grid view can show blank content while item count says resources exist.
2. Search/filter can show count `1` with an empty visual list, including
   `题目集` and fast `Dee` input.
3. Search no-result state says `此文件夹为空/新建文件`, which reads like a folder
   empty state rather than a search no-result state.
4. `最近` can be empty despite freshly created or modified resources.
5. After rename, list can blank while the detail pane remains on the old
   resource state; SQLite already has the new title.
6. Delete has no second confirmation in this path.
7. Drag/drop again showed dropped but did not actually move the resource.
8. Chinese inline rename through Computer Use degraded to `LR-`; ASCII rename
   worked. This needs human IME reproduction before classifying as product
   versus automation input behavior.

Evidence:

- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-10/2026-05-30T09-47-47-146Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-11/2026-05-30T09-47-47-284Z`
- `~/Library/Application Support/tauri-lab/evidence/dstu-stress-12/2026-05-30T09-50-26-242Z`

### Conversation Linkage And Resource References

Status: pass for primary context-linking flows.

Passed:

- Import learning resource through Learning Hub, then attach it from the chat
  input resource library.
- Single-resource prompt produced a resource-specific model response and
  `message_learning_resource_links` rows.
- Multi-turn follow-up without reattaching still used prior resource context
  through conversation history.
- Multi-resource attach and comparison worked; references panel showed two
  resources.
- After deleting one resource, the resource library correctly excluded it.
- From a resource detail pane, `提问`, `总结`, `生成测验`, and `学习笔记` opened
  conversation flows with prefilled resource-specific prompts and model
  responses. `思维导图` and `学习应用` buttons were visible but not completed.

Findings:

1. Removing a resource attachment affects the current turn, but prior
   transcript context remains. The UI does not explain this distinction.
2. Renaming or deleting a resource leaves old labels in existing message
   reference panels. The historical links become orphaned after delete and
   the UI still shows the stale old title without a renamed/deleted marker.

Evidence:

- `.tauri-lab/evidence/dstu-stress-13/codex-lr-agent-5/20260530-121341`
- `.tauri-lab/evidence/dstu-stress-14/codex-lr-agent-5/20260530-121351`
- `.tauri-lab/evidence/dstu-stress-15/codex-lr-agent-5/20260530-121358`

## Second-Run Cross-Cutting Findings

1. Grid/list rendering and selection-state refresh are the strongest
   cross-cutting risk. Multiple agents reproduced blank lists, stale detail
   panes, and count/list mismatches while SQLite had the correct data.
2. Drag/drop currently gives positive UI feedback without the expected move.
   Treat this as a functional defect until a product decision says drag/drop
   is intentionally non-operational.
3. Folder-scoped creation paths need focused tests: context-menu creation did
   not preserve the folder target.
4. Historical chat references need a state model for renamed/deleted resources.
   Immutable history is acceptable, but the UI should mark stale/deleted
   resources explicitly.
5. Question-set import needs duplicate and count semantics clarified.
6. Computer Use CJK text entry can be unreliable; keep ASCII control cases and
   add manual IME confirmation before filing CJK-only bugs.
