# tauri-lab Command Reference

All commands assume:

```sh
cd <deep-student-repo>
```

## Service

```sh
npm run tauri-lab -- service start --json
npm run tauri-lab -- service status --json
npm run tauri-lab -- service install --json
npm run tauri-lab -- service install --start --json
npm run tauri-lab -- service stop --with-instances --json
```

Use `--ensure-service` on daemon-backed commands when a fresh Codex session may not have started the service.

## Project

```sh
npm run tauri-lab -- project register deep-student \
  --cwd "$PWD" \
  --source-app "src-tauri/target/debug/bundle/macos/Deep Student.app" \
  --json
```

## Pool

```sh
npm run tauri-lab -- pool create deep-student codex-sync --count 12 --json
npm run tauri-lab -- pool start codex-sync --concurrency 4 --wait --metrics --timeout 45 --json
npm run tauri-lab -- pool status codex-sync --json
npm run tauri-lab -- pool stop codex-sync --concurrency 4 --json
```

Use `--concurrency 2-4` for first-run pools because each app performs database initialization.

## Agent Checkout

```sh
npm run tauri-lab -- agent checkout codex-sync \
  --owner codex-agent-name \
  --purpose "feature or suite under test" \
  --ttl 7200 \
  --start --wait --metrics \
  --json
```

Important returned fields:

- `target.app`: pass to Computer Use `get_app_state`.
- `target.home`: inspect SQLite and app data under this HOME.
- `target.metrics_addr`: readiness and runtime metrics.
- `target.logs.backend`: Rust/backend stdout.
- `target.logs.stderr`: process stderr.
- `target.logs.frontend`: WebView console/error JSONL when the app bridge is active.

## Logs

```sh
npm run tauri-lab -- logs INSTANCE --kind backend --tail 200
npm run tauri-lab -- logs INSTANCE --kind stderr --tail 200
npm run tauri-lab -- logs INSTANCE --kind frontend --tail 200
npm run tauri-lab -- logs INSTANCE --kind all --tail 200
npm run tauri-lab -- logs daemon --kind daemon --tail 200
```

## Fixtures

```sh
npm run tauri-lab -- fixture webdav start sync-webdav \
  --username ds-test \
  --password ds-pass \
  --root deep-student-e2e \
  --json
npm run tauri-lab -- fixture webdav status sync-webdav --json
npm run tauri-lab -- fixture webdav credentials sync-webdav --json
npm run tauri-lab -- fixture webdav tree sync-webdav --json
npm run tauri-lab -- fixture webdav stop sync-webdav --json
```

Docker Desktop must be running for `start`.

## Evidence

```sh
npm run tauri-lab -- evidence snapshot INSTANCE --tail 300 --json
```

The snapshot path contains logs, target metadata, slot state, metrics, SQLite summaries, and credential presence.

## Assertions

```sh
npm run tauri-lab -- assert slot INSTANCE --active slotA --pending null --json
npm run tauri-lab -- assert credential INSTANCE --cloud-storage absent --json
npm run tauri-lab -- assert sqlite INSTANCE \
  --slot active \
  --db chat_v2 \
  --query "select count(*) from chat_v2_sessions;" \
  --equals 1 \
  --json
npm run tauri-lab -- assert sqlite INSTANCE \
  --slot active \
  --db vfs \
  --query "select count(*) from resources;" \
  --json
npm run tauri-lab -- assert webdav-tree sync-webdav \
  --contains "data_governance/manifests/e2e-device-a.json" \
  --json
```

## Cleanup

```sh
npm run tauri-lab -- fixture webdav stop sync-webdav --json
npm run tauri-lab -- agent release INSTANCE --owner codex-agent-name --json
npm run tauri-lab -- instance stop-all --json
npm run tauri-lab -- service stop --with-instances --json
```
