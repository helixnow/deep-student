import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CATEGORIES, DEFAULT_KNOWN, classifyCompare, loadKnown } from '../../../scripts/electron-migration/record/g3-classify.mjs';

const VFS = 'app-data/com.deepstudent.differential/slots/slotA/databases/vfs.db';
const MISTAKES = 'app-data/com.deepstudent.differential/slots/slotA/mistakes.db';
const known = loadKnown(DEFAULT_KNOWN);
const row = (db, table, column = null) => ({ kind: column ? 'value' : 'row', db, table, column, key: null, before: null, after: null });
const artifact = (id, differences, normalizationSkipped = []) => ({ scenario: { id }, differences, normalizationSkipped });

test('A-side chat_v2_blocks failure covers its step and everything after it, nothing before', () => {
  const result = classifyCompare(artifact('chat.stream.blocks', [
    { step: 1, command: 'chat_v2_save_message', kind: 'outcome', difference: { path: '/title' } },
    { step: 3, command: 'chat_v2_upsert_streaming_block', kind: 'expectation', side: 'A', expected: 'result', actual: 'error',
      raw: '"Database error: no such table: chat_v2_blocks"' },
    { step: 3, command: 'chat_v2_upsert_streaming_block', kind: 'outcome-kind', a: 'error', b: 'result', rawA: '"no such table: chat_v2_blocks"', rawB: '{}' },
    { step: 4, command: 'chat_v2_load_session', kind: 'outcome', difference: { path: '/blocks/length' } },
    { step: null, command: null, kind: 'final-database', count: 1, sample: [row(VFS, 'chat_v2_blocks')] }]), known);
  assert.deepEqual(result.differences.map(item => item.category), ['product', 'a-defect', 'a-defect', 'a-defect', 'a-defect']);
  assert.equal(result.summary, 'product', 'the unrelated step-1 difference keeps the scenario a product difference');
  assert.deepEqual(result.knownIds, ['K-001']);
});

test('the same error text on the B side is a product difference', () => {
  const result = classifyCompare(artifact('chat.stream.blocks', [
    { step: 3, command: 'chat_v2_upsert_streaming_block', kind: 'expectation', side: 'B', expected: 'result', actual: 'error',
      raw: '"no such table: chat_v2_blocks"' }]), known);
  assert.equal(result.summary, 'product');
});

test('A1≠A2 places that no rule covers are nondeterministic only when every listed sample is there', () => {
  const skipped = [{ db: MISTAKES, table: 'document_tasks', reason: 'A1/A2 row counts differ; table not normalized' },
    { db: VFS, table: 'resources', column: 'updated_at', reason: 'A1/A2 values differ but not as random ids/timestamps' }];
  const race = classifyCompare(artifact('anki.document.cancel', [
    { step: 5, command: 'anki_cancel', kind: 'database', count: 2, sample: [row(MISTAKES, 'document_tasks'), row(VFS, 'resources', 'updated_at')] }], skipped), known);
  assert.equal(race.summary, 'nondeterministic');
  const mixed = classifyCompare(artifact('anki.document.cancel', [
    { step: 5, command: 'anki_cancel', kind: 'database', count: 2, sample: [row(MISTAKES, 'document_tasks'), row(VFS, 'resources', 'name')] }], skipped), known);
  assert.equal(mixed.summary, 'product', 'resources.name is stable in A');
  const truncated = classifyCompare(artifact('anki.document.cancel', [
    { step: 5, command: 'anki_cancel', kind: 'database', count: 80, sample: [row(MISTAKES, 'document_tasks')] }], skipped), known);
  assert.equal(truncated.summary, 'product', 'a capped sample cannot prove the rest');
  const json = classifyCompare(artifact('anki.document.cancel', [
    { step: 2, command: 'anki_status', kind: 'outcome', difference: { path: '/progress' } }],
  [{ site: 's2:result', pointer: '/progress', reason: 'A1/A2 numbers differ but are not 10+ digit ids/epochs' }]), known);
  assert.equal(json.summary, 'nondeterministic');
  const otherStep = classifyCompare(artifact('anki.document.cancel', [
    { step: 3, command: 'anki_status', kind: 'outcome', difference: { path: '/progress' } }],
  [{ site: 's2:result', pointer: '/progress', reason: 'A1/A2 numbers differ but are not 10+ digit ids/epochs' }]), known);
  assert.equal(otherStep.summary, 'product');
});

test('registered environment limits and the category vocabulary', () => {
  const result = classifyCompare(artifact('shell.pdfstream', [
    { step: 0, command: 'pdfstream_check_access', kind: 'outcome-kind', a: 'result', b: 'error', rawA: '{}', rawB: '"denied"' }]), known);
  assert.equal(result.summary, 'environment');
  assert.deepEqual(Object.values(CATEGORIES), ['真实产品差异', 'A 端缺陷', '环境差异', '已知非确定性']);
  assert.equal(classifyCompare(artifact('x', []), known).summary, null);
});

test('the registry cannot declare a product category or omit evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'w13-known-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'known.json');
  await writeFile(file, JSON.stringify({ schema: 'g3-known-differences/v1', entries: [{ id: 'K-x', category: 'product', owner: 'o', evidence: 'e', match: {} }] }));
  assert.throws(() => loadKnown(file), /category product/);
  await writeFile(file, JSON.stringify({ schema: 'g3-known-differences/v1', entries: [{ id: 'K-y', category: 'environment', owner: 'o', match: {} }] }));
  assert.throws(() => loadKnown(file), /needs id, owner, evidence, match/);
});
