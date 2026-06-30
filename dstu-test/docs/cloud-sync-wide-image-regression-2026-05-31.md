# Cloud Sync Wide Image Regression - 2026-05-31

## Purpose

Use one broad data image to exercise many cloud-sync surfaces in a single real
UI flow. The goal is to catch dependency ordering, missing table coverage,
dedupe, replay, and blob/file hydration failures without relying on many
subagents.

The entry point for every sync action was the real Tauri UI through Computer
Use. SQLite, WebDAV, and log checks below were run only after UI actions.

## Environment

- Repo: `/Volumes/cipan/deep-student`
- Seed image: `sync-wide-stable-coverage-seed-0531`
- WebDAV fixture: `sync-wide-webdav-blobfix-0531`
- Endpoint: `http://127.0.0.1:18089/`
- Root: `wide-sync-blobfix-0531`
- Writer: `deep-student-ds-sync-blobfix-writer`
- Reader 1: `deep-student-sync-blobfix-reader-clean-0531`
- Reader 2: `deep-student-sync-blobfix-reader2-clean-0531`

## Seed Coverage

The wide seed includes synced records across:

- VFS: folders, folder_items, resources, notes, files, blobs, exam sheets,
  questions, answer submissions, review plans, todos, pomodoro, translations,
  essays, essay sessions, mindmaps.
- Chat: sessions, messages, blocks, attachments, groups, session mistakes,
  resources, workspace index.
- Mistakes: mistakes, anki cards, chat messages, document tasks, review
  sessions, review analyses, review chat messages.
- LLM usage: usage logs.

It also intentionally includes same-record mutation/delete chains and parent
child dependencies so one upload can expose ordering and dedupe bugs.

Audit command:

```sh
npm run dstu-test:inspect-wide-sync -- --image sync-wide-stable-coverage-seed-0531
```

Latest audit result: PASS. The image has zero foreign-key errors, 1 blob row
with present bytes, 0 file/blob orphans, 5 question types, todo parent links,
4 soft-deleted rows, 1 delete change-log row, 33 same-record multi-change
chains, chat attachments/resource links, mistake review lifecycle rows, and
LLM usage covering 2 providers, 4 models, and 3 statuses.

## Bugs Found And Fixed

### 1. Todo Parent Ordering

Earlier wide-image download failed with:

```text
todo_items.parent_id must belong to the same list
```

Fix:

- Apply downloaded `todo_items` parents before child rows.
- Preserve writer-side `change_log_id` order ahead of `record_id` when sorting
  same-second changes.
- Skip incomplete upserts that are shadowed by a same-batch delete.

### 2. Blob Metadata Missing Before Files

The next wide-image run failed with a `files -> blobs` foreign-key problem.
The remote package had file rows whose blob metadata never appeared as row
sync data.

Fix:

- Added VFS migration `V20260526__add_blob_metadata_sync`.
- Added `blobs` INSERT/UPDATE/DELETE triggers into `__change_log`.
- Backfilled existing `blobs` rows as unsynced INSERT changes for legacy data.
- Classified `blobs` as `RowSync`; raw blob bytes still use blob file sync.
- Applied `resources` and `blobs` before dependent file-like tables during
  download.

## Real UI Retest

### Writer Upload

UI steps:

1. Open writer from `tauri-lab`.
2. Configure WebDAV through Settings -> Data Governance -> Sync.
3. Type the password through the real password field.
4. Click Test Connection, Save Config, then Upload.

Result:

- UI changed from pending `441` to synced `441`.
- Remote package:
  `1780228847-5ef59edb-8a14-409b-860c-c237570c80e7.json.zst`
- Package distribution:

```text
chat_v2=185
llm_usage=43
mistakes=11
vfs=202
blobs=1
files=14
```

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-ds-sync-blobfix-writer/2026-05-31T12-01-14-300Z`

### Reader 1 Fresh Download

UI steps:

1. Start a clean Tauri instance with no seed image.
2. Accept onboarding.
3. Configure the same WebDAV root through UI.
4. Click Download.

Result:

- Backend logged `total=307, deduped=134, skipped_self=0`.
- Apply results:
  - `llm_usage`: `success=43, failed=0`
  - `chat_v2`: `success=61, failed=0, skipped=37`
  - `vfs`: `success=122, failed=0, skipped=33`
  - `mistakes`: `success=11, failed=0`
- Blob file sync logged `download 1`.
- `__sync_conflicts=0` for all four databases.
- `vfs.blobs=1`.
- `files` rows with missing `blob_hash` targets: `0`.
- `pragma foreign_key_check` returned no rows.

Repeated Download:

- UI click Download again.
- Backend logged `total=0, downloaded=0, conflicts=0`.
- VFS `__change_log` stayed at `121`; no replay amplification.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-blobfix-reader-clean-0531/2026-05-31T12-05-31-390Z`

### Reader 2 Two-Package Fresh Download

Reader 1 uploaded its local first-open chat session as a one-row second device
package. A second clean reader then downloaded the root containing both packages.

Remote packages:

```text
sync-blobfix-writer-0531: 441 changes
sync-blobfix-reader-clean-0531: 1 change
```

Result:

- Backend logged `other_devices=1, total=308, deduped=134`.
- Apply results:
  - `mistakes`: `success=11, failed=0`
  - `chat_v2`: `success=62, failed=0, skipped=37`
  - `llm_usage`: `success=43, failed=0`
  - `vfs`: `success=122, failed=0, skipped=33`
- `__sync_conflicts=0` for all four databases.
- VFS `__change_log=121`, `blobs=1`.
- Missing `files -> blobs` references: `0`.
- `pragma foreign_key_check` returned no rows.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-blobfix-reader2-clean-0531/2026-05-31T12-12-25-612Z`

## Interpretation

The wide image is now an efficient high-signal regression tool:

- It reproduced two real product bugs in sequence.
- After fixes, it verified upload, fresh hydration, repeated download
  idempotency, blob byte hydration, and two-package download from independent
  clean devices.
- The synced count after download is lower than package count by design:
  same-record mutation chains are deduped, incomplete upserts shadowed by
  deletes are skipped, and LocalRuntime/BackupOnly/DerivedRebuild tables are
  not record-synced.

When using this image, always verify both UI and objective state:

```sh
npm run tauri-lab -- assert sqlite <reader> --slot active --db vfs \
  --query "select count(*) from blobs;" --json
npm run tauri-lab -- assert sqlite <reader> --slot active --db vfs \
  --query "select count(*) from files where blob_hash is not null and blob_hash not in (select hash from blobs);" \
  --equals 0 --json
npm run tauri-lab -- assert sqlite <reader> --slot active --db vfs \
  --query "pragma foreign_key_check;" --json
```

Also inspect backend logs for:

```text
total=307/308
deduped=134
failed=0
conflicts=0
second download total=0
```

## Deep Chaos Wide Seed - 2026-05-31

After the first wide-image regression, a deeper seed was generated to cover the
remaining high-risk schema cases found by a second audit:

- composite-primary-key replay paths;
- business unique-key reuse after hard delete;
- JSON update chains in chat groups, Anki cards, and mistakes chat messages;
- parent tombstones with child records still present;
- explicit Boundary/Local/BackupOnly table classification checks;
- multiple workspace DBs, blob metadata, and blob byte hydration.

Image:

```text
sync-wide-chaos-deep-coverage-seed-0531
bytes=6131627
approx=5.85 MiB
```

Seed audit:

```sh
npm run dstu-test:inspect-wide-sync -- \
  --image sync-wide-chaos-deep-coverage-seed-0531 \
  --mode seed
```

Result: PASS.

Notable seed breadth:

```text
vfs: blobs=4, questions=11, answer_submissions=10, review_plans=11, resources=44, hard-delete change rows=3
chat: sessions=10 before app first-open, messages=21, blocks=39
mistakes: mistakes=5, anki_cards=5, chat_messages=4
llm: usage_logs=51, usage_daily=1
workspace db files=2
```

### Deep Writer Upload

Environment:

- WebDAV fixture: `sync-wide-chaos-deep-webdav-0531`
- Endpoint: `http://127.0.0.1:18122/`
- Root: `wide-sync-chaos-deep-0531`
- Writer: `deep-student-sync-chaos-deep-writer-0531`
- Writer app: `/Users/heli/Library/Application Support/tauri-lab/apps/ds-sync-chaos-deep-writer.app`

UI steps:

1. Start the seeded writer through `tauri-lab`.
2. Open Settings -> Data Governance -> Sync.
3. Configure WebDAV in the real UI, typing the password into the secure field.
4. Click Test Connection, Save Config, then Upload.

Result:

- UI showed pending `0`, synced `569`.
- Backend logged `uploaded=569, downloaded=0, conflicts=0`.
- Blob sync logged `upload 4, download 0, failed 0`.
- Two workspace DBs uploaded:
  - `ws_wide-sync-stable-20260531-workspace.db`
  - `ws_wide-sync-chaos-deep-0531-workspace.db`
- WebDAV tree contained one writer change package, one manifest, four blob
  files, `blobs_manifest.json`, `workspaces_manifest.json`, and both workspace
  DB files.

Remote package:

```text
data_governance/changes/e2e-sync-chaos-deep-writer-0531/1780233998-51b7b8d4-fee4-43da-9afa-aadd76d3c774.json.zst
```

### Deep Reader Fresh Download

Reader:

- Instance: `deep-student-sync-chaos-deep-reader-0531`
- App: `/Users/heli/Library/Application Support/tauri-lab/apps/ds-sync-chaos-deep-reader.app`

UI steps:

1. Start a clean reader through `tauri-lab`.
2. Accept onboarding.
3. Configure the same WebDAV endpoint/root/user/password through UI.
4. Click Test Connection and Save Config.
5. Click Download.

Result:

- Backend logged `total=435, deduped=134, skipped_self=0`.
- Apply summaries:
  - `mistakes`: `success=26, failed=0, skipped=6`
  - `llm_usage`: `success=52, failed=0, skipped=2`
  - `vfs`: `success=187, failed=0, skipped=38`
  - `chat_v2`: `success=83, failed=0, skipped=41`
- The skipped rows were expected same-batch delete-shadowed upserts, not
  failed hydration.
- Blob sync logged `upload 0, download 4, failed 0`.
- Two workspace DBs downloaded.
- `__sync_conflicts=0` across all four sync databases.

Hydrated audit:

```sh
npm run dstu-test:inspect-wide-sync -- \
  --instance deep-student-sync-chaos-deep-reader-0531 \
  --mode hydrated
```

Result: PASS.

Hydrated audit covered:

- zero foreign-key errors;
- zero unresolved sync conflicts;
- 4 blob metadata rows with blob bytes present;
- no `files -> blobs` or compressed-blob orphans;
- 4 exam sheets, 11 questions, 5 question types, 10 answers;
- todo hierarchy and parent links;
- translations, essays, and mindmaps;
- tombstone final state;
- 12 chat sessions after first-open local session, 21 messages, 39 blocks;
- attachments, session mistakes, and synced chat resources;
- 5 mistakes, 5 Anki cards, review sessions and review chat links;
- 51 LLM usage logs across 2 providers, 4 models, and 4 statuses;
- 2 workspace DB files totaling 221184 bytes.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-chaos-deep-reader-0531/2026-05-31T13-37-56-690Z`

### Deep Reader Idempotency

UI step:

- Click Download again on the same reader.

Result:

```text
since=1780234630
total=0
deduped=0
downloaded=0
conflicts=0
skipped=0
duration=18ms
```

The hydrated audit still passed after the second download.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-chaos-deep-reader-0531/2026-05-31T13-39-02-106Z`

### Post-Sync Learning Resource UI Probe

After reader hydration, the real UI was opened to Learning Resources:

- Sidebar showed synced chat groups and conversations.
- Learning Resources -> All Files showed `11` items.
- Switching from grid to list revealed synced folders and learning resources,
  including:
  - `Shell-E-Folder`
  - `记忆`
  - `附件`
  - `模型实测资料包`
  - two `Wide sync coverage` folders
  - `新思维导图`
  - `新作文`
  - `新翻译`
  - `新题目集`
  - `DeepSeek V4 Pro 实测笔记`

While continuing into the question-set filter, Computer Use returned
`remoteConnection`, then `cgWindowNotFound`. `tauri-lab` still reported the app
process running and metrics healthy, but System Events saw no app window. A
new short-name UI probe instance created from the same deep image also started
and reported metrics ready, but Computer Use could not enumerate its window
either. At that point even Safari returned `cgWindowNotFound`, so the remaining
UI probe was blocked by the Computer Use/window-enumeration layer rather than
by SQLite/WebDAV sync state.

Captured evidence for the window loss:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-chaos-deep-reader-0531/2026-05-31T13-42-38-990Z`

The cloud-sync result is still valid because upload, download, and repeated
download were all triggered through the real Tauri UI before the Computer Use
window enumeration failure.
