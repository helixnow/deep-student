# Cloud Sync E2E Checklist

## Environment

- Use real Tauri app windows controlled through Computer Use.
- Use `tauri-lab` for isolated HOME, bundle id, device id, metrics, and logs.
- Use `tauri-lab fixture webdav start` with local Docker WebDAV unless the user explicitly asks for another server.
- Avoid external paid LLM calls unless the user approves the exact action.

## Parallel Run Setup

For five subagents, the parent agent should prepare:

- one WebDAV fixture id and credentials command;
- one 10-15 instance pool, preferably 15 for 3 devices per heavy scenario;
- optional `tauri-lab` data images for accepted first-run state, configured WebDAV, or seeded resources;
- one lease owner per subagent;
- a unique WebDAV root prefix per scenario unless the scenario is intentionally testing conflicts;
- a shared result format so aggregation is quick.
- an assignment table that maps each owner to exact instance ids and app paths.

Subagents must only operate assigned app paths. They should verify their own targets with `agent targets --owner ...` and verify each assigned window with `agent verify <instance> --owner ... --app ... --require-running --json`. They must not select windows from the global Computer Use target list.

Subagents must not stop or restart the shared WebDAV fixture. To test network interruption, use a bad endpoint or ask the parent for an exclusive fixture.

If a data image is used, record the image id and whether it was created from a prior real UI configuration pass. Do not use images as a substitute for testing the original setup flow; use them to speed up repeated scenario runs after the setup flow has already been covered.

For single-agent high-signal cloud sync smoke, use the broad image flow. Prefer
the current deep seed when available:

- writer from `sync-wide-chaos-deep-coverage-seed-0531`;
- clean reader 1 with no image;
- optional clean reader 2 with no image after reader 1 uploads its small local
  delta;
- one WebDAV root shared by those devices.

The older stable flow is still useful for historical comparison:

- writer from `sync-wide-stable-coverage-seed-0531`;
- clean reader 1 with no image;
- clean reader 2 with no image after reader 1 uploads its small local delta;
- one WebDAV root shared by those three devices.

Before using either image, run:

```sh
npm run dstu-test:inspect-wide-sync -- \
  --image sync-wide-chaos-deep-coverage-seed-0531 \
  --mode seed
```

The audit must pass or the run is not a canonical wide-image regression.

Required assertions for that flow:

- writer upload creates a large remote package and the package includes
  `table_name=="blobs"`;
- reader 1 download has zero unresolved `__sync_conflicts`, zero orphan
  `files.blob_hash`, and empty `pragma foreign_key_check`;
- reader 1 repeated download logs `total=0`;
- reader 2 download from two remote device packages does not grow
  `__change_log` beyond the expected deduped counts.
- downloaded readers pass:

```sh
npm run dstu-test:inspect-wide-sync -- \
  --instance <reader-instance-id> \
  --mode hydrated
```

For the 2026-05-31 deep baseline, expect writer upload `569`, first reader
download `total=435, deduped=134, conflicts=0`, 4 blobs downloaded, 2 workspace
DBs downloaded, and repeated reader download `total=0`.

Suggested owner names:

- `codex-sync-agent-a-upload`
- `codex-sync-agent-b-download`
- `codex-sync-agent-c-conflict`
- `codex-sync-agent-d-backup-restore`
- `codex-sync-agent-e-retry-cleanup`

## Baseline

For every device record:

- instance id
- app path for Computer Use
- HOME path
- device id
- metrics address
- backend/stderr/frontend log paths
- active slot and pending slot
- baseline SQLite counts
- WebDAV root
- seed image id, if any
- evidence snapshot path after each major phase

## UI Flows

Run through the UI, then assert state:

- configure WebDAV
- test connection
- upload-only
- download-only
- bidirectional sync
- cloud backup upload
- cloud backup history
- cloud restore
- app restart after restore
- sync after restore
- clear config
- missing password / half-configured recovery

## Subagent Result Format

Each subagent should return:

- leased instance ids and app paths used;
- confirmation that no unassigned app path was operated;
- `agent verify` preflight result for each operated instance;
- WebDAV fixture id and root/prefix used;
- UI actions performed in order;
- assertions and command outputs summarized;
- evidence snapshot paths;
- failures with reproduction steps and log paths;
- cleanup or lease-release status.

## SQLite Assertions

Prefer built-in assertions:

```sh
npm run tauri-lab -- assert sqlite INSTANCE \
  --slot active \
  --db chat_v2 \
  --query "select count(*) from chat_v2_sessions;" \
  --equals 6 \
  --json
```

Use raw SQLite only for ad hoc diagnosis after the UI-driven assertion fails.

Common DB paths under an instance HOME:

```text
Library/Application Support/com.deepstudent.app/slots/slotA/chat_v2.db
Library/Application Support/com.deepstudent.app/slots/slotA/databases/vfs.db
Library/Application Support/com.deepstudent.app/slots/slotA/llm_usage.db
Library/Application Support/com.deepstudent.app/slots/slotA/mistakes.db
```

Useful queries:

```sql
select count(*) from chat_v2_sessions;
select count(*) from chat_v2_messages;
select count(*) from __change_log;
select count(*) from __sync_conflicts;
```

## Failure Evidence

For every failure collect:

- Computer Use visible state or screenshot
- exact UI action sequence
- backend logs
- frontend logs
- stderr logs
- relevant SQLite counts
- WebDAV file tree before/after
- whether the failure repeats after restart

Use:

```sh
npm run tauri-lab -- evidence snapshot INSTANCE --tail 300 --json
npm run tauri-lab -- fixture webdav tree sync-webdav --json
npm run tauri-lab -- lease audit --json
```

## Known Risk Areas

- Half-configured cloud storage: provider/root/username exist but secure password is absent.
- Restore slot switching: restored backup is pending until restart.
- Same-machine localStorage pollution when bundle id is not unique.
- Main screen can create an empty session on a fresh device.
- Manifest-level conflict counts can differ from actionable row conflicts.
- Parent/child rows, file/blob rows, same-record mutation chains, and
  multi-package roots are mandatory in cloud-sync regression data. They catch
  ordering and replay bugs that simple one-row smoke tests miss.
- The deep wide image additionally includes composite-key replay probes,
  business unique-key reuse after delete, JSON update chains, parent tombstones
  with children, explicit boundary/local tables, multiple workspace DBs, and
  richer question-set coverage.
- If Computer Use loses Tauri windows after a successful UI sync, capture
  evidence and logs before restarting. Verify with `instance status` and
  System Events whether the app process still exists but has no visible
  windows; this is a test-control/window-enumeration failure unless backend or
  frontend logs show an application crash.
