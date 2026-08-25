# Anki preference memory write closure

## Production wiring

ChatAnki now runs `extract → consolidate → persist` for three user signals:

- a non-empty `extraRequirements`, after the current run has retrieved its historical hint;
- successful substantive `chatanki_update_card` and `chatanki_batch_update_cards` content edits;
- successful `chatanki_delete_card` and `chatanki_delete_cards` deletions.

Whitespace-only and metadata-only edits are ignored. Canonical front/back/text changes and custom-template
field changes are observed; mirrored template aliases are deduplicated. Diagnostic error cards are excluded
from deletion evidence.

The write helper serializes the settings read/modify/write sequence inside the process, parses the existing
store, calls `consolidate_observation`, and saves the resulting store. A malformed existing value is preserved
rather than replaced with an empty store. All read, parse, serialization, and save errors are logged and
swallowed: preference learning cannot roll back a successful edit/delete or prevent card generation.

## Storage and privacy

The store is local. It is JSON in the active data space's `mistakes.db`, table `settings`, under key
`chatanki_preference_memory_store`. No preference-memory network API or cloud write is used by this path.

Only distilled preference entries are persisted: short statements, structured subjects, confidence,
evidence summaries/counts, and timestamps. Raw cards and the full `extraRequirements` string are not stored in
the preference setting. A no-signal observation may persist an empty/unchanged store so the write closure stays
uniform. Existing backup/sync behavior for the local database is outside this feature's path.

## Semantics

Consolidation remains ADD-only. Matching observations only increase evidence/confidence; conflicting
preferences coexist as separate entries. No observation rewrites or semantically deletes an existing entry.
The existing bounded-capacity eviction policy remains the sole removal mechanism.

## Verification

Seventeen new focused tests cover the full transform, no-signal behavior, ADD-only conflicts, canonical/cloze/
custom-field edit diffs, alias deduplication, metadata-only edits, diagnostic-card filtering, initial
persistence, reinforcement, malformed-store fail-closed behavior, language learning from edits, deletion
density learning, and omission of unrelated `extraRequirements` text.
