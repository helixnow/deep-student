# DSTU Test

`dstu-test/` collects the local, real-environment test system used for Deep Student Tauri testing:

- `dstu-test/scripts/tauri-lab.mjs`: multi-instance Tauri control plane for real desktop UI testing.
- `docker/`: build inputs for the cloud-sync fixture's FTP image (`Dockerfile.ftp`, `ftp_server.py`). The fixture composition itself lives in `scripts/dev/docker-compose.sync-test.yml`, which is also what CI's Cloud Provider Contract Gate runs; `docker/docker-compose.sync-test.yml` is only a thin `include` wrapper kept for older references.
- `skills/`: Codex skills that teach agents how to use `tauri-lab` and run cloud-sync E2E tests safely.
- `docs/`: investigation notes, design docs, and run reports from the first real test passes.

The intent is that a collaborator can clone the repo, install the skills, start fixtures, launch many isolated Tauri windows, and let Codex or subagents drive real UI workflows while assertions inspect SQLite, logs, metrics, and WebDAV state afterward.

## Quick Start

From the repository root:

Prerequisites:

- macOS with Codex Desktop Computer Use available for real UI driving.
- Node/npm dependencies installed for this repository.
- A local Tauri macOS app bundle already built at `src-tauri/target/debug/bundle/macos/Deep Student.app`.
- Docker Desktop running when using WebDAV/MinIO cloud fixtures.
- The macOS `sqlite3`, `xattr`, `/usr/libexec/PlistBuddy`, and `launchctl` commands available. These are present on a normal macOS install.

```sh
npm run dstu-test:install-skills -- --force
npm run tauri-lab -- service start --json
npm run tauri-lab -- project register deep-student \
  --cwd "$PWD" \
  --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app" \
  --json
```

If `dstu-test/scripts/tauri-lab.mjs` changes while the daemon is already
running, restart the service before creating new instances:

```sh
npm run tauri-lab -- service restart --json
```

Managed Deep Student instances default to short display names such as
`ds-smoke-01` so macOS window metadata stays readable by Computer Use. Use an
explicit `--display-name` only when a scenario needs a custom visible name.

Create and start a small pool:

```sh
npm run tauri-lab -- pool create deep-student smoke-03 --count 3 --json
npm run tauri-lab -- pool start smoke-03 --concurrency 2 --wait --metrics --timeout 90 --json
npm run tauri-lab -- agent checkout smoke-03 \
  --owner codex-smoke-a \
  --purpose "manual UI smoke" \
  --start --wait --metrics \
  --json
```

Use the returned `target.app` path as the Computer Use app target. When multiple agents are active, never pick windows from the global app list; use leases and exact app paths only.

## Cloud Fixtures

Preferred WebDAV fixture for automated runs:

```sh
npm run tauri-lab -- fixture webdav start sync-webdav \
  --username ds-test \
  --password ds-pass \
  --root deep-student-e2e \
  --json
npm run tauri-lab -- fixture webdav credentials sync-webdav --json
```

Docker Compose fixture for collaborators who want explicit WebDAV, MinIO, and FTP containers:

```sh
npm run dstu-test:cloud:up
npm run dstu-test:cloud:down
```

These wrap `scripts/dev/docker-compose.sync-test.yml` with the same startup sequence CI's Cloud Provider Contract Gate uses (build, wait for healthchecks, then seed the MinIO bucket), so a fixture that comes up locally is the fixture CI runs against.

The Compose WebDAV endpoint is `http://127.0.0.1:8080`, username `webdav`, password `webdav123`.

## Data Images

`tauri-lab` images are runtime artifacts stored outside the repo under `TAURI_LAB_HOME` or `~/Library/Application Support/tauri-lab/images`. They are intentionally not committed.

Images should normally be created on the machine running the tests. A copied image can work, but may contain absolute paths or machine-specific fixture state depending on what the app saved through the UI.

Useful commands:

```sh
npm run tauri-lab -- image list --json
npm run tauri-lab -- image inspect lh-shell-seed --json
npm run tauri-lab -- image create lh-shell-seed \
  --from-instance learning-apps-05-05 \
  --scope home \
  --description "Learning Hub shell seed" \
  --json
npm run tauri-lab -- pool create deep-student lh-05 --count 5 --image lh-shell-seed --json
```

Create images from stopped instances by default. Use `--live` only for disposable smoke seeds.

## Parallel Agents

For five Codex subagents, use a 10-15 instance pool and assign leases from the parent agent:

```sh
npm run tauri-lab -- pool create deep-student sync-e2e-15 --count 15 --image lh-shell-seed --json
npm run tauri-lab -- pool start sync-e2e-15 --concurrency 4 --wait --metrics --timeout 90 --json
npm run tauri-lab -- agent checkout sync-e2e-15 --owner codex-sync-agent-a --purpose "writer" --json
npm run tauri-lab -- agent targets --owner codex-sync-agent-a --json
```

Each subagent must verify before Computer Use:

```sh
npm run tauri-lab -- agent verify <instance-id> \
  --owner codex-sync-agent-a \
  --app "<exact target.app path>" \
  --require-running \
  --json
```

Parent waiting policy for long cloud-sync runs:

- Do not impose a short active timeout on subagents. Full real UI cloud-sync testing can legitimately take about an hour.
- After spawning agents, the parent should sleep or perform passive polling only: `lease audit`, `pool status`, WebDAV `status/tree`, and log/evidence reads.
- Lack of a quick report is not a failure. Intervene only when a subagent reports failure/completion, the user asks to stop, or objective infrastructure evidence shows the assigned app/fixture is no longer running.
- The parent must not operate a subagent's assigned app window while that subagent is still running.

Cleanup:

```sh
npm run tauri-lab -- lease audit --json
npm run tauri-lab -- lease clear --pool sync-e2e-15 --json
npm run tauri-lab -- pool stop sync-e2e-15 --concurrency 4 --json
```

## Evidence And Debugging

After meaningful UI actions or failures:

```sh
npm run tauri-lab -- evidence snapshot <instance-id> --tail 300 --json
npm run tauri-lab -- logs <instance-id> --kind backend --tail 200
npm run tauri-lab -- logs <instance-id> --kind frontend --tail 200
npm run tauri-lab -- fixture webdav tree sync-webdav --json
```

Use SQLite/WebDAV/log checks only as assertions after real UI operations. The test entry point remains the real Tauri UI through Computer Use.

## Run Reports

Current run reports:

- `docs/cloud-sync-wide-image-regression-2026-05-31.md`: wide data-image
  regression that uses one seeded writer plus clean readers to cover VFS,
  chat, mistakes, LLM usage, blob/file dependencies, todo ordering, dedupe,
  repeated download idempotency, and two-package hydration.
- `docs/cloud-sync-six-agent-run-2026-05-31.md`: six-agent, 18-instance long cloud-sync run with the parent no-timeout policy. Baseline, bidirectional, and backup/restore passed; conflict testing found a record-level conflict漏报/静默覆盖 bug; delete and credential stress scenarios exposed multi-window Computer Use targeting/input reliability limits.
- `docs/cloud-sync-matrix-30-run-2026-05-30.md`: 30-instance cloud-sync matrix run with five subagents. This is the strongest current evidence for duplicate replay, re-upload amplification, conflict-count mismatch, global credential leakage, and WebDAV fixture robustness gaps.
- `docs/learning-hub-parallel-lifecycle-run-2026-05-30.md`: Learning Hub multi-agent UI testing, including the later 15-instance seeded run with focused question-set coverage.
- `docs/cloud-sync-parallel-e2e-run-2026-05-30.md`: parallel cloud-sync E2E lessons plus the reserve-instance sync regression run.
- `docs/cloud-sync-real-e2e-lessons-2026-05-29.md`: original cloud-sync real-test lessons.
- `docs/local-tauri-instance-manager-design-2026-05-29.md`: tauri-lab service and multi-instance manager design notes.

Latest cloud-sync signal:

- The strongest current single-agent cloud-sync regression image is
  `sync-wide-chaos-deep-coverage-seed-0531` (`6131627` bytes, about `5.85 MiB`).
  It extends the earlier wide image with composite-key replay, business
  unique-key reuse after hard delete, JSON update chains, parent tombstones,
  explicit boundary-table checks, 4 blobs, 2 workspace DBs, 11 questions across
  5 types, and richer chat/mistake/LLM coverage. Audit it with:
  `npm run dstu-test:inspect-wide-sync -- --image sync-wide-chaos-deep-coverage-seed-0531 --mode seed`.
- The 2026-05-31 deep wide-image real UI run uploaded `569` changes from a
  seeded writer, downloaded into a clean reader with `total=435`,
  `deduped=134`, `conflicts=0`, downloaded 4 blobs and 2 workspace DBs, then a
  repeated UI Download logged `total=0`. The hydrated reader audit passed with
  zero FK errors, zero open conflicts, no blob orphans, and full question-set,
  learning-app, chat, mistake, LLM, and workspace hydration.
- The 2026-05-31 wide-image regression is the fastest high-signal smoke for
  cloud sync. It uploaded a 441-change package, verified `blobs` metadata is
  included, downloaded into two clean devices, repeated download with
  `total=0`, and downloaded from a two-package root without replay
  amplification or `files -> blobs` foreign-key failures.
- Before reusing or sharing a wide cloud-sync image, audit it with:
  `npm run dstu-test:inspect-wide-sync -- --image sync-wide-stable-coverage-seed-0531 --mode seed`
  or the deep image command above.
  The audit checks foreign keys, blob bytes, file/blob references, question-set
  breadth, todo hierarchy, tombstones, multi-change rows, chat attachments,
  mistake review rows, and LLM provider/status spread.
- For post-sync UI probes, Learning Resources -> All Files should show the
  hydrated broad dataset. In the 2026-05-31 deep run it showed 11 items
  including `新题目集`, `新作文`, `新翻译`, `新思维导图`, two
  `Wide sync coverage` folders, and `DeepSeek V4 Pro 实测笔记`. Continuing into
  the question-set filter hit a Computer Use/window-enumeration failure
  (`remoteConnection`, then `cgWindowNotFound`) while the app process and
  metrics remained healthy; capture evidence before restarting if this repeats.
- A 30-instance real UI matrix found P0 duplicate download replay and bidirectional re-upload amplification. Fresh seeded devices applied equivalent remote packages as new changes (`359 -> 718 -> 1077`) and then uploaded more packages, which matches the user-facing report that sync is almost unusable.
- The focused `sync-fix-smoke` retest fixed the main cloud-sync regressions: duplicate remote packages are deduped, repeated downloads no longer grow `__change_log`, bidirectional sync after download no longer uploads another full package, backend conflicts match actionable SQLite/UI conflicts, empty WebDAV passwords are blocked, and new credentials are written under the instance app-data path.
- The 2026-05-31 focused conflict retest fixed and verified the conflict UI path: after real UI sync, conflict badges/panels refresh automatically, and one local conflict with multiple cloud candidates shows every candidate with the newest cloud candidate clearly marked.
- Long Tauri display names can make Computer Use fail with `cgWindowNotFound` because macOS truncates owner names. Restart `tauri-lab` after script updates and prefer the default short instance names.
- Secure password fields should be driven by real click plus keyboard typing in Computer Use tests. Accessibility `set_value` can make the field look filled without reliably updating frontend state.
- During the stress run, the shared WebDAV fixture stopped while app instances stayed healthy. Future matrix runs should capture fixture health logs and use explicit parent-owned restart policy only when restart is part of the test design.
