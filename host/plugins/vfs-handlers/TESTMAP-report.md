# L13b → coordinator

The proposed test destinations now live in [TESTMAP.md](TESTMAP.md), so the
lane-specific wiring command can inspect them. The coordinator still owns updates
to `host/plugins/vfs/TESTMAP.md`; no test inventory has been moved out of L13.

R3 / C2 handoff: import the current **63 ported / 2 pending / 3 obsolete** rows.
Five `index_service.rs` rows (four atomic reset tests and the single-pool sync test)
now map to `ported:host/plugins/vfs-handlers/tests/index-admin.test.ts`, with real
L12 providers. L11 maintenance has now entered main (9c13dfc39); the three
`handlers.rs` path tests (`test_source_id_prefix_parsing`, `test_path_length_constraint`,
`test_path_format`) now map to `ported:host/plugins/vfs-handlers/tests/paths.test.ts`.
They run through production invoke and the real L11 provider; shared harness no longer
installs a maintenance double. Path rollback/UTF-8 limit/title fallback remain covered.
The two `todo_handlers.rs` blocking-runner tests are now pending: CRUD/error-shape
tests do not establish the original thread guarantee (R13-02).

The content-hash port is
`crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_content_hash_consistency`
→ `ported:host/plugins/vfs-handlers/tests/question-sync.test.ts` (real L11 update/submit
metadata path). Three retired question-sync conflict tests now use the
`obsolete:dead-in-rust` approvals already present in `migration/approvals.json`.
Please synchronize these changes into L13's authoritative TESTMAP; this lane cannot edit it.
