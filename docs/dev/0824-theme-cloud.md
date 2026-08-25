# 0824 theme cloud integration

PR #275 tracks the cloud-only theme warehouse. It includes all seven #177
increments through `6d6769bc`, while retaining the #169 parsed FTP 550
tombstone handling, #174 WebDAV/S3 normalization, and the theme R02 regression
tests.

Validation gates:

```sh
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib cloud_storage
```

Mobile theme G and subapp theme F are intentionally outside this branch.
