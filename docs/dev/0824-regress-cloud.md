# 0824 cloud/F/G targeted regressions

Date: 2026-08-25  
Branch: `cursor/0824-regress-cloud-cde6`  
Base: `origin/cursor/0824-rehearse-cloud-latest-cde6` @ `2630dc95f`

## Scope

This is a test-only regression pass over the latest #177 rehearsal after F and G
landed. Product behavior is unchanged. The only test repairs are:

- stop the thread-width source contract from reading the old `InputBarV2`
  component after composer ownership split;
- lock the Rust ZIP password minimum to Unicode code points while retaining the
  stable short-password code;
- add one source contract proving `DataGovernanceDashboard` keeps A's accessible
  tabs/DEV gate, B's current #177 E2EE ZIP wiring, and G's 44px targets together.

## Regression matrix

| Area | Targeted evidence | Result |
|---|---|---|
| Cloud backup ZIP remote-size mismatch | `cloud_storage::sync_manager` unit regression | Pending |
| SAF persistable/content URI | `sync_r10_android` host contracts and source anchors | Pending |
| Hashed manifest/tombstone paths; watermark identity | record-path integration plus tombstone/file-key unit contracts | Pending |
| `recoveryKind`, portable refusal, maintenance mode | Rust cloud manifest tests plus current cloud UI/data-governance tests | Pending |
| E2EE short/missing passwords | Rust current ZIP resolver and TS stable-code/UI tests, including emoji code points | Pending |
| #174 WebDAV/S3 | WebDAV encoded href and S3 endpoint normalization unit tests | Pending |
| #169 FTP 550 tombstone | strict FTP classification plus shared-object tombstone scenario | Pending |
| Composer contracts | split `Composer*` source contracts; no `InputBarV2` source import | Pending |
| Finder host buckets | host-isolation/persistence suite | Pending |
| Anki/flashcard read-only | Generative UI display-only contract | Pending |
| G 44px and dashboard A+B+G | split composer touch contracts, dashboard coexistence contract, general touch baseline | Pending |

## Commands

The final results will be recorded after running these groups from the isolated
worktree:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib 'cloud_storage::'
cargo test --manifest-path src-tauri/Cargo.toml --lib 'data_governance::sync::tombstone::tests'
cargo test --manifest-path src-tauri/Cargo.toml --lib 'file_and_snapshot_keys_are_neutral_ids'
cargo test --manifest-path src-tauri/Cargo.toml --lib 'resolve_zip_encryption_password_tests'
cargo test --manifest-path src-tauri/Cargo.toml --test sync_r10_android
cargo test --manifest-path src-tauri/Cargo.toml --test sync_r12_record_path_names
cargo test --manifest-path src-tauri/Cargo.toml --test sync_scenarios_tests \
  asset_tombstone_resolves_object_key_and_keeps_shared_content_object
```

```bash
npx vitest run \
  src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts \
  tests/vitest/chat-v2/threadWidthAlignmentContract.test.ts \
  tests/vitest/chatV2ComposerPanelTokensContract.test.ts \
  tests/vitest/chatV2InputBarRadiusContract.test.ts \
  tests/vitest/chatV2SendButtonContract.test.ts \
  tests/vitest/data-governance/BackupTab.zip-password.test.tsx \
  tests/vitest/data-governance/DataGovernanceDashboard.abg.source.test.ts \
  tests/vitest/data-governance/DataGovernanceDashboard.debug-tab-visibility.test.tsx \
  tests/vitest/data-governance/localizeCloudError.test.ts \
  tests/vitest/data-governance/maintenance-mode.test.tsx \
  tests/vitest/data-governance/r09-ux-cloud-storage.test.tsx \
  tests/vitest/data-governance/syncE2eeErrorMapping.test.ts \
  tests/vitest/data-governance/systemStatusStore.restore-barrier.test.ts \
  tests/vitest/fontSizeScaleClosureContract.test.ts \
  tests/vitest/generative-ui/flashcardDisplayOnly.test.ts \
  tests/vitest/learning-hub/finder-host-buckets.test.ts
```

## Product semantics

No production branch was pushed and no product guard was weakened. Android
ContentResolver/persistable-grant behavior remains a host-side/source-anchor
regression only; this pass does not claim Android real-device sign-off.
