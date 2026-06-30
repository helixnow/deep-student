# Cloud Sync Real E2E Lessons

Date: 2026-05-29
Project: Deep Student nightly
Scope: real Tauri UI operations, local Docker WebDAV, SQLite/WebDAV state verification

## Goal

The purpose of this run was to test cloud sync as a real user would experience it:

- Start the real Tauri desktop app.
- Operate settings, sync, backup, restore, and retry flows through Computer Use.
- Use a local Docker WebDAV server as the cloud endpoint.
- Validate every UI action against both local SQLite state and remote WebDAV files.
- Preserve enough evidence that another Codex window or agent can continue the run.

The run intentionally avoided relying only on unit tests or direct command invocation. Direct database and filesystem checks were used only after UI actions, as assertions and diagnostics.

## Test Environment

WebDAV container:

- Name: `deep-student-webdav-e2e`
- Endpoint: `http://127.0.0.1:18080/dav/`
- Credentials: `ds-test / ds-pass`
- Root: `deep-student-e2e-20260529-200400`
- Host data root: `/tmp/ds-sync-e2e-20260529-200400/webdav-root`

Primary app data used during the run:

- Original device: `~/Library/Application Support/com.deepstudent.app/slots/slotA`
- Isolated device C: `/tmp/ds-device-c-home`
- Isolated device D: `/tmp/ds-device-d-home`

Important launch rule:

```sh
HOME=/tmp/ds-device-d-home DEVICE_ID=e2e-device-d \
  src-tauri/target/debug/bundle/macos/Deep\ Student.app/Contents/MacOS/deep-student
```

Launching via `open -n ...Deep Student.app` is not enough when the test needs deterministic `DEVICE_ID`; the environment can be lost and the app may reuse the persisted device identity.

## Verified Flows

### First Device Upload And Restart Persistence

The first device could configure WebDAV from the UI, run bidirectional sync, and upload change files plus a manifest to WebDAV.

After app restart, the UI did not require retyping the password, and sync still succeeded. This proves the secure credential path can work on the same device.

### Missing Credential Negative Path

On a fresh isolated Tauri instance, the UI could show WebDAV as configured while the password was not available. Pressing cloud sync actions then failed with:

```text
401 Unauthorized
```

This reproduced for download-only as well as bidirectional sync, so the problem is not limited to one button. Any cloud sync action can enter the failure path when non-sensitive config exists but secure credentials do not.

### Re-enter Password Recovery

After typing the WebDAV password through the UI and saving the config:

- Test connection succeeded.
- Download-only succeeded.
- Upload-only succeeded.
- Credentials were written to the secure credential file under the isolated HOME.

### Download-only

Device D started with one local empty session created by the app on the main screen.

After clicking "download":

- Local `chat_v2_sessions` changed from 1 to 6.
- WebDAV file list did not change.
- Local pending change remained pending.

This is the expected behavior for download-only.

### Upload-only

After clicking "upload":

- WebDAV gained `data_governance/changes/e2e-device-d/...json.zst`.
- WebDAV gained `data_governance/manifests/e2e-device-d.json`.
- Local pending changes became 0.
- Local conflicts table remained empty.

This is the expected behavior for upload-only.

### Cloud Backup

Clicking "upload backup to cloud" through the UI created a local tiered backup, exported a ZIP, and uploaded it to WebDAV.

Remote backup files became:

```text
20260529-121404-103-e2edev-2614c348.zip
20260529-133035-348-e2edev-81802f11.zip
```

The UI history list displayed both versions.

### Cloud Restore

Restoring an older cloud backup from the UI:

- Downloaded the remote ZIP.
- Imported it as a local backup.
- Restored it into inactive `slotB`.
- Marked `slotB` as pending.

Before restart:

```json
{
  "active": "slotA",
  "pending": "slotB"
}
```

After restart:

```json
{
  "active": "slotB",
  "pending": null
}
```

The restore flow is therefore restart-dependent. Any automated test must include the restart and active-slot assertion, otherwise it only verifies half of the restore behavior.

### Post-restore Sync

After switching to `slotB`, the same saved credential could still be used. Clicking download succeeded and rehydrated the restored slot from the cloud changes.

The log showed `skipped_self=1`, confirming that the app skipped its own remote device changes when the `DEVICE_ID` matched.

### Clear Config

Clicking "clear config" through the UI:

- Immediately changed the UI to "cloud storage not configured".
- Deleted the secure credentials file.
- Disabled cloud sync actions.

The persisted `webview_settings.json` still contained stale `cloud_storage_config_v2` until the next startup. After restart, the file was rewritten to:

```json
{
  "i18nextLng": "zh-CN"
}
```

This is acceptable for the normal restart path, but there is a timing caveat: if a backup or process exit occurs immediately after clearing config, stale local WebView settings may remain on disk until the next persistence pass.

## Bugs And Risks Found

### P0/P1: Half-configured Cloud Storage Looks Usable

Observed behavior:

- UI shows provider/root/username as configured.
- Password is absent from secure storage.
- Sync buttons are enabled.
- User gets `401 Unauthorized` only after attempting sync.

Probable cause:

- `cloud_storage_config_v2` stores non-sensitive config only.
- Passwords are intentionally cleared in UI config.
- Passwords are stored separately in secure storage.
- When the safe config exists but secure credentials are missing, the UI does not clearly block sync or request password re-entry.

Important source locations:

- `src/features/settings/components/CloudStorageSection.tsx`
  - Loads safe config and clears password.
  - Separately loads credentials.
  - Saves safe config and credentials separately.
- `src/utils/systemApi.ts`
  - Includes `cloud_storage_config_v2` in localStorage backup collection.

Recommended product behavior:

- Treat provider/root/username without credentials as `needs_credentials`, not as configured.
- Disable upload/download/bidirectional sync until credentials are present.
- Show an explicit "please re-enter cloud password" CTA.
- Surface this state on the sync panel, not only inside cloud settings.

### P1: Conflict Count Is Misleading

Observed behavior:

- Logs repeatedly reported `conflicts=1`.
- UI showed record-level conflicts as 0.
- SQLite `__sync_conflicts` had 0 rows.

Probable cause:

- The sync execution result reports manifest/database-level conflict detection from `SyncManager::detect_conflicts`.
- The UI conflict panel reads actual record-level conflicts from `__sync_conflicts`.
- Those two concepts are currently surfaced under the same word, "conflicts".

Recommended product behavior:

- Rename the manifest-level count to something like `manifest_conflicts_detected` or stop reporting it as user-visible conflict count.
- Return record-level conflicts from the conflict-guard application path when the UI is expected to show actionable conflicts.
- Add an assertion that `conflicts_detected > 0` only when unresolved conflict rows exist, unless the field is explicitly documented as manifest-level.

### P1: Same Bundle ID Pollutes Multi-device Local Testing

A same-machine multi-device simulation using the same Tauri bundle id can share WebKit localStorage across isolated `HOME` directories. That can make a fake "fresh device" inherit UI cloud config from another fake device.

This is partly a test harness problem, not necessarily a production multi-device bug. A real multi-device test manager must isolate at least:

- `HOME`
- `DEVICE_ID`
- bundle identifier
- app data directory
- WebKit storage
- metrics/debug ports

Without that isolation, tests can both over-report and under-report cloud sync defects.

### P1: Cloud Credential File Is Global, Not Per-Instance

The cloud storage credential used by the current implementation is stored under:

```text
~/Library/Application Support/deep-student/.secure/cloud_storage_credentials.enc
```

Implications:

- different `tauri-lab` instances on the same macOS account can share the same saved cloud password;
- credential assertions must scan that global path, not only the copied app bundle or per-instance support directory;
- evidence snapshots should record the global credential file when present.

Treat this as shared account state unless the product moves to per-instance credential storage.

### P1: tauri-lab Script Changes Require Daemon Restart

The CLI talks to a long-running tauri-lab daemon. Editing `dstu-test/scripts/tauri-lab.mjs` does not affect live assertions until the daemon is restarted.

Implications:

- after patching tauri-lab, run `service stop` and `service start` before trusting new assertion behavior;
- otherwise the CLI can appear to use old logic even though the file on disk has changed.

### P2: Main Screen Auto-creates Empty Sessions

Opening the main screen on a clean app creates an empty chat session. This is real product behavior, but sync tests must account for it.

Consequences:

- A "fresh" device often has 1 local pending change before any explicit test action.
- Download-only should leave that local change pending.
- Upload-only should upload it.
- Restore tests may create an additional post-restore session when the app starts.

The test harness should either start directly on a settings route, if supported, or record the auto-created session as part of the expected baseline.

## Useful Verification Commands

SQLite summary:

```sh
sqlite3 "$HOME/Library/Application Support/com.deepstudent.app/slots/slotA/chat_v2.db" \
  "select count(*) from chat_v2_sessions; select count(*) from __change_log; select count(*) from __sync_conflicts;"
```

Isolated device D, active slotB:

```sh
sqlite3 "/tmp/ds-device-d-home/Library/Application Support/com.deepstudent.app/slots/slotB/chat_v2.db" \
  "select 'sessions', count(*) from chat_v2_sessions; select 'change_log', count(*) from __change_log; select 'conflicts', count(*) from __sync_conflicts;"
```

WebDAV data governance files:

```sh
docker exec deep-student-webdav-e2e \
  find /data/deep-student-e2e-20260529-200400/data_governance \
  -maxdepth 5 -type f -printf '%p %s bytes\n' | sort
```

Decode uploaded change files:

```sh
for f in /tmp/ds-sync-e2e-20260529-200400/webdav-root/deep-student-e2e-20260529-200400/data_governance/changes/*/*.json.zst; do
  echo "FILE $f"
  zstd -dc "$f" | jq '{device_id, changes_count: (.changes|length), changes: [.changes[] | {table_name, operation, record_id}]}'
done
```

Inspect slot state:

```sh
cat "/tmp/ds-device-d-home/Library/Application Support/com.deepstudent.app/slots/state.json"
```

Inspect cloud credentials:

```sh
find "/tmp/ds-device-d-home/Library/Application Support" \
  -name "cloud_storage_credentials.enc" -print -exec ls -l {} \;
```

## Requirements For A Local Multi-Tauri Instance Manager

The previous run strongly suggests that a reusable local manager is worth building. It should manage long-lived app instances independently of a single Codex context or terminal session.

### Primary Responsibilities

The manager should:

- Register projects and launch profiles.
- Start and stop multiple Tauri instances.
- Keep instances alive even if the current Codex window/context is compacted or replaced.
- Provide stable metadata for Computer Use targeting.
- Allocate isolated homes, device ids, bundle ids, ports, logs, and cloud roots.
- Expose machine-readable status and evidence paths.
- Support multiple agents using different windows in parallel.

### Instance Model

Each instance should have a stable record:

```json
{
  "id": "deep-student-device-a",
  "project": "deep-student",
  "cwd": "<deep-student-repo>",
  "bundle_id": "com.deepstudent.e2e.device-a",
  "app_path": "/tmp/tauri-e2e/apps/deep-student-device-a.app",
  "home": "/tmp/tauri-e2e/homes/deep-student-device-a",
  "device_id": "e2e-device-a",
  "pid": 12345,
  "window_title": "Deep Student - device-a",
  "metrics_port": 59331,
  "log_path": "/tmp/tauri-e2e/logs/deep-student-device-a.log",
  "state": "running"
}
```

### Computer Use Friendly Design

Computer Use works best when every app/window is unambiguous. The manager should therefore create per-instance `.app` wrappers with:

- Unique bundle id.
- Unique app display name, such as `Deep Student E2E A`.
- Stable window title suffix, if the app can support it.
- Direct executable launch rather than `open -n`, so env vars are preserved.

The manager should print and persist exact `app` targets that Codex can pass to Computer Use, for example:

```text
Computer Use target:
/tmp/tauri-e2e/apps/Deep Student E2E A.app
```

or:

```text
bundle id:
com.deepstudent.e2e.device-a
```

Avoid relying on generic app name `Deep Student`, because it can target the installed release or the wrong test instance.

### Process Lifetime

The manager should run as a small local daemon or supervisor process. Codex should be able to reconnect by reading a registry file, not by relying on the original terminal session.

Suggested files:

```text
.tauri-e2e/
  registry.json
  projects/deep-student.json
  instances/deep-student-device-a.json
  logs/deep-student-device-a.log
  evidence/deep-student-device-a/
```

For a first version, a Node or Rust CLI with detached child processes is enough:

```sh
tauri-e2e register deep-student --cwd <deep-student-repo>
tauri-e2e start deep-student --profile device-a
tauri-e2e start deep-student --profile device-b
tauri-e2e status --json
tauri-e2e stop deep-student-device-a
```

### WebDAV And Cloud Test Integration

The manager should also be able to start or attach cloud fixtures:

```json
{
  "cloud": {
    "type": "webdav",
    "container": "deep-student-webdav-e2e",
    "endpoint": "http://127.0.0.1:18080/dav/",
    "username": "ds-test",
    "password_ref": "local-test-only",
    "root": "deep-student-e2e-20260529-200400"
  }
}
```

It should persist the fixture metadata without exposing secrets in normal status output. Tests can request credentials only when filling UI fields.

### Agent Parallelism

For future multi-agent testing, the manager should reserve instance ownership:

```json
{
  "instance_id": "deep-student-device-a",
  "owner": "codex-agent-sync-download",
  "lease_expires_at": "2026-05-29T14:30:00Z",
  "current_task": "cloud download-only regression"
}
```

This prevents two subagents from driving the same window at once. Parallelism should happen across windows, not inside one shared app instance.

### Assertions As First-class Commands

The manager should not only launch apps. It should provide standard assertion helpers:

- `assert-sqlite`
- `assert-webdav-files`
- `assert-credential-present`
- `assert-credential-absent`
- `assert-slot`
- `snapshot-state`

The UI action remains the test entry point, but assertions should be reusable and machine-readable.

Example:

```sh
tauri-e2e assert-sqlite deep-student-device-a \
  --db chat_v2 \
  --query "select count(*) from chat_v2_sessions" \
  --equals 6
```

### Minimum MVP

The smallest useful version should include:

- Project registration.
- Profile registration for two devices.
- Detached start/stop/status.
- Unique HOME and DEVICE_ID per instance.
- Unique wrapper app and bundle id per instance.
- Log capture.
- WebDAV fixture metadata.
- A `status --json` command that gives Codex exact Computer Use targets.

### Later Enhancements

After the MVP works:

- Add dynamic metrics port injection.
- Add per-instance screenshot/evidence folders.
- Add route/deep-link startup if the Tauri app supports it.
- Add per-agent leases.
- Add failure bundle collection: logs, DB counts, WebDAV tree, screenshots.
- Add a test plan runner that sequences UI instructions plus assertions.

## Next Testing Priorities

Recommended next cases:

- True two-device conflict test using isolated bundle ids.
- Backup restore with encrypted cloud backup password.
- S3-compatible fixture, likely MinIO, after WebDAV coverage stabilizes.
- Network interruption during upload/download.
- Restart during pending slot restore.
- Clear config followed immediately by backup, to verify stale WebView settings are not reintroduced.
- Running two Codex agents against two windows with manager leases.

## 2026-05-30 Parallelization Update

After implementing `tauri-lab`, a local stress run validated that the manager can safely exceed the scale needed for cloud sync testing:

- 64 Deep Student Tauri instances were started simultaneously.
- All instances reached metrics-ready state.
- Computer Use could still target and click the last instance by exact `.app` path.
- No swap I/O was observed in the sampled 64-instance state.

The practical recommendation is not to run cloud sync UI workflows at 64 windows. Use 10-15 instances as the normal working set:

- 5 Codex subagents.
- 2-3 leased devices per subagent.
- One parent-owned WebDAV fixture.
- Scenario-specific remote root prefixes unless testing conflicts.

Suggested work split:

| Agent | Scenario |
| --- | --- |
| A | Fresh config, connection, upload-only, missing credential recovery |
| B | Download-only hydration from seeded WebDAV state |
| C | Bidirectional sync and conflict behavior |
| D | Backup, history, restore, restart-dependent slot activation |
| E | Retry/interruption, stale config cleanup, post-restore sync sanity |

Every subagent should return UI steps, instance ids, app paths, assertions, WebDAV tree deltas, evidence snapshot paths, and failures. The parent agent should aggregate results and do final cleanup.
