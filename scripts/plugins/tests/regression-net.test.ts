import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compareGraphs, normalizeBundle, normalizeModuleId } from '../chunk-graph.mjs';
import { baselineFromRuns, compareTrace, groupTrace, inventoryOf, normalizeCall } from '../ipc-trace.mjs';
import { DOM_SCENES, SCENES, VISUAL_SCENES, openScene, replyBlockEnded, sceneUrl } from '../../../tests/visual/lib/scenes.mjs';
import { motionScenes, problemsOf } from '../../../tests/visual/motion-check.mjs';
import {
  BROWSER_LAYERS, LAYERS, flaggedCommits, layerArgs, layerEnv, needsDemo, runFailed, selectLayers, summaryLines,
} from '../../../tests/visual/regress.mjs';

const root = '/repo';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function bundle({ lazyStatic = false, extraEntryModule = false, appBytes = 100 } = {}) {
  const entryModules: Record<string, number> = { '/repo/src/main.tsx': 10, '/repo/src/App.tsx': appBytes, '/repo/src/ui-kernel/kernel.ts': 5 };
  if (extraEntryModule) entryModules['/repo/src/features/settings/components/Settings.tsx'] = 40;
  return {
    chunks: [
      { fileName: 'assets/main-AAAAAAAA.js', name: 'main', isEntry: true, isDynamicEntry: false, facadeModuleId: '/repo/index.html',
        imports: ['assets/vendor-react-BBBBBBBB.js', ...(lazyStatic ? ['assets/Settings-CCCCCCCC.js'] : [])],
        dynamicImports: ['assets/Settings-CCCCCCCC.js'], importedCss: ['assets/main-DDDDDDDD.css'], bytes: 115 + (appBytes - 100) + (extraEntryModule ? 40 : 0), modules: entryModules },
      { fileName: 'assets/vendor-react-BBBBBBBB.js', name: 'vendor-react', isEntry: false, isDynamicEntry: false, facadeModuleId: null,
        imports: [], dynamicImports: [], importedCss: [], bytes: 50, modules: { '/elsewhere/deep-student/node_modules/react/index.js': 50 } },
      { fileName: 'assets/Settings-CCCCCCCC.js', name: 'Settings', isEntry: false, isDynamicEntry: true, facadeModuleId: '/repo/src/features/settings/components/Settings.tsx',
        imports: ['assets/vendor-react-BBBBBBBB.js'], dynamicImports: [], importedCss: [], bytes: 40, modules: { '/repo/src/features/settings/components/Settings.tsx': 40 } },
    ],
    assets: [{ fileName: 'assets/main-DDDDDDDD.css', bytes: 30 }],
  };
}

describe('chunk-graph', () => {
  it('normalises module ids and chunk identities without hashes', () => {
    expect(normalizeModuleId('/x/deep-student/node_modules/@scope/pkg/a.js?commonjs', root)).toBe('node_modules/@scope/pkg/a.js');
    expect(normalizeModuleId('\0vite/preload-helper', root)).toBe('virtual:vite/preload-helper');
    const graph = normalizeBundle(bundle(), root);
    expect(Object.keys(graph.chunks)).toEqual(['index.html', 'src/features/settings/components/Settings.tsx', 'vendor-react']);
    expect(graph.chunks['index.html'].file).toBe('assets/main.js');
    expect(graph.summary.entryClosure.chunks).toEqual(['index.html', 'vendor-react']);
    expect(graph.summary.lazySources).toEqual([{ key: 'src/features/settings/components/Settings.tsx', inEntryClosure: false }]);
  });

  it('is clean against itself', () => {
    const graph = normalizeBundle(bundle(), root);
    expect(compareGraphs(graph, normalizeBundle(bundle(), root))).toEqual({ violations: [], changes: [], growth: 0 });
  });

  it('catches a lazy page pulled into the entry closure', () => {
    const { violations } = compareGraphs(normalizeBundle(bundle(), root), normalizeBundle(bundle({ lazyStatic: true }), root));
    expect(violations.join('\n')).toContain('lazy module src/features/settings/components/Settings.tsx is now in the entry static closure');
  });

  it('catches a new source module and byte growth in the entry closure', () => {
    const { violations } = compareGraphs(normalizeBundle(bundle(), root), normalizeBundle(bundle({ extraEntryModule: true }), root));
    expect(violations).toContain('entry closure gained source module src/features/settings/components/Settings.tsx');
    expect(violations.some((v: string) => v.startsWith('entry closure grew by 40 bytes'))).toBe(true);
    const grown = compareGraphs(normalizeBundle(bundle(), root), normalizeBundle(bundle({ appBytes: 101 }), root));
    expect(grown.violations).toHaveLength(1);
    expect(compareGraphs(normalizeBundle(bundle(), root), normalizeBundle(bundle({ appBytes: 101 }), root), { allowGrowth: 1 }).violations).toEqual([]);
  });
});

describe('ipc-trace', () => {
  const rows = (calls: string[], step = 'boot') => calls.map((call) => ({ step, call }));

  it('masks embedded ids and keeps distinct calls in first-occurrence order', () => {
    expect(normalizeCall('listen:chat_v2_event_demo-draft-mm8i4n2n-0')).toBe('listen:chat_v2_event_demo-draft-<id>-0');
    expect(normalizeCall('get_setting(key)')).toBe('get_setting(key)');
    expect(groupTrace(rows(['a(x)', 'b()', 'a(x)']), ['boot'])).toEqual([{ name: 'boot', calls: ['a(x)', 'b()'] }]);
  });

  it('marks steps as sequence only when command order is stable across runs', () => {
    const stable = baselineFromRuns('s', [[{ name: 'boot', calls: ['listen:e', 'a()', 'b()'] }], [{ name: 'boot', calls: ['a()', 'listen:e', 'b()'] }]]);
    expect(stable.steps[0].order).toBe('sequence');
    const racy = baselineFromRuns('s', [[{ name: 'boot', calls: ['a()', 'b()'] }], [{ name: 'boot', calls: ['b()', 'a()'] }]]);
    expect(racy.steps[0].order).toBe('set');
    expect(() => baselineFromRuns('s', [[{ name: 'boot', calls: ['a()'] }], [{ name: 'boot', calls: ['a()', 'c()'] }]])).toThrow(/call set differs/);
  });

  it('reports a renamed argument key and reordered commands', () => {
    const golden = { scene: 's', steps: [{ name: 'boot', order: 'sequence', calls: ['chat_v2_list_sessions(groupId,limit,offset,status)', 'b()'] }] };
    expect(compareTrace(golden, [{ name: 'boot', calls: ['chat_v2_list_sessions(group_id,limit,offset,status)', 'b()'] }])).toEqual([
      'boot: + chat_v2_list_sessions(group_id,limit,offset,status)',
      'boot: - chat_v2_list_sessions(groupId,limit,offset,status)',
    ]);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['b()', 'chat_v2_list_sessions(groupId,limit,offset,status)'] }])[0]).toMatch(/command order changed/);
    expect(compareTrace({ ...golden, steps: [{ ...golden.steps[0], order: 'set' }] }, [{ name: 'boot', calls: ['b()', 'chat_v2_list_sessions(groupId,limit,offset,status)'] }])).toEqual([]);
  });

  it('checks unordered commands for presence only and keeps enforcing the others', () => {
    const golden = { scene: 's', steps: [{ name: 'boot', order: 'sequence', unordered: ['r(id)'], calls: ['a()', 'r(id)', 'b()', 'c()'] }] };
    expect(compareTrace(golden, [{ name: 'boot', calls: ['a()', 'b()', 'c()', 'r(id)'] }])).toEqual([]);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['r(id)', 'a()', 'b()', 'c()'] }])).toEqual([]);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['a()', 'r(id)', 'c()', 'b()'] }])).toEqual(['boot: command order changed at #1: expected b(), got c()']);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['a()', 'b()', 'c()'] }])).toEqual(['boot: - r(id)']);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['a()', 'r(other)', 'b()', 'c()'] }])).toEqual(['boot: + r(other)', 'boot: - r(id)']);
  });

  it('still reports a reorder when the step also gained or lost calls', () => {
    const golden = { scene: 's', steps: [{ name: 'boot', order: 'sequence', calls: ['listen:e', 'a()', 'b()', 'c()', 'd()'] }] };
    expect(compareTrace(golden, [{ name: 'boot', calls: ['a()', 'c()', 'd()', 'b()'] }])).toEqual([
      'boot: - listen:e',
      'boot: command order changed at #1 (among the commands on both sides): expected b(), got c()',
    ]);
    expect(compareTrace(golden, [{ name: 'boot', calls: ['listen:e', 'a()', 'x()', 'b()', 'd()'] }])).toEqual(['boot: + x()', 'boot: - c()']);
  });

  it('--update honours the previous golden\'s unordered list when deciding sequence', () => {
    const runs = [
      [{ name: 'boot', calls: ['a()', 'r(id)', 'b()', 'c()'] }],
      [{ name: 'boot', calls: ['a()', 'b()', 'c()', 'r(id)'] }],
      [{ name: 'boot', calls: ['a()', 'b()', 'r(id)', 'c()'] }],
    ];
    expect(baselineFromRuns('s', runs).steps[0].order).toBe('set');
    const previous = { scene: 's', steps: [{ name: 'boot', order: 'sequence', unordered: ['r(id)', 'gone()'], calls: [] }] };
    expect(baselineFromRuns('s', runs, previous).steps).toEqual([
      { name: 'boot', order: 'sequence', unordered: ['r(id)'], calls: ['a()', 'r(id)', 'b()', 'c()'] },
    ]);
    const racyOthers = [runs[0], [{ name: 'boot', calls: ['a()', 'c()', 'r(id)', 'b()'] }]];
    expect(baselineFromRuns('s', racyOthers, previous).steps[0].order).toBe('set');
    expect(baselineFromRuns('s', runs, { scene: 's', steps: [{ name: 'boot', order: 'sequence', calls: [] }] }).steps[0]).not.toHaveProperty('unordered');
  });

  it('masks uuids and epoch-millisecond timestamps, not short numbers', () => {
    expect(normalizeCall('listen:upload_3f2b8c1e-9a4d-4b7e-8c2f-0123456789ab')).toBe('listen:upload_<uuid>');
    expect(normalizeCall('listen:task_1772415000123_done')).toBe('listen:task_<ts>_done');
    expect(normalizeCall('emit:pomodoro-mini:state')).toBe('emit:pomodoro-mini:state');
    expect(normalizeCall('review_plan_get_stats(examId)')).toBe('review_plan_get_stats(examId)');
  });

  it('groups only by step and call: extra fields on trace rows (block phase) never reach a golden', () => {
    const traced = [
      { step: 'boot', call: 'emit:chat_v2_event_demo-anki-cards', phase: 'start' },
      { step: 'boot', call: 'emit:chat_v2_event_demo-anki-cards', phase: 'chunk' },
      { step: 'boot', call: 'chat_v2_upsert_streaming_block(blockId,blockType,content,messageId,sessionId)' },
      { step: 'boot', call: 'emit:chat_v2_event_demo-anki-cards', phase: 'end' },
    ];
    expect(groupTrace(traced, ['boot', 'open-session'])).toEqual([
      { name: 'boot', calls: ['emit:chat_v2_event_demo-anki-cards', 'chat_v2_upsert_streaming_block(blockId,blockType,content,messageId,sessionId)'] },
      { name: 'open-session', calls: [] },
    ]);
  });

  it('inventories every call shape with the scenes that issue it, sorted', () => {
    const goldens = [
      { scene: 'b', steps: [{ name: 'boot', order: 'set', calls: ['x()', 'listen:e'] }] },
      { scene: 'a', steps: [{ name: 'boot', order: 'set', calls: ['x()'] }, { name: 'step', order: 'sequence', calls: ['y(id)'] }] },
    ];
    expect(inventoryOf(goldens)).toEqual({ 'listen:e': ['b'], 'x()': ['a', 'b'], 'y(id)': ['a'] });
  });

  it('keeps the committed inventory.json equal to the inventory of the committed scene goldens', () => {
    const dir = path.join(repoRoot, 'tests/visual/__golden__/ipc');
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(read('inventory.json')).toEqual(inventoryOf(SCENES.map((scene) => read(`${scene.id}.json`))));
  });

  it('pins every hand-registered unordered call (REGRESSION.md §3.3: each one needs its own commit with race evidence)', () => {
    const dir = path.join(repoRoot, 'tests/visual/__golden__/ipc');
    const registered = SCENES.flatMap((scene) => JSON.parse(fs.readFileSync(path.join(dir, `${scene.id}.json`), 'utf8')).steps
      .flatMap((step: { name: string; unordered?: string[] }) => (step.unordered ?? []).map((call) => `${scene.id}/${step.name}: ${call}`)));
    expect(registered).toEqual(['notes/boot: notes_editor_register(noteId)']);
  });
});

describe('scene matrix', () => {
  const ids = (scenes: Array<{ id: string }>) => scenes.map((scene) => scene.id);

  it('snapshots the DOM of every scene but reading-translation and screenshots the 12 visual ones', () => {
    expect(new Set(ids(SCENES)).size).toBe(18);
    expect(ids(DOM_SCENES)).toEqual(ids(SCENES).filter((id) => id !== 'reading-translation'));
    expect(ids(VISUAL_SCENES)).toEqual([
      'shell-chat', 'shell-desktop', 'chat', 'learning-hub', 'notes', 'mindmap', 'essay', 'question-bank', 'anki', 'flashcards', 'models', 'skills-mcp',
    ]);
  });

  it('waits for __DEMO_READY__ in every single-app scene and for a quiet DOM in the two whole-shell ones', () => {
    expect(SCENES.filter((s: { ready: string }) => s.ready === 'quiet').map((s: { id: string }) => s.id)).toEqual(['shell-chat', 'shell-desktop']);
    expect(SCENES.filter((s: { entry: string }) => s.entry.startsWith('demo-app.html?app=')).every((s: { ready: string }) => s.ready === 'demo-ready')).toBe(true);
  });

  it('builds scene URLs that keep the entry query and add the theme only for dark', () => {
    const at = (id: string) => SCENES.find((s: { id: string }) => s.id === id)!;
    expect(sceneUrl('http://127.0.0.1:1', at('shell-chat'))).toBe('http://127.0.0.1:1/demo.html');
    expect(sceneUrl('http://127.0.0.1:1', at('shell-chat'), 'dark')).toBe('http://127.0.0.1:1/demo.html?theme=dark');
    expect(sceneUrl('http://127.0.0.1:1', at('shell-desktop'), 'dark')).toBe('http://127.0.0.1:1/demo.html?desktop=1&theme=dark');
    expect(sceneUrl('http://127.0.0.1:1', at('data-sync'), 'light')).toBe('http://127.0.0.1:1/demo-app.html?app=data-sync');
  });
});

describe('scene clock moves (IPC layer)', () => {
  type Call = string;
  /** A stand-in for a Playwright page that logs, in order, what openScene asks of it. */
  function fakePage({ replyEnds = true, bootQuiet = true } = {}) {
    const calls: Call[] = [];
    const page = {
      goto: async (url: string) => { calls.push(`goto ${url.replace(/^.*\//, '')}`); },
      waitForFunction: async (fn: () => unknown) => {
        if (fn === replyBlockEnded) {
          calls.push('wait reply block end');
          if (!replyEnds) throw new Error('timeout');
          return;
        }
        calls.push(`wait ${/__DEMO_READY__/.test(String(fn)) ? 'demo-ready' : 'text'}`);
      },
      evaluate: async (fn: unknown, arg?: { quietMs?: number }) => {
        calls.push(arg?.quietMs ? `quiet ${arg.quietMs}` : 'evaluate');
        // The whole-shell boot waits for 2500 ms without DOM mutations; settle waits for 800 ms.
        return arg?.quietMs === 2500 ? bootQuiet : true;
      },
      clock: {
        fastForward: async (ms: number) => { calls.push(`fastForward ${ms}`); },
        runFor: async (ms: number) => { calls.push(`runFor ${ms}`); },
      },
    };
    return { page, calls };
  }
  const scene = (id: string) => SCENES.find((s: { id: string }) => s.id === id)!;
  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => { (globalThis as { window?: unknown }).window = originalWindow; });

  it('declares clock moves only for the two whole-shell scenes', () => {
    const moved = SCENES.filter((s: { bootClock: unknown }) => s.bootClock).map((s: { id: string; bootClock: unknown }) => [s.id, s.bootClock]);
    expect(moved).toEqual([
      ['shell-chat', { replyJump: 5000, startupTimers: 5000 }],
      ['shell-desktop', { startupTimers: 5000 }],
    ]);
  });

  it('shell-chat: jumps once the reply ended a block and before the quiet wait, then runs the startup timers and settles again', async () => {
    const { page, calls } = fakePage();
    expect(await openScene(page, 'http://127.0.0.1:1', scene('shell-chat'), 'light', { clock: true })).toBe(true);
    expect(calls).toEqual([
      'goto demo.html', 'wait reply block end', 'fastForward 5000', 'wait text', 'quiet 2500',
      'evaluate', 'quiet 800', 'runFor 5000', 'evaluate', 'quiet 800',
    ]);
  });

  it('shell-desktop: no jump; the startup timers run after the scene settled', async () => {
    const { page, calls } = fakePage();
    expect(await openScene(page, 'http://127.0.0.1:1', scene('shell-desktop'), 'light', { clock: true })).toBe(true);
    expect(calls).toEqual(['goto demo.html?desktop=1', 'wait text', 'quiet 2500', 'evaluate', 'quiet 800', 'runFor 5000', 'evaluate', 'quiet 800']);
  });

  it('never moves the clock for the DOM and screenshot layers, nor for single-app scenes', async () => {
    for (const [id, clock] of [['shell-chat', false], ['shell-desktop', false], ['notes', true]] as const) {
      const { page, calls } = fakePage();
      await openScene(page, 'http://127.0.0.1:1', scene(id), 'light', { clock });
      expect(calls.filter((call) => /fastForward|runFor|reply block/.test(call))).toEqual([]);
    }
  });

  it('a reply that never ends a block makes the scene not ready instead of jumping at an arbitrary point', async () => {
    const { page, calls } = fakePage({ replyEnds: false });
    expect(await openScene(page, 'http://127.0.0.1:1', scene('shell-chat'), 'light', { clock: true })).toBe(false);
    expect(calls).not.toContain('fastForward 5000');
    // Readiness is not waited for again after the failed reply wait.
    expect(calls.filter((call) => call.startsWith('wait '))).toEqual(['wait reply block end']);
  });

  it('a boot that never goes quiet is not ready, even though the startup timers still ran', async () => {
    const { page, calls } = fakePage({ bootQuiet: false });
    expect(await openScene(page, 'http://127.0.0.1:1', scene('shell-desktop'), 'light', { clock: true })).toBe(false);
    expect(calls).toContain('runFor 5000');
  });

  it('applies each move on its own: a reply jump alone neither runs the startup timers nor settles twice', async () => {
    const { page, calls } = fakePage();
    const jumpOnly = { ...scene('shell-chat'), bootClock: { replyJump: 3000 } };
    expect(await openScene(page, 'http://127.0.0.1:1', jumpOnly, 'light', { clock: true })).toBe(true);
    expect(calls).toEqual(['goto demo.html', 'wait reply block end', 'fastForward 3000', 'wait text', 'quiet 2500', 'evaluate', 'quiet 800']);
  });

  it('a single-app scene given startup timers runs them after __DEMO_READY__ and the settle, then settles again', async () => {
    const { page, calls } = fakePage();
    const timed = { ...scene('notes'), bootClock: { startupTimers: 1200 } };
    expect(await openScene(page, 'http://127.0.0.1:1', timed, 'light', { clock: true })).toBe(true);
    expect(calls).toEqual(['goto demo-app.html?app=notes', 'wait demo-ready', 'evaluate', 'quiet 800', 'runFor 1200', 'evaluate', 'quiet 800']);
  });

  it('moves the clock the same way for the dark theme; only the URL changes', async () => {
    const light = fakePage();
    const dark = fakePage();
    await openScene(light.page, 'http://127.0.0.1:1', scene('shell-desktop'), 'light', { clock: true });
    await openScene(dark.page, 'http://127.0.0.1:1', scene('shell-desktop'), 'dark', { clock: true });
    expect(dark.calls).toEqual(light.calls.map((call) => (call === 'goto demo.html?desktop=1' ? 'goto demo.html?desktop=1&theme=dark' : call)));
  });

  it('replyBlockEnded looks for the end phase of a chat block event, not of other emits', () => {
    const win = (rows: unknown[]) => { (globalThis as { window?: unknown }).window = { __DS_TRACE__: rows }; };
    win([{ step: 'boot', call: 'emit:chat_v2_event_demo-anki-cards', phase: 'chunk' }, { step: 'boot', call: 'emit:other', phase: 'end' }]);
    expect(replyBlockEnded()).toBe(false);
    win([{ step: 'boot', call: 'emit:chat_v2_event_demo-anki-cards', phase: 'end' }]);
    expect(replyBlockEnded()).toBe(true);
    (globalThis as { window?: unknown }).window = {};
    expect(replyBlockEnded()).toBe(false);
  });
});

describe('motion-check verdict', () => {
  const result = (mode: string, over: Record<string, unknown> = {}) => ({
    mode, ready: true, matches: mode === 'reduce', probe: { run: true, end: true }, count: 7, properties: {}, targets: {}, errors: [], ...over,
  });

  it('passes when reduce starts no more transitions than no-preference', () => {
    expect(problemsOf({ 'no-preference': result('no-preference'), reduce: result('reduce', { count: 6 }) })).toEqual([]);
    expect(problemsOf({ 'no-preference': result('no-preference'), reduce: result('reduce', { count: 7 }) })).toEqual([]);
  });

  it('fails on more transitions under reduce and names the top properties and elements', () => {
    const problems = problemsOf({
      'no-preference': result('no-preference'),
      reduce: result('reduce', { count: 6136, properties: { opacity: 4000, color: 2136 }, targets: { 'div.row': 6000, 'span': 136 } }),
    });
    expect(problems).toEqual([
      'reduce started 6136 transitions before ready, no-preference 7',
      '  reduce, by property: opacity ×4000, color ×2136',
      '  reduce, by element: div.row ×6000, span ×136',
    ]);
  });

  it('fails when the emulated mode, the probe or readiness is wrong, and does not compare counts then', () => {
    expect(problemsOf({ 'no-preference': result('no-preference', { matches: true }), reduce: result('reduce') })).toEqual([
      'no-preference: matchMedia(prefers-reduced-motion: reduce) is true',
    ]);
    expect(problemsOf({ 'no-preference': result('no-preference'), reduce: result('reduce', { probe: { run: true, end: false } }) })).toEqual([
      'reduce: probe with a declared transition: transitionrun true, transitionend false',
    ]);
    expect(problemsOf({ 'no-preference': result('no-preference'), reduce: result('reduce', { ready: false, count: null }) })).toEqual(['reduce: never became ready']);
  });

  it('does not compare counts when no-preference never became ready, and reports page errors per mode', () => {
    expect(problemsOf({
      'no-preference': result('no-preference', { ready: false, count: null }),
      reduce: result('reduce', { count: 9000, errors: ['pageerror: boom'] }),
    })).toEqual(['no-preference: never became ready', 'reduce: pageerror: boom']);
  });

  it('names at most five properties and elements, most frequent first', () => {
    const many = { a: 1, b: 6, c: 5, d: 4, e: 3, f: 2 };
    const problems = problemsOf({ 'no-preference': result('no-preference'), reduce: result('reduce', { count: 21, properties: many, targets: many }) });
    expect(problems.slice(1)).toEqual(['  reduce, by property: b ×6, c ×5, d ×4, e ×3, f ×2', '  reduce, by element: b ×6, c ×5, d ×4, e ×3, f ×2']);
  });

  it('measures notes by default and refuses whole-shell scenes and unknown ids', () => {
    const ids = (scenes: Array<{ id: string }>) => scenes.map((scene) => scene.id);
    expect(ids(motionScenes().scenes)).toEqual(['notes']);
    expect(motionScenes().unusable).toEqual([]);
    expect(motionScenes(new Set(['notes', 'shell-chat', 'nope'])).unusable).toEqual(['shell-chat', 'nope']);
    expect(ids(motionScenes(new Set(['anki', 'notes'])).scenes)).toEqual(['notes', 'anki']);
  });
});

describe('regress.mjs', () => {
  it('selects all layers in order by default and reports unknown names', () => {
    expect(selectLayers(undefined).selected).toEqual(Object.keys(LAYERS));
    expect(selectLayers('dom,ipc,bogus')).toEqual({ selected: ['dom', 'ipc', 'bogus'], unknown: ['bogus'] });
  });

  it('flags [待审] commits only when the tag is among the leading title tags', () => {
    expect(flaggedCommits([
      'aaaa111 [W09][RF-W09-x][待审] label copy',
      'bbbb222 [待审] direct',
      'cccc333 [W16] Docs: how [待审] commits are listed',
      'dddd444 [W18] menus [待审]',
    ])).toEqual(['aaaa111 [W09][RF-W09-x][待审] label copy', 'bbbb222 [待审] direct']);
  });

  it('fails the run on a failed preflight or a failed layer, not on skipped layers', () => {
    expect(runFailed([{ name: 'dom', status: 0 }, { name: 'ipc', status: 'skip' }], [])).toBe(false);
    expect(runFailed([{ name: 'dom', status: 0 }, { name: 'ipc', status: 1 }], [])).toBe(true);
    expect(runFailed([{ name: 'dom', status: 'skip' }], ['demo.html: #root is empty'])).toBe(true);
  });

  it('lists nothing for an empty range (git log prints one empty line)', () => {
    expect(flaggedCommits([''])).toEqual([]);
  });

  it('runs the boot preflight only when a browser layer is selected', () => {
    expect(BROWSER_LAYERS.every((name: string) => name in LAYERS)).toBe(true);
    expect(needsDemo(['slots', 'chunks', 'evidence'])).toBe(false);
    expect(needsDemo(['slots', 'motion'])).toBe(true);
  });

  it('runs every layer in check mode and passes --main-dist to the chunk layer only', () => {
    for (const name of Object.keys(LAYERS).filter((n) => n !== 'evidence')) expect(layerArgs(name)).toContain('--check');
    expect(layerArgs('evidence').slice(1, 4)).toEqual(['run', '-c', 'vitest.config.ts']);
    expect(layerArgs('chunks', { mainDist: '/m' })).toEqual(['scripts/plugins/chunk-graph.mjs', '--check', '--dist', '/m']);
    expect(layerArgs('dom', { mainDist: '/m' })).toEqual(['tests/visual/dom-golden.mjs', '--check']);
    expect(LAYERS.chunks).toEqual(['scripts/plugins/chunk-graph.mjs', '--check']);
  });

  it('gives the evidence run a build number unless one is set, and leaves the other layers\' environment alone', () => {
    const env = { PATH: '/bin' };
    expect(layerEnv('evidence', env)).toEqual({ PATH: '/bin', DEEP_STUDENT_BUILD_NUMBER: '20000' });
    expect(layerEnv('evidence', { ...env, DEEP_STUDENT_BUILD_NUMBER: '123' }).DEEP_STUDENT_BUILD_NUMBER).toBe('123');
    expect(layerEnv('ipc', env)).toBe(env);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('prints the boot problem first, then one line per layer in run order', () => {
    expect(summaryLines([
      { name: 'slots', status: 0, seconds: 3 }, { name: 'dom', status: 'skip', seconds: 0 }, { name: 'chunks', status: 1, seconds: 40 },
    ], ['demo.html: #root is empty', 'second problem'])).toEqual([
      'FE-A1 regression summary',
      '  ✗ boot         demo.html: #root is empty',
      '  ✓ slots        exit 0  3s',
      '  - dom          skipped (demo does not boot)',
      '  ✗ chunks       exit 1  40s',
    ]);
  });
});
