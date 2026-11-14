/**
 * Host memory diagnostics (not part of the golden suite). Electron does not pass `NODE_OPTIONS` to the
 * Host utility process, so the test patches `utilityProcess.fork` in the main process to add `--inspect`,
 * kills the Host and lets the supervisor restart it (electron/shell/host.ts restarts up to 3 times a
 * minute). Over the inspector it reads `process.memoryUsage()` and takes a V8 heap snapshot, summarised by
 * `support/heap-summary.ts`. Phases: desktop idle, after opening chat/notes/settings, and idle with the
 * compile cache disabled. The restarted Host has the same plugins and data as the original; its numbers
 * describe composition, the cold/warm working sets come from ⑨.
 *
 *   bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts
 *
 * Output: test-results/w12-heap/host-heap.json (snapshots are deleted unless W12_KEEP_HEAP=1).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from '../support/app.ts';
import { summarizeHeap, type HeapSummary } from '../support/heap-summary.ts';
import { inspector } from '../support/inspector.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const OUT = join(repoRoot, 'test-results/w12-heap');
const HOST = 'Deep Student Host';
const MB = (bytes: number) => Math.round(bytes / 1024 / 1024);

interface Phase {
  label: string;
  /** null after a snapshot was already taken in this Host: generating one inflates RSS for good. */
  originalHostWorkingSetMB: number | null;
  restartedHostWorkingSetMB: number | null;
  memoryUsageMB: Record<string, number>;
  heap: HeapSummary;
}

async function hostMetrics(app: LaunchedApp): Promise<{ pid: number; workingSetMB: number } | null> {
  const metrics = await app.app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
    .map((m) => ({ pid: m.pid, name: m.name ?? m.serviceName ?? '', ws: m.memory.workingSetSize })));
  const host = metrics.find((m) => m.name === HOST);
  return host === undefined ? null : { pid: host.pid, workingSetMB: Math.round(host.ws / 1024) };
}

async function restartHostWithInspector(app: LaunchedApp, port: number): Promise<void> {
  await app.app.evaluate(({ utilityProcess }, inspectPort) => {
    const u = utilityProcess as unknown as { fork: (...a: unknown[]) => unknown; __w12Fork?: (...a: unknown[]) => unknown };
    u.__w12Fork ??= u.fork.bind(u);
    u.fork = (...a: unknown[]) => {
      const options = (a[2] ?? {}) as { execArgv?: string[] };
      return u.__w12Fork!(a[0], a[1], { ...options, execArgv: [...(options.execArgv ?? []), `--inspect=127.0.0.1:${inspectPort}`] });
    };
  }, port);
  const old = (await hostMetrics(app))!.pid;
  process.kill(old, 'SIGKILL');
  await expect.poll(async () => (await hostMetrics(app))?.pid ?? old, { timeout: 60_000, message: 'Host was not restarted' }).not.toBe(old);
  await app.call('plugin:host|status', {}, 90_000);
}

async function measure(app: LaunchedApp, dir: string, label: string, port: number): Promise<Phase> {
  await app.page.waitForTimeout(5_000);
  const original = (await hostMetrics(app))!.workingSetMB;
  await restartHostWithInspector(app, port);
  await app.page.waitForTimeout(8_000);
  const restarted = (await hostMetrics(app))!.workingSetMB;
  const cdp = await inspector(port);
  try {
    const usage = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true }) as { result: { value: string } };
    const memoryUsageMB = Object.fromEntries(Object.entries(JSON.parse(usage.result.value) as Record<string, number>).map(([k, v]) => [k, MB(v)]));
    const chunks: string[] = [];
    cdp.on((method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(String(params.chunk)); });
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    const file = join(dir, `${label}.heapsnapshot`);
    writeFileSync(file, chunks.join(''));
    const heap = summarizeHeap(file, 30);
    if (process.env.W12_KEEP_HEAP !== '1') rmSync(file);
    return { label, originalHostWorkingSetMB: original, restartedHostWorkingSetMB: restarted, memoryUsageMB, heap };
  } finally {
    cdp.close();
  }
}

test('Host memory: working set and heap composition', async () => {
  test.setTimeout(20 * 60_000);
  rmSync(OUT, { recursive: true, force: true });
  const dir = join(OUT, 'snapshots');
  mkdirSync(dir, { recursive: true });
  const phases: Phase[] = [];

  let app = await launchApp({ label: 'heap' });
  try {
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    phases.push(await measure(app, dir, 'idle', 9341));
    for (const id of ['chat', 'notes', 'settings']) {
      await openDockApp(app.page, id);
      await app.page.waitForTimeout(1_500);
    }
    await app.page.waitForTimeout(3_000);
    const cdp = await inspector(9341);
    try {
      const chunks: string[] = [];
      cdp.on((method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(String(params.chunk)); });
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      const file = join(dir, 'after-apps.heapsnapshot');
      writeFileSync(file, chunks.join(''));
      const usage = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true }) as { result: { value: string } };
      phases.push({ label: 'after-apps', originalHostWorkingSetMB: null, restartedHostWorkingSetMB: null,
        memoryUsageMB: Object.fromEntries(Object.entries(JSON.parse(usage.result.value) as Record<string, number>).map(([k, v]) => [k, MB(v)])),
        heap: summarizeHeap(file, 30) });
      if (process.env.W12_KEEP_HEAP !== '1') rmSync(file);
    } finally {
      cdp.close();
    }
  } finally {
    await app.close();
  }

  app = await launchApp({ label: 'heap-nocache', env: { NODE_DISABLE_COMPILE_CACHE: '1' } });
  try {
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(app.page);
    phases.push(await measure(app, dir, 'idle-no-compile-cache', 9342));
  } finally {
    await app.close();
  }

  writeFileSync(join(OUT, 'host-heap.json'), `${JSON.stringify(phases, null, 1)}\n`);
  test.info().annotations.push({ type: 'host-heap', description: phases.map((p) => `${p.label}: ws ${p.originalHostWorkingSetMB}/${p.restartedHostWorkingSetMB} MB, heap ${p.heap.totalMB} MB, usage ${JSON.stringify(p.memoryUsageMB)}`).join('; ') });
  expect(phases).toHaveLength(3);
});
