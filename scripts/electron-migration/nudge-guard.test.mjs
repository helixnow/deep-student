import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as nudge from './lib/nudge-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-06T10:00:00Z');
const msg = (extra = '') => `【C0 最高优先级】WP-043 X7-differential 的 rust 构建仍未给出 job id，20 分钟内给出中间证据。${extra}`;
const hist = (entries) => entries.map(([min, from, to, text]) => ({ t: new Date(T0 + min * 60_000).toISOString(), from, to, ...nudge.features(text, [to, from]) }));

test('third push of the same topic to the same owner within 2h without new evidence is refused with the ladder', () => {
  const h = hist([[0, 'C0-chief', 'C1-app', msg()], [10, 'C0-chief', 'C1-app', msg('（第二轮）')]]);
  const r = nudge.assess(h, { from: 'C0-chief', to: 'C1-app', text: msg('（第三轮）'), nowMs: T0 + 20 * 60_000 });
  assert.equal(r.allow, false);
  assert.equal(r.level, 3);
  assert.match(r.ladder, /restart|assign|repair apply/);
  assert.match(r.ladder, /待用户裁定/);
});

test('new evidence (commit, job id) or a different topic or recipient lets the message through', () => {
  const h = hist([[0, 'C0-chief', 'C1-app', msg()], [10, 'C0-chief', 'C1-app', msg()]]);
  const now = T0 + 20 * 60_000;
  assert.equal(nudge.assess(h, { from: 'C0-chief', to: 'C1-app', text: msg('X7 已提交 3f9c2ab71，job 20261106165331-ac6acb 失败'), nowMs: now }).allow, true);
  assert.equal(nudge.assess(h, { from: 'C0-chief', to: 'C2-platform', text: msg(), nowMs: now }).allow, true);
  assert.equal(nudge.assess(h, { from: 'C0-chief', to: 'C1-app', text: 'WP-260 L12-vfs-index 门禁失败需要隔离证据', nowMs: now }).allow, true);
  assert.equal(nudge.assess(h, { from: 'C0-chief', to: 'C1-app', text: msg(), nowMs: T0 + 3 * 3_600_000 }).allow, true, 'outside the 2h window');
});

test('second push is allowed but warned; automated senders are never gated', () => {
  const h = hist([[0, 'C0-chief', 'C1-app', msg()]]);
  const second = nudge.assess(h, { from: 'C0-chief', to: 'C1-app', text: msg(), nowMs: T0 + 10 * 60_000 });
  assert.equal(second.allow, true);
  assert.match(second.ladder, /第 2 次/);
  const auto = hist([[0, 'night-guard', 'C2-platform', msg()], [5, 'night-guard', 'C2-platform', msg()]]);
  assert.equal(nudge.assess(auto, { from: 'night-guard', to: 'C2-platform', text: msg(), nowMs: T0 + 10 * 60_000 }).allow, true);
});

test('evidence extraction ignores plain words and keeps shas, job and run ids', () => {
  const f = nudge.features('main ae4efdf9e, deadbeef, job 20261106165332-9e16dd, run 2026-11-06T165321717Z-3652911, IQ-20261106170000-ab12');
  assert.deepEqual(f.evidence.sort(), ['2026-11-06T165321717Z-3652911', '20261106165332-9e16dd', 'IQ-20261106170000-ab12', 'ae4efdf9e'].sort());
});

test('coord.mjs queue end to end: refuses the third identical nudge (exit 3), accepts --force-repeat with a reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-e2e-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const runs = path.join(dir, '.oc-runs');
  fs.mkdirSync(runs);
  fs.writeFileSync(path.join(runs, 'sessions.json'), JSON.stringify({ 'C0-chief': { coordinator: true, chief: true }, 'C1-app': { coordinator: true, lanes: [] } }));
  const send = (...extra) => spawnSync(process.execPath, [path.join(HERE, 'coord.mjs'), 'queue', 'C1-app', '-', '--from', 'C0-chief', ...extra], { cwd: dir, input: msg(), encoding: 'utf8' });
  assert.equal(send().status, 0);
  assert.equal(send().status, 0);
  const third = send();
  assert.equal(third.status, 3);
  assert.match(third.stderr, /未发送/);
  assert.equal(fs.readdirSync(path.join(runs, 'inbox')).length, 2, 'the refused nudge never reaches the inbox');
  assert.notEqual(send('--force-repeat').status, 0, '--force-repeat without --reason is rejected');
  assert.equal(send('--force-repeat', '--reason', 'X7 换了新的失败原因：logs/HEAD 属主').status, 0);
  const log = fs.readFileSync(path.join(runs, 'nudge-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.filter((l) => l.blocked).length, 1);
  assert.equal(log.at(-1).forced, 'X7 换了新的失败原因：logs/HEAD 属主');
});
