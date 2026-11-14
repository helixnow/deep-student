#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const worker = fileURLToPath(new URL('./worker.ts', import.meta.url));
const tempBase = join(tmpdir(), 'opencode');
mkdirSync(tempBase, { recursive: true });
const root = mkdtempSync(join(tempBase, 'x1-smoke-'));
const start = Date.now();
const results = [];
const requested = process.env.DS_SMOKE_RUNTIME ?? 'both';
if (!['both', 'node', 'electron'].includes(requested)) throw new Error('DS_SMOKE_RUNTIME must be both, node or electron');
for (const runtime of requested === 'both' ? ['node', 'electron'] : [requested]) {
  const dir = join(root, runtime);
  for (const name of ['', 'home', 'tmp', 'data', 'config', 'cache', 'local']) mkdirSync(join(dir, name), { recursive: true });
  const env = { ...process.env, DS_SMOKE_ROOT: dir, HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'),
    TMPDIR: join(dir, 'tmp'), TMP: join(dir, 'tmp'), TEMP: join(dir, 'tmp'),
    XDG_DATA_HOME: join(dir, 'local'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'),
    APPDATA: join(dir, 'config'), LOCALAPPDATA: join(dir, 'local'), DS_APP_DATA_DIR: join(dir, 'data'),
    DS_ELECTRON_USER_DATA: join(dir, 'electron-user'), DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1' };
  delete env.NODE_OPTIONS;
  if (runtime === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  // boundary-allow native-import: Test-only launcher selects the installed Electron executable; never imported by a production plugin or Host entry.
  const executable = runtime === 'electron' ? require('electron') : 'node';
  const outcome = await new Promise(resolve => {
    const child = spawn(executable, [worker], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = error.message; });
    const budget = Math.max(1, Math.min(85000, 175000 - (Date.now() - start)));
    const timer = setTimeout(() => child.kill('SIGKILL'), budget);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(dir, 'stdout.log'), stdout);
      writeFileSync(join(dir, 'stderr.log'), stderr);
      resolve({ code, signal, spawnError });
    });
  });
  let result;
  try { result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); }
  catch { result = { runtime, startup: { issues: [] }, probes: [] }; }
  result.process = outcome;
  result.artifacts = dir;
  let inflight = '';
  if (outcome.signal) {
    try {
      const current = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'));
      inflight = `; last started probe #${current.index}/${result.selected ?? '?'} ${current.command} (${current.lane}) at ${current.elapsedMs}ms`;
    } catch { inflight = '; no probe had started'; }
  }
  if (outcome.signal || outcome.spawnError) result.startup.issues.push({ lane: 'X1-e2e-smoke', reason: outcome.spawnError ?? `worker terminated: ${outcome.signal} (runtime budget exceeded)${inflight}` });
  result.counts = { total: result.probes.length, success: 0, 'business-error': 0, crash: 0, 'environment-blocked': 0 };
  for (const probe of result.probes) result.counts[probe.outcome]++;
  result.passed = outcome.code === 0 && result.startup.expected > 0 && result.startup.installed?.length === result.startup.expected && result.probes.length === result.selected;
  results.push(result);
  console.log(`${runtime} (${result.mode ?? 'unknown'}): startup ${result.startup.installed?.length ?? 0}/${result.startup.expected ?? 0}; probes ${JSON.stringify(result.counts)}; ${result.passed ? 'PASS' : 'FAIL'}`);
  const shard = result.shard ? ` shard ${result.shard.index}/${result.shard.count} [${result.shard.from}, ${result.shard.to}) of ${result.shard.of}` : '';
  console.log(`  ${runtime} reached ${result.probes.length}/${result.selected ?? '?'} selected commands${shard}; code ${outcome.code} signal ${outcome.signal ?? 'none'}; ${result.durationMs ?? '?'}ms`);
  for (const issue of result.startup.issues) console.log(`  ${runtime} startup issue [${issue.lane}]: ${String(issue.reason).split('\n')[0]}`);
}
const summary = { durationMs: Date.now() - start, results };
writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = ['# X1 whole-host smoke', '', `Duration: ${summary.durationMs}ms`, '', '| Runtime | Lane | Kind | Plugin / command | Minimal args / reason |', '|---|---|---|---|---|'];
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
for (const result of results) {
  const rows = [];
  for (const issue of result.startup.issues ?? []) rows.push([issue.lane, 'startup', '', issue.reason]);
  for (const issue of result.startup.degraded ?? []) rows.push([issue.lane, 'degraded', issue.id, issue.reason]);
  for (const issue of result.startup.missingProvides ?? []) rows.push([issue.lane, 'missing provides', issue.plugin, issue.service]);
  for (const probe of result.probes.filter(p => p.outcome === 'crash')) rows.push([probe.lane, probe.category ?? 'crash', probe.command, `${JSON.stringify(probe.args)} — ${probe.reason?.split('\n').slice(0, 2).join(' ')}${probe.shellRequests?.length ? ' [shell unavailable]' : ''}`]);
  for (const probe of result.probes.filter(p => p.outcome === 'environment-blocked')) rows.push([probe.lane, 'environment-blocked', probe.command, `${JSON.stringify(probe.args)} — headless worker has no Electron shell for ${probe.ops.join(', ')}; not counted as crash (C2 conditional approval). Original: ${probe.reason?.split('\n').slice(0, 2).join(' ')}`]);
  for (const issue of result.uncaught ?? []) rows.push(['unattributed (see stderr)', 'uncaught', issue.command, issue.error]);
  for (const row of rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))) lines.push(`| ${[result.runtime, ...row].map(cell).join(' | ')} |`);
}
writeFileSync(join(root, 'issues.md'), lines.join('\n') + '\n');
console.log(`Artifacts: ${root}/summary.json; ${root}/issues.md`);
process.exitCode = results.every(result => result.passed) ? 0 : 1;
