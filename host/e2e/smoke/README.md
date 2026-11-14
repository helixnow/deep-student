# Whole-production-Host smoke (X1)

WAVE0 / WP-041 real-window entries: [`B-DRIVER.md`](./B-DRIVER.md),
`window-smoke.mjs` (production dist) and `b-driver.mjs` (v0 command recording).
The historical Host-only gate below remains separate and retains its original assertions.

```sh
node host/e2e/smoke/run.mjs
# The same gate, discoverable by the existing integration test scripts:
npm run test:host -- host/e2e/smoke --maxWorkers=1
npm run test:host:electron -- host/e2e/smoke --maxWorkers=1
```

Requires the project's installed Node, Electron and native dependencies. Does **not**
rebuild native modules (node_modules may be shared between worktrees).
The default runner tests Node and real Electron with `ELECTRON_RUN_AS_NODE=1`,
sequentially, with an 85-second subprocess budget each and a 175-second total budget.
A missing runtime, startup failure, degraded plugin, missing declared service,
invalid result/error, panic, uncaught error or invocation timeout fails the gate.

`__fixtures__/worker.ts` calls the production F1 profile generator, compares its output with
`host/profiles/desktop.json`, relocates its module URLs into a temporary profile,
then boots **one** `serveHost` session containing all platform and business plugins.
No service substitution, plugin-specific testing host or altered plugin config is used.
The handshake uses production (`debug: false`) mode; the probe itself validates the
JSON result/error contract so a contract diagnostic cannot be mistaken for a valid
business error. Contract-valid legacy string errors count as business errors too.
Every registered contract command receives one schema-valid minimal invocation
through the production handshake/invoke/result protocol, using the `main` source.
Calls are serialized because purge, backup and maintenance mutate the same data space.

The environment redirects HOME, XDG, APPDATA, userData, appData and temporary files
to a fresh `/tmp/opencode/x1-smoke-*` directory. The subprocess also changes cwd into
that directory so empty relative paths cannot write into the repository. The
production file-only key-seed option prevents access to the user's system keyring.
Artifacts are deliberately retained; the runner prints `summary.json` and
lane-grouped `issues.md` paths. Per-runtime `result.json` records every minimal
argument, outcome, result/error, panic stack and uncovered contract command;
`stderr.log` retains production logs. No production data is seeded or copied.

## Reproduction / slower diagnostics

```sh
# Fresh production Host, but only invoke this one command:
DS_SMOKE_RUNTIME=electron DS_SMOKE_COMMAND=insight_confirm node host/e2e/smoke/run.mjs
# Preserve the production MCP 60s slow-service budget instead of the default 5s:
DS_SMOKE_SLOW=1 node host/e2e/smoke/run.mjs
# Target the Fetch restricted-port URL branch without changing production code
# (port 1 does not prove TCP ECONNREFUSED):
DS_SMOKE_RUNTIME=both DS_SMOKE_COMMAND=test_mcp_sse DS_SMOKE_SSE_ENDPOINT=http://127.0.0.1:1/sse node host/e2e/smoke/run.mjs
```

`DS_SMOKE_RUNTIME=node|electron|both` defaults to `both`. A selected command must
actually be registered; unknown names fail rather than silently probing nothing.
Full integration gates should not set `DS_SMOKE_COMMAND`.

`DS_SMOKE_COMMAND` also accepts an explicit comma-separated list, in invocation
order. Every name must be registered; unknown/unregistered names, empty entries,
and duplicates fail the whole selection. There are no glob/prefix matches.
All selected commands run serially in one fresh full-profile Host per runtime.
`production.test.ts` still clears the selection and runs all registered commands.

`DS_SMOKE_STARTUP_ONLY=1` performs only the production startup, status, provides,
and registration inventory (zero command probes). It still fails on real startup
defects. The `production.test.ts` integration test forces full command mode so
this focused diagnostic cannot silently reduce its coverage.

All subprocess helpers live in `__fixtures__/`; they are test-only infrastructure,
not production Host modules. `run.mjs` remains the stable CLI entry. IPC responses
are checked **after** F1's production D3 serialization: JSON numbers outside the
safe-integer range are permitted as the contract allows, raw BigInt on the wire
fails, and the probe never converts or rounds internal service values itself.

## Global job queue (required for manual runs)

Submit CPU-heavy diagnostics instead of executing them directly. From this worktree:

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/e2e/smoke/probe.test.ts host/e2e/smoke/minimal.test.ts --maxWorkers=1
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx tsc -p host/e2e/smoke/__fixtures__/tsconfig.json --pretty false --incremental --tsBuildInfoFile /tmp/opencode/x1-smoke.tsbuildinfo
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- env DS_SMOKE_STARTUP_ONLY=1 node host/e2e/smoke/run.mjs
```

Use `job.mjs result <job-id> --tail <enough-lines>` after reviewing/writing while
queued; retain original exit code, Errors lines, and full log path. The automated
integration gate itself is exempt from the manual queue requirement.

## Boundaries of the evidence

This is the requested Electron-as-Node **Host** gate, not a Chromium / preload / GUI
test. Its transport is an in-process protocol loopback; no private handler is called.
It does not install main's window-origin ACL: the objective is reaching every
registered business handler, including commands not exposed by the current UI.
Actual shell operations are rejected explicitly, never faked as successful; shell
requests and resulting failures are recorded separately for triage. In particular,
restart never restarts the test machine or a real application. Network commands
run against their production defaults in an empty configuration; network timeout
is a budget failure, not proof of a code defect. Native UI, live cloud accounts and
real renderer/preload transport still need their own gate.

Minimal here means legal **IPC schema** values (empty strings/arrays, zero, omitted
Option arguments, required object fields, first enum variant). Business validation
is expected to reject some of these. Unregistered contracts are inventoried but
are not called or counted as successfully covered.
