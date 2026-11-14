import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admission, sliceCpus } from './lib/resource-budget.mjs';
import { fulltestVerdict } from './lib/fulltest-result.mjs';
import { consumeFailure, recoveryDelay } from './lib/provider-recovery.mjs';

const green = { memAvailable: 32 * 1024 ** 3, diskAvailable: 100 * 1024 ** 3, uidThreads: 600, pressure: 5, load: 25, cpus: 32 };
test('resource pressure denies new work without killing or exempting existing tests', () => {
  assert.equal(admission(green).ok, true);
  for (const change of [{ memAvailable: 1 }, { diskAvailable: 1 }, { uidThreads: 1500 }, { pressure: 50 }, { load: 50 }]) {
    assert.equal(admission({ ...green, ...change }).ok, false);
  }
});
test('CPU budget uses the shared slice quota, not the calling unit quota', () => {
  assert.equal(sliceCpus(() => '2800000 100000\n', 99), 28);
  assert.equal(sliceCpus(() => 'max 100000\n', 32), 32);
  assert.equal(sliceCpus(() => { throw new Error('ENOENT'); }, 16), 16);
  // A 10-core G3 unit at load 14 on a 28-core slice is healthy.
  assert.equal(admission({ ...green, load: 14, cpus: sliceCpus(() => '2800000 100000', 10) }).ok, true);
});
const shard = (i, code = 0) => ({ i, code, report: { success: true, testResults: [], numTotalTests: 10, numPassedTests: 9, numFailedTests: 0, numPendingTests: 1, numFailedTestSuites: 0 } });
test('fulltest fails closed on raw exit despite zero assertion failures', () => {
  assert.equal(fulltestVerdict([shard(1), shard(2)], 2, true).ok, true);
  assert.equal(fulltestVerdict([shard(1), shard(2, 1)], 2, true).ok, false);
  assert.equal(fulltestVerdict([shard(1)], 2, true).ok, false);
  assert.equal(fulltestVerdict([shard(1), { i: 2 }], 2, true).ok, false);
  assert.equal(fulltestVerdict([shard(1), shard(2)], 2, false).ok, false);
  const partial = shard(2); partial.report.numTotalTests = 11;
  assert.equal(fulltestVerdict([shard(1), partial], 2, true).ok, false);
});
test('recovery cooldown persists across ticks and cannot grow indefinitely within one failed run', () => {
  const s = { lastResumeAt: 'first' };
  assert.equal(consumeFailure(s, 'provider.internal', 1000), false);
  const due = s.providerNextTryAt;
  assert.equal(consumeFailure(s, 'provider.internal', 2000), false);
  assert.equal(s.providerStreak, 1);
  assert.equal(s.providerNextTryAt, due);
  assert.equal(consumeFailure(s, 'provider.internal', due), true);
  s.lastResumeAt = 'second';
  assert.equal(consumeFailure(s, 'provider.internal', due + 1000), false);
  assert.equal(s.providerStreak, 2);
  assert.equal(recoveryDelay(100), 30 * 60_000);
  assert.equal(recoveryDelay(1, 'provider.auth'), 30 * 60_000);
});
