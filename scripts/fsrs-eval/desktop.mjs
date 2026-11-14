/** Launch the real Electron desktop against a new or previously created local V7 trial profile. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPreload } from '../../electron/scripts/build-preload.mjs';

const repo = resolve(import.meta.dirname, '../..');
const temp = realpathSync(tmpdir());
const args = process.argv.slice(2);
const smoke = args[0] === '--smoke';
const [flag, value, ...extra] = smoke ? args.slice(1) : args;
assert.ok(!extra.length && (flag === undefined || (flag === '--resume' && value)),
  'Usage: node scripts/fsrs-eval/desktop.mjs [--resume <trial directory>] [--smoke (new library only)]');
assert.ok(!smoke || !value, 'The desktop smoke run requires a new trial library');
const root = value ? realpathSync(value) : mkdtempSync(join(temp, 'dstu-fsrs7-desktop-'));
assert.ok(dirname(root) === temp && basename(root).startsWith('dstu-fsrs7-desktop-'));
const data = join(root, 'data');
const chromium = join(root, 'chromium');
const profilePath = join(root, 'profile.json');
const profile = { extends: 'official', plugins: [
  { id: 'dstu.review', module: join(repo, 'host/plugins/review/trial-desktop.ts') },
] };
if (!value) {
  mkdirSync(data);
  mkdirSync(chromium);
  writeFileSync(profilePath, JSON.stringify(profile), { flag: 'wx' });
} else {
  assert.deepEqual(JSON.parse(readFileSync(profilePath, 'utf8')), profile);
  for (const path of [data, chromium, profilePath]) assert.equal(realpathSync(path), path);
  if (existsSync(`${data}.os`)) assert.equal(realpathSync(`${data}.os`), `${data}.os`);
}

// Keep Chromium's local storage on the same origin across resumes.
const portPath = join(root, 'frontend-port');
let port;
if (existsSync(portPath)) {
  assert.equal(realpathSync(portPath), portPath);
  port = Number(readFileSync(portPath, 'utf8'));
  assert.ok(Number.isInteger(port) && port > 1023 && port < 65536);
} else {
  const net = createServer();
  net.listen(0, '127.0.0.1');
  await once(net, 'listening');
  port = net.address().port;
  await new Promise((done, fail) => net.close(error => error ? fail(error) : done()));
  writeFileSync(portPath, String(port), { flag: 'wx' });
}
const url = `http://127.0.0.1:${port}`;
// Use the Node CI development build number when this checkout lacks the old Android history.
const env = { ...process.env, DEEP_STUDENT_BUILD_NUMBER: process.env.DEEP_STUDENT_BUILD_NUMBER ?? '20000',
  DS_APP_DATA_DIR: data, DS_ELECTRON_USER_DATA: chromium, DS_HOST_PROFILE: profilePath, DS_ELECTRON_DEV_URL: url };
for (const key of ['ELECTRON_RUN_AS_NODE', 'DS_HOST_ENTRY', 'DS_SAFE_MODE', 'DS_MIGRATIONS_DIR',
  'DS_ELECTRON_FRONTEND_DIST', 'DS_CAPABILITIES_DIR', 'DS_ELECTRON_CAPTURE']) delete env[key];
const require = createRequire(import.meta.url);
const electron = require('electron');
execFileSync(process.execPath, [join(repo, 'scripts/generate-version.mjs')], { cwd: repo, env, stdio: 'inherit' });
await buildPreload();
console.log(`FSRS-7 trial: ${root}`);
console.log(`Resume: node scripts/fsrs-eval/desktop.mjs --resume '${root}'`);
const vite = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: repo, env, stdio: 'inherit' });
let shell;
const stop = () => { shell?.kill(); vite.kill(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (vite.exitCode !== null || vite.signalCode !== null || Date.now() >= deadline) throw new Error('Isolated frontend failed to start');
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
    if (response?.ok) break;
    await delay(250);
  }
  shell = spawn(electron, [join(repo, 'electron/main.ts'), ...(smoke ? ['--remote-debugging-port=0'] : [])],
    { cwd: repo, env, stdio: ['inherit', 'inherit', smoke ? 'pipe' : 'inherit'] });
  const exited = once(shell, 'exit');
  if (smoke) {
    try {
      const { smokeDesktop } = await import('./desktop-smoke.mjs');
      await smokeDesktop(shell, root, data);
    } finally {
      shell.kill();
      await exited;
    }
  }
  const [status] = await exited;
  process.exitCode = status ?? 0;
} finally {
  stop();
}
