# Local Testing Method

Use `.github/workflows/ci.yml`, its referenced actions, and the current test
configuration as the authoritative gate list. Read this guide before a full
local run. Historical reports explain failures; they do not replace running
the current source. Never weaken assertions, mock the behavior under test, or
delete a failing test to obtain a green result.

## Resources And Order

On the current 32 GiB development host, keep every concurrent test process in
one parent scope with approximately 22 GiB soft / 24 GiB hard memory limits:

```bash
systemd-run --user --scope \
  -p MemoryHigh=22G -p MemoryMax=24G -p MemorySwapMax=2G \
  env NODE_OPTIONS=--max-old-space-size=6144 \
  node path/to/local-runner.mjs
```

Child shards share this allowance. Do not give each shard its own 24 GiB limit.
Keep release/Android builds separate from tests and other heavy builds. Use
one Cargo build job, one linker thread, and one test thread per Rust partition.
Do not run a filtered `cargo test` without `--lib` or an explicit `--test` target:
it can compile/link every integration target before applying the name filter.

Run affected existing tests and a reproducer first, then integration/browser
tests, then the full gate set. Generate `src/version.ts` before type checking or
building after a cache cleanup:

```bash
node scripts/generate-version.mjs
```

Keep stdout in per-gate logs and record exit codes and source hashes. Check
progress at meaningful stages, without repeatedly polling an unchanged build.

## React Components And Hooks

Use `vitest.config.ts` and the repository's existing Tauri aliases. For focused
runs use one worker; keep the forks pool and file isolation enabled:

```bash
env NODE_OPTIONS=--max-old-space-size=6144 \
  npx vitest run path/to/affected.test.tsx --maxWorkers=1 --minWorkers=1
```

For the full frontend suite use all four official shards, `--shard=N/4`.
Local sequential shards with one worker are a conservative default. Parallel
shards must share the parent budget and leave room for each worker's heap;
never combine four shards each using the maximum two-worker CI configuration.

- Exercise real component state and event handlers. Mock IPC, provider/network
  calls and unrelated expensive renderers, not shortcut, focus or persistence
  coordination logic being verified.
- Mock hook callbacks with stable identities. In particular use the existing
  `tests/ct/mocks/react-i18next.tsx`, which caches `t` per namespace. Returning a
  new `t`, `resetState` or similar effect dependency every render can cause an
  infinite update loop that appears as a hung/OOM worker.
- Dispatch keyboard events to the actual focused element for input/control
  cases. `fireEvent.keyDown(document.body)` alone misses native controls,
  delegated Enter and modal focus bugs. Use real browser tests for native
  activation, Tab movement, mouse-then-keyboard use and layout.
- jsdom key events can verify `isComposing`/`keyCode=229` guards; they do not
  establish operating-system IME behavior. jsdom also does not implement
  default Enter/Space activation or real layout measurements.
- Await asynchronous state with `findBy...`/`waitFor`, and explicitly control a
  deferred save/listener to reproduce races. Do not replace these with long
  sleeps. Reset singleton stores and unregister listeners between cases.
- Cleanup timers and mounted components. Preserve `defaultPrevented`, native
  controls, inactive-window ownership and nested overlays in event tests.

## Browser Components

Use `playwright-ct.config.ts`, existing harnesses, one worker, and the same
6 GiB Node heap for cold compilation. The default 4 GiB heap has failed while
bundling the real question-bank dependency graph, before any assertion ran.

```bash
env NODE_OPTIONS=--max-old-space-size=6144 \
  npx playwright test -c playwright-ct.config.ts \
  tests/ct/question-bank/batchPractice.spec.tsx \
  tests/ct/question-bank/questionExplanation.spec.tsx \
  tests/ct/question-bank/paperExport.spec.tsx --workers=1
```

Practice coverage includes 390px and 1280px viewports, answer persistence,
hidden references before submission, confirmation overlays, saved explanations
without answering, and desktop shortcuts after real radio/button focus. Inspect
screenshots and horizontal overflow. A click-only batch test does not cover
keyboard integration; testing only the legacy editor inside a fake modal does
not cover `MistakeRedoOverlay`.

The export browser harness generates real PDF bytes and DOCX document blocks.
At present `paperExport.spec.tsx` writes to the fixed
`.local-work/verification/practice-20261027/` directory. Run it before the Rust
export QA; copy the freshly generated `sample-blocks.json` into the directory
selected by `QBANK_EXPORT_QA_DIR`. Check freshness and record this transfer.
Do not mistake a missing/wrong-path fixture for a renderer failure or reuse an
old sample as evidence of the current browser run. The Rust DOCX QA consumes
these blocks and creates `sample.docx`. Export changes also require rendering
and inspecting the real PDF/DOCX pages under the applicable artifact skills.

## Rust And Migration Gates

Use the toolchain pinned by CI (currently Rust 1.98.1). Match CI's dependencies,
default features, PDFium preparation and test exclusions. Typical local env:

```bash
export RUSTUP_TOOLCHAIN=1.98.1 CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_PROFILE_TEST_STRIP=symbols RUST_TEST_THREADS=1
export RAYON_NUM_THREADS=1 PROPTEST_CASES=64
export RUSTFLAGS='-C link-arg=-fuse-ld=lld -C link-arg=-Wl,--threads=1'
```

From `src-tauri`, build once with `cargo nextest archive --locked`, including
the ignored provider binaries. Run eight `hash:N/8` partitions from this archive
with `--test-threads 1`, without Cargo compilation. Use `xvfb-run -a
dbus-run-session --` for tests needing Linux desktop services. Each binary gets
isolated temporary `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`,
removed on completion; do not use the developer's live application database.
When extracting once for concurrent reuse, provide Nextest binary/cargo metadata,
target-dir remap and workspace remap consistently.

Match the official filter excluding custom `_e2e`, `migration_fixture_upgrade_gate`
and `mod` binaries. The 10,000-record timing assertion
`binary(=sync_weird_tests) & test(=w69_ten_thousand_tiny_records)` must run after
all competing partitions finish. Do not loosen its timing bound. Bind the
performance filter to its binary: a test-name-only filter may try to enumerate
custom executables that do not implement libtest's listing protocol.

Run static migration checks and migration-tooling tests, then the production
migration gate with its nonzero minimum count (`--min-tests 50`). If private
representative fixtures are unavailable, use CI's existing `--mode skip` policy
and report the skip; do not claim fixture upgrades were exercised.

## Provider, Platform And Security Checks

Validate the pinned Docker composition, start healthy MinIO/WebDAV/FTP services,
initialize MinIO, and execute all three ignored provider suites from the same
Nextest archive (`--run-ignored only --test-threads 1 --no-tests fail`). Stop
containers and remove their test volumes in a `finally`/trap even on failure.
Do not treat Docker's absence as passing provider tests.

The complete local run also includes Node build contracts, version checks and
generation idempotence, fmt, lint, licenses, both tsc and tsgo, all Vitest shards,
production frontend build/startup and bundle-size check, Clippy all-targets,
Rust tests, migrations, browser components and provider contracts. Compare this
list to the current official workflow before each run.

Windows Shell Sandbox requires a Windows runner. Local Linux success must state
this boundary; require the exact PR head's remote CI for Windows coverage.
`npm audit` and `cargo audit` are informational in the current workflow, including
advisory-service availability. Report advisories separately without quietly
upgrading dependencies or converting a required gate into informational.

## Failure Triage And Delivery Evidence

Classify a failure before rerunning: implementation regression, outdated test,
missing fixture/tooling, process heap exhaustion, resource contention or external
service failure. For hangs/OOM inspect the failing file, mock identities, heap
and exit status. Increasing heap alone is not a repair for an update loop.

Retain earlier failures. An append-only results ledger uses the latest result
per gate; all required gates must pass on the final source. After a code change,
invalidate affected results and rerun relevant gates; preserve unrelated evidence
only with an explicit source comparison. Review actual subagent diffs and observe
test outputs directly before accepting them.

Record commit, worktree state, tracked/new source hashes, tool versions, command,
exit code, test counts, skips and environmental corrections under ignored
`.local-work/verification/<task>/`. Commit/PR only after the full local gate set
passes. Do not reuse a green upstream run for a different PR head. Build packages
from the verified source, preserving the established deliverable layout, features,
Android development certificate and 16 KiB ELF/ZIP alignment. Keep signing keys
and application data out of logs, commits and test fixtures.

These procedures incorporate the 2026-10-27 practice/export run, 2026-10-28
grading recovery run and shortcut investigation. Their local handoff and result
files remain in `.local-work/verification/`; this guide contains the reusable
method without requiring those machine-specific reports to exist on CI.
