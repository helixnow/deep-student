import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QUIET, databaseFingerprint, openStreams, quiesce } from '../../../scripts/electron-migration/record/g3-quiet.mjs';

/** Virtual clock: sleep advances time and runs scheduled side effects. */
function clock(effects = []) {
  let now = 0;
  return {
    now: () => now,
    sleep: async ms => { now += ms; for (const effect of effects) if (!effect.done && now >= effect.at) { effect.done = true; effect.run(); } },
  };
}
const session = (eventType, messageId = 'msg_1') => ({ event: 'chat_v2_session_sess_1', payloadRaw: JSON.stringify({ eventType, messageId }) });

test('quiesce returns after the fingerprint is unchanged for the whole window', async () => {
  let version = 0;
  const c = clock([{ at: 100, run: () => version++ }, { at: 400, run: () => version++ }]);
  const result = await quiesce({ events: () => [], fingerprint: () => String(version), now: c.now, sleep: c.sleep });
  assert.equal(result.settled, true);
  assert.equal(result.waitedMs >= 400 + QUIET.windowMs, true, `waited ${result.waitedMs}`);
  assert.equal(result.waitedMs < 400 + QUIET.windowMs + 2 * QUIET.pollMs, true);
});

test('quiesce stops at the cap when writes never stop, and says so', async () => {
  let version = 0;
  const c = clock();
  const result = await quiesce({ events: () => [], fingerprint: () => String(version++), now: c.now, sleep: c.sleep });
  assert.equal(result.settled, false);
  assert.equal(result.waitedMs >= QUIET.maxMs && result.waitedMs < QUIET.maxMs + QUIET.streamMs, true);
});

test('quiesce first waits for open session streams to reach a terminal event', async () => {
  const events = [session('stream_start')];
  const c = clock([{ at: 1200, run: () => events.push(session('stream_cancelled')) }]);
  assert.deepEqual(openStreams(events), ['chat_v2_session_sess_1#msg_1']);
  const result = await quiesce({ events: () => events, fingerprint: () => 'same', now: c.now, sleep: c.sleep });
  assert.equal(result.settled, true);
  assert.deepEqual(result.streamsOpen, []);
  assert.equal(result.waitedMs >= 1200 + QUIET.windowMs, true);
});

test('a stream that never ends is bounded and reported as still open', async () => {
  const events = [session('stream_start')];
  const c = clock();
  const result = await quiesce({ events: () => events, fingerprint: () => 'same', now: c.now, sleep: c.sleep });
  assert.deepEqual(result.streamsOpen, ['chat_v2_session_sess_1#msg_1']);
  assert.equal(result.waitedMs >= QUIET.streamMs, true);
});

test('a step that explicitly waited for a non-terminal event is captured mid-stream', async () => {
  const events = [session('stream_start')];
  const c = clock();
  const result = await quiesce({ events: () => events, fingerprint: () => 'same', now: c.now, sleep: c.sleep,
    step: { waitAfter: { event: 'stream_start', channelPrefix: 'chat_v2_session_' } } });
  assert.equal(result.skipped, 'mid-stream waitAfter');
  assert.equal(result.waitedMs, 0);
});

test('databaseFingerprint sees WAL appends and ignores non-database files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'w13-quiet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'vfs.db'), 'SQLite format 3\0');
  await writeFile(join(dir, 'vfs.db-wal'), 'a');
  await writeFile(join(dir, 'notes.txt'), 'x');
  const first = databaseFingerprint(dir);
  await appendFile(join(dir, 'notes.txt'), 'y');
  assert.equal(databaseFingerprint(dir), first);
  await appendFile(join(dir, 'vfs.db-wal'), 'b');
  assert.notEqual(databaseFingerprint(dir), first);
});

test('the A and B recorders call the same quiesce before every capture', async () => {
  for (const file of ['g3-run-a.mjs', 'g3-run-b.mjs']) {
    const source = await readFile(new URL(`../../../scripts/electron-migration/record/${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{[^}]*\bquiesce\b[^}]*\} from '\.\/g3-quiet\.mjs'/, file);
    assert.match(source, /capture: async \(_, \{ phase \}\) => \{[^]*?await quiesce\(/, file);
  }
});
