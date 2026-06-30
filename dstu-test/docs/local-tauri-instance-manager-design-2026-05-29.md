# Local Tauri Instance Manager Design

Date: 2026-05-29
Project: Deep Student
Status: MVP implemented and locally validated

## Problem

Real desktop E2E testing needs multiple independent Tauri app windows:

- Cloud sync tests need multiple simulated devices.
- Codex may compact context or the user may switch to a different Codex window.
- Future parallel subagents should be able to test different app modules at the same time.
- Computer Use needs stable and unambiguous app targets.

Starting Tauri from a Codex shell session is not enough. If the shell/session dies, the app process and server context are easy to lose. A local manager should own those processes as a service and expose simple commands that any Codex session can call later.

## Local Findings

### Device ID Is Already Environment-controllable

`src-tauri/src/cloud_storage/sync_manager.rs` reads `DEVICE_ID` before falling back to persisted device files. This is ideal for simulated devices.

Implication:

- The manager must launch each instance by executing the app binary directly with an explicit `DEVICE_ID`.
- Avoid `open -n Some.app` for controlled launches because environment variables can be lost.

### Metrics Port Is Already Environment-controllable

`src-tauri/src/metrics_server.rs` defaults to `127.0.0.1:59321`, but also reads `DSTU_METRICS_ADDR`.

Implication:

- The manager can allocate a unique metrics port per instance without app code changes.
- Example: `DSTU_METRICS_ADDR=127.0.0.1:59331`.

### Bundle Identity Matters For Computer Use And WebKit Storage

Same-machine multi-device tests that share the same bundle id can cross-contaminate WebKit localStorage. Computer Use can also target the wrong app if there is an installed release and a dev build with the same name.

Implication:

- Each managed instance should have a unique copied `.app` bundle.
- Each copied bundle should have a unique `CFBundleIdentifier`, `CFBundleName`, and `CFBundleDisplayName`.
- Computer Use should target the copied app path or unique bundle id, never the generic `Deep Student` name.

### Data Slots Add Another Restart Boundary

Cloud restore writes to an inactive slot and marks it pending. The restored data only becomes active after restart.

Implication:

- The manager should provide `restart` as a first-class action.
- Assertions should include active slot checks.

## Design Goals

The manager should be:

- Service-owned: app instances survive Codex process exit, context compaction, or terminal replacement.
- Command-driven: Codex can operate it using stable CLI commands.
- Computer Use friendly: every app window has a stable, unambiguous target.
- Multi-device aware: each instance has isolated app data, WebKit storage, device id, metrics port, logs, and cloud test root.
- Parallel-agent safe: subagents can lease different instances without fighting over one window.
- Evidence oriented: every run has logs, DB paths, WebDAV roots, screenshots, and status snapshots.

## Proposed Shape

Use two components:

1. A local service daemon.
2. A CLI that talks to the daemon.

Working name:

```text
tauri-lab
```

The daemon owns process lifecycle. The CLI is the interface used by Codex, humans, and future subagents.

## Service Model

### macOS LaunchAgent

On macOS, install the daemon as a per-user LaunchAgent:

```text
~/Library/LaunchAgents/com.deepstudent.tauri-lab.plist
```

Commands:

```sh
tauri-lab service install
tauri-lab service start
tauri-lab service stop
tauri-lab service status --json
tauri-lab service uninstall
```

The service should bind only to localhost or a Unix domain socket. It should not expose network access beyond the local machine.

### IPC

Preferred first version:

- Unix domain socket on macOS/Linux.
- Named pipe or localhost HTTP fallback for Windows later.

Simple fallback for MVP:

- Localhost HTTP API bound to `127.0.0.1`.
- Random auth token stored in a chmod `0600` file.

The CLI reads the token and calls the daemon.

## Registry Layout

Use a stable user-level directory:

```text
~/Library/Application Support/tauri-lab/
  daemon.json
  token
  registry.json
  projects/
    deep-student.json
  instances/
    deep-student-device-a.json
    deep-student-device-b.json
  apps/
    Deep Student E2E A.app/
    Deep Student E2E B.app/
  homes/
    deep-student-device-a/
    deep-student-device-b/
  logs/
    daemon.log
    deep-student-device-a.stdout.log
    deep-student-device-a.stderr.log
  evidence/
    deep-student-device-a/
```

The project can also have a lightweight checked-in config, but runtime state should live outside the repo so Codex context changes and git operations do not disrupt it.

## Data Model

### Project

```json
{
  "id": "deep-student",
  "name": "Deep Student",
  "cwd": "<deep-student-repo>",
  "source_app": "<deep-student-repo>/src-tauri/target/debug/bundle/macos/Deep Student.app",
  "binary_relative_path": "Contents/MacOS/deep-student",
  "default_env": {
    "RUST_LOG": "info"
  }
}
```

### Instance

```json
{
  "id": "deep-student-device-a",
  "project_id": "deep-student",
  "profile": "device-a",
  "display_name": "Deep Student E2E A",
  "bundle_id": "com.deepstudent.e2e.device-a",
  "app_path": "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app",
  "binary_path": "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app/Contents/MacOS/deep-student",
  "home": "~/Library/Application Support/tauri-lab/homes/deep-student-device-a",
  "device_id": "e2e-device-a",
  "metrics_addr": "127.0.0.1:59331",
  "pid": 12345,
  "state": "running",
  "computer_use_target": "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app",
  "log_stdout": "~/Library/Application Support/tauri-lab/logs/deep-student-device-a.stdout.log",
  "log_stderr": "~/Library/Application Support/tauri-lab/logs/deep-student-device-a.stderr.log"
}
```

### Lease

```json
{
  "instance_id": "deep-student-device-a",
  "owner": "codex-agent-sync-download",
  "purpose": "cloud sync download-only regression",
  "created_at": "2026-05-29T14:00:00Z",
  "expires_at": "2026-05-29T15:00:00Z"
}
```

Leases prevent two agents from driving the same window. The manager may allow force-release for stale leases.

## Command Interface

### Project Commands

```sh
tauri-lab project register deep-student \
  --cwd <deep-student-repo> \
  --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app"

tauri-lab project list --json
tauri-lab project inspect deep-student --json
```

### Instance Commands

```sh
tauri-lab instance create deep-student device-a \
  --display-name "Deep Student E2E A" \
  --bundle-id com.deepstudent.e2e.device-a \
  --device-id e2e-device-a \
  --metrics-addr 127.0.0.1:59331

tauri-lab instance start deep-student-device-a
tauri-lab instance start deep-student-device-a --wait --metrics --timeout 30
tauri-lab instance stop deep-student-device-a
tauri-lab instance restart deep-student-device-a
tauri-lab instance wait deep-student-device-a --metrics --timeout 30
tauri-lab instance stop-all
tauri-lab instance status deep-student-device-a --json
tauri-lab instance list --json
```

### Computer Use Commands

```sh
tauri-lab computer-use target deep-student-device-a
tauri-lab computer-use list --json
```

Output should be copy-paste ready:

```json
{
  "app": "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app",
  "bundle_id": "com.deepstudent.e2e.device-a",
  "pid": 12345,
  "window_hint": "Deep Student"
}
```

Codex can then call Computer Use with the exact `app` path. This is the most important UX detail for automation.

### Log And Evidence Commands

```sh
tauri-lab logs deep-student-device-a --tail 200
tauri-lab evidence snapshot deep-student-device-a
tauri-lab evidence open deep-student-device-a
```

Snapshot should collect:

- instance JSON
- process status
- latest logs
- active slot state
- SQLite counts
- WebDAV file tree, if a cloud fixture is attached
- optional screenshot path from Computer Use, if available

### Lease Commands

```sh
tauri-lab lease acquire deep-student-device-a \
  --owner codex-agent-sync-download \
  --purpose "cloud sync download-only regression" \
  --ttl 3600

tauri-lab lease release deep-student-device-a --owner codex-agent-sync-download
tauri-lab lease list --json
```

### Fixture Commands

```sh
tauri-lab fixture webdav start deep-student-sync \
  --port 18080 \
  --username ds-test \
  --password-ref local-dev \
  --root deep-student-e2e-20260529-200400

tauri-lab fixture webdav status deep-student-sync --json
tauri-lab fixture webdav tree deep-student-sync
```

Secrets should be hidden in ordinary output. The CLI can expose them only through explicit test setup commands.

## Launch Strategy

### Build/copy App Bundle

For each instance:

1. Copy the source app bundle to manager-owned `apps/`.
2. Patch `Contents/Info.plist`:
   - `CFBundleIdentifier`
   - `CFBundleName`
   - `CFBundleDisplayName`
3. Launch the copied app binary directly with environment variables:
   - `HOME`
   - `DEVICE_ID`
   - `DSTU_METRICS_ADDR`
   - `RUST_LOG`
   - optional `DSTU_E2E_INSTANCE_ID`

Example daemon launch:

```sh
env \
  HOME="~/Library/Application Support/tauri-lab/homes/deep-student-device-a" \
  DEVICE_ID="e2e-device-a" \
  DSTU_METRICS_ADDR="127.0.0.1:59331" \
  RUST_LOG="info" \
  "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app/Contents/MacOS/deep-student"
```

This preserves environment control while giving Computer Use a unique app bundle.

### Why Not `open -n`

`open -n` is convenient for humans but bad for this harness:

- Environment propagation is unreliable.
- It can launch the wrong installed app with the same bundle id.
- It makes `DEVICE_ID` and metrics port control less deterministic.

The daemon should launch the binary itself.

## Development Modes

### Mode 1: Bundled App Mode

Use an already built debug/release app bundle.

Pros:

- Most stable.
- No Vite server dependency.
- Best for cloud sync, backup, restore, persistence tests.

Cons:

- Requires rebuild after frontend changes.

### Mode 2: Shared Frontend Dev Server

Run one frontend dev server and launch multiple Tauri shells against it.

Pros:

- Faster iteration for UI changes.

Cons:

- More moving parts.
- Source Tauri config has a fixed dev URL.
- Need to ensure all app instances point to the same compatible dev server.

Recommendation:

- MVP should support bundled app mode first.
- Add shared dev server mode later.

## Assertions

The manager should include assertion helpers, because raw shell commands are easy to lose across context compaction.

Examples:

```sh
tauri-lab assert sqlite deep-student-device-a \
  --slot active \
  --db chat_v2 \
  --query "select count(*) from chat_v2_sessions" \
  --equals 6

tauri-lab assert slot deep-student-device-a --active slotB --pending null

tauri-lab assert webdav-tree deep-student-sync \
  --contains "data_governance/manifests/e2e-device-a.json"

tauri-lab assert credential deep-student-device-a --cloud-storage present
```

UI action should remain the test entry point. Assertions are for state verification after Computer Use operations.

## Computer Use Workflow

A future test should look like this:

```sh
tauri-lab service start
tauri-lab project register deep-student --cwd <deep-student-repo> --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app"
tauri-lab fixture webdav start deep-student-sync --port 18080
tauri-lab instance create deep-student device-a --device-id e2e-device-a --metrics-addr 127.0.0.1:59331
tauri-lab instance create deep-student device-b --device-id e2e-device-b --metrics-addr 127.0.0.1:59332
tauri-lab instance start deep-student-device-a
tauri-lab instance start deep-student-device-b
tauri-lab computer-use list --json
```

Then Codex uses Computer Use:

```json
{
  "app": "~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app"
}
```

After UI actions:

```sh
tauri-lab evidence snapshot deep-student-device-a
tauri-lab assert sqlite deep-student-device-a --slot active --db chat_v2 --query "select count(*) from chat_v2_sessions" --equals 6
```

## Service Survival Semantics

The daemon should distinguish:

- Daemon process lifetime.
- Managed app process lifetime.
- Test lease lifetime.
- Codex session lifetime.

Codex session exit should not stop the daemon or managed apps.

The user or Codex should explicitly stop them:

```sh
tauri-lab instance stop deep-student-device-a
tauri-lab fixture webdav stop deep-student-sync
tauri-lab service stop
```

The daemon can optionally restart crashed instances if the instance has `"restart_policy": "on-failure"`.

For UI tests, default should be `"restart_policy": "never"` so crashes remain visible.

## Parallel Subagent Model

Parallel testing should be window-per-agent:

- Agent A leases device A and tests sync settings.
- Agent B leases device B and tests backup/restore.
- Agent C leases device C and tests main chat UI.

No two agents should operate one app window at the same time.

The manager should make this visible:

```sh
tauri-lab lease list
tauri-lab instance list --with-leases
```

## Security

The service must be local-only:

- Bind to localhost or Unix socket only.
- Use an auth token for HTTP.
- Store token with `0600` permissions.
- Do not print secrets by default.
- Keep WebDAV passwords in fixture config as secret refs or test-only generated credentials.
- Redact secure fields in logs and status JSON.

## MVP Implementation Plan

### Phase 1: CLI + Detached Process Supervisor

Implement a Node.js CLI first, because the repo already has Node tooling and the logic is mostly filesystem/process orchestration.

MVP commands:

- `service start/status/stop`
- `project register/list/inspect`
- `instance create/start/stop/restart/status/list/stop-all/wait`
- `computer-use target/list`
- `lease acquire/release/list`
- `logs`

For the first cut, the service can be a detached Node daemon.

Phase 1 landed as:

- `dstu-test/scripts/tauri-lab.mjs`
- `npm run tauri-lab -- ...`

Runtime defaults:

- Root: `~/Library/Application Support/tauri-lab`
- Daemon endpoint: `127.0.0.1:47631`
- Token file: `~/Library/Application Support/tauri-lab/token`
- Registry: `~/Library/Application Support/tauri-lab/registry.json`

The MVP uses only Node.js standard library APIs and does not add project dependencies.

Usability improvements landed after the first validation run:

- `--ensure-service` can start the daemon automatically for daemon-backed commands.
- `instance create` auto-allocates metrics ports from `127.0.0.1:59331-59430` when `--metrics-addr` is omitted.
- `instance start --wait --metrics` and `instance wait --metrics` wait for real readiness instead of requiring ad hoc sleeps.
- `service stop --with-instances` stops running managed apps before shutting down the daemon.
- `instance stop-all` stops every running managed app without stopping the daemon.
- `lease acquire/release/list` records short-lived ownership so parallel agents can avoid driving the same window.
- `instance list` and `computer-use list` include current lease metadata.
- When the daemon is stopped, commands now give a direct `service start` / `--ensure-service` hint instead of a raw `ECONNREFUSED`.
- `pool create/start/stop/status/list` can manage many Deep Student instances as one test pool.
- `agent checkout/release` gives each Codex agent a leased instance plus Computer Use target, HOME, metrics, and log paths.
- Backend, stderr, frontend, and daemon logs can be read separately with `logs --kind`.
- The daemon serializes API handling to avoid concurrent registry writes losing pids during parallel pool startup.
- The app now has a tauri-lab frontend log bridge that writes WebView warnings/errors to the instance `frontend.jsonl` file when launched by tauri-lab.
- `service install/uninstall` can create or remove a macOS LaunchAgent so the daemon can be started as a user service outside a Codex terminal.
- `fixture webdav start/status/tree/credentials/stop` manages a local Docker WebDAV server as a first-class cloud fixture.
- `image create/apply/list/inspect/remove` manages reusable per-instance data images for seeded UI tests.
- `evidence snapshot` captures instance status, Computer Use target, backend/stderr/frontend log tails, metrics, slot state, SQLite summaries, and cloud credential presence into a resumable evidence directory.
- `assert slot/sqlite/credential/webdav-tree` provides reusable post-UI assertions for cloud sync tests.

## MVP Validation Run

Run date: 2026-05-29

Validation commands used:

```sh
npm run tauri-lab -- service start --json
npm run tauri-lab -- project register deep-student \
  --name "Deep Student" \
  --cwd <deep-student-repo> \
  --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app" \
  --json
npm run tauri-lab -- instance create deep-student lab-a \
  --id deep-student-lab-a \
  --display-name "Deep Student E2E A" \
  --bundle-id com.deepstudent.e2e.lab-a \
  --device-id e2e-lab-a \
  --metrics-addr 127.0.0.1:59341 \
  --json
npm run tauri-lab -- instance create deep-student lab-b \
  --id deep-student-lab-b \
  --display-name "Deep Student E2E B" \
  --bundle-id com.deepstudent.e2e.lab-b \
  --device-id e2e-lab-b \
  --metrics-addr 127.0.0.1:59342 \
  --json
npm run tauri-lab -- instance start deep-student-lab-a --json
npm run tauri-lab -- instance start deep-student-lab-b --json
npm run tauri-lab -- computer-use list --json
```

Validated behavior:

- The daemon detached from the Codex shell and ran with `PPID=1`.
- Both managed app instances launched from copied `.app` bundles.
- A used bundle id `com.deepstudent.e2e.lab-a`; B used `com.deepstudent.e2e.lab-b`.
- Computer Use could target each instance by exact `.app` path:
  - `~/Library/Application Support/tauri-lab/apps/Deep Student E2E A.app`
  - `~/Library/Application Support/tauri-lab/apps/Deep Student E2E B.app`
- Both instances reached the real Tauri UI and accepted the first-run agreement through Computer Use.
- Each instance created its own HOME and app data tree under `homes/`.
- Each instance exposed metrics on its own port.
- `instance restart deep-student-lab-b` terminated the old process and started a new controllable process.
- `instance stop` terminated the app process and closed the metrics port.
- Stopping the daemon did not kill an already running app instance; the app was reparented to `PPID=1` and remained controllable by Computer Use.
- Restarting the daemon could read the registry and report that still-running app as `running` by checking the stored pid.

State isolation checks:

```sh
sqlite3 ".../homes/deep-student-lab-a/.../slotA/chat_v2.db" \
  "select count(*), group_concat(id) from chat_v2_sessions;"
sqlite3 ".../homes/deep-student-lab-b/.../slotA/chat_v2.db" \
  "select count(*), group_concat(id) from chat_v2_sessions;"
```

Observed result:

- A and B each had their own `chat_v2.db`.
- A and B had different session IDs.
- A and B had different `.master_key` hashes.
- Message counts remained zero because no LLM send action was performed.

Current cleanup result:

- Both managed instances were stopped.
- The daemon was stopped after validation.
- The copied bundles, homes, logs, and registry remain under `~/Library/Application Support/tauri-lab` for future reuse.

Second smoke validation used a temporary runtime root under `/tmp` and confirmed:

- `project list --ensure-service` can auto-start a fresh daemon.
- `instance create` assigned `127.0.0.1:59331` and `127.0.0.1:59332` automatically to two instances.
- `lease acquire` added the lease to both `instance list` and `computer-use list`.
- A second `lease acquire` by a different owner was rejected with `lease already held`.
- `instance start --wait --metrics --timeout 20` waited until the real Tauri metrics endpoint was reachable.
- `service stop --with-instances` stopped the running Tauri process and then stopped the daemon.
- The temporary runtime root was removed after the smoke run.

Third smoke validation confirmed:

- `pool create deep-student codex-pool --count 3` created three isolated instances with ports `59331-59333`.
- `agent checkout` assigned different instances to different owners.
- `pool start --concurrency 2 --wait --metrics --timeout 35` brought all three instances to metrics-ready state.
- A registry race was found when concurrent start requests wrote stale registry snapshots; daemon API handling was serialized and the smoke was rerun successfully.
- `pool stop` and `service stop --with-instances` cleaned up all test processes and the temporary runtime root.

Fourth command-level smoke validation confirmed:

- `node --check dstu-test/scripts/tauri-lab.mjs` passed.
- A temporary runtime root could start the daemon, register the project, create a two-instance pool, lease one instance, run `assert slot`, run `assert credential`, capture `evidence snapshot`, list fixtures, and stop cleanly.
- `fixture webdav start` fails fast with a clear Docker daemon error when Docker Desktop is not running, and leaves no orphaned tauri-lab daemon.

Codex skills created for future sessions:

- `~/.codex/skills/deep-student-tauri-lab`
- `~/.codex/skills/deep-student-cloud-sync-e2e`

## MVP Gaps Found During Validation

- `service stop` still stops only the daemon by default. This remains useful for proving app survival; use `service stop --with-instances` when cleanup should include apps.
- Commands such as `instance list` still require the daemon to be running. `--ensure-service` removes most of the friction, but a fully offline registry reader could still be useful.
- LaunchAgent install/uninstall exists, but it still needs a real install/bootout validation pass on the user's machine before relying on it as the default startup path.
- WebDAV fixture commands exist, but Docker Desktop was not running during the latest validation, so a full fixture start and app UI connection pass is still pending.
- Leases are advisory only right now. Future subagent tooling should honor them automatically before using Computer Use.
- Pool scale beyond three instances still needs a longer soak run at target size, such as 12-16 instances with `--concurrency 4`.

## 2026-05-30 Stress Result And Parallel Testing Topology

A capacity run on the local machine validated that `tauri-lab` can manage far more windows than the expected daily cloud-sync workload needs.

Observed scale ladder:

- 16, 20, 24, 32, 40, 48, 56, and 64 simultaneous Deep Student Tauri instances all started successfully.
- All tested instances reached `--wait --metrics` readiness.
- Computer Use could target first/middle/last windows by exact copied `.app` path, including the 64th instance.
- The 64-instance sample showed near-idle CPU and no swap I/O.
- One 48-instance UI click briefly took about two seconds and showed a transient loading state, but 56 and 64 returned to about one second for the sampled click.

This does not prove an absolute maximum. It does prove that the current machine has enough headroom for a practical 5-agent cloud sync test topology.

Recommended topology for real E2E work:

- Parent agent starts the daemon, WebDAV fixture, and a `sync-e2e-15` pool.
- Parent leases 2-3 devices to each subagent.
- Each subagent receives only its leased instance ids, exact Computer Use app paths, metrics addresses, logs, fixture id, and assigned WebDAV root/prefix.
- Each subagent drives UI only through Computer Use, then verifies via `tauri-lab assert ...`, `fixture webdav tree`, logs, and `evidence snapshot`.
- Parent aggregates the five reports and performs final cleanup.

Recommended five-way scenario split:

| Agent | Instance Count | Focus |
| --- | ---: | --- |
| A | 2 | Fresh WebDAV config, connection test, upload-only, missing password recovery |
| B | 2 | Download-only hydration from preseeded remote state |
| C | 3 | Bidirectional sync, conflict rows/counts, concurrent edits |
| D | 3 | Cloud backup, backup history, restore pending slot, restart activation |
| E | 2-3 | Network interruption/retry, stale config cleanup, post-restore sanity |

Operational notes:

- Use `pool start --concurrency 4 --wait --metrics --timeout 90` for the 15-instance pool.
- Use leases before any Computer Use operation; no two agents should ever share an app path.
- The parent agent is the only allocator. Subagents receive an assignment table and must not choose windows from `computer-use list`.
- Subagents should use `agent targets --owner <owner>` to rediscover only their own windows after context compaction.
- Subagents should run `agent verify <instance-id> --owner <owner> --app <exact-app-path> --require-running --json` before their first Computer Use action.
- Before dispatch, run `lease list --json` and confirm every assigned instance is leased to the expected owner.
- During and after the run, use `lease audit --json` to detect duplicate active app targets.
- After aggregation, compare each subagent report against the assignment table; any unassigned app path use invalidates that sub-run.
- Use scenario-specific WebDAV prefixes except for deliberate conflict tests.
- Treat shared fixtures as parent-owned global resources. Subagents must not stop/restart/remove a shared WebDAV fixture; interruption tests need bad endpoints or an exclusive fixture.
- Keep the daemon running while subagents are active, and clean with `lease clear --pool <pool-id>`, `instance stop-all`, fixture stop, then `service stop --with-instances`.

Data image workflow:

- Use images to skip expensive repeated setup after the setup flow has already been tested once through real UI.
- `image create <id> --from-instance <instance-id> --scope home` captures the instance HOME, including app data, local settings, first-run agreement state, and WebKit/localStorage state.
- `image create <id> --scope app-data` captures only `Library/Application Support/com.deepstudent.app`; this is smaller but may not preserve first-run UI state.
- `instance create ... --image <id>` and `pool create ... --image <id>` apply the image before startup.
- Apply images only to stopped instances. Use `--live` during image creation only for quick smoke seeds where a mid-write snapshot is acceptable.
- For `home` images, the manager rewrites bundle-id-scoped directory names when applying the image to a differently bundled test app.

### Phase 2: LaunchAgent Install

Landed:

- `service install`
- `service uninstall`
- `service status` reports LaunchAgent installation/loading status

Still needed:

- validate `launchctl bootstrap`/`bootout` on the target machine
- robust stale PID cleanup

### Phase 3: Fixtures And Assertions

Landed:

- WebDAV fixture lifecycle.
- SQLite assertion helper.
- WebDAV tree assertion.
- active/pending slot assertion.
- cloud credential presence assertion.
- evidence snapshot bundle.

Still needed:

- Docker-on validation for WebDAV fixture.
- richer DB schema-specific assertions.
- MinIO/S3 fixture after WebDAV stabilizes.

### Phase 4: Agent Leases

Add:

- lease acquire/release/list
- TTL cleanup
- owner labels in status output

### Phase 5: Optional App Support Improvements

Small app-side improvements could make the manager much better:

- `DSTU_WINDOW_TITLE_SUFFIX` to append instance labels to window titles.
- route startup env/deep link to open settings directly.
- explicit test mode flag to prevent auto-creating an empty chat session.
- command to dump current data dirs and active slot.
- built-in catalog of named seed images such as `lh-empty-accepted`, `lh-doc-preview-seed`, and `sync-webdav-configured`.

These are not required for the MVP, but they would make the framework significantly more reliable.

## Open Questions

- Should runtime state live under user-level `Application Support/tauri-lab` only, or should each repo also have a `.tauri-lab/project.json` checked in?
- Should the first implementation be a repo-local script or a reusable Codex-wide tool?
- Do we want bundled mode only at first, or should shared Vite dev server mode be included immediately?
- Should the manager create wrappers by copying `.app` bundles, or should it generate minimal wrapper apps around the original binary?
- How much should the manager know about Deep Student-specific SQLite schemas versus generic Tauri projects?

## Recommendation

Build the manager as a small service plus CLI, starting with bundled app mode.

The most important design choices are:

1. Daemon owns app processes, not Codex.
2. Each instance gets a unique copied app bundle and bundle id.
3. Launch binaries directly with explicit env vars.
4. CLI prints exact Computer Use targets.
5. Per-instance leases prevent subagents from colliding.
6. Assertions are first-class and evidence-oriented.
7. Owner-scoped target lookup and assignment verification prevent subagents from driving windows they were not given.
8. Data images let repeated multi-agent runs start from known states instead of rebuilding fixtures through slow UI setup every time.

This gives Codex a stable control plane: any later Codex window can run `tauri-lab instance list --json`, get the app targets, and continue testing without reconstructing the world.
