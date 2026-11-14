/**
 * Performance baseline (recorded, not gated): cold start on an empty data root and warm restart on the same
 * root. Phase times come from the wire trace (`time` = ms since the main process started); first window and
 * desktop-ready are measured from `_electron.launch`. Memory is Electron's `app.getAppMetrics()` working set
 * per process (main = Browser, renderer = Tab, Host = the "Deep Student Host" utility process), sampled once
 * the desktop is idle, once more 60s after desktop-ready (last cold and last warm run only, nothing opened in
 * between) and again after opening chat, notes and settings. Cold starts report the agreement page
 * (first-run agreement button visible) and the dock (visible right after accepting) separately; desktop-ready
 * additionally includes dismissing the welcome/tour dialogs (with `dismissWelcome`'s 2.5s quiet wait).
 *
 * Writes `perf-baseline.json` next to the Playwright results; the numbers are copied into W12-PROGRESS.md.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp, type WireRow } from '../support/app.ts';
import { AGREEMENT_BUTTON, dismissWelcome, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const COLD_RUNS = 3;
const WARM_RUNS = 5;
const HOST_PROCESS_NAME = 'Deep Student Host';
const SETTLE_MS = 60_000;

interface ProcessMemory { type: string; name: string; workingSetMB: number; peakMB: number }
interface Sample {
  kind: 'cold' | 'warm';
  firstWindowMs: number;
  /** Cold only: the first-run agreement button is visible (renderer + Host up, first screen painted). */
  agreementPageMs: number | null;
  /** The dock is visible (cold: right after accepting the agreement). */
  dockVisibleMs: number;
  /** Cold: after the welcome/tour dialogs are dismissed, including `dismissWelcome`'s 2.5s quiet wait. */
  desktopReadyMs: number;
  phases: Record<string, number | null>;
  idle: ProcessMemory[];
  /** Last cold and last warm run: SETTLE_MS after desktop-ready, before any app is opened. */
  settled: ProcessMemory[] | null;
  afterApps: ProcessMemory[] | null;
}

const MB = (kb: number) => Math.round(kb / 1024);

async function memory(app: LaunchedApp): Promise<ProcessMemory[]> {
  const metrics = await app.app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({
    type: m.type, name: m.name ?? m.serviceName ?? '', workingSetSize: m.memory.workingSetSize, peakWorkingSetSize: m.memory.peakWorkingSetSize,
  })));
  return metrics.map((m) => ({ type: m.type, name: m.name, workingSetMB: MB(m.workingSetSize), peakMB: MB(m.peakWorkingSetSize) }));
}

function phaseTimes(allRows: readonly WireRow[]): Record<string, number | null> {
  // A reused root appends every launch to the same wire.jsonl; `seq` restarts at 1 per launch.
  const rows = allRows.slice(allRows.findLastIndex((r) => r.seq === 1));
  const at = (pred: (r: WireRow) => boolean) => {
    const row = rows.find(pred);
    return row === undefined ? null : Math.round(row.time);
  };
  const kindOf = (r: WireRow) => (r.message as { kind?: string } | undefined)?.kind;
  return {
    hostStart: at((r) => r.kind === 'host-start'),
    hostSpawn: at((r) => r.kind === 'host-spawn'),
    firstRendererInvoke: at((r) => r.kind === 'renderer-invoke'),
    hostReady: at((r) => r.kind === 'host-in' && kindOf(r) === 'ready'),
    firstHostResult: at((r) => r.kind === 'host-in' && kindOf(r) === 'result'),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)]!;
};

/** Launch, wait for the desktop (dock) and an idle Host, sample memory; cold runs pass onboarding. */
async function measure(kind: 'cold' | 'warm', root: string | undefined, last: boolean): Promise<{ sample: Sample; root: string }> {
  const started = performance.now();
  const app = await launchApp(root === undefined ? { label: 'perf' } : { root });
  try {
    await waitForBridge(app.page);
    await app.call('plugin:host|status', {}, 90_000);
    const since = () => Math.round(performance.now() - started);
    const dock = app.page.getByTestId('wb-dock');
    let agreementPageMs: number | null = null;
    if (kind === 'cold') {
      const agreement = app.page.getByRole('button', { name: AGREEMENT_BUTTON });
      await agreement.waitFor({ state: 'visible', timeout: 60_000 });
      agreementPageMs = since();
      await agreement.click();
    }
    await expect(dock).toBeVisible({ timeout: 60_000 });
    const dockVisibleMs = since();
    if (kind === 'cold') await dismissWelcome(app.page);
    const desktopReadyMs = since();
    await app.page.waitForTimeout(3_000);
    const idle = await memory(app);
    let settled: ProcessMemory[] | null = null;
    if (last) {
      await app.page.waitForTimeout(started + desktopReadyMs + SETTLE_MS - performance.now());
      settled = await memory(app);
    }
    let afterApps: ProcessMemory[] | null = null;
    if (last) {
      for (const id of ['chat', 'notes', 'settings']) {
        await openDockApp(app.page, id);
        await app.page.waitForTimeout(1_500);
      }
      await app.page.waitForTimeout(2_000);
      afterApps = await memory(app);
    }
    return { root: app.root, sample: { kind, firstWindowMs: Math.round(app.launchMs), agreementPageMs, dockVisibleMs, desktopReadyMs, phases: phaseTimes(app.wire()), idle, settled, afterApps } };
  } finally {
    await app.close();
  }
}

test('performance baseline: cold start, warm restart, process memory', async () => {
  test.setTimeout(10 * 60_000);
  const samples: Sample[] = [];
  let root = '';
  for (let i = 0; i < COLD_RUNS; i++) {
    const run = await measure('cold', undefined, i === COLD_RUNS - 1);
    samples.push(run.sample);
    root = run.root;
  }
  for (let i = 0; i < WARM_RUNS; i++) samples.push((await measure('warm', root, i === WARM_RUNS - 1)).sample);

  const summarize = (kind: Sample['kind']) => {
    const rows = samples.filter((s) => s.kind === kind);
    const phaseNames = Object.keys(rows[0]!.phases);
    const groups: Record<string, (p: ProcessMemory) => boolean> = {
      main: (p) => p.type === 'Browser',
      renderer: (p) => p.type === 'Tab',
      host: (p) => p.type === 'Utility' && p.name === HOST_PROCESS_NAME,
      gpu: (p) => p.type === 'GPU',
      otherUtility: (p) => p.type === 'Utility' && p.name !== HOST_PROCESS_NAME,
    };
    const sumBy = (list: ProcessMemory[] | null, pred: (p: ProcessMemory) => boolean) => (list ?? []).filter(pred).reduce((n, p) => n + p.workingSetMB, 0);
    const mem = (pick: (s: Sample) => ProcessMemory[] | null) => Object.fromEntries(Object.entries(groups).map(([group, pred]) => [group,
      median(rows.filter((s) => pick(s) !== null).map((s) => sumBy(pick(s), pred)))]));
    return {
      runs: rows.length,
      firstWindowMs: median(rows.map((s) => s.firstWindowMs)),
      agreementPageMs: median(rows.map((s) => s.agreementPageMs).filter((v): v is number => v !== null)),
      dockVisibleMs: median(rows.map((s) => s.dockVisibleMs)),
      desktopReadyMs: median(rows.map((s) => s.desktopReadyMs)),
      phases: Object.fromEntries(phaseNames.map((p) => [p, median(rows.map((s) => s.phases[p]).filter((v): v is number => v !== null))])),
      idleMemoryMB: mem((s) => s.idle),
      settledMemoryMB: mem((s) => s.settled),
      afterAppsMemoryMB: mem((s) => s.afterApps),
    };
  };
  const report = { cold: summarize('cold'), warm: summarize('warm'), samples };
  const out = join(repoRoot, 'test-results', 'w12-desktop-smoke');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'perf-baseline.json'), `${JSON.stringify(report, null, 2)}\n`);
  test.info().annotations.push({ type: 'perf-cold', description: JSON.stringify(report.cold) });
  test.info().annotations.push({ type: 'perf-warm', description: JSON.stringify(report.warm) });

  expect(report.cold.phases.hostReady, 'Host ready').not.toBeNull();
  expect(samples.every((s) => s.idle.some((p) => p.type === 'Utility' && p.name === HOST_PROCESS_NAME)), 'Host utility process present in metrics').toBe(true);
});
