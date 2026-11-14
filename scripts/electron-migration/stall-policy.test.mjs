import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decide, MAX_AUTO_RESTARTS, attributeBusy, restartItem, inboxExpired, actionEnv, unattributedDeferral, UNATTRIBUTED_CAP_MS } from './lib/stall-policy.mjs';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const MIN = 60_000;
const base = { autoRestartMs: 30 * MIN, nowMs: NOW, recentRestarts: [], forMs: 31 * MIN };

test('an executor stalled past the threshold is restarted once per episode', () => {
  assert.equal(decide({ ...base, forMs: 29 * MIN }).action, 'none');
  assert.equal(decide(base).action, 'restart');
  assert.equal(decide({ ...base, restartedThisEpisode: true }).action, 'none');
});

test('disabled by default, and never for coordinators, parked lanes or paused dispatch', () => {
  assert.equal(decide({ ...base, autoRestartMs: 0 }).action, 'none');
  assert.equal(decide({ ...base, coordinator: true }).action, 'none');
  assert.equal(decide({ ...base, parked: true }).action, 'none');
  assert.equal(decide({ ...base, dispatchPaused: true }).action, 'none');
});

test('after the per-lane cap the coordinator is told once instead of restarting forever', () => {
  const recent = Array.from({ length: MAX_AUTO_RESTARTS }, (_, i) => NOW - (i + 1) * 40 * MIN);
  assert.equal(decide({ ...base, recentRestarts: recent }).action, 'escalate');
  assert.equal(decide({ ...base, recentRestarts: recent, escalatedThisEpisode: true }).action, 'none');
  assert.equal(decide({ ...base, recentRestarts: recent.map((t) => t - 3 * 3_600_000) }).action, 'restart', 'old restarts fall out of the window');
});

test('the 18.3-hour R6 stall of 11-04 would have been restarted after 30 minutes', () => {
  assert.equal(decide({ ...base, forMs: 65_709_000 }).action, 'restart');
});

test('no restart during maintenance, a hold, or while the scheduler is stopped (nobody would deliver it)', () => {
  assert.equal(decide({ ...base, held: 'maintenance.json: deploy' }).action, 'none');
  assert.equal(decide({ ...base, schedulerDown: true }).action, 'none');
});

test('a tool process that cannot be attributed to a lane defers auto-restart', () => {
  assert.equal(decide({ ...base, unattributedBusy: 1 }).action, 'none');
});

test('attributeBusy: children of opencode serve are counted per worktree, the rest as unattributed', () => {
  const wts = ['/w/L02', '/w/X7'];
  const procs = [
    { pid: 10, ppid: 1, cwd: '/home/dsdev', cmd: 'opencode serve --port 4096' },
    { pid: 11, ppid: 10, cwd: '/w/L02/src', cmd: 'node vitest run' },
    // A long job that cd's into the main repo: looked "stalled" under cwd-only attribution.
    { pid: 12, ppid: 10, cwd: '/home/dsdev/dev/deep-student', cmd: 'bash -c cd ../deep-student && npm test' },
    { pid: 13, ppid: 12, cwd: '/home/dsdev/dev/deep-student', cmd: 'node vitest' },
    { pid: 14, ppid: 10, cwd: '/w/X7', cmd: 'git --git-dir /home/dsdev/.local/share/opencode/snapshot/x add .' },
    { pid: 15, ppid: 1, cwd: '/tmp', cmd: 'sleep 100' },
    { pid: 16, ppid: 1, cwd: '/w/X7', cmd: 'opencode run --session abc' },
  ];
  const r = attributeBusy({ procs, worktrees: wts });
  assert.equal(r.perWorktree.get('/w/L02'), 1);
  assert.equal(r.perWorktree.get('/w/X7'), 0, 'opencode clients and snapshot git are not tool work');
  assert.equal(r.unattributed, 2, 'serve descendants outside every lane worktree; unrelated processes are ignored');
});

test('restart mail expires: a restart queued while the scheduler was down is not delivered hours later', () => {
  const item = restartItem({ lane: 'L02', message: 'm' }, NOW);
  assert.equal(item.action, 'restart');
  assert.equal(inboxExpired(item, NOW + 5 * MIN), false);
  assert.equal(inboxExpired(item, NOW + 16 * MIN), true);
  assert.equal(inboxExpired({ lane: 'L02', action: 'queue', message: 'm' }, NOW + 1e9), false, 'items without expiresAt never expire');
});

test('stall-watch environment: maintenance marker, hold file and a stopped scheduler all suppress auto-restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-env-'));
  const runs = path.join(root, '.oc-runs');
  const opsDir = path.join(root, 'ops-night');
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(path.join(opsDir, 'hold'), { recursive: true });
  const watch = { platform: 'linux', readCmdline: () => Buffer.from('node\u0000/x/oc-dispatch.mjs\u0000watch') };
  const env = () => actionEnv({ runs, opsDir, nowMs: NOW, procOpts: watch });
  assert.equal(env().schedulerDown, true, 'no heartbeat at all: scheduler stopped');
  assert.equal(decide({ ...base, ...env() }).action, 'none');
  fs.writeFileSync(path.join(runs, 'scheduler-heartbeat.json'), JSON.stringify({ pid: process.pid, at: new Date(NOW - 60 * MIN).toISOString() }));
  assert.deepEqual(env(), { held: null, schedulerDown: false });
  assert.equal(decide({ ...base, ...env() }).action, 'restart');
  fs.writeFileSync(path.join(runs, 'maintenance.json'), '{"by":"deploy"}');
  assert.equal(decide({ ...base, ...env() }).action, 'none');
  fs.rmSync(path.join(runs, 'maintenance.json'));
  fs.writeFileSync(path.join(opsDir, 'hold', 'ds-stall-watch'), 'investigating');
  assert.match(decide({ ...base, ...env() }).why, /有意停住/);
});

test('attributeBusy: a job that cd\'d out of its worktree still counts for its lane via an ancestor, OLDPWD or its command line', () => {
  const wts = ['/w/L02', '/w/X7', '/w/R6'];
  const procs = [
    { pid: 10, ppid: 1, cwd: '/home/dsdev', cmd: 'opencode serve' },
    { pid: 20, ppid: 10, cwd: '/w/L02', cmd: 'bash -lc npm test' },
    { pid: 21, ppid: 20, cwd: '/home/dsdev/dev/deep-student', cmd: 'node vitest' },
    { pid: 30, ppid: 10, cwd: '/home/dsdev/dev/deep-student', cmd: 'bash -c npm test', oldpwd: '/w/X7' },
    { pid: 40, ppid: 10, cwd: '/home/dsdev/dev/deep-student', cmd: 'node scripts/x.mjs --out /w/R6/tmp/a' },
    { pid: 50, ppid: 10, cwd: '/home/dsdev/dev/deep-student', cmd: 'node vitest' },
  ];
  const r = attributeBusy({ procs, worktrees: wts });
  assert.equal(r.perWorktree.get('/w/L02'), 2);
  assert.equal(r.perWorktree.get('/w/X7'), 1);
  assert.equal(r.perWorktree.get('/w/R6'), 1);
  assert.deepEqual(r.unattributedProcs.map((p) => p.pid), [50]);
});

test('an unattributable tool process defers auto-restart for at most 30 minutes', () => {
  const procs = [{ pid: 50, cmd: 'node vitest', start: '123' }];
  let d = unattributedDeferral({ procs, seen: {}, nowMs: NOW });
  assert.equal(d.active, 1);
  d = unattributedDeferral({ procs, seen: d.seen, nowMs: NOW + 29 * MIN });
  assert.equal(d.active, 1);
  d = unattributedDeferral({ procs, seen: d.seen, nowMs: NOW + UNATTRIBUTED_CAP_MS + 1 });
  assert.equal(d.active, 0, 'after the cap the normal stall decision applies again');
  assert.equal(decide({ ...base, unattributedBusy: d.active }).action, 'restart');
  d = unattributedDeferral({ procs: [], seen: d.seen, nowMs: NOW + 40 * MIN });
  assert.deepEqual(d.seen, {}, 'exited processes are forgotten');
});
