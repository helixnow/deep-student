// HISTORICAL RECORD of the 2026-11-06 ser38 one-off deployment. DO NOT RERUN.
// As root it imported repo modules, ran git and copied files from dsdev-writable paths into /etc/systemd and
// /usr/local/sbin; under the W11 threat model every one of those is a root code-execution path for lane agents.
// Current deployment: ops/oc-orchestrator/README.md (export reviewed blobs with git show, verify sha256, install).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

console.error('deploy-night.mjs is a historical record and refuses to run; see ops/oc-orchestrator/README.md');
process.exit(2);
const lease = await import('/home/dsdev/dev/deep-student/scripts/electron-migration/lib/integrate-lease.mjs');

const ROOT = '/home/dsdev/dev/deep-student';
const WT = '/home/dsdev/dev/ds-mig/_night-maintenance';
const OPS = '/home/dsdev/ops-night';
const RUNS = path.join(ROOT, '.oc-runs');
const JOBS = '/home/dsdev/.oc-jobs';
// git run as root rewrites ORIG_HEAD / packed-refs / index / logs/HEAD as root-owned, and every dsdev lane
// commit fails afterwards (X7, 2026-11-07). Always run git as the repository owner.
const asOwner = process.getuid?.() === 0 ? ['runuser', '-u', 'dsdev', '--', 'git'] : ['git'];
const git = (cwd, ...args) => execFileSync(asOwner[0], [...asOwner.slice(1), '-c', 'user.name=maintenance-ser38', '-c', 'user.email=maintenance@local', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const log = message => { console.log(`${new Date().toISOString()} ${message}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const systemctl = (...args) => execFileSync('systemctl', args, { encoding: 'utf8', timeout: 60_000 });
const report = { startedAt: new Date().toISOString(), phases: [] };
const save = phase => {
  report.phases.push({ phase, at: new Date().toISOString() });
  fs.writeFileSync(path.join(OPS, 'deployment.json'), JSON.stringify(report, null, 2));
  log(phase);
};

// Existing detached integrations finish naturally; no lease theft and no process kill.
let locked = false;
const deadline = Date.now() + 60 * 60_000;
while (!locked && Date.now() < deadline) {
  const result = lease.acquire(RUNS, { owner: 'maintenance-ser38', reason: 'validated night pipeline deployment', probe: lease.defaultProbe(ROOT) });
  locked = result.ok;
  if (!locked) await sleep(5000);
}
if (!locked) throw new Error('Live integration did not release within one hour; no deployment performed');
try {
  if (git(WT, 'status', '--porcelain')) throw new Error('Maintenance branch has uncommitted changes');
  const wip = git(ROOT, 'status', '--porcelain', '--untracked-files=no');
  const file = 'scripts/electron-migration/jobs/runner.mjs';
  if (wip && wip !== `M ${file}` && wip !== ` M ${file}`) throw new Error('Unexpected main WIP: ' + wip);
  if (git(ROOT, 'diff', '--cached', '--name-only')) throw new Error('Unknown staged work on main');
  const prior = execFileSync('git', ['-C', ROOT, 'show', `f7301a763:${file}`]);
  if (wip) {
    const actual = fs.readFileSync(path.join(ROOT, file));
    if (!actual.equals(prior)) throw new Error('Runner WIP changed since approved preserved commit; refusing overwrite');
    fs.writeFileSync(path.join(OPS, 'initial', 'runner-adopted.mjs'), actual);
    // Exact content has already been committed on our branch, not discarded.
    fs.writeFileSync(path.join(ROOT, file), execFileSync('git', ['-C', ROOT, 'show', `HEAD:${file}`]));
  }
  report.mainBefore = git(ROOT, 'rev-parse', 'main');
  git(WT, 'merge', '--no-edit', 'main');
  git(ROOT, 'merge', '--ff-only', 'ops/night-stability');
  report.mainAfter = git(ROOT, 'rev-parse', 'main');
  save('validated code merged');
} finally {
  lease.release(RUNS);
}

fs.writeFileSync(path.join(OPS, 'draining'), 'Waiting for existing job queue to finish; no task interrupted');
save('waiting for jobs to drain');
while (Date.now() < deadline) {
  const count = dir => fs.readdirSync(path.join(JOBS, dir)).filter(f => f.endsWith('.json')).length;
  if (count('running') === 0 && count('queue') === 0) break;
  await sleep(2000);
}
if (fs.readdirSync(path.join(JOBS, 'running')).some(f => f.endsWith('.json')) || fs.readdirSync(path.join(JOBS, 'queue')).some(f => f.endsWith('.json'))) {
  throw new Error('Jobs did not drain; code merged but services not restarted. Resume supervised deployment explicitly.');
}

for (const [name, target] of [
  ['ds-migration-night.conf', '/etc/systemd/system/ds-migration.service.d/z-night.conf'],
  ['ds-jobs-night.conf', '/etc/systemd/system/ds-jobs.service.d/z-night.conf'],
  ['dsdev-night.conf', '/etc/systemd/system/dsdev.slice.d/z-night.conf'],
  ['ds-night-guard.service', '/etc/systemd/system/ds-night-guard.service'],
  ['ds-night-guard.timer', '/etc/systemd/system/ds-night-guard.timer'],
]) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(OPS, 'systemd', name), target);
}
fs.copyFileSync(path.join(OPS, 'night-guard.py'), '/usr/local/sbin/ds-night-guard.py');
systemctl('daemon-reload');
systemctl('set-property', '--runtime', 'dsdev.slice', 'CPUQuota=2800%', 'MemoryHigh=44G', 'MemoryMax=52G', 'MemorySwapMax=8G', 'TasksMax=1800');
systemctl('restart', 'ds-jobs.service');
fs.unlinkSync(path.join(OPS, 'draining'));

// Retain queues, sessions, models and live lane PIDs. Only reset old recovery
// counters so failures from deleted suppliers do not impose a stale cooldown.
const sessionFile = path.join(RUNS, 'sessions.json');
const sessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
fs.copyFileSync(sessionFile, path.join(OPS, 'initial', 'sessions-before-systemd.json'));
for (const [lane, s] of Object.entries(sessions)) {
  if (lane.startsWith('__')) continue;
  s.providerStreak = 0;
  delete s.failedRun;
  delete s.providerNextTryAt;
}
fs.writeFileSync(`${sessionFile}.tmp`, JSON.stringify(sessions, null, 2));
fs.chownSync(`${sessionFile}.tmp`, 1000, 1000);
fs.renameSync(`${sessionFile}.tmp`, sessionFile);
systemctl('start', 'ds-migration.service');
systemctl('restart', 'ds-dashboard.service');
systemctl('enable', '--now', 'ds-night-guard.timer', 'ds-fulltest.timer');
save('systemd services restored with resource limits');
systemctl('start', '--no-block', 'ds-fulltest.service');
save('unique immutable-source fulltest requested');
