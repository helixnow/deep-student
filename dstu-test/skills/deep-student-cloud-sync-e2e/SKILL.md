---
name: deep-student-cloud-sync-e2e
description: Run real, UI-driven Deep Student cloud sync E2E tests. Use when Codex needs to validate WebDAV/cloud sync, backup, restore, credentials, conflict behavior, multi-device synchronization, or sync regressions through real Tauri UI operations followed by SQLite/WebDAV/log verification.
---

# Deep Student Cloud Sync E2E

Use this skill for realistic cloud sync testing of Deep Student. The entry point must be real Tauri UI actions through Computer Use; shell, SQLite, and WebDAV checks are assertions after UI actions.

## Required Shape

1. Start or claim isolated Tauri instances with `tauri-lab`.
2. Start a local Docker WebDAV fixture for cloud storage.
3. Configure sync through the app UI.
4. Trigger sync, backup, restore, and retry flows through UI buttons.
5. Verify results with SQLite, WebDAV file trees, metrics, and logs.
6. Record failures with exact UI steps and state evidence.

## Parallel Agent Shape

For high-throughput real testing, run five subagents over a shared `tauri-lab` pool and shared local WebDAV fixture:

- Create 10-15 app instances. Prefer 15 when each agent needs a writer, reader, and recovery/restore target.
- Give each subagent a distinct owner id and 2-3 leased instances.
- Each subagent must use only its leased `target.app` paths with Computer Use.
- Subagents must not call `computer-use list` to choose targets. They may inspect `lease list` for verification, but target selection comes only from the parent assignment.
- Subagents should run `agent targets --owner ...` after receiving the assignment, then `agent verify <instance> --owner ... --app ... --require-running --json` before the first Computer Use action. A failed verify aborts that sub-run.
- Partition WebDAV roots by scenario or device group so agents do not overwrite each other's remote state unless the scenario is explicitly a conflict test.
- Subagents must not stop, restart, remove, or reconfigure a shared WebDAV fixture. Interruption tests must use a bad endpoint/credentials, or the parent must allocate an exclusive fixture for that agent.
- Every subagent reports: leased instance ids, UI steps performed, assertions run, WebDAV tree deltas, evidence snapshot paths, failures, and cleanup status.
- The parent must not use a short active timeout for full cloud-sync runs. Real UI setup, multi-device sync, backup/restore, and diagnostics can take about an hour. After spawning subagents, the parent should sleep or passively poll, wait for final reports, and avoid closing agents unless they explicitly fail, complete, or the user asks to stop.

Recommended five-way split:

| Agent | Devices | Scenario |
| --- | --- | --- |
| A | 2 | fresh config, connection test, upload-only, missing password recovery |
| B | 2 | download-only hydration from preseeded WebDAV state |
| C | 3 | bidirectional sync, conflict count, concurrent edits |
| D | 3 | cloud backup, backup history, restore pending slot, restart activation |
| E | 2-3 | interruption/retry, stale config cleanup, post-restore sync sanity |

The parent agent owns fixture startup, pool startup, lease assignment, final aggregation, and final cleanup.

Parent waiting policy:

- Give long-running subagents enough time to finish their assigned real UI workflows.
- Do not interpret no report within 30/60/180 seconds as a hang.
- Passive checks are allowed: pool status, lease audit, WebDAV status/tree snapshots, and logs/evidence reads.
- Active intervention is allowed only after an explicit subagent failure/completion, user instruction, or hard evidence that infrastructure is gone, such as a stopped app process or stopped fixture.
- Do not operate a subagent's assigned app window from the parent while the subagent is still running.

Anti-collision rule: app windows are never shared. Even conflict tests share cloud state only through WebDAV prefixes; each actor still uses its own leased Tauri instance.

## Instance Setup

Prefer a pool when simulating multiple devices:

```sh
cd <deep-student-repo>
npm run tauri-lab -- service start --json
npm run tauri-lab -- project register deep-student \
  --cwd "$PWD" \
  --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app" \
  --json
npm run tauri-lab -- pool create deep-student sync-e2e --count 4 --json
npm run tauri-lab -- pool start sync-e2e --concurrency 2 --wait --metrics --timeout 45 --json
```

For five subagents:

```sh
npm run tauri-lab -- pool create deep-student sync-e2e-15 --count 15 --json
npm run tauri-lab -- pool start sync-e2e-15 --concurrency 4 --wait --metrics --timeout 90 --json
```

Start the WebDAV fixture:

```sh
npm run tauri-lab -- fixture webdav start sync-webdav \
  --username ds-test \
  --password ds-pass \
  --root deep-student-e2e \
  --json
npm run tauri-lab -- fixture webdav credentials sync-webdav --json
```

Use the fixture `endpoint`, `username`, password, and `root` only by typing them through the real cloud settings UI.

For repeated regression runs, prefer a `tauri-lab` data image after one real UI configuration pass:

```sh
npm run tauri-lab -- image create sync-webdav-configured \
  --from-instance sync-e2e-01 \
  --scope home \
  --description "WebDAV configured through real UI" \
  --json
npm run tauri-lab -- pool create deep-student sync-e2e-15 \
  --count 15 \
  --image sync-webdav-configured \
  --json
```

The image is allowed only after the original configuration was created through real UI operations. Subsequent tests may start from the image, then perform the scenario-specific sync/backup/restore actions through UI and verify with SQLite/WebDAV/logs.

For a fast, broad cloud-sync smoke, prefer the newest wide coverage image when
it is available locally. The current strongest image is
`sync-wide-chaos-deep-coverage-seed-0531`:

```sh
npm run tauri-lab -- image inspect sync-wide-chaos-deep-coverage-seed-0531 --json
npm run dstu-test:inspect-wide-sync -- \
  --image sync-wide-chaos-deep-coverage-seed-0531 \
  --mode seed
npm run tauri-lab -- instance create deep-student sync-wide-writer \
  --image sync-wide-chaos-deep-coverage-seed-0531 \
  --device-id sync-wide-writer \
  --json
```

The inspect command must pass before using the image as the canonical broad
regression seed. It checks foreign keys, blob files, blob references,
question-set breadth, todo parent links, tombstones, same-record multi-change
chains, composite replay paths, business unique-key reuse after delete, JSON
update chains, chat attachments/resources, mistakes review data, and LLM status
variety.

The previous stable image `sync-wide-stable-coverage-seed-0531` is still useful
for comparing historical 441-change runs. Use the deep image first when the
goal is maximum schema coverage in one pass.

Drive this scenario through real UI:

1. Configure WebDAV on the seeded writer, then click Upload.
2. Verify the remote package contains broad VFS/chat/mistakes/LLM rows and at
   least one `blobs` row.
3. Create a clean reader with no image, configure the same WebDAV root through
   UI, then click Download.
4. Assert no `files -> blobs` orphan rows, no `foreign_key_check` rows, and no
   unresolved `__sync_conflicts`.
5. Click Download again on the same reader and verify backend logs show
   `total=0`.
6. Upload the reader's small local delta, then download from a second clean
   reader to cover two-package hydration without replay amplification.
7. Run hydrated audit on downloaded readers:

```sh
npm run dstu-test:inspect-wide-sync -- \
  --instance <reader-instance-id> \
  --mode hydrated
```

For the deep image, the 2026-05-31 baseline was writer upload `569`, first
reader download `total=435, deduped=134, conflicts=0`, repeated download
`total=0`, 4 blobs hydrated, 2 workspace DBs hydrated, and hydrated audit PASS.

Claim an instance for each agent:

```sh
npm run tauri-lab -- agent checkout sync-e2e \
  --owner codex-sync-agent-a \
  --purpose "cloud sync upload/download" \
  --ttl 7200 \
  --json
```

Use the returned `target.app` path in Computer Use.

When assigning multiple devices to one subagent, repeat checkout with the same owner and role-specific purpose. Keep leases active until that subagent has captured evidence, then release or let the parent clean all instances after aggregation.

Subagent preflight:

```sh
npm run tauri-lab -- agent targets --owner codex-sync-agent-a --json
npm run tauri-lab -- agent verify sync-e2e-01 \
  --owner codex-sync-agent-a \
  --app "<exact target.app path returned by tauri-lab>" \
  --require-running \
  --json
```

Parent final audit and cleanup:

```sh
npm run tauri-lab -- lease audit --json
npm run tauri-lab -- lease clear --pool sync-e2e-15 --json
```

## What To Verify

- Configured provider/root/username/password behavior.
- Missing credential state: safe config present but secure credential absent must not look healthy.
- Upload-only: remote change files and manifest appear; local pending changes clear.
- Download-only: remote changes hydrate local DB; local-only pending changes remain pending.
- Bidirectional sync: both upload and download effects occur.
- Cloud backup: remote ZIP appears and UI history updates.
- Cloud restore: inactive slot becomes pending, then restart switches active slot.
- Post-restore sync: credentials and device identity remain correct.
- Conflict reporting: UI conflict count must match actionable conflict rows.

## Assertions

Prefer `tauri-lab` assertions after UI actions:

```sh
npm run tauri-lab -- assert sqlite sync-e2e-01 \
  --slot active \
  --db chat_v2 \
  --query "select count(*) from chat_v2_sessions;" \
  --equals 6 \
  --json
npm run tauri-lab -- assert credential sync-e2e-01 --cloud-storage present --json
npm run tauri-lab -- assert webdav-tree sync-webdav \
  --contains "data_governance/manifests/e2e-device-a.json" \
  --json
```

Capture evidence after each major cloud sync phase and before cleanup:

```sh
npm run tauri-lab -- evidence snapshot sync-e2e-01 --tail 300 --json
npm run tauri-lab -- fixture webdav tree sync-webdav --json
```

Read logs when behavior is surprising:

```sh
npm run tauri-lab -- logs sync-e2e-01 --kind backend --tail 200
npm run tauri-lab -- logs sync-e2e-01 --kind frontend --tail 200
npm run tauri-lab -- logs sync-e2e-01 --kind stderr --tail 200
```

## Known Product/Test Lessons

- Same bundle id can pollute same-machine WebKit state. Always use `tauri-lab` copied bundles.
- `DEVICE_ID` and `DSTU_METRICS_ADDR` must be explicit per instance.
- Opening the main screen can auto-create an empty chat session; record it as baseline.
- Restore is restart-dependent: verify pending slot before restart and active slot after restart.
- Safe cloud config without secure credentials can create a half-configured state; test it deliberately.
- Docker Desktop must be running before `fixture webdav start`; if it is not, the command fails fast and should be retried after Docker starts.
- Do not inspect SQLite/WebDAV before the UI action. Use database and cloud checks as assertions and diagnostics only.
- Parent and subagents must avoid duplicate Computer Use targets. Lease first, then operate.
- Use `agent targets` and `agent verify` instead of global target browsing when multiple Codex windows or subagents are active.
- A 2026-05-30 local stress run proved 64 instances can be managed on this machine, but detailed cloud sync workflows should usually run at 10-15 active windows for clearer debugging and less UI latency.
- A 2026-05-30 30-instance cloud-sync matrix found P0 duplicate replay and re-upload amplification. Always test fresh seeded devices against roots with 1, 2, and 3 equivalent remote packages, then assert that `__change_log` does not grow from `359 -> 718 -> 1077` and that bidirectional sync does not upload another full package.
- The 2026-05-30 focused `sync-fix-smoke` retest verified the fix shape: first fresh download from a seeded root logged `deduped=134`, second fresh device with two remote packages logged `total=226, deduped=134`, repeated download logged `total=0`, and chat/vfs/llm `__change_log` stayed at `49/72/38` with zero actionable conflicts.
- Treat backend `conflicts=N` as suspect until UI record-level conflicts and SQLite `__sync_conflicts` agree. Record all three values in every conflict/idempotency run.
- Credential assertions are not enough by themselves: current evidence found cloud credentials under a global same-machine path. Verify the UI-saved provider/root and instance-scoped behavior, not just credential file presence.
- For secure password inputs, prefer real click plus keyboard typing. Accessibility `set_value` can make the field appear filled while frontend state remains empty, which is useful as a negative test but not reliable for setup.
- Shared WebDAV fixtures can stop during high-concurrency runs. Capture fixture `status`, Docker state, and tree size at start, mid-run, and final aggregation; do not restart a shared fixture mid-scenario unless the parent explicitly makes restart part of the test design.
- The 2026-05-31 wide-image regression found real todo ordering and
  `files -> blobs` foreign-key bugs, then verified the fixes with a 441-change
  writer package, a clean reader download, repeated download `total=0`, and a
  second clean reader downloading from two remote packages.
- The 2026-05-31 deep wide-image regression verified the stronger
  `sync-wide-chaos-deep-coverage-seed-0531` image: 569 uploaded changes,
  reader download `total=435, deduped=134`, 4 blobs, 2 workspace DBs, no open
  conflicts, hydrated audit PASS, and repeated UI Download `total=0`.
- If Computer Use returns `remoteConnection` followed by `cgWindowNotFound`
  during a post-sync UI probe, first capture `evidence snapshot`, frontend
  logs, backend logs, and `instance status`. Then verify whether System Events
  sees any windows for the app process. Do not reinterpret a successful prior
  UI-triggered sync as shell-triggered just because the later window
  enumeration layer failed.

## References

Read `references/checklist.md` before starting a full cloud sync run.
