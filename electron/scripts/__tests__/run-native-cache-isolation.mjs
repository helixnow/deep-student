#!/usr/bin/env node
/** Existing caller-owned cache + portable input: read-only verification.
 * --app <mac .app> --cache <existing cache directory>
 * Leaves all run evidence and caller files in place, including on failure.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { prepareApp, isolatedEnv, workBase } from '../packaged-app.mjs';
import { snapshotCacheInput, sameCacheInput } from '../cache-input-snapshot.mjs';
import { auditLaunchEnvironment } from '../launch-env-audit.mjs';
import { MAC_NATIVE_CACHE_ENV } from '../../shell/launch-env.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('timed out waiting for the isolated packaged app');
}

async function main() {
  if (process.platform !== 'darwin' || !args.includes('--app') || !args.includes('--cache')) {
    throw new Error('macOS required: --app <bundle> --cache <existing directory>');
  }
  const cache = resolve(opt('--cache'));
  const before = snapshotCacheInput(cache); // Does not create or modify it.
  const { appPath, executable } = prepareApp(resolve(opt('--app')));
  const root = mkdtempSync(join(workBase(), 'existing-cache-'));
  const capture = join(root, 'capture-canary.png');
  const child = spawn(executable, ['--remote-debugging-port=0'], { cwd: root,
    env: isolatedEnv(root, { NODE_COMPILE_CACHE: cache, NODE_COMPILE_CACHE_PORTABLE: '1', DS_ELECTRON_CAPTURE: capture }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  child.on('exit', () => { exited = true; });
  let browser;
  const results = [];
  const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  try {
    const endpoint = await waitFor(() => {
      if (exited) throw new Error(`app exited before DevTools: ${stderr.slice(-1000)}`);
      return /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1];
    });
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitFor(async () => {
      for (const context of browser.contexts()) for (const page of context.pages()) {
        if (await page.evaluate(() => Boolean(globalThis.__TAURI_INTERNALS__)).catch(() => false)) return page;
      }
      return null;
    });
    const status = await page.evaluate(async () => {
      let timer;
      try {
        return await Promise.race([globalThis.__TAURI_INTERNALS__.invoke('plugin:host|status', {}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host readiness timeout')), 60_000); })]);
      } finally { clearTimeout(timer); }
    });
    check('bundled frontend and normal Host ready', page.url().startsWith('tauri://localhost/') && Array.isArray(status) && status.length === 0);
    check('Host still uses userData compile cache', existsSync(join(root, 'userdata', 'host-compile-cache')));
    const audit = auditLaunchEnvironment(stdout, child.pid, MAC_NATIVE_CACHE_ENV, ['DS_ELECTRON_CAPTURE']);
    check('both native cache inputs and JS capture input deleted, with exact PID audit', audit.ok && !existsSync(capture));
  } finally {
    await browser?.close().catch(() => undefined);
    if (!exited) {
      child.kill('SIGTERM');
      await waitFor(() => exited, 20_000).catch(() => child.kill('SIGKILL'));
      await waitFor(() => exited, 5_000);
    }
    // Also check shutdown-time cache flushes. No cleanup of caller input/root.
    check('existing external cache preserved byte-for-byte with no file/tree/metadata changes', sameCacheInput(before, snapshotCacheInput(cache)));
    writeFileSync(join(root, 'stdout.log'), stdout);
    writeFileSync(join(root, 'stderr.log'), stderr);
    writeFileSync(join(root, 'report.json'), JSON.stringify({ appPath, pid: child.pid, cache, portable: '1', entries: before.size, results }, null, 2) + '\n');
    console.log(`artifacts: ${root}`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
