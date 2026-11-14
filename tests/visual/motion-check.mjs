#!/usr/bin/env node
/**
 * Reduced-motion cost guard: while a scene loads, `prefers-reduced-motion: reduce` must not start more CSS
 * transitions than no preference does.
 *
 *   node tests/visual/motion-check.mjs [--check] [--scenes notes] [--dist DIR | --base URL] [--build] [--retries N] [--throttle R]
 *
 * Why: the global reduce rule in src/shared/styles/deep-student.css forces `transition-duration: 0.01ms`
 * on every element (0.01ms rather than 0 keeps `transitionend` for components that wait for it). With the
 * initial `transition-property: all`, that turns every element without a declared transition into
 * `transition: all 0.01ms`, unless a layered `transition-property: none` default holds it back
 * (src/styles/ui-motion.css, W26 2e1a2cd5). Without it the notes demo started 2958–4604 transitions while
 * loading under reduce against 7 with no preference, and style recalculation got 10× slower.
 *
 * Counted: `transitionrun` events, capture phase on document, from before the first app script until the
 * scene assigns `window.__DEMO_READY__ = true`. The count is read inside that assignment, so the window
 * ends at the same app state on fast and slow hosts; no timing is compared. Both modes use the pinned
 * environment of the other browser layers (lib/page.mjs) and differ only in `reducedMotion`.
 * Passes when, per scene: reduce count ≤ no-preference count, `matchMedia` reports the requested mode, and
 * a probe element that declares a transition still fires `transitionrun` and `transitionend` in both modes
 * (proves the counter sees transitions, and that declared transitions keep their events under reduce).
 * Only scenes with a `__DEMO_READY__` signal qualify (single-app demos). There is no baseline to --update.
 * --throttle R applies CDP CPU throttling, for showing that the counts do not move with host speed.
 */
import { newScenePage } from './lib/page.mjs';
import { parseLayerArgs, startDemo } from './lib/runner.mjs';
import { SCENES, sceneUrl } from './lib/scenes.mjs';

const DEFAULT_SCENES = ['notes'];
const MODES = ['no-preference', 'reduce'];

/** Page init (no closures over Node values): count transitionrun, freeze the count when the scene is ready. */
function motionCounter() {
  const state = { total: 0, atReady: null, properties: {}, targets: {} };
  window.__DS_MOTION__ = state;
  document.addEventListener('transitionrun', (event) => {
    state.total += 1;
    if (state.atReady !== null) return;
    state.properties[event.propertyName] = (state.properties[event.propertyName] ?? 0) + 1;
    const target = event.target;
    const key = target instanceof Element ? `${target.localName}${[...target.classList].slice(0, 3).map((c) => `.${c}`).join('')}` : String(target);
    state.targets[key] = (state.targets[key] ?? 0) + 1;
  }, { capture: true, passive: true });
  let ready;
  Object.defineProperty(window, '__DEMO_READY__', {
    configurable: true,
    get: () => ready,
    set: (value) => {
      if (value === true && state.atReady === null) state.atReady = state.total;
      ready = value;
    },
  });
}

/** A declared transition must still run and end in both modes. */
function probeDeclaredTransition() {
  return new Promise((resolve) => {
    const seen = { run: false, end: false };
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;transition:opacity 40ms linear';
    const finish = () => { clearTimeout(timer); el.remove(); resolve(seen); };
    const timer = setTimeout(finish, 3000);
    el.addEventListener('transitionrun', () => { seen.run = true; });
    el.addEventListener('transitionend', () => { seen.end = true; finish(); });
    document.body.append(el);
    void el.getBoundingClientRect();
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  });
}

const top = (counts, n = 5) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => `${key} ×${count}`).join(', ');

async function measure(demo, scene, mode, throttle) {
  const { context, page, errors } = await newScenePage(demo.browser, { viewport: 'desktop', reducedMotion: mode, initScripts: [motionCounter] });
  try {
    if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(sceneUrl(demo.base, scene), { waitUntil: 'load', timeout: 60_000 });
    const ready = await page.waitForFunction(() => window.__DEMO_READY__ === true, null, { timeout: 60_000, polling: 100 }).then(() => true, () => false);
    const matches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    const probe = ready ? await page.evaluate(probeDeclaredTransition) : { run: false, end: false };
    const state = await page.evaluate(() => window.__DS_MOTION__);
    return { mode, ready, matches, probe, count: state.atReady, properties: state.properties, targets: state.targets, errors };
  } finally {
    await context.close();
  }
}

/** `--scenes` (default: notes) → the scenes to measure, and the ids that are not single-app scenes with `__DEMO_READY__`. */
export function motionScenes(wanted = new Set(DEFAULT_SCENES)) {
  const scenes = SCENES.filter((scene) => wanted.has(scene.id));
  const unusable = [...wanted].filter((id) => !scenes.some((scene) => scene.id === id && scene.ready === 'demo-ready'));
  return { scenes, unusable };
}

/** Verdict for one scene: `byMode` holds the `measure` result of each mode. */
export function problemsOf(byMode) {
  const problems = [];
  for (const r of Object.values(byMode)) {
    if (!r.ready) problems.push(`${r.mode}: never became ready`);
    if (r.matches !== (r.mode === 'reduce')) problems.push(`${r.mode}: matchMedia(prefers-reduced-motion: reduce) is ${r.matches}`);
    if (r.ready && !(r.probe.run && r.probe.end)) problems.push(`${r.mode}: probe with a declared transition: transitionrun ${r.probe.run}, transitionend ${r.probe.end}`);
    problems.push(...r.errors.map((error) => `${r.mode}: ${error}`));
  }
  const { reduce, 'no-preference': plain } = byMode;
  if (reduce.ready && plain.ready && reduce.count > plain.count) {
    problems.push(`reduce started ${reduce.count} transitions before ready, no-preference ${plain.count}`);
    problems.push(`  reduce, by property: ${top(reduce.properties)}`);
    problems.push(`  reduce, by element: ${top(reduce.targets)}`);
  }
  return problems;
}

async function main() {
  const argv = process.argv.slice(2);
  const throttleAt = argv.indexOf('--throttle');
  const throttle = throttleAt >= 0 ? Number(argv.splice(throttleAt, 2)[1]) : 1;
  const opts = parseLayerArgs(argv);
  if (opts.mode === 'update') {
    console.error('[motion-check] compares the two modes of one build; there is no baseline to update');
    process.exit(2);
  }
  const { scenes, unusable } = motionScenes(opts.scenes ?? undefined);
  if (unusable.length) {
    console.error(`[motion-check] not a single-app scene with __DEMO_READY__: ${unusable.join(', ')}`);
    process.exit(2);
  }
  const demo = await startDemo(opts);
  const failures = [];
  try {
    for (const scene of scenes) {
      let attempt = 0;
      let byMode;
      let problems;
      do {
        byMode = {};
        for (const mode of MODES) byMode[mode] = await measure(demo, scene, mode, throttle);
        problems = problemsOf(byMode);
      } while (problems.length && attempt++ < opts.retries);
      const counts = `transitionrun before ready: reduce ${byMode.reduce.count}, no-preference ${byMode['no-preference'].count}${throttle > 1 ? ` (CPU ×${throttle})` : ''}`;
      if (!problems.length) {
        console.log(`  ✓ ${scene.id}: ${counts}${attempt > 0 ? ` (matched on retry ${attempt})` : ''}`);
        continue;
      }
      console.log(`  ✗ ${scene.id}: ${counts}`);
      for (const problem of problems) console.log(`      ${problem}`);
      failures.push(scene.id);
    }
  } finally {
    await demo.close();
  }
  console.log(`[motion-check] ${failures.length ? `FAILED (${failures.join(', ')})` : 'passed'} (${scenes.length} scene${scenes.length === 1 ? '' : 's'})`);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
