/**
 * Host event-loop stalls after startup: in the round-8 full run (INT fe5feb68) ten launches had a cheap Host
 * command (`get_setting`, `dstu_get`, `get_model_assignments`) answered 1–3 s late, 4–6 s after HostReady,
 * with no Host result arriving in between. This attaches to the Host inspector (`W12_HOST_INSPECT_PORT`)
 * as soon as the Host is ready, samples the CPU every 1 ms through the first-run flow and opening notes,
 * and reports the longest busy stretches with their hottest functions and the deepest repo frame on the stack.
 *
 *   bin/heavy npx playwright test -c host/e2e/smoke/playwright-diagnostics.config.ts host-stall
 *
 * Output: test-results/w12-heap/host-stall.json (summary) and host-stall-<n>.cpuprofile.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot } from '../support/app.ts';
import { freePort, inspector } from '../support/inspector.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';
import { openDockApp } from '../support/renderer.ts';

const OUT = join(repoRoot, 'test-results/w12-heap');
const RUNS = Number(process.env.W12_STALL_RUNS ?? 3);

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
interface Profile { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }

const frameLabel = (f: CallFrame) => `${f.functionName || '(anonymous)'} ${f.url.replace(/^file:\/\/.*?\/wt\/[^/]+\//, '')}:${f.lineNumber + 1}`;
const inRepo = (url: string) => url.startsWith('file://') && !url.includes('/node_modules/');

/** Busy stretches (consecutive non-idle samples, gaps under 5 ms tolerated) of at least 300 ms. */
function stalls(profile: Profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const stack = (id: number) => {
    const frames: CallFrame[] = [];
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) frames.push(byId.get(at)!.callFrame);
    return frames;
  };
  let t = profile.startTime;
  const times = profile.timeDeltas.map((d) => (t += d));
  const idle = (id: number) => byId.get(id)!.callFrame.functionName === '(idle)';
  const runs: Array<{ from: number; to: number }> = [];
  let from = -1;
  for (let i = 0; i < profile.samples.length; i++) {
    const busy = !idle(profile.samples[i]!);
    if (busy && from < 0) from = i;
    const gapAhead = i + 1 < profile.samples.length ? times[i + 1]! - times[i]! : Infinity;
    if (from >= 0 && (!busy || gapAhead > 5_000 || i === profile.samples.length - 1)) {
      runs.push({ from, to: busy ? i : i - 1 });
      from = -1;
    }
  }
  return runs
    .map(({ from: a, to: b }) => ({ a, b, ms: (times[b]! - times[a]!) / 1000 }))
    .filter((r) => r.ms >= 300)
    .sort((x, y) => y.ms - x.ms)
    .slice(0, 5)
    .map(({ a, b, ms }) => {
      const self = new Map<string, number>();
      const repo = new Map<string, number>();
      for (let i = a; i <= b; i++) {
        const frames = stack(profile.samples[i]!);
        const top = frameLabel(frames[0]!);
        self.set(top, (self.get(top) ?? 0) + 1);
        const deepestRepo = frames.find((f) => inRepo(f.url));
        const key = deepestRepo ? frameLabel(deepestRepo) : '(no repo frame)';
        repo.set(key, (repo.get(key) ?? 0) + 1);
      }
      const top = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${n} ${k}`);
      return { atMsAfterProfileStart: Math.round((times[a]! - profile.startTime) / 1000), ms: Math.round(ms), samples: b - a + 1,
        topSelf: top(self), topDeepestRepoFrame: top(repo) };
    });
}

test('Host CPU profile across startup, first run and opening notes', async () => {
  test.setTimeout(RUNS * 120_000);
  mkdirSync(OUT, { recursive: true });
  const report = [];
  for (let run = 0; run < RUNS; run++) {
    const port = await freePort();
    const app = await launchApp({ label: 'host-stall', env: { W12_HOST_INSPECT_PORT: String(port) } });
    try {
      await waitForBridge(app.page);
      await app.call('plugin:host|status', {}, 90_000);
      const cdp = await inspector(port);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 1_000 });
      await cdp.send('Profiler.start');
      const startedAt = Date.now();
      await passFirstRun(app.page);
      await openDockApp(app.page, 'notes');
      await app.page.waitForTimeout(Math.max(0, 20_000 - (Date.now() - startedAt)));
      const { profile } = await cdp.send('Profiler.stop') as { profile: Profile };
      cdp.close();
      writeFileSync(join(OUT, `host-stall-${run}.cpuprofile`), JSON.stringify(profile));
      report.push({ run, durationMs: Math.round((profile.endTime - profile.startTime) / 1000), samples: profile.samples.length, stalls: stalls(profile) });
    } finally {
      await app.close();
    }
  }
  writeFileSync(join(OUT, 'host-stall.json'), `${JSON.stringify(report, null, 1)}\n`);
  test.info().annotations.push({ type: 'host-stall', description: JSON.stringify(report.map((r) => ({ run: r.run, stalls: r.stalls.map((s) => [s.atMsAfterProfileStart, s.ms, s.topDeepestRepoFrame[0]]) }))) });
  expect(report.every((r) => r.samples > 1_000), 'the Host inspector returned a sampled profile').toBe(true);
});
