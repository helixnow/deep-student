#!/usr/bin/env node
/**
 * FE-A1 layer 3 — IPC call trace of scripted demo-shell scenarios (plans/FRONTEND-PLUGINIZATION.md §2.8).
 *
 *   node scripts/plugins/ipc-trace.mjs [--check] [--scenes a,b] [--dist DIR | --base URL] [--retries N] [--build] [--throttle R]
 *   node scripts/plugins/ipc-trace.mjs --update [--runs N]
 *
 * Every invoke the frontend issues (through the demo's Tauri mocks) is recorded as
 * `command(sorted,arg,keys{nested,keys})`; event subscriptions as `listen:<event>` / `unlisten:` / `emit:`.
 * Values are never recorded. Dynamic ids/timestamps inside names are masked.
 *
 * Per scene and step the golden keeps the distinct calls in first-occurrence order. --update runs each
 * scene --runs times (default 3): the call set must be identical in every run, and the step is marked
 * `"order": "sequence"` only when the first-occurrence order of its commands was identical too
 * (otherwise "set": effects race on lazy chunk loading). Listener registration order and call counts
 * (debounced saves, polling) are never compared.
 * A step may list known racing commands in `"unordered": [call, …]` (edited by hand in the golden): they are
 * checked for presence only and left out of every order comparison, in --check and when --update decides
 * "sequence" (--update keeps the list of the existing golden), so one racing call does not demote the
 * whole step to "set".
 * --check fails on any added or removed call, and on reordered commands in "sequence" steps (compared over
 * the commands present on both sides, so an added or removed call does not mask a reorder);
 * a failing scene is retried --retries times (default 1) before it counts.
 * Scenes with a `bootClock` (lib/scenes.mjs) move the page clock during boot so that app timers land on a fixed
 * side of the boot window; --throttle R (CDP CPU throttling, --check only) shows that the traces do not move
 * with host speed.
 * Goldens: tests/visual/__golden__/ipc/<scene>.json (platform independent) and inventory.json
 * (command → argument shapes, the input for W09's frontend-invoke gate).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Same masking rules as the DOM serialiser, for names that embed ids. */
export function normalizeCall(call) {
  return call
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/(?<!\d)1[6-9]\d{11}(?!\d)/g, '<ts>')
    .replace(/(?<![A-Za-z0-9])(?=[a-z0-9]*\d[a-z0-9]*\d)(?=[a-z0-9]*[a-z][a-z0-9]*[a-z])[a-z0-9]{8,}(?![A-Za-z0-9])/g, '<id>');
}

/** Raw trace rows → { step: distinct calls in first-occurrence order }. */
export function groupTrace(rows, stepNames) {
  const steps = new Map(stepNames.map((name) => [name, []]));
  for (const row of rows) {
    const list = steps.get(row.step) ?? steps.set(row.step, []).get(row.step);
    const call = normalizeCall(row.call);
    if (!list.includes(call)) list.push(call);
  }
  return [...steps].map(([name, calls]) => ({ name, calls }));
}

/**
 * Combine several runs of one scene into a golden; throws if the call sets disagree.
 * `previous` (the golden being replaced) supplies each step's `unordered` list; entries no longer in the
 * step's calls are dropped.
 */
export function baselineFromRuns(scene, runs, previous = null) {
  const [first, ...rest] = runs;
  const steps = first.map((step, index) => {
    const sorted = JSON.stringify([...step.calls].sort());
    for (const run of rest) {
      const other = run[index];
      if (!other || other.name !== step.name || JSON.stringify([...other.calls].sort()) !== sorted) {
        const diff = diffCalls(step.calls, other?.calls ?? []);
        throw new Error(`${scene}/${step.name}: call set differs between runs (${diff.join('; ')}); cannot baseline`);
      }
    }
    const unordered = (previous?.steps?.find((s) => s.name === step.name)?.unordered ?? []).filter((call) => step.calls.includes(call));
    const order = JSON.stringify(commandOrder(step.calls, unordered));
    const sequence = rest.every((run) => JSON.stringify(commandOrder(run[index].calls, unordered)) === order);
    return { name: step.name, order: sequence ? 'sequence' : 'set', ...(unordered.length ? { unordered } : {}), calls: step.calls };
  });
  return { scene, steps };
}

/**
 * Order is enforced on commands only: listener (un)registration follows React effect scheduling.
 * `unordered` commands (a step's known races) are left out as well.
 */
export function commandOrder(calls, unordered = []) {
  const skip = new Set(unordered);
  return calls.filter((call) => !/^(listen|unlisten|emit):/.test(call) && !skip.has(call));
}

export function diffCalls(expected, actual) {
  return [...actual.filter((c) => !expected.includes(c)).map((c) => `+ ${c}`), ...expected.filter((c) => !actual.includes(c)).map((c) => `- ${c}`)];
}

/** Failures of `actual` (grouped trace) against a golden. */
export function compareTrace(golden, actual) {
  const failures = [];
  const names = golden.steps.map((step) => step.name);
  const actualNames = actual.map((step) => step.name);
  if (JSON.stringify(names) !== JSON.stringify(actualNames)) failures.push(`steps ${names.join(',')} → ${actualNames.join(',')}`);
  for (const step of golden.steps) {
    const now = actual.find((s) => s.name === step.name);
    if (!now) continue;
    const diff = diffCalls(step.calls, now.calls);
    for (const line of diff) failures.push(`${step.name}: ${line}`);
    // Compared over the commands both sides have, so an added or removed call cannot hide a reorder.
    const expectedOrder = commandOrder(step.calls, step.unordered).filter((call) => now.calls.includes(call));
    const actualOrder = commandOrder(now.calls, step.unordered).filter((call) => step.calls.includes(call));
    if (step.order === 'sequence' && JSON.stringify(expectedOrder) !== JSON.stringify(actualOrder)) {
      const at = expectedOrder.findIndex((call, i) => call !== actualOrder[i]);
      const scope = diff.length ? ' (among the commands on both sides)' : '';
      failures.push(`${step.name}: command order changed at #${at}${scope}: expected ${expectedOrder[at]}, got ${actualOrder[at]}`);
    }
  }
  return failures;
}

export function inventoryOf(goldens) {
  const commands = {};
  for (const golden of goldens) {
    for (const step of golden.steps) {
      for (const call of step.calls) {
        (commands[call] ??= new Set()).add(golden.scene);
      }
    }
  }
  return Object.fromEntries(Object.keys(commands).sort().map((call) => [call, [...commands[call]].sort()]));
}

function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const { newScenePage, readTrace } = await import('../../tests/visual/lib/page.mjs');
  const { SCENES, openScene, runSteps } = await import('../../tests/visual/lib/scenes.mjs');
  const { goldenRoot, outRoot, parseLayerArgs, repoRoot, startDemo, writeFile } = await import('../../tests/visual/lib/runner.mjs');
  const argv = process.argv.slice(2);
  const runsAt = argv.indexOf('--runs');
  const runs = runsAt >= 0 ? Number(argv.splice(runsAt, 2)[1]) : 3;
  const throttleAt = argv.indexOf('--throttle');
  const throttle = throttleAt >= 0 ? Number(argv.splice(throttleAt, 2)[1]) : 1;
  const opts = parseLayerArgs(argv);
  if (opts.mode === 'update' && throttle > 1) throw new Error('--throttle is for --check only (baselines are recorded unthrottled)');
  const goldenDir = path.join(goldenRoot, 'ipc');
  const scenes = SCENES.filter((scene) => !opts.scenes || opts.scenes.has(scene.id));
  const demo = await startDemo(opts);

  const traceScene = async (scene) => {
    const { context, page, errors } = await newScenePage(demo.browser, { viewport: 'desktop' });
    try {
      if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
      const ready = await openScene(page, demo.base, scene, 'light', { clock: true });
      await runSteps(page, scene);
      const rows = await readTrace(page);
      return { ready, errors, steps: groupTrace(rows, ['boot', ...scene.steps.map((step) => step.name)]) };
    } finally {
      await context.close();
    }
  };

  const failures = [];
  let flaky = 0;
  try {
    for (const scene of scenes) {
      const file = path.join(goldenDir, `${scene.id}.json`);
      if (opts.mode === 'update') {
        const results = [];
        for (let i = 0; i < runs; i++) results.push(await traceScene(scene));
        const broken = results.find((r) => !r.ready || r.errors.length);
        if (broken) {
          failures.push(`${scene.id}: ${broken.ready ? broken.errors[0] : 'never became ready'}`);
          continue;
        }
        try {
          const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
          const golden = baselineFromRuns(scene.id, results.map((r) => r.steps), previous);
          writeFile(file, stringify(golden));
          const describe = (s) => `${s.name} ${s.calls.length} (${s.order}${s.unordered ? `, unordered ${s.unordered.join(' ')}` : ''})`;
          console.log(`  wrote ${path.relative(repoRoot, file)}: ${golden.steps.map(describe).join(', ')}`);
        } catch (error) {
          failures.push(error.message);
        }
        continue;
      }
      if (!fs.existsSync(file)) {
        failures.push(`${scene.id}: no golden; generate with --update on the baseline commit`);
        continue;
      }
      const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
      let attempt = 0;
      let problems;
      let result;
      do {
        result = await traceScene(scene);
        problems = [
          ...(result.ready ? [] : ['never became ready']),
          ...result.errors,
          ...compareTrace(golden, result.steps),
        ];
      } while (problems.length && attempt++ < opts.retries);
      if (!problems.length) {
        if (attempt > 0) flaky++;
        console.log(`  ✓ ${scene.id}${attempt > 0 ? ` (matched on retry ${attempt})` : ''}`);
        continue;
      }
      writeFile(path.join(outRoot, 'ipc', `${scene.id}.json`), stringify({ scene: scene.id, steps: result.steps }));
      console.log(`  ✗ ${scene.id}`);
      for (const problem of problems.slice(0, 40)) console.log(`      ${problem}`);
      failures.push(`${scene.id}: ${problems.length} difference(s)`);
    }
    if (opts.mode === 'update' && !failures.length) {
      // Derived from every golden on disk, so a --scenes update keeps it in step as well.
      const files = SCENES.map((scene) => path.join(goldenDir, `${scene.id}.json`));
      if (files.every((file) => fs.existsSync(file))) {
        writeFile(path.join(goldenDir, 'inventory.json'), stringify(inventoryOf(files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8'))))));
      } else {
        console.log('  inventory.json not rewritten: some scenes have no golden yet');
      }
    }
  } finally {
    await demo.close();
  }
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  console.log(`[ipc-trace] ${opts.mode} ${failures.length ? 'FAILED' : 'passed'} (${scenes.length} scenes${flaky ? `, ${flaky} needed a retry` : ''})`);
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
