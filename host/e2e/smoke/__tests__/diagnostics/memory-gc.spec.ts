/**
 * Forced-GC memory phase (W01 handoff: evidence for or against shrinking the Host heap after HostReady).
 * Same protocol as ⑨ — cold start on an empty data root, warm restarts on the same root, sample 3s after the
 * desktop is ready and again after opening chat, notes and settings — plus, at both points, a full GC in
 * every process and two more samples (2s and 10s after the GC).
 *
 * - Host: `--inspect` from its first fork (`W12_HOST_INSPECT_PORT`, see `__fixtures__/window-main.mjs`), so
 *   cold and warm are the original Host, not a supervisor restart; GC via CDP `HeapProfiler.collectGarbage`,
 *   plus `process.memoryUsage()` before and after.
 * - Renderer: CDP `HeapProfiler.collectGarbage` over Playwright's CDP session.
 * - Main: `--js-flags=--expose-gc`, `gc()`.
 *
 * Working sets come from `app.getAppMetrics()` exactly as in ⑨; the "before" sample is taken before the
 * inspector is attached. Variants: default; compile cache off (`NODE_DISABLE_COMPILE_CACHE=1`) to tell
 * reclaimable JS heap from the compile cache's native memory; and a control that stays idle 60s before the
 * forced GC, to see whether V8 gives the memory back by itself.
 *
 *   bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts memory-gc
 *   W12_GC_VARIANTS=default-idle60 bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts memory-gc
 *
 * Output: test-results/w12-heap/memory-gc.json.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from '../support/app.ts';
import { freePort, inspector, memoryUsageMB, type Inspector } from '../support/inspector.ts';
import { AGREEMENT_BUTTON, dismissWelcome, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const OUT = join(repoRoot, 'test-results/w12-heap');
const HOST = 'Deep Student Host';
const GROUPS = ['main', 'renderer', 'host', 'gpu'] as const;
type Group = typeof GROUPS[number];
type Working = Record<Group, number>;

interface Point {
  before: Working;
  /** Variants with `settleMs`: idle for that long without a forced GC (does V8 shrink the heap by itself?). */
  settled?: Working;
  gc2s: Working;
  gc10s: Working;
  hostUsageBefore: Record<string, number>;
  hostUsageAfter: Record<string, number>;
}
interface Sample {
  variant: string;
  kind: 'cold' | 'warm';
  idle: Point;
  afterApps: Point | null;
  mainGc: boolean;
  /** First cold run of each variant (no after-apps phase): node_modules packages loaded in the Host (source KB). */
  idlePackagesKB?: Record<string, number>;
}

/** Packages whose scripts the Host has parsed so far (CDP replays `Debugger.scriptParsed` on enable). */
async function loadedPackages(cdp: Inspector): Promise<Record<string, number>> {
  const sizes = new Map<string, number>();
  cdp.on((method, params) => {
    if (method !== 'Debugger.scriptParsed') return;
    const url = String(params.url ?? '');
    const at = url.lastIndexOf('/node_modules/');
    if (at < 0) return;
    const parts = url.slice(at + '/node_modules/'.length).split('/');
    const name = parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
    sizes.set(name, (sizes.get(name) ?? 0) + Number(params.length ?? 0));
  });
  await cdp.send('Debugger.enable');
  await new Promise((r) => setTimeout(r, 1_000));
  await cdp.send('Debugger.disable');
  return Object.fromEntries([...sizes].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / 1024)]));
}

async function working(app: LaunchedApp): Promise<Working> {
  const metrics = await app.app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
    .map((m) => ({ type: m.type, name: m.name ?? m.serviceName ?? '', ws: m.memory.workingSetSize })));
  const sum = (pred: (m: typeof metrics[number]) => boolean) => Math.round(metrics.filter(pred).reduce((n, m) => n + m.ws, 0) / 1024);
  return {
    main: sum((m) => m.type === 'Browser'),
    renderer: sum((m) => m.type === 'Tab'),
    host: sum((m) => m.type === 'Utility' && m.name === HOST),
    gpu: sum((m) => m.type === 'GPU'),
  };
}

async function collectGarbage(app: LaunchedApp, host: Inspector): Promise<boolean> {
  const renderer = await app.app.context().newCDPSession(app.page);
  try {
    let mainGc = false;
    for (let i = 0; i < 2; i++) {
      const [, , main] = await Promise.all([
        host.send('HeapProfiler.collectGarbage'),
        renderer.send('HeapProfiler.collectGarbage'),
        app.app.evaluate(() => {
          const gc = (globalThis as { gc?: () => void }).gc;
          if (typeof gc !== 'function') return false;
          gc();
          return true;
        }),
      ]);
      mainGc = main;
      await app.page.waitForTimeout(250);
    }
    return mainGc;
  } finally {
    await renderer.detach();
  }
}

async function point(app: LaunchedApp, host: Inspector | null, port: number, settleMs = 0): Promise<{ point: Point; host: Inspector; mainGc: boolean }> {
  const before = await working(app);
  let settled: Working | undefined;
  if (settleMs > 0) {
    await app.page.waitForTimeout(settleMs);
    settled = await working(app);
  }
  const cdp = host ?? await inspector(port);
  const hostUsageBefore = await memoryUsageMB(cdp);
  const mainGc = await collectGarbage(app, cdp);
  await app.page.waitForTimeout(2_000);
  const gc2s = await working(app);
  await app.page.waitForTimeout(8_000);
  const gc10s = await working(app);
  return { point: { before, ...(settled ? { settled } : {}), gc2s, gc10s, hostUsageBefore, hostUsageAfter: await memoryUsageMB(cdp) }, host: cdp, mainGc };
}

async function measure(variant: string, env: Record<string, string>, kind: 'cold' | 'warm', root: string | undefined, withApps: boolean,
  listPackages = false, settleMs = 0): Promise<{ sample: Sample; root: string }> {
  const port = await freePort();
  const app = await launchApp({
    ...(root === undefined ? { label: `gc-${variant}` } : { root }),
    env: { ...env, W12_HOST_INSPECT_PORT: String(port) },
    electronArgs: ['--js-flags=--expose-gc'],
  });
  let host: Inspector | null = null;
  try {
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    if (kind === 'cold') await app.page.getByRole('button', { name: AGREEMENT_BUTTON }).click({ timeout: 60_000 });
    await expect(app.page.getByTestId('wb-dock')).toBeVisible({ timeout: 60_000 });
    if (kind === 'cold') await dismissWelcome(app.page);
    await app.page.waitForTimeout(3_000);
    const idle = await point(app, null, port, settleMs);
    host = idle.host;
    const idlePackagesKB = listPackages ? await loadedPackages(host) : undefined;
    let afterApps: Point | null = null;
    if (withApps) {
      for (const id of ['chat', 'notes', 'settings']) {
        await openDockApp(app.page, id);
        await app.page.waitForTimeout(1_500);
      }
      await app.page.waitForTimeout(2_000);
      afterApps = (await point(app, host, port)).point;
    }
    return { root: app.root, sample: { variant, kind, idle: idle.point, afterApps, mainGc: idle.mainGc, ...(idlePackagesKB ? { idlePackagesKB } : {}) } };
  } finally {
    host?.close();
    await app.close();
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!;
};

function summarize(rows: Sample[]) {
  const pick = (get: (s: Sample) => Point | null) => {
    const points = rows.map(get).filter((p): p is Point => p !== null);
    if (points.length === 0) return null;
    const stage = (key: 'before' | 'settled' | 'gc2s' | 'gc10s') => points.every((p) => p[key] !== undefined)
      ? Object.fromEntries(GROUPS.map((g) => [g, median(points.map((p) => p[key]![g]))])) : undefined;
    const usage = (key: 'hostUsageBefore' | 'hostUsageAfter') => Object.fromEntries(Object.keys(points[0]![key]).map((k) => [k, median(points.map((p) => p[key][k]!))]));
    return { runs: points.length, before: stage('before'), settled: stage('settled'), gc2s: stage('gc2s'), gc10s: stage('gc10s'),
      hostUsageBefore: usage('hostUsageBefore'), hostUsageAfter: usage('hostUsageAfter') };
  };
  return { idle: pick((s) => s.idle), afterApps: pick((s) => s.afterApps) };
}

interface Variant { name: string; env: Record<string, string>; cold: number; warm: number; apps: boolean; settleMs: number }
const ALL_VARIANTS: Variant[] = [
  { name: 'default', env: {}, cold: 3, warm: 3, apps: true, settleMs: 0 },
  { name: 'no-compile-cache', env: { NODE_DISABLE_COMPILE_CACHE: '1' }, cold: 2, warm: 2, apps: true, settleMs: 0 },
  { name: 'default-idle60', env: {}, cold: 2, warm: 2, apps: false, settleMs: 60_000 },
];
/** `W12_GC_VARIANTS=default-idle60` (comma list) runs a subset. */
const VARIANTS = ALL_VARIANTS.filter((v) => !process.env.W12_GC_VARIANTS || process.env.W12_GC_VARIANTS.split(',').includes(v.name));

test('memory before and after a forced GC: cold and warm start', async () => {
  test.setTimeout(40 * 60_000);
  const samples: Sample[] = [];
  for (const v of VARIANTS) {
    let root = '';
    for (let i = 0; i < v.cold; i++) {
      const run = await measure(v.name, v.env, 'cold', undefined, v.apps && i === v.cold - 1, i === 0 && v.settleMs === 0, v.settleMs);
      samples.push(run.sample);
      root = run.root;
    }
    for (let i = 0; i < v.warm; i++) samples.push((await measure(v.name, v.env, 'warm', root, v.apps && i === v.warm - 1, false, v.settleMs)).sample);
  }
  const report = Object.fromEntries(VARIANTS.map((v) => [v.name, {
    cold: summarize(samples.filter((s) => s.variant === v.name && s.kind === 'cold')),
    warm: summarize(samples.filter((s) => s.variant === v.name && s.kind === 'warm')),
  }]));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'memory-gc.json'), `${JSON.stringify({ report, samples }, null, 1)}\n`);
  for (const [name, r] of Object.entries(report)) test.info().annotations.push({ type: `memory-gc-${name}`, description: JSON.stringify(r) });

  expect(samples.every((s) => s.mainGc), 'main process gc() exposed by --js-flags=--expose-gc').toBe(true);
  expect(samples.every((s) => s.idle.before.host > 0 && s.idle.gc10s.host > 0), 'Host utility process present in metrics').toBe(true);
  expect(samples.every((s) => (s.idle.hostUsageBefore.heapUsed ?? 0) > 0), 'Host inspector answered process.memoryUsage()').toBe(true);
});
