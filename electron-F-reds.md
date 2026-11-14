# W37 Electron F-host reds

## Scope and baseline

- Exclusive W37 was clean, then fast-forwarded to `891d75ed6549d7ccb3c8a2009c8ae0867a745290`.
- Evidence: `.reports/server/land-test-F-host/failure-details.json` and `summary.json` in the orchestration root. F-host used Linux x64, Node 26.5.0, 8 shards / parallel 8. This establishes concurrency, not CPU saturation by itself.
- Changed only the two assigned tests and this report. No product/lifecycle/INT changes, SSH, full suite, timeout increase, or compile-cache experiment.

## Findings

### boot-diagnostics-host

- F-host fails its own 50,000ms polling deadline (50,509ms total); it is not an assertion that CSP/boot diagnostics is broken.
- DBus warnings did not prevent document scripts or Host startup. The inline CSP rejection is intentional: the test serves an inline script that must be blocked under the unchanged production policy. The original output contains the expected first-script/rejection errors for stages 0, 1 and 2.
- Host reports ready **34,137.9ms** after process start, including imports **16,928.5ms**, plugin installation **14,275.1ms**, storage apply **13,504.2ms**. Migration itself reports **13,424ms**. Startup consumes much of the single 50s envelope; subsequent documents each wait until `performance.now() >= 8300`, and child documents until 8400. Therefore startup/remaining-stage budget contention is concrete, but the original failure omits report counts and child navigation progress, so it cannot prove which report was missing.
- No evidence currently justifies blaming DBus, changing CSP, or changing product startup. A Linux-specific child-window issue is **not excluded** by a macOS pass.
- Test changes preserve 50s/60s deadlines and all existing assertions. Failure now includes received main/child reports, timestamped HTTP requests and exit/signal status. `electron.log` and `progress.json` are retained under the printed `/tmp/opencode/f2-boot-*` directory even on failure. A child-runner exception reports its role/fatal error rather than becoming an opaque wait for a missing child report.

### node-modules-closure

- Two cases took **31,875ms** / **31,312ms**, exceeding configured 30s. `STACK_TRACE_ERROR` is Vitest's registration-site marker (`@vitest/runner/dist/chunk-hooks.js:638`), used by `withTimeout` / `makeTimeoutError`; it is not a package-resolution error. No missing-dependency or missing-file assertion was recorded.
- Three assertions independently traverse/parse substantially the same shipped code. Keep extracted module specifier strings in a test-process-local map keyed by absolute source path; reuse across bare/relative checks. No AST retention, persisted cache, hashing, changed walk/filter rules, or assertion weakening. The checkout is read-only during this test.
- This removes demonstrated redundant work, but does not claim the remaining first scan can meet 30s under arbitrary shared load.

## Local targeted verification (macOS, Electron runner, maxWorkers=1)

Command before and after changes:

```sh
npm run test:host:electron -- electron/tests/node-modules-closure.test.ts electron/tests/boot-diagnostics-host.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

- Baseline: **2 files / 10 tests passed**, 30.48s overall. Boot 25,361ms; bare / scan-presence / relative assertions 1554 / 1404 / 1494ms.
- Patched: **2 files / 10 tests passed**, 27.76s overall. Boot 25,374ms; corresponding assertions 1636 / 12 / 104ms.
- Existing import-form, require-shadowing, direct createRequire, required runtime-package, closure and relative-shipping assertions all pass unchanged.

## Linux handoff — schedule after F-fe, low load

Run once in the Linux worktree containing this commit with its existing Electron-compatible dependencies, no concurrent heavy suite. One Vitest worker; tests are sequential (boot spawns its real Electron/Host children).

```sh
mkdir -p /tmp/opencode
npm run test:host:electron -- electron/tests/node-modules-closure.test.ts electron/tests/boot-diagnostics-host.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose --reporter=json --outputFile.json=/tmp/opencode/W37-electron-F-reds.json
```

Return JSON + verbose output; on boot failure also retain the printed `f2-boot-*` directory's `progress.json`, `reports.json` if present, `electron.log`, and `wire.jsonl`. No `DISPLAY` wrapper is necessary: existing `spawnElectron` supplies Xvfb when DISPLAY is absent.

- A low-load pass supports resource contention as the original trigger; retain original timeout, do not declare a product regression from the F-host log alone.
- A repeat boot failure: request timeline distinguishes child page/script loading from missing main stage; report/wire contents distinguish renderer callbacks/ACL failures from slow startup. Hand off any demonstrated product issue before editing product files.
- A repeat first-scan timeout: retain timing/load evidence and profile the scanner; this patch does not mask it by increasing timeout.

**Status:** targeted macOS green; Linux low-load result pending parent scheduling. The original Linux reds are not yet certified resolved.
