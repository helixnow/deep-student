// The recording clock is not frozen. When B is recorded on another calendar date than A/A2
// (A store reuse), a value that is the same in A1 and A2 but follows "today" differs in B.
// Recording dates come from worker receipts; a difference that is exactly the recording date
// shift is classified as an environment difference. Classification never changes a fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompare, clockOffsets, recordingDates } from '../../../scripts/electron-migration/record/g3-classify.mjs';

const window = (from, to = from) => ({ startedAt: from, endedAt: to });

test('clock: recording dates per take in the pinned time zone, and B−A day offsets only when B shares no date with A/A2', () => {
  assert.deepEqual(recordingDates(window('2026-11-07T15:50:00.000Z', '2026-11-07T16:10:00.000Z'), 'UTC'), ['2026-11-07']);
  assert.deepEqual(recordingDates(window('2026-11-07T15:50:00.000Z', '2026-11-07T16:10:00.000Z'), 'Asia/Shanghai'), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(recordingDates(window('2026-11-07T23:00:00.000Z', '2026-11-09T01:00:00.000Z'), 'UTC'), ['2026-11-07', '2026-11-08', '2026-11-09']);
  assert.deepEqual(recordingDates(null, 'UTC'), []);

  const a = window('2026-11-07T10:00:00.000Z'), a2 = window('2026-11-07T10:05:00.000Z');
  assert.deepEqual(clockOffsets({ A: a, A2: a2, B: window('2026-11-07T22:00:00.000Z') }, 'UTC'), []);
  assert.deepEqual(clockOffsets({ A: a, A2: a2, B: window('2026-11-14T09:00:00.000Z') }, 'UTC'), [7]);
  assert.deepEqual(clockOffsets({ A: a, A2: a2, B: window('2026-11-14T23:50:00.000Z', '2026-11-15T00:20:00.000Z') }, 'UTC'), [7, 8]);
  assert.deepEqual(clockOffsets({ A: a, A2: window('2026-11-08T00:10:00.000Z'), B: window('2026-11-08T09:00:00.000Z') }, 'UTC'), [], 'B shares a date with A2');
  assert.deepEqual(clockOffsets({ A: a, A2: a2, B: window('2026-11-05T09:00:00.000Z') }, 'UTC'), [-2]);
  assert.deepEqual(clockOffsets({ A: a, B: null }, 'UTC'), [], 'unknown recording time: no offset is claimed');
});

test('clock: only a difference that is exactly the recording date shift is an environment difference', () => {
  const outcome = (expected, actual) => ({ step: 0, command: 'review_due', kind: 'outcome', difference: { path: '/due', expected, actual } });
  const value = (before, after) => ({ kind: 'value', db: 'app-data/slots/slotA/databases/vfs.db', table: 'review_items', key: null, column: 'due_date',
    before: { storageClass: 'text', value: before }, after: { storageClass: 'text', value: after } });
  const database = (samples, count = samples.length) => ({ step: 0, command: 'review_due', kind: 'database', where: 'after step 0', count, sample: samples });
  const artifact = differences => ({ scenario: { id: 'review.due' }, differences, normalizationSkipped: [] });
  const category = (difference, clock = { offsets: [7] }, known = []) => classifyCompare(artifact([difference]), known, clock).differences[0];

  assert.deepEqual(category(outcome('2026-11-07', '2026-11-14')), { category: 'environment', known: 'clock-skew' });
  assert.deepEqual(category(outcome('2026-11-07 00:00:00', '2026-11-14 00:00:00')), { category: 'environment', known: 'clock-skew' });
  assert.deepEqual(category(outcome('2026-11-08', '2026-11-15'), { offsets: [7, 8] }), { category: 'environment', known: 'clock-skew' });
  assert.deepEqual(category({ ...outcome('2026-11-07', '2026-11-14'), kind: 'args' }), { category: 'environment', known: 'clock-skew' });
  assert.deepEqual(category({ step: 1, command: 'review_due', kind: 'events', where: 'after step 1',
    difference: { path: '/0/payload/day', expected: '2026-11-07', actual: '2026-11-14' } }), { category: 'environment', known: 'clock-skew' });
  assert.deepEqual(category(database([value('2026-11-07', '2026-11-14'), value('2026-11-10', '2026-11-17')])), { category: 'environment', known: 'clock-skew' });

  for (const [label, difference, clock] of [
    ['same-day compare', outcome('2026-11-07', '2026-11-14'), { offsets: [] }],
    ['no clock information', outcome('2026-11-07', '2026-11-14'), null],
    ['shift is not the recording offset', outcome('2026-11-07', '2026-11-15'), { offsets: [7] }],
    ['time of day also differs', outcome('2026-11-07 10:00:00', '2026-11-14 11:00:00'), { offsets: [7] }],
    ['not a date', outcome('alpha', 'beta'), { offsets: [7] }],
    ['number difference', outcome(3n, 4n), { offsets: [7] }],
    ['database sample incomplete', database([value('2026-11-07', '2026-11-14')], 2), { offsets: [7] }],
    ['database sample mixed', database([value('2026-11-07', '2026-11-14'), value('a', 'b')]), { offsets: [7] }],
    ['database row missing', database([{ ...value('2026-11-07', '2026-11-14'), kind: 'row' }]), { offsets: [7] }],
  ]) assert.deepEqual(category(difference, clock), { category: 'product', known: null }, label);

  const registered = [{ id: 'K-X', category: 'a-defect', owner: 'o', evidence: 'e', match: { commands: ['review_due'] } }];
  assert.deepEqual(category(outcome('2026-11-07', '2026-11-14'), { offsets: [7] }, registered), { category: 'a-defect', known: 'K-X' }, 'registry first');
  const unstable = classifyCompare({ scenario: { id: 'review.due' }, differences: [outcome('2026-11-07', '2026-11-14')],
    normalizationSkipped: [{ site: 's0:result', pointer: '/due' }] }, [], { offsets: [7] }).differences[0];
  assert.deepEqual(unstable, { category: 'nondeterministic', known: 'A1≠A2' }, 'A1≠A2 before the clock');
  const summary = classifyCompare(artifact([outcome('2026-11-07', '2026-11-14'), outcome('x', 'y')]), [], { offsets: [7] });
  assert.equal(summary.summary, 'product', 'a product difference still decides the compare');
});
