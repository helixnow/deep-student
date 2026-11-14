# M3 mobile platform providers

The seven owned platform services have explicit `mobile.ts` entries (M8 integrated them):
`host/profiles/generate.ts` prefers `<dir>/mobile.ts` for the mobile profile, so these names
are discovered exactly like the desktop `index.ts` entries and must declare `mobile` in
`meta.platforms`. Their runtime closures are Node-free
(`node scripts/portability/scan.mjs --profile host/profiles/mobile.json`).

## Implemented boundaries

- **paths:** POSIX paths matching `files/opfs.ts` roots, persistent OPFS device ID.
- **log:** redacted bounded memory ring and console; structured logs use the same
  ring. Desktop request/response archives are not retained; archive reads fail.
- **settings:** existing SQL repository and secret migration semantics reused;
  `index.ts` now imports the portable path implementation.
- **http:** browser `fetch`, cancellation/timeout, bounded response reads. Public
  policy and pinned requests fail closed with `UnsupportedOnPlatform`: Worker fetch
  cannot supply DNS resolution or inspect cross-origin redirect destinations.
  Browser CORS restrictions remain in effect.
- **secrets:** file-only OPFS seed and authenticated AES-GCM SecureStore for settings;
  no plaintext fallback. Seed and nonce/ciphertext layout match the desktop v3 store.
  This is origin-local storage, **not OS-keychain protection**. Desktop CryptoService,
  backup/publication, cloud credential staging and keychain operations are explicitly
  unavailable. No encrypted cloud sync readiness is claimed.
- **diagnostics:** portable background-task lifecycle; OS package installation
  reports unsupported. Desktop database/devtools commands are not registered.
- **vector:** native index connect fails explicitly, rather than returning empty
  search results or loading LanceDB.

## Plugin portability progress and blockers

Replaced UUID/random bytes, SHA-256 hashing, UTF-8 ordering, byte counts, supported
base64/hex operations, Node path imports, timer promises and pure helper imports.
Existing persisted hashes and sync wire encodings are retained. Removed unused
crypto imports and kept SQLite's lenient base64 blob decoder semantics.

Runtime-nonportable production files went from **117 to 38** across the four plugins
(the original 118 findings-bearing files also included a type-only Buffer reference):

- **chat: 5** — agents-md, attachment-stage, completion-dispatcher, register,
  workspace-profiles. These retain desktop filesystem reads/writes and home lookup.
- **chat-pipeline: 5** — repository/budget, canonical-image-payloads,
  context-compiler-owner, finalizer, retrieval-images. These retain filesystem stat,
  temporary OCR files, image reads and synchronous attachment hashing.
- **agent-orchestration: 4** — index, repository/automation-model,
  repository/legacy, src/custom-agent. These retain legacy DB discovery/migration,
  hostname/process scheduler identity and synchronous agent/proposal files.
- **sync: 24** — filesystem-backed apply/open/registry, blob/workspace/asset transfer,
  pruning, deletion queues, conflict/history/list/status/import/export commands.
  Many public repository helpers are synchronous; replacing them with `ctx.files`
  requires async API/caller changes, not a safe import-only substitution.

There are also runtime gateways into plugins outside M3 ownership (agent-workspace,
agent-skills, vfs, sync-providers, and platform ZIP/backup support). Thus the four
business plugins are **not yet Worker-ready** and do not declare mobile support.

## Verification

- `tsc --noEmit -p tsconfig.host.json`.
- `node scripts/portability/scan.mjs --check`: zero new violations; 163 baseline
  entries resolved (baseline deliberately not rewritten, outside ownership).
- All seven staged provider closures checked with `checkModulesClosure`.
- Focused mobile provider tests cover identity persistence/rotation, encrypted secret
  restart/tamper handling, fetch byte limits and fail-closed policy, unavailable native
  indexes/package installation, and bounded/redacted log snapshots.
- Existing desktop-profile tests have a baseline failure unrelated to this work:
  `dstu.plugin-workshop` requires missing `dstuPluginInstaller`. Do not hide it by
  changing profile files or unrelated plugins.
