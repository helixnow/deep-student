# Android mobile-slim feature closure — RED handoff

Status: RED confirmed by the main agent (`node --test scripts/__tests__/android-mobile-features.test.mjs`, exit 1; log in `docs/handwriting-annotation/verification/closure-android-features-red-r1.log`). Minimal fix applied to the Android override only; not rerun by this author.

## Defect

`src-tauri/tauri.conf.json` sets `build.features` to the desktop list
(`sqlite`, `lance`, `mcp`). `src-tauri/tauri.android.conf.json` did not override
`build`, so Tauri's JSON Merge Patch (RFC 7396) platform merge inherited that list.
The official Android CI command then receives:

```text
--features mobile-slim tauri/custom-protocol sqlite lance mcp ...
```

Observed from the actual Gradle-phase cargo command during the approved x86_64
mobile-slim build. `--no-default-features` does not help because these features come
from the Tauri config, not the crate default feature.

## RED test

`scripts/__tests__/android-mobile-features.test.mjs` is a single `node:test` case:

- Locates the official `npx tauri android build` line and asserts it remains
  `--features mobile-slim` with `--locked --no-default-features`.
- Applies RFC 7396 merge to `tauri.conf.json` + `tauri.android.conf.json`.
- Fails if effective Android `build.features` contains desktop-only `lance` or `mcp`.

Expected RED result on current sources: the merged features contain `lance` and
`mcp`, because the Android override had no `build.features`. Confirmed: exit 1.

Main-run command:

```bash
node --test scripts/__tests__/android-mobile-features.test.mjs
```

## Fix applied

`src-tauri/tauri.android.conf.json` now replaces the platform feature list:

```json
"build": {
  "features": []
}
```

Under RFC 7396 this replaces the desktop list with an empty array. The
CLI-provided `mobile-slim` feature remains authoritative, producing:

```text
--features mobile-slim tauri/custom-protocol --locked --no-default-features
```

`[]` was chosen over `["mobile-slim"]` because the CLI already supplies
`mobile-slim`; duplicating it would hard-code the workflow's feature choice into
the platform config. The base desktop config and Android workflow were not changed.

## Boundaries

- No build, adb, network, subagent, or commit was performed; no test was rerun by this author after the fix.
- The main agent owns the post-fix GREEN run.
- Workflow command check reads only the Android build invocation line.
- The test simulation covers the config merge, not the Gradle cargo spawn itself.
