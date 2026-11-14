import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expects, run } from './assert-parity.mjs';
import { rustEvidence } from './rust-evidence.mjs';
import { source } from './common.mjs';
import { matchingCases, testCases } from './testmap.mjs';

test('Rust AST excludes comment/string assertions and counts expected panic once', async () => {
  const [f] = await rustEvidence('#[test]\n#[should_panic]\nfn x() { assert!(true); assert_eq!(1, 1); assert_ne!(1, 2); assert_matches!(x, Some(_)); let s = "assert!(false)"; /* assert!(false); */ panic!("end"); }');
  assert.equal(f.assertions, 5); assert.equal(f.panics, 1);
});
test('cfg-gated Rust assertions are counted and identified', async () => {
  const [f] = await rustEvidence('#[test]\nfn x() { assert!(a);\n #[cfg(feature = "g")]\n assert_eq!(1, 1); }');
  assert.equal(f.assertions, 2); assert.equal(f.cfgAssertions, 1);
});
test('TS count excludes assertion quotas/comments and includes aliases and local helpers', () => {
  const sf = source('a.ts', 'import { expect as check } from "vitest"; function verify(x) { check(x).toBe(1); } test("x", () => { expect.assertions(2); verify(1); expect.soft(2).toBe(2); /* expect(1) */ });');
  assert.equal(expects(sf, testCases(sf)[0].body.body), 2);
});
test('case matching respects identifier boundaries (L04 events.rs report)', () => {
  const sf = source('a.ts', 'test("test_backend_event_deserialization_with_variant", () => {}); test("events: test_backend_event_deserialization", () => {});');
  assert.deepEqual(matchingCases(testCases(sf), 'test_backend_event_deserialization').map(c => c.title), ['events: test_backend_event_deserialization']);
});
test('TESTMAP pairs individual cases, never borrows expects from another test, changed scope works', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/assert-parity-');
  const content = {
    'src-tauri/src/a.rs': '#[test]\nfn test_a_neighbor() { assert!(true); }\n#[cfg(feature = "cloud_storage_s3")]\n#[tokio::test]\n#[ignore = "requires Docker and DS_SYNC_TEST_DOCKER=1"]\nasync fn test_a() { assert!(true); assert_eq!(1,1); }',
    'host/plugins/p/TESTMAP.md': '| `src/a.rs::test_a` | test | L2 | ported:host/plugins/p/tests/a.test.ts |',
    'host/plugins/p/tests/a.test.ts': 'test("test_a", () => expect(1).toBe(1)); test("test_a_neighbor", () => { expect(2); expect(3); });',
  };
  for (const [f, s] of Object.entries(content)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); }
  try {
    const r = await run({ root, changed: null });
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].test, 'test_a');
    assert.equal(r.findings[0].rustAssertions, 2);
    assert.equal(r.findings[0].tsExpects, 1);
    assert.equal(r.findings[0].rustAttributes, '#[cfg(feature = "cloud_storage_s3")]\n#[tokio::test]\n#[ignore = "requires Docker and DS_SYNC_TEST_DOCKER=1"]');
    assert.equal((await run({ root, changed: [] })).findings.length, 0);
  }
  finally { fs.rmSync(root, { recursive: true }); }
});
