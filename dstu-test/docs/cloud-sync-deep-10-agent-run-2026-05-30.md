# Cloud Sync Deep 10-Agent Run - 2026-05-30

## Scope

This run attempted 10 parallel Codex subagents over 30 real Tauri instances, with one Docker-backed WebDAV fixture per agent.

Entry points were real Tauri UI operations through Computer Use. SQLite, WebDAV trees, and logs were used only as post-UI evidence.

## Environment

- Pool: `sync-deep-10x3-0530`
- Instances: 30 running during test, 3 per owner
- Source data image on first device of each group: `model-rich-deepseek-v4pro-seed`
- WebDAV fixtures: `sync-deep-a` through `sync-deep-j`
- WebDAV implementation: `tauri-lab fixture webdav --server node-builtin --image yuqing-agent:latest`
- Test WebDAV credentials: `ds-test` / fixture password
- Final evidence root: `/Users/heli/Library/Application Support/tauri-lab/evidence`

The default `bytemark/webdav:latest` image could not be pulled due Docker Hub timeout, so the existing local Docker image `yuqing-agent:latest` was used with tauri-lab's node-builtin WebDAV server.

## Subagent Allocation

| Group | Owner | Instances | Fixture | Intended Scenario |
| --- | --- | --- | --- | --- |
| A | `codex-sync-deep-a-baseline` | 01-03 | `sync-deep-a` | first config, validation, upload/download |
| B | `codex-sync-deep-b-hydration` | 04-06 | `sync-deep-b` | download hydration and idempotency |
| C | `codex-sync-deep-c-bidir` | 07-09 | `sync-deep-c` | bidirectional merge |
| D | `codex-sync-deep-d-conflict` | 10-12 | `sync-deep-d` | same-record conflict |
| E | `codex-sync-deep-e-tombstone` | 13-15 | `sync-deep-e` | delete/edit/tombstone |
| F | `codex-sync-deep-f-backup` | 16-18 | `sync-deep-f` | cloud backup/restore |
| G | `codex-sync-deep-g-credential` | 19-21 | `sync-deep-g` | credentials/recovery |
| H | `codex-sync-deep-h-network` | 22-24 | `sync-deep-h` | network faults |
| I | `codex-sync-deep-i-migration` | 25-27 | `sync-deep-i` | migration/all-table coverage |
| J | `codex-sync-deep-j-stress` | 28-30 | `sync-deep-j` | stress/idempotency |

## Actual Results

| Group | Remote State | Observed Backend Result | Final Local Evidence |
| --- | --- | --- | --- |
| A | 2 files, 336K | source 01 uploaded 359 changes, 0 conflicts | 01 has chat `__change_log=171`, sessions=7; 02/03 did not hydrate |
| B | 2 files, 336K | source 04 uploaded 359; target 05 downloaded 225, skipped 68; repeated download downloaded 0 | 05 has chat `__change_log=48`, sessions=8, conflicts=0 |
| C | empty | no cloud sync completion observed | 07 source remained local rich state; 08/09 empty |
| D | 2 files, 336K | source 10 uploaded 359; target 11 downloaded 225, skipped 68 | conflict mutation did not complete; 11 has conflicts=0 |
| E | 2 files, 336K | source 13 uploaded 359; target 14 downloaded 225, skipped 68 | delete/tombstone mutation did not complete; 14 has conflicts=0 |
| F | 2 files, 932K | source 16 cloud backup completed, 3 files | restore phase did not complete |
| G | 2 files, 336K | source 19 uploaded 359, 0 conflicts | credential recovery matrix did not complete |
| H | empty | no successful sync observed | bad endpoint/retry scenario did not complete |
| I | empty | no successful sync observed | migration/all-table UI coverage did not complete |
| J | empty | no successful sync observed | stress loop did not complete |

## Verified Positive Signals

- Upload path is functional for rich seed devices: groups A/B/D/E/G each uploaded 359 pending changes and produced a manifest plus compressed change package.
- Download path and dedupe are functional in group B:
  - First download on instance 05: `downloaded=225`, `skipped=68`, `conflicts=0`.
  - Repeated download on instance 05: `downloaded=0`, `skipped=0`, `conflicts=0`.
  - Final instance 05 snapshot: chat `__change_log=48`, sessions=8, conflicts=0.
- Additional one-way hydration worked in D/E target devices with the same `downloaded=225`, `skipped=68`, `conflicts=0` pattern.
- Cloud backup path produced a remote backup zip and manifest in group F.
- Secure store log paths are instance-scoped under each tauri-lab HOME, e.g. `.secure` under the instance app data directory.

## Problems Found

### P1 - 10 parallel Computer Use subagents did not reliably return control/results

Most subagents stayed in `running` state for an extended period and did not return final reports through mailbox. Parent-side evidence showed real UI-triggered sync actions did occur, but coverage stopped before the scenario-specific later phases.

Impact: The current multi-agent orchestration cannot yet be trusted for unattended 10-way deep UI testing. It works as a stress/probe, but not as a deterministic full-coverage run.

Likely causes:

- Too many simultaneous Computer Use sessions against macOS accessibility/Tauri windows.
- Agents were given broad end-to-end scenarios, causing long single turns without incremental status.
- No enforced heartbeat/progress file written by subagents outside mailbox.
- No parent-side timeout contract per scenario phase.

Required framework fix:

- Add a per-agent progress ledger file under `dstu-test/runs/<run-id>/<owner>.json`.
- Require subagents to write phase status after every UI milestone.
- Run in waves, e.g. 3-4 Computer Use agents at a time, while keeping 30 app instances available.
- Add parent watchdog that marks `blocked`, captures evidence, and reassigns remaining phases.

### P2 - Docker WebDAV default image pull is not reliable

`bytemark/webdav:latest` could not be pulled from Docker Hub during setup. The run used local `yuqing-agent:latest` instead.

Required framework fix:

- Document `yuqing-agent:latest` as the offline default for local Mac runs.
- Optionally preflight `docker image inspect` and choose server implementation before starting fixtures.

### P2 - Seed image still triggers unrelated model/API errors

Some frontend/backend logs contain model API 401 and CSP unsafe-eval noise from the rich seed/model settings. These did not block cloud sync evidence, but they increase log noise and can confuse cloud-sync triage.

Required fixture fix:

- Create a cloud-sync-specific rich data image with model-provider calls disabled or mocked.

## Evidence Pointers

Final snapshots were captured for all 30 instances at approximately `2026-05-30T14:52Z`.

Examples:

- A source: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-deep-10x3-0530-01/2026-05-30T14-52-13-792Z`
- B target idempotency: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-deep-10x3-0530-05/2026-05-30T14-52-14-852Z`
- D target hydration: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-deep-10x3-0530-11/2026-05-30T14-52-16-536Z`
- E target hydration: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-deep-10x3-0530-14/2026-05-30T14-52-17-342Z`
- F source backup: `/Users/heli/Library/Application Support/tauri-lab/evidence/sync-deep-10x3-0530-16/2026-05-30T14-52-17-883Z`

## Conclusion

This run did not achieve the full intended 10-scenario deep coverage. It did validate important upload/download/idempotency/backup paths through real UI entry points, and it exposed a concrete orchestration bottleneck in 10-way Computer Use parallelism.

Before the next full run, the multi-agent framework should be changed from "10 broad autonomous agents" to "30 ready instances + 3-4 active UI agents per wave + progress ledger + watchdog reassignment". That should preserve throughput while making the run auditable and resumable.
