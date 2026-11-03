# Task2 sync slice — canonical pointer integrity and conflict blob pins

Repo /home/xutao/deepstudent/deep-student feature branch. Scope ONLY dstu-sync/src/data_governance/sync/{ink.rs,ink_tests.rs,mod.rs} (new helper module, minimal callsites), own report. Do not edit VFS repos/types or approval files. Read reviews/storage-sync-findings.md and task-2-brief state layout; no broad exploration.

## First gate

TESTS_ONLY before implementation. Add `#[cfg(test)] mod ink_tests` under sync/mod.rs, tests use actual migrated VfsDatabase and current VfsInkRepo create/save (already3pass). Can access SyncManager private recompute via child module. Tests assert actual counts/bytes, not source text or mock. Minimal helper API scaffold only when necessary. NO test/build/install/agents/commit/push execution. Return NEEDS_RED_VERIFICATION. Main runs.

## Canonical index

files blob_hash=sha256=currentmanifest hash, preview_json stored STRING with `{"ink":{"schema_version":1,"document_id":files.id,"revision":manifest.revision,"manifest_blob_hash":hash,"blob_refs":[sorted unique page/background hashes]}}`. Index derived from manifest, no second writable source. `resources.hash` mirror from files row.

## Initial tests

1. Create blank with VfsInkRepo, read pagehash, invoke recompute_blob_ref_counts, verify bothmanifest/page counts1, blob files exist, real cleanup_unreferenced does NOT delete them. Current code pagecount becomes0 -> red.
2. After save, capture old files row and persist full JSON snapshot to ConflictResolver table via actual save helper or plain INSERT under ensure_conflict_table; its preview_json string contains old page deps. Recompute should pin oldmanifest/page+background while conflict unresolved. Set resolved_at then recompute→old deps0, current stays1. Duplicate hash within a document counted once, samehash in two independent owners counted twice. May use valid service-built hashes, avoid fabricated blobs not real bytes.
3. Incoming dsink partial row missing preview/sha/blob/revision canonical members must reject without any state/ref mutation; create minimal `validate_ink_change` helper scaffold returningOk to red if needed. Full row remains valid; pointer-group revision/hash mismatch rejects. Local existing dsink identification must catch payload that omits mime or tries to change format.
4. Existing resources hash intentionally stale after canonical complete files state; batch-end reconciliation helper updates only dsink mirror, does not modify genericresources. False index hash/references reject/quarantine. No missing blobs permitted to expose a new file pointer; blob transfer is independent, return/keep quarantine retry (no deleting foreign blobs).

First dispatch prioritize1–2 true lifecycle tests and3small completeness helper; remaining integration follows. No proof via independent SQL schema or replacing real service. Report exact selector `data_governance::sync::ink_tests`.

## Later implementation expectation

Count current unique deps plus unresolved files dsink conflict snapshot primarymanifest anddeps. Respect json_valid/null for legacy snapshots, rejectinvalidcanonical new data fail closed, no generic JSON URL parsing. Extend both plain/guard sync paths at same shared boundary; complete files tuple LWW, never FieldMerge individual canonicalcomponents. resources mirror repair before transaction commit/refcounts; conflicts resolving releases pins on same recount used GC.

Validate actual manifest/page bytehashes if available at apply; avoid SQL-only trusting arbitrary deps. Use existing dstu-vfs service helper if layerdependency already allowed (dstu-sync dependsdstu-vfs), but do NOT concurrently modify ink_repo. If bytes notyet downloaded, quarantine/defer record rather than publish pointer; don't pretend DB+remote file sync atomic. Proper retry must be testable. No new table/migration unless evidence impossible otherwise.
