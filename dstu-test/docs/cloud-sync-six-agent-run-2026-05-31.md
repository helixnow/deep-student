# Cloud Sync Six-Agent Run - 2026-05-31

## Purpose

Run a long, real UI-driven cloud sync regression with six Codex subagents over
18 isolated Tauri instances. The parent agent used the updated coordination
rule: sleep/passive polling only, no active short timeout for quiet subagents.

## Environment

- Repo: `/Volumes/cipan/deep-student`
- Pool: `sync-six-18-0531`
- Instances: 18 running during the run
- Seed image: `model-rich-deepseek-v4pro-seed` applied to `01`, `04`, `07`,
  `10`, `13`, and `16`
- WebDAV server: `node-builtin` inside local Docker image `yuqing-agent:latest`
- Credentials: username `ds-test`, password `ds-pass`

Docker `bytemark/webdav:latest` startup blocked on Docker credential helper, so
the run switched to the repo-supported `node-builtin` WebDAV fixture using a
local image. This avoided registry/network dependency while preserving a real
local cloud server.

## Parent Coordination

- Parent created fixtures, pool, leases, and assignments.
- Subagents received only exact leased `.app` paths.
- Parent waited in 5-minute sleeps and did not close/kill agents for silence.
- Parent used passive checks only: `lease audit`, `pool status`, WebDAV
  `status/tree`, and fixture directory sizes.
- Parent did not operate subagent-assigned windows.

This policy worked: full reports arrived after a long run, including useful
late findings that would have been lost with 30/60/180 second timeouts.

## Assignment

| Agent | Owner | Instances | Fixture | Scenario | Result |
| --- | --- | --- | --- | --- | --- |
| A | `codex-sync6-a-0531` | `01/02/03` | `sync-six-0531-a` | baseline upload/download/idempotency/password recovery | Pass |
| B | `codex-sync6-b-0531` | `04/05/06` | `sync-six-0531-b` | bidirectional sync/idempotency | Pass |
| C | `codex-sync6-c-0531` | `07/08/09` | `sync-six-0531-c` | concurrent edit conflict | Fail |
| D | `codex-sync6-d-0531` | `10/11/12` | `sync-six-0531-d` | delete/tombstone propagation | Blocked before mutation |
| E | `codex-sync6-e-0531` | `13/14/15` | `sync-six-0531-e` | backup/restore/post-restore sync | Pass |
| F | `codex-sync6-f-0531` | `16/17/18` | `sync-six-0531-f` | credentials/network/retry stress | Blocked/incomplete |

## Final WebDAV Trees

| Fixture | Files | Size | Notes |
| --- | ---: | ---: | --- |
| `sync-six-0531-a` | 2 | 336K | one source change package + manifest |
| `sync-six-0531-b` | 4 | 344K | source package/manifest + small second-device package/manifest |
| `sync-six-0531-c` | 6 | 352K | source package plus two conflicting device packages |
| `sync-six-0531-d` | 0 | 0B | no mutation executed |
| `sync-six-0531-e` | 4 | 940K | backup zip, root manifest, post-restore package/manifest |
| `sync-six-0531-f` | 0 | 0B | assigned fixture unused due control/input blocker |

## Agent A - Baseline

Status: pass.

- `01` configured WebDAV through UI and uploaded seeded data.
- Upload UI showed pending `0`, synced `359`; backend logged
  `uploaded=359, downloaded=0, conflicts=0`.
- `02` downloaded from the seeded remote; backend logged `total=225`,
  `deduped=134`, `skipped=68`, `conflicts=0`.
- `03` first used a wrong password and UI showed `401 Unauthorized`, then
  recovered with the correct password.
- `03` repeated download logged `total=0`, proving idempotency.
- WebDAV remained at two files; `02/03` did not upload new packages.
- `02/03` had `chat_v2.__sync_conflicts=0` and `vfs.__sync_conflicts=0`.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-01/2026-05-31T00-58-41-876Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-01/2026-05-31T01-00-50-263Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-02/2026-05-31T01-14-41-300Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-03/2026-05-31T01-29-57-706Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-03/2026-05-31T01-50-06-175Z`

## Agent B - Bidirectional Sync

Status: pass.

- `04` uploaded seeded data: `uploaded=359, conflicts=0`.
- `05` downloaded remote data, then created a Todo through UI and uploaded only
  a small local delta: `uploaded=4, conflicts=0`.
- `06` downloaded both remote packages and then repeated download.
- `06` repeated download logged `total=0, downloaded=0, uploaded=0,
  conflicts=0, skipped=0`.
- WebDAV stayed at four files after `06`; no `06` re-upload package appeared.
- `__change_log` did not show the prior `359 -> 718 -> 1077` amplification.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-04/2026-05-31T01-03-28-139Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-05/2026-05-31T01-17-34-812Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-05/2026-05-31T01-27-07-083Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-06/2026-05-31T01-46-35-116Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-06/2026-05-31T01-47-03-407Z`

## Agent C - Conflict

Status: fail.

The run reproduced a real concurrent edit conflict, but product conflict
detection did not create a record-level conflict and later silently overwrote
one side.

Steps:

- `07` uploaded seeded data.
- `08/09` downloaded the same remote state.
- Both edited the same `chat_v2` session title through real UI:
  `sess_59f36c72-8535-41f0-8994-efe7d2b0c891`.
- `08` renamed it to `C08 冲突标题 0531A` and uploaded:
  `uploaded=2, conflicts=0`.
- `09` renamed it to `C09 冲突标题 0531B`.
- `09` conflict detection showed `db_conflicts=1, record_conflicts=0`.
- `09` bidirectional sync logged `uploaded=2, downloaded=2, conflicts=0`.
- `08` later downloaded and its title became `C09 冲突标题 0531B`.
- Final `__sync_conflicts=0`; the losing version was not preserved.

Issue: conflict漏报/静默覆盖. Manifest-level divergence exists, but record-level
conflict materialization does not happen for this concurrent edit.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-08/2026-05-31T02-04-12-227Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-09/2026-05-31T02-04-54-302Z`

## Agent D - Delete/Tombstone

Status: blocked before mutation.

The agent correctly stopped before clicking sync/delete because UI target
isolation became untrustworthy:

- `agent targets` and `agent verify` passed for `10/11/12`.
- WebDAV `sync-six-0531-d` stayed running and empty.
- DB baselines were captured.
- Computer Use repeatedly hit `Transport closed`.
- macOS accessibility fallback showed foreground/config state from another
  scenario, such as root `sync-six-0531-a` and endpoint `18082`, not D's
  assigned root `sync-six-0531-d` and endpoint `18104`.

No delete/tombstone assertions were executed. This is a tooling/control-plane
risk, not product validation.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-10/2026-05-31T01-59-05-558Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-11/2026-05-31T01-59-05-745Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-12/2026-05-31T01-59-05-684Z`

## Agent E - Backup/Restore

Status: pass.

- `13` configured WebDAV and created a cloud backup:
  `20260531-005904-405-syncsi-b61b64b2`, 925.9 KB.
- Remote backup file appeared at
  `backups/20260531-005904-405-syncsi-b61b64b2.zip`.
- `14` restored that backup. Before restart: `active=slotA`,
  `pending=slotB`; restored `slotB` contained sessions/messages.
- `14` restarted and activated restore: `active=slotB`, `pending=null`.
- `14` uploaded a post-restore sync package.
- `15` downloaded post-restore data; `__sync_conflicts=0`.
- `14` kept WebDAV config/root and device identity after restore/restart.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-13/2026-05-31T01-00-08-501Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-14/2026-05-31T01-01-07-101Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-14/2026-05-31T01-12-23-832Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-14/2026-05-31T01-15-11-503Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-14/2026-05-31T01-19-17-235Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-15/2026-05-31T01-39-51-056Z`

## Agent F - Credentials/Network Stress

Status: blocked/incomplete.

- `16` was verified and a snapshot was captured.
- `17/18` could not be reliably edited after Computer Use transport dropped.
- Accessibility fallback saw windows but WebDAV fields would not accept/persist
  direct edits or paste reliably.
- The agent also reported a working endpoint `http://127.0.0.1:18082/` and
  fixture `sync-webdav`, while its assigned fixture was `sync-six-0531-f` at
  `http://127.0.0.1:18106/`. Treat this as another target/config isolation
  warning.

No reliable wrong-password/bad-root/retry verdict should be taken from F.

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-16/2026-05-31T01-02-43-583Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-six-18-0531-17/2026-05-31T01-33-15-316Z`

## Findings

1. P1 product bug: concurrent edits to the same chat session title can silently
   overwrite one side without a record-level conflict. `db_conflicts=1` but
   `record_conflicts=0`, final `__sync_conflicts=0`.
2. The earlier duplicate replay/re-upload amplification regression did not
   reproduce in A/B. Fresh downloads deduped remote packages and repeated
   downloads logged `total=0`.
3. Backup/restore passed the important slot transition: restore writes pending
   slot, restart activates it, and post-restore sync can continue.
4. Multi-agent UI control remains fragile at high concurrency. D and F both hit
   Computer Use/Accessibility target or input reliability issues. Subagents
   correctly stopped instead of risking cross-window mutation.
5. The parent sleep/no-timeout policy is necessary. Useful reports arrived well
   after short timeout windows.

## Focused Conflict Retest

Status: fixed and verified for the targeted conflict UI path.

Follow-up single-agent UI testing reproduced the Agent C conflict shape with a
local WebDAV fixture `sync-conflict-visible-0531`, then verified two fixes:

- After a real UI rename and a real UI bidirectional sync, the sync tab now
  refreshes the conflict badge and record-level conflict panel automatically.
  The tester did not click the conflict panel refresh button after sync.
- When one local version conflicts with multiple cloud candidates, the conflict
  panel now shows every cloud candidate instead of hiding all but one. The
  verified UI state showed local `conflict-title-C-0531`, cloud `1/2`
  `conflict-title-A-0531`, cloud `2/2` `conflict-title-B-0531`, and the action
  label `采用云端（最新/2）`.

Assertions after the UI action matched the screen:

```sql
select table_name, record_id, count(*) as rows,
       group_concat(side || ':' || json_extract(data_json, '$.title'), ' | ') as variants
from __sync_conflicts
where resolved_at is null
group by table_name, record_id;
```

Result:

```text
chat_v2_sessions|sess_59f36c72-8535-41f0-8994-efe7d2b0c891|3|cloud:conflict-title-A-0531 | local:conflict-title-C-0531 | cloud:conflict-title-B-0531
```

Evidence:

- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-sync-refresh-ui-01/2026-05-31T06-09-22-114Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-cand-ui-01/2026-05-31T06-53-26-963Z`
- `/Users/heli/Library/Application Support/tauri-lab/evidence/deep-student-final-cand-ui-02/2026-05-31T07-01-36-405Z`

Tooling fix discovered during the retest:

- Long Tauri display names can be truncated by macOS window owner metadata,
  causing Computer Use `cgWindowNotFound` even when the CGWindow exists.
- `tauri-lab` now defaults managed instance display names to short stable
  values such as `ds-cand-01` and injects `DSTU_E2E_STANDARD_WINDOW=1`, while
  preserving explicit `--display-name` values.
- Because `tauri-lab` runs as a detached daemon, script changes require
  `npm run tauri-lab -- service restart --json` before new create/start behavior
  is available. This was verified by creating `ds-final-cand-ui-02` after a
  daemon restart and controlling it through Computer Use.

Remaining risk:

- The focused run found a seed/download convergence warning where an equivalent
  seeded root reported many skipped downloads while pending counts remained
  nonzero. Keep root-equivalence and pending-convergence cases in the next
  cloud sync matrix.
- A home image can carry credential files, but a new short-name bundle may still
  require re-saving cloud storage config through UI before sync controls become
  configured. Treat image-based credential/config migration as a separate
  compatibility scenario.

## Recommended Follow-Ups

- Fix and retest record-level conflict materialization for concurrent edits.
- Add a focused single-agent delete/tombstone run, because the six-agent run did
  not safely execute that scenario.
- Add a focused single-agent credential/network stress run with fewer windows,
  because the six-agent F run was blocked by desktop control reliability.
- Improve `tauri-lab`/Computer Use targeting guardrails for parallel desktop
  runs: per-agent window focus verification, screenshot/config sanity checks
  before destructive clicks, and a hard fail if visible endpoint/root does not
  match the assigned fixture.
- Keep the parent no-active-timeout policy in skills and README.

## Focused Gap Retest - Credentials And Tombstone

Status: completed for credential recovery and Todo delete/tombstone
propagation as of 2026-05-31 17:01 Asia/Shanghai.

This run exists because the previous six-agent matrix still did not fully cover
real UI credential recovery and delete/tombstone propagation. Entry points were
real Tauri UI actions through Computer Use; SQLite/WebDAV/logs were used only
after UI actions as verification.

Credential recovery:

- Instance `sync-gap-clean-0531-01` was recovered from wrong WebDAV password
  state by typing the correct password through the real password field.
- UI showed `连接成功！` after `测试连接`.
- UI showed `配置已保存` after `保存配置`.
- Evidence: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap-clean-0531-01/2026-05-31T07-49-21-034Z`.
- Risk still present: evidence shows both instance-scoped credential
  `.secure/cloud_storage_credentials.enc` and an older global
  `/Users/heli/Library/Application Support/deep-student/.secure/cloud_storage_credentials.enc`.
  Credential isolation still needs a dedicated clean-machine/style run.

Delete/tombstone propagation pre-delete phase:

- Fixture `sync-gap-delete-0531` is running at `http://127.0.0.1:18120/`, root
  `sync-gap-delete-0531`, username `ds-test`.
- Writer `sync-gap2-05-0531-01` created Todo list
  `sync tombstone list 0531` and Todo item
  `sync tombstone todo item 0531` through the real Todo UI, then uploaded
  through the real sync UI.
- Writer upload produced WebDAV files:
  `data_governance/changes/sync-gap2-05-0531-01/1780214224-9a409d67-722f-492f-a166-ee1b643a7bf5.json.zst`
  and `data_governance/manifests/sync-gap2-05-0531-01.json`.
- Writer local SQLite assertions passed for active list/item count `1`.
- Writer evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-01/2026-05-31T07-57-34-404Z`.

Reader/verifier cold-download phase:

- Reader `sync-gap2-05-0531-02` was configured through real WebDAV UI,
  downloaded through the real sync UI, and SQLite confirmed active list/item
  count `1`.
- Reader first download log: `downloaded=229`, `skipped=225`, `conflicts=0`;
  applied changes were `vfs=3`, `chat_v2=1`, `llm_usage=0`.
- Reader repeated download did not duplicate the Todo data, but UI surfaced a
  warning about `38` incomplete changes; backend showed a second download with
  `downloaded=38`, `skipped=38`, all from `llm_usage`.
- Reader evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-02/2026-05-31T08-03-22-545Z`
  and
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-02/2026-05-31T08-03-56-219Z`.
- Verifier `sync-gap2-05-0531-03` was also configured through real WebDAV UI,
  downloaded through the real sync UI, and SQLite confirmed active list/item
  count `1`.
- Verifier first download log matched reader: `downloaded=229`, `skipped=225`,
  `conflicts=0`, applied `vfs=3`, `chat_v2=1`, `llm_usage=0`.
- Verifier evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-03/2026-05-31T08-08-30-609Z`.

Idempotent replay warning fix and retest:

- Product issue found: repeated download on Reader replayed 38 `llm_usage`
  changes that were already present/equivalent. Backend correctly skipped them,
  but UI counted ordinary skipped rows as incomplete payload skips and surfaced
  a misleading `38` incomplete changes warning.
- Fix applied: `ApplyChangesResult` now tracks
  `skipped_incomplete_count` separately from ordinary `skipped_count`.
  UI-facing `skipped_changes` and warning messages use only true incomplete
  `INSERT`/`UPDATE` changes with missing `data` payload.
- Guardrail test added:
  `test_apply_semantically_equal_skip_is_not_incomplete`.
- Verification:
  `cargo test --manifest-path src-tauri/Cargo.toml test_apply_ -- --nocapture`
  passed, 20 tests.
- Verification:
  `cargo check --manifest-path src-tauri/Cargo.toml` passed with only existing
  project warnings.
- Real UI retest used the Reader exact app path:
  `/Users/heli/Library/Application Support/tauri-lab/apps/ds-sync-gap2-05-0531-02.app`.
- The Reader app bundle had to be rebuilt as a complete Tauri debug bundle.
  Replacing only `Contents/MacOS/deep-student` caused a blank window because the
  binary and bundled frontend/CSP assets were mismatched. The correct procedure
  was `npm run tauri -- build --debug`, then stop the instance, remove only the
  instance `.app` bundle, and let `tauri-lab` copy and patch the rebuilt source
  bundle while preserving the instance home.
- `npm run tauri -- build --debug` produced the required `.app` bundle, but
  exited nonzero after bundling because updater signing private key was absent.
  The usable app bundle still existed at
  `src-tauri/target/debug/bundle/macos/Deep Student.app`.
- Real UI retest result: clicking `下载` through Computer Use completed without
  the previous incomplete-data warning.
- Backend retest log:
  `downloaded=38`, database `llm_usage success=0 failed=0 skipped=38`, final
  sync summary `uploaded=0, downloaded=38, conflicts=0, skipped=0`.
- SQLite assertions after the UI retest still passed: active Todo list count
  `1`, active Todo item count `1`.
- Evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-02/2026-05-31T08-45-44-808Z`.

Delete/tombstone propagation completion:

- Writer `sync-gap2-05-0531-01` was restarted from the rebuilt debug bundle
  while preserving its home, then controlled through the exact app path
  `/Users/heli/Library/Application Support/tauri-lab/apps/ds-sync-gap2-05-0531-01.app`.
- Through the real Todo UI, Writer deleted only
  `sync tombstone todo item 0531` from `sync tombstone list 0531`.
- Writer SQLite assertions immediately after the UI delete passed:
  active item count `0`, tombstoned item count `1`.
- Through the real sync UI, Writer clicked `上传`; the sync screen moved pending
  changes from `2` to `0`.
- Writer backend log showed the tombstone upload:
  `uploaded=2, downloaded=0, conflicts=0, skipped=0`.
- WebDAV gained the second Writer package
  `data_governance/changes/sync-gap2-05-0531-01/1780217833-ac99b2d5-3886-47b3-ae71-dd31a063de85.json.zst`
  of size 486 bytes, plus the updated writer manifest.
- Writer evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-01/2026-05-31T08-57-27-609Z`.
- Reader `sync-gap2-05-0531-02` clicked `下载` through the real sync UI.
  SQLite assertions passed: active item count `0`, tombstoned item count `1`.
- Reader backend log showed `downloaded=40`, `conflicts=0`, `skipped=0`;
  database application details were `vfs success=1 failed=0 skipped=1` and
  `llm_usage success=0 failed=0 skipped=38`.
- Reader evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-02/2026-05-31T08-59-08-601Z`.
- Verifier `sync-gap2-05-0531-03` clicked `下载` through the real sync UI.
  SQLite assertions passed: active item count `0`, tombstoned item count `1`.
- Verifier backend log matched Reader: `downloaded=40`, `conflicts=0`,
  `skipped=0`, with `vfs success=1 failed=0 skipped=1` and
  `llm_usage success=0 failed=0 skipped=38`.
- Verifier evidence:
  `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-gap2-05-0531-03/2026-05-31T09-00-40-545Z`.
- Verifier repeated `下载` through the real sync UI as an idempotency check.
  The Todo tombstone remained stable (`deleted_at is not null` count `1`), and
  no incomplete-data warning appeared after the earlier fix.
- Remaining optimization: repeated download still fetches 38 equivalent
  `llm_usage` changes and skips them idempotently. This is no longer surfaced
  as a false incomplete-data warning, but it is still an efficiency/convergence
  issue to investigate in a later sync-filtering pass.

Coverage is still not sufficient overall. Remaining untested or only partially
tested real scenarios include:

- Historical schema/data migration versions syncing into current version.
- Large attachments/blobs and blob deletion queues.
- Mid-sync WebDAV interruption/restart and retry recovery.
- Batch delete and delete/edit conflicts across devices.
- More VFS domains beyond Todo/chat, especially questions, resources, notes,
  folders, essays, mindmaps, pomodoro/review data, and files.
- S3/MinIO-compatible provider path.
- Credential isolation on a clean profile without global credential fallback.
