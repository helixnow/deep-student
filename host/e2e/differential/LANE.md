# X7 differential

## Resume 2026-11-06 15:26Z — report seal and residual triage

- Resumed at `e4892297d`, clean tree. No separate TESTMAP for this lane (see the
  historical note below). Ledger check `20261106152615-758c5e` passed: command/test
  problems 0, orphan registrations 0. This is not G3 parity coverage.
- Freeze rule (updated 2026-11-07, W13 round 10; replaces the X7-era "do not edit
  `g3-normalize.mjs`, `g3-compare.mjs`, `g3-batch.mjs`" of C0 08:38Z, which held only during
  that day's live recording). A G3 recording runs from a frozen server worktree
  (`G3-RECORDING-RUNBOOK.md` §1.2/§9.2), so editing this repo never changes a running driver.
  What a change costs instead:
  - A path (the g3-inputs A-process slice: `scenario-v0.mjs`, `g3-run-a.mjs`, `g3-services.mjs`,
    `g3-search-service.mjs`, `g3-wait.mjs`, `g3-startup.mjs`, `g3-quiet.mjs`, `json.mjs`, the
    harness, the seed/snapshot fixtures they import): stales every A trace whose slice
    contains it (`g3-a-stale` reports a `code:` reason) and needs an A re-record.
  - Normalizer set (`NORMALIZER_FILES`: `g3-normalize*.mjs`, `json.mjs`) and `g3-compare.mjs`:
    stales compares only; recompute, no re-record.
  - Driver/provenance (`g3-provenance.mjs` `RUNNER_FILES`, e.g. `g3-batch.mjs`, `g3-worker.mjs`):
    a resumed `--out` must use the tree it started with.
  Between `ASHA` being chosen for an A store (S0) and that store's report being accepted, the
  main orchestrator freezes A-path changes; only the main orchestrator lifts that freeze (in
  `.reports/lanes/FROM-MAIN.md`). Outside that window W13 may change these files, and states
  the A-stale components of each change in its report. Nobody but the main orchestrator
  starts or stops recording drivers.
- `g3-report.mjs` now requires `RUN-MANIFEST.json`. It checks HEAD, sorted original
  equivalence JSON bytes (including provider sidecars and scanned wave0/fixture suites),
  batch/normalizer/approvals SHA-256, unique A/A2/B trace-reference counts and the active
  compare file/hash list. Archives such as `compare.pre-final-*` are never report inputs.
  It checks the seal again after recomputation; it never reads `progress.json`.
- Generate the seal **after the driver has finished**, on the final committed tree:
  `node scripts/electron-migration/record/g3-report.mjs --runs fixtures/differential/g3/runs/full --write-manifest`.
  This writes a new file only (no overwrite), without generating a report. Then invoke
  the report normally, through job.mjs. Changing HEAD, rules, corpus, or compares requires
  the coordinator to preserve the old seal and deliberately create a new one.
- The seal is a report-input snapshot, not retroactive proof of the Host revision used
  by historical recordings. That proof still needs a recording receipt; do not claim
  all old traces ran at the manifest HEAD. Counts are compare-referenced traces, not
  successful recording totals. A2/approvals hashes and substitution lists are independently
  verified from the raw artifacts, and stale normalizer hashes are rejected.
- `g3-triage.mjs` groups existing residual diffs into `runs/full/DIFF-TRIAGE.{md,json,json.gz}`.
  It does not normalize or record. Candidate environment/representation differences require
  C2 approval; they are not automatic exemptions or confirmed product root causes.
- Report/manifest tests: 4 passed, job `20261106153724-5d5cbd` (including stale/missing
  seal, edited compare, stale normalizer, side counts, and forged progress counters).

## G3 ledger (2026-11-06, board/G3-LEDGER.md)

A binary for all recordings: build **20261106023719-bc16bc** (incremental, exit 0, 6m52s, sha256
`102b4835…ac7c`). It carries the D-156 isolated identifier `com.deepstudent.differential` via
build-time `TAURI_CONFIG` (tauri-build 2.6.3 lib.rs:472-489, tauri-codegen 2.6.3 lib.rs:83-86);
`src-tauri/tauri.conf.json` is unchanged. The first build 20261106013300-a8a249 (production
identifier) is kept for reference only. llvm-cov/llvm-profdata are missing (U-005), so coverage
is `not-measured`; raw profiles are kept.

Runners (all through `jobs/job.mjs`; A under `xvfb-run -a dbus-run-session`):
- `record/g3-run-a.mjs SCENARIO RECEIPT OUT [--scenario ID…] [--take A1 --take A2] [--gzip]
  [--compact --profile-pool DIR]`: real Tauri main webview running `g3-harness.mjs`, one process
  per take on a fresh X3 seed copy. The request body must equal `argsRaw` byte for byte, and the
  raw custom-protocol response is the outcome. Events: contract names plus `src/` `listen()`/
  `once()` literals, with id/path-derived channels subscribed from the step that holds the id
  (`eventScope.since/derived`). The run fails if a `com.deepstudent.app` directory appears.
- `record/g3-run-b.mjs SCENARIO OUT [--scenario ID…] [--gzip] [--compact]`: forks
  `host/kernel/main.ts` with `host/profiles/desktop.json` over the HostSupervisor protocol.
  Shell requests get explicit errors and are recorded. `eventScope.kind = all`.
- Both runners resolve `${llm.*}`/`${provider.*}` against the X5 mock LLM (port `LLM_PORT` 47110 by
  default, `llmPort` for tests outside a worker namespace), `${search.searxngUrl}` against the
  SearXNG mock (47140), `${runner.*}` from the run itself, and run `waitBefore`/`waitAfter` as
  event barriers (`g3-wait.mjs`, no sleeps).
- `record/g3-batch.mjs RECEIPT [--out DIR] [--workers-a N …]`: covers the whole scanned corpus,
  with every worker in its own `unshare -rn` namespace. Resumable per shard.
- `record/g3-compare.mjs SCENARIO ID A_TRACE B_TRACE OUT.compare.json[.gz]`: same-input, no
  normalization. Compares expectation, args, outcome kind/value, X3 DB state per step plus
  before/after/final. Events are compared per window, only for names in scope on both sides:
  A's derived channels are rebuilt from B's own ids. Everything else goes to `eventsOutOfScope`.
- `record/g3-report.mjs`: 768 denominator (sha `4f47fa0a…718e`), owner and `g3w-*.json` suites,
  every `*.compare.json[.gz]` under `fixtures/differential/g3/runs/` re-hashed and recomputed.
  Five statuses always sum to 768; JSON and Markdown come from one object. blocked/excluded
  records: `board/g3/{blockers,excluded}.json` (or `--blockers/--excluded`).

Status:
- First A recording `get_app_version` A1=A2: `fixtures/differential/a-runs/20261106-first-A/`.
- G2 delivered: chat streaming, notes CRUD/delete and review session on real A and B,
  `fixtures/differential/g2/` (manifest with sha256, README with findings). Outcome kinds are equal
  on every step. Compares are unequal without normalization (random ids/timestamps; A1≠A2 too).
  Structural B findings: `sync_state.db` outside the identifier dir, missing
  `chat_v2_compaction_memory_flushes`, extra `rag_documents`/`rag_document_chunks`.
- G3 full run in progress: `fixtures/differential/g3/runs/full/` (gitignored; `progress.json`).
- Waiting on C2: id/timestamp normalization justified by A1/A2 (WAVE0 §3), and whether to drop
  WebKit `hsts-storage.sqlite` from DB compare.
- Tests: `g3-report.test.mjs` (3) and `g3-run-b.test.mjs` (2), wrapped by `.test.ts`.
- v0 steps without `args` are sent as `{}` (Tauri invoke default, X1 B driver); this was an
  X7 validator defect that rejected 170 owner scenarios.

## Previous package: WP-153 — v0 seed/HOME preparation

`record/scenario-v0.mjs:prepareScenarioRun` consumes X3 resolveSeed/copySeed;
the first-command launcher creates its source once with X3 createSeed and uses
the shared preparation. HOME is always `<copy>/home`, with app/local-data paths
from the same copy. ZIP completeness uses X3's published file list; unknown,
uncreated or incomplete seeds fail explicitly without regeneration.
Node preparation checks cover two independent copies, child-process HOME/file
consumption, source immutability and the original empty/get_app_version input.
See `WP-043-RUN.md` for the preparation API; no new seed protocol or SQL.

WP-043 remains **partially blocked**: both original real build exit101 receipts
are retained. PDFium/D46/LLVM await maintenance; WP-153 performs no Rust build or
A startup. A1/A2/golden remain 0; preparation self-checks do not promote G3/C.

## Previous package: WP-043 (2026-11-05 17:34Z)

Actual new session `ses_e53394115ffekLMlt1CB4m1PJP`, launcher PID 3158851.
Full real Tauri build is now authorized by D007/WP-043. Dedicated rust queue is
active (limit 1 / 150 minutes); jobs12/dev/instrument-coverage, existing target.
First real-app job `20261105173612-f65814` exited 101 in 610.504s at lance-encoding's
missing PROTOC. Incremental retry `20261105174903-ed84f3` used the already downloaded
locked vendored protoc and exited 101 in 366.864s at the missing production Linux
PDFium resource (`resources/pdfium/libpdfium.so`, tauri.linux.conf.json:5).
No reduced features, install, clean or business Rust edit. Maintenance must supply
that original resource; no binary/real A startup/A1/A2 was produced.
Build receipts/logs/config originals: `fixtures/differential/wp043/builds/`.
The build-script profraw files are **not** application command coverage.

Prepared self-driving real-main-webview harness and A1/A2 recorder:
`WP-043-RUN.md`. v0 references/JSONPath/capture have 4 passing recorder-only tests
(`20261105175031-249875`), including exact IDs shared with real SQLite FK/events.
No normalization approved/applied, no 34-ID changes, no command C pass.
Remaining startup blockers: missing PDFium Linux x64 chromium/7350 asset;
D46 root-config allowlist/isolated identifier;
matching llvm-cov/llvm-profdata absent both PATH and the rustc toolchain bin.
X3 dependency is now resolved: final merge includes main `e6bce8aae` and its public
seed/DB APIs. Added one direct X7 consumer check (empty copies, exact i64/REAL,
unchanged source seed, raw DB difference); final gate validates this fifth check.
General Tauri event raw precision/global subscription is not established.
See WP-043 audit for final build and gate outcomes; older status below is historical.

## Scope and remaining work

The frozen **34-ID first build was authorized** by the architect and attempted once:
`20261104143346-a72af4`, exit 101 after 173.779 seconds. Dependencies compiled, but
the new harness manifest omitted direct `log` for the frozen embedding module.
Full log/manifest/resolved lock/compiler receipt is in `fixtures/differential/builds/`.
WP-012 explicitly authorizes the direct `log` repair and incremental retry; Rust
1.98.1 and Linux build dependencies are supplied. The manifest repair is committed.
C2 has now confirmed the live dedicated `rust` queue class satisfies build policy
and the existing 34 IDs (including `regex.boundedOriginal`) remain frozen. X7 read
status.json at 2026-11-05T15:25:35.262Z: rust limit 1 / running 0. Future authorized
builds use jobs and CARGO_BUILD_JOBS=12, reusing target without clean. WP-012 was
delivered partially complete at 15:07Z; no helper retry has run. WP-043 is now
assigned for the real Tauri oracle; D46 configuration-path allowlist is still missing.

- Prepared: data-driven reference source, exact source/lock provenance checks,
  production TS adapters, seeded vectors, 977 serde candidate types / 14226 inputs,
  first-difference comparator, SQLite/command/event replay framework, ledger exporter.
- Pending: successful reference binary after the failed build. Queue classification
  and ID count are resolved; Rust execution/comparison has not begun.
- Published on current main: F7 projected capture primitive and L23 PasswordVerifier
  byte codec. The existing projected adapter is now exercised, and the verifier
  adapter uses L23's public production codec. Seven core serde mappings remain blocked.
- Remaining larger scope: full AppState command recording, historical SQLite snapshots,
  three-platform replay. WP-043 authorizes the real app build and first command only.
- C evidence remains **0%**. Preparation or TS-only execution is not parity.
- L16 `1e2356b29` is now on normal main. Original front/tags/extra_fields probes
  independently rechecked by `20261104163838-b3c3ab`: all three throw the actual
  AnkiCardDecodeError and match the original rejection expectation. Report:
  `fixtures/differential/recheck-L16-decoder.json`. This closes the three static
  decoder findings, not IPC bypass, full error-wire parity, or Rust dynamic C.
- L02/L03 original five static findings rechecked on normal main `ad11a8394`
  (worktree `c334fea66`): all five match their original Rust-source expectations;
  report `fixtures/differential/recheck-L02-L03.json`, job `20261104131237-6d2fa8`.
  This is source+production revalidation, not C/Rust execution.
- PasswordVerifier codec is now exported through L23 `api.ts`; X7 binds that
  production entrypoint for the already-frozen ID without any Rust rebuild.
- Additional deterministic input corpus: `boundary-vectors.json` has 146 cases
  across existing FSRS/cloze/UTC/KDF IDs (no new Rust entrypoints). TS preflight
  `20261104140407-948382` executed all 146; that is availability, not Rust parity.
- New L16 trim findings are recorded separately in `cloze-boundary-findings.json`:
  U+0085 imageRef acceptance and whitespace-only label fallback differ from Rust.
  Repair `5e05f9bc0` is now on main; targeted recheck script
  `record/recheck-l16-cloze.mjs` retains the two original inputs/expectations.
  Job `20261105000513-32a276` passed both, closing these two static findings only;
  report: `fixtures/differential/recheck-L16-cloze.json`. C1 notified.

Detailed callable list, provenance, job receipts and owner findings:
`docs/dev/electron-migration/audits/X7-differential.md`.

## Validation

WP-012 baseline on merged main `967f43c75`: typecheck
`20261105140230-b2aba4` exit 0; Vitest `20261105140232-c07566` exit 0,
1 wrapper passed / 0 failed / 0 skipped, asserting 12 Node checks passed.
Queue/ID/binary inspection `20261105140411-4520ad` exit 0 confirms `other`,
34 existing IDs, no binary. Original job receipts/logs: `fixtures/differential/wp012/`.
This inspection's exit 0 means successful inspection, not permission to build.
Final lane-gate results belong to the WP-012 delivery report/selfgate receipt.
Resumed after interruption: merged main `cbf79a849`; lane-gate passed at
`dff130742` (jobs `20261105143508-003fd4/-ffefad/-ecdb30`). The source now has
a cargo `rust` class (`runner.mjs:29`), but live runner PID 2068047 predates that
edit and still reports no `rust` limit. Build waits for the service reload.

2026-11-05 Linux recovery: initial Vitest job `20261105000349-ab3429` reproduced
the reported main-red wrapper failure. The stale test expected the now-published
F7 projected API to be unavailable. Replaced it with real success/first-overflow
checks and retained unpublished-function blocking. Wrapper failures now expose
child stdout/stderr, with explicit TAP reporting. See the audit's final section
for the current validation receipts and remaining evidence blockers.
Node recorder job `20261105000708-d57e80`: 12 passed, 0 failed/skipped, exit 0.
Typecheck job `20261105000348-d47d92` and ledger job `20261105000348-1b28f1`
also exited 0. Final committed-head lane-gate receipt remains a separate check.

Gate at `f530c9eac` / main `c6309183c` passed all four checks. After merging main
`a9683a43b`, self-review found the exporter accepted incomplete per-call evidence
despite requiring complete top-level observations. Regression job
`20261105005417-4f5273` failed as intended on missing outcome. The exporter now
requires each call's return/error, events and DB changes; explicit null output is
still valid. The existing golden test contains the regression assertions.

Post-main-merge lane-gate passed at `95eed3c8d`, baseline `d84e29565`:
typecheck, boundaries, boundaries-strict(changed), tests. The Vitest entry invokes
nine intact Node recorder tests (native SQLite / JSONL runtime).

The subsequent self-review fixes preserve arbitrary-precision decimal/exponent
tokens and reject replay reports missing database/event evidence. Regression
assertions are added to the existing tests, not substituted for previous assertions.
Next post-merge lane-gate passed at `f7eccb522`, baseline `45c3250b0`.
The SQLite snapshot follow-up includes indexes/triggers/views, metadata,
AUTOINCREMENT state and per-cell storage classes; a tenth recorder test covers
changes that leave application row values unchanged. Snapshot shape is now
`{ schema, metadata, tables }`; table snapshots retain rows and add storage classes.
Gate on `c334fea66` / main `ad11a8394` passed. Two new real-HTTP checks cover UTF-8
request chunk boundaries and delivery of an SSE prefix before premature EOF;
they failed before the provider fix. The recorder suite now has twelve checks.
Gate on `6c7e46510` / main `16a254adf` passed before the next change. Invalid UTC
parser results now remain observable null values instead of being classified as
an unavailable API; regression assertions are added to the existing adapter check.
Before ending this change: commit, merge main, run the shared lane-gate. Its final
receipt is recorded per commit in the coordinator's selfgate record.

## Resume discipline

Read this file and the audit; check git history before recreating fixtures. Keep
the existing 34 Rust dispatch IDs frozen as confirmed by C2.
Further vectors need data only, not a rebuild. Follow WORKER.md: deliver this one
work package with `wp-done`, then end the session; no automatic continuation.
This lane has no separate BLOCKERS.md / TESTMAP.md; blockers and coverage are in
this file and the audit. No Rust test mapping is promoted by this manifest repair.
