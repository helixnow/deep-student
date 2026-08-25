# 0824 / v0.9.44 ZIP restore compatibility

This note compares Git tag `v0.9.44` (`1cf6cabc`) with the 0824 release branch. “Import” means that the ZIP can be unpacked into the backup list. “Slot restore” means that it may replace an A/B data slot after `BackupManifest::validate_for_slot_restore`.

## Decision

- A portable ZIP produced by v0.9.44 can be imported on 0824 for inspection or re-export, but it cannot restore a data slot.
- A v0.9.44 cloud backup contains the same portable ZIP. Cloud E2EE only wraps that whole ZIP in DSBK; after 0824 decrypts it with the same cloud password, it is still a partial archive and cannot restore a slot.
- 0824 encrypted full-fidelity ZIPs can restore on 0824 after password-based unsealing and validation. They are not backward-compatible with v0.9.44: the old importer does not know `key_policy=included_encrypted` or `portable_secrets.dsbk`.
- 0824 exports therefore have no general restore guarantee on older clients. In particular, encrypted full-fidelity exports must be documented as 0824-or-later artifacts. Unencrypted portable exports retain the older shape but are archives, not disaster-recovery packages.

The new hashed manifest name, random/neutral version ID, and additive `recoveryKind` field do not by themselves require this incompatibility claim:

- v0.9.44 enumerates every `manifests/*.json`, so it can discover a hashed manifest filename.
- Its version-ID validator accepts the new 22-character hexadecimal ID.
- Serde ignores the additive `recoveryKind` field.

Those metadata changes can reduce old-client status fidelity (for example, its own-device last-sync lookup still uses the raw device ID), but the actual restore boundary is the ZIP payload and manifest contract. 0824 also dual-reads the legacy raw device-manifest name.

## Compatibility matrix

| Producer / artifact | 0824 import | 0824 slot restore | v0.9.44 consumer |
|---|---:|---:|---|
| v0.9.44 local portable ZIP | Yes | No: `PartialOverlay` + `excluded_portable` | Imports as a partial archive; no slot restore |
| v0.9.44 cloud ZIP, no cloud E2EE | Yes after download | No | Existing behavior |
| v0.9.44 cloud ZIP, whole-object E2EE | Yes after DSBK decrypt with the same password | No: decrypted inner ZIP is still portable | Existing behavior |
| 0824 unencrypted portable ZIP | Yes | No | Expected to retain the v0.9.44 portable shape, but no downgrade guarantee |
| 0824 encrypted full-fidelity ZIP | Yes with its backup password | Yes, only after full validation | Unsupported: unknown `included_encrypted` policy/sealed payload |
| 0824 cloud backup with configured E2EE | Yes with the stored cloud password | Yes if the unsealed manifest passes the full-snapshot gate | Unsupported as a disaster-recovery path |

Do not use v0.9.44 and 0824 as concurrent writers to a cloud root that has 0824 E2EE metadata. v0.9.44 predates the password verifier in `.encryption-marker` and cannot enforce the same wrong-password gate. Use 0824-or-later on every writer or use a separate cloud root.

## Refusal and atomicity contract

0824 intentionally keeps these gates fail-closed:

1. ZIP import validates paths, sizes, checksums, manifest policy, and sealed-payload shape.
2. Missing or incorrect sealed-ZIP passwords fail without exposing a restorable package.
3. `validate_for_slot_restore` rejects portable, partial, legacy-without-coverage, and otherwise incomplete manifests before any slot write.
4. A full snapshot cannot opt out of asset restore.
5. The restore command requires `DataSpaceManager` before disk preparation, slot clearing, or database writes. The former fallback wrote an inactive `slotB` candidate and only discovered at cutover time that atomic registration was unavailable.
6. Restore writes only the inactive slot. Candidate migration, integrity work, sync-baseline reset, the activation marker, and the durable cutover lease must complete before restart can activate it.

Importing a partial archive is successful as an archive operation. The Dashboard must not follow that success with a “Restore now” prompt when job stats report `recovery_kind=partial_archive` or `restorable=false`.

## Stable refusal codes

| Code | Meaning |
|---|---|
| `E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE` | Portable/partial/otherwise non-slotable archive, including a request to omit assets from a full restore |
| `E_BACKUP_SEALED_PASSWORD_REQUIRED` | Encrypted full-fidelity ZIP was imported without its backup password |
| `E_BACKUP_SEALED_DECRYPT_FAILED` | Sealed payload authentication failed; the password is wrong or the payload is damaged |
| `E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE` | A/B data-space management is unavailable, so restore stopped before writing candidate data |
| `E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT` | New cloud/ZIP encryption password is below the minimum |
| `E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED` | Cloud E2EE is configured but its stored password is unavailable |
| `E_SYNC_E2EE_PASSWORD_REQUIRED` | Encrypted cloud data requires a password on this device |
| `E_SYNC_E2EE_WRONG_PASSWORD` | The cloud password does not authenticate existing encrypted data |
| `E_SYNC_E2EE_MARKER_CORRUPTED` | The cloud encryption marker cannot be trusted |
| `E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED` | A protected cloud root contains legacy plaintext data |

Messages may be localized or reworded; programmatic dispatch must use the code.

## Unsupported paths

- Slot-restoring any unencrypted portable ZIP, including v0.9.44 local and cloud exports.
- Treating whole-object cloud E2EE in v0.9.44 as full fidelity; it encrypted an already-stripped portable ZIP.
- Importing an 0824 encrypted full-fidelity ZIP into v0.9.44.
- Restoring legacy manifest v1/v2 packages that lack a coverage ledger.
- Slot-restoring tiered/partial packages with excluded required domains.
- Skipping assets during a full-slot restore.
- Restoring a sealed ZIP without the correct password.
- Mixed-version writes from v0.9.44 into an 0824 E2EE cloud root.
- In-place password rotation for an existing cloud root; use a new root and upload again.

