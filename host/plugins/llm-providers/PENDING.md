# L01 v2 additional pending regressions

## V2-03 / X6-UD-0040 — preview unknown-field depth 128

**Status (WP-017, 2026-11-05): implemented and active; provider regression passed.
Independent main review and L12 indexing consumption remain separate follow-up conditions.**

- Original Rust evidence: `multimodal/page_indexer.rs:17-25` derives Deserialize;
  its unknown fields use serde `IgnoredAny`, not `Value::deserialize`.
  serde_json 1.0.149 `de.rs:1102-1281,1910` uses an independent ignored-value stack
  without decrementing typed `remaining_depth`. R1 confirmed in `c7bd5d5ce` §16
  and withdrew the former depth128 rejection claim, not the original run facts.
- Required result: the following valid unknown-field vector must be accepted by
  the real `ctx.llmMultimodal.parseAttachmentPreviewJson` entry:

  ```ts
  const text = `{"pages":[],"x":${'['.repeat(127)}${']'.repeat(127)}}`;
  expect(ctx.llmMultimodal.parseAttachmentPreviewJson(text)).toEqual({ pages: [] });
  ```

- Former blocker resolved: main `967f43c75` exports the public `JsonReader` with
  `skipIgnoredValue()` and `endArray()`. WP-017 uses it for the ordered typed
  path, without Value pre-parsing or a copied scanner.
- Restored as an **active** service-entry test in `tests/codex-integer-width.test.ts`:
  `preview accepts the corrected pending unknown-field depth 128 vector`.
  Before the implementation, job `20261105140945-6d857d` failed this vector
  (`invalid attachment preview: invalid JSON`; six new cases failed overall).
  After the implementation, job `20261105141327-8880db` passed all 48 tests in
  page-indexer / codex-integer-width / services, exit 0, no Errors/unhandled report.
  This is provider-side production-entry evidence, not a Rust execution or R1 signoff.
- The valid depth127 vector remains an active test in that file. Typed negative
  zero, actual Value zero/depth rules, preview precision and existing assertions
  are unchanged by moving this unresolved vector to pending.

This is an additional v2 regression, not a named original Rust test. No synthetic
Rust test ID or unrelated generated TESTMAP disposition is introduced. Previous
Vitest skip receipts remain historical; absence of this case from the runtime
suite was not evidence of passing it. WP-017 preserves the corrected vector and
this history; the obsolete depth128 rejection assertion is not restored.
