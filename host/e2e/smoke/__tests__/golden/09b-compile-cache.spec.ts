/**
 * Node compile cache in the real Electron Host (W01, `host/kernel/compile-cache.ts`): the Host enables
 * `module.enableCompileCache()` before loading the profile and flushes after HostReady. The cache lives in
 * `<os.tmpdir()>/node-compile-cache`, and every smoke data root has its own TMPDIR, so a cold start (fresh
 * root) begins with an empty cache and a warm restart on the same root reuses it.
 *
 * Each mode (cache disabled with `NODE_DISABLE_COMPILE_CACHE=1`, cache enabled = product default) runs
 * COLD_RUNS cold starts on fresh roots and WARM_RUNS restarts on the last one. Host ready is the wire time of
 * the Host `ready` message (ms since the main process started; fork-to-ready is reported beside it).
 * Timings are recorded, not gated; only the cache directory's presence is asserted.
 * Writes `compile-cache.json` next to the Playwright results.
 */
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot, type WireRow } from '../support/app.ts';
import { waitForBridge } from '../support/onboarding.ts';

const COLD_RUNS = 3;
const WARM_RUNS = 3;

interface Run { mode: 'disabled' | 'enabled'; kind: 'cold' | 'warm'; hostReadyMs: number; forkToReadyMs: number; cacheEntries: number }

function hostTimes(allRows: readonly WireRow[]): { hostReadyMs: number; forkToReadyMs: number } {
  const rows = allRows.slice(allRows.findLastIndex((r) => r.seq === 1));
  const spawn = rows.find((r) => r.kind === 'host-spawn');
  const ready = rows.find((r) => r.kind === 'host-in' && (r.message as { kind?: string } | undefined)?.kind === 'ready');
  expect(spawn && ready, 'host-spawn and Host ready in the wire trace').toBeTruthy();
  return { hostReadyMs: Math.round(ready!.time), forkToReadyMs: Math.round(ready!.time - spawn!.time) };
}

const cacheDir = (root: string) => join(root, 'tmp', 'node-compile-cache');
const countEntries = (dir: string): number => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countEntries(join(dir, e.name)) : 1), 0)
  : 0);

async function launch(mode: Run['mode'], kind: Run['kind'], root?: string): Promise<{ run: Run; root: string }> {
  const env: Record<string, string> = mode === 'disabled' ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {};
  const app = await launchApp(root === undefined ? { label: `cc-${mode}`, env } : { root, env });
  try {
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    // Let the post-ready flush land before the process is stopped.
    await app.page.waitForTimeout(1_500);
  } finally {
    await app.close();
  }
  return { root: app.root, run: { mode, kind, ...hostTimes(app.wire()), cacheEntries: countEntries(cacheDir(app.root)) } };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;

test('Host compile cache: Host ready with the cache disabled vs enabled, cold and warm', async () => {
  test.setTimeout(15 * 60_000);
  const runs: Run[] = [];
  for (const mode of ['disabled', 'enabled'] as const) {
    let root = '';
    for (let i = 0; i < COLD_RUNS; i++) {
      const cold = await launch(mode, 'cold');
      runs.push(cold.run);
      root = cold.root;
    }
    for (let i = 0; i < WARM_RUNS; i++) runs.push((await launch(mode, 'warm', root)).run);
  }

  const summary = Object.fromEntries((['disabled', 'enabled'] as const).flatMap((mode) => (['cold', 'warm'] as const).map((kind) => {
    const rows = runs.filter((r) => r.mode === mode && r.kind === kind);
    return [`${mode}-${kind}`, { runs: rows.length, hostReadyMs: median(rows.map((r) => r.hostReadyMs)), forkToReadyMs: median(rows.map((r) => r.forkToReadyMs)) }];
  })));
  const report = { summary, runs };
  const out = join(repoRoot, 'test-results', 'w12-desktop-smoke');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'compile-cache.json'), `${JSON.stringify(report, null, 2)}\n`);
  test.info().annotations.push({ type: 'compile-cache', description: JSON.stringify(summary) });

  expect(runs.filter((r) => r.mode === 'disabled').map((r) => r.cacheEntries), 'NODE_DISABLE_COMPILE_CACHE=1 writes no cache').toEqual(runs.filter((r) => r.mode === 'disabled').map(() => 0));
  expect(runs.filter((r) => r.mode === 'enabled').every((r) => r.cacheEntries > 0), 'the Host writes its compile cache under the root TMPDIR').toBe(true);
});
