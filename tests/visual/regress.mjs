#!/usr/bin/env node
/**
 * FE-A1 umbrella: run the regression layers in order and print one summary.
 *
 *   bin/heavy node tests/visual/regress.mjs [--layers slots,dom,ipc,screenshots,motion,chunks,evidence] [--build] [--main-dist DIR] [--base REV]
 *
 * Always --check (baselines are only rewritten through each layer's own --update).
 * --build rebuilds the demo shell first; the chunk layer builds the main app itself unless --main-dist is given.
 * Before the browser layers a boot preflight (lib/boot-check.mjs) checks that the demo shell boots; if it
 * does not, those layers are skipped with the cause instead of failing every scene.
 * --base REV lists the commits in REV..HEAD flagged `[待审]` (user-visible changes awaiting review) and the
 * files they touch, so a failing layer's diffs can be split into flagged intended changes and regressions.
 */
import { spawnSync } from 'node:child_process';
import { repoRoot, runBuildChild, defaultDemoDir } from './lib/build.mjs';

export const LAYERS = {
  slots: ['scripts/plugins/slot-snapshot.mjs', '--check'],
  dom: ['tests/visual/dom-golden.mjs', '--check'],
  ipc: ['scripts/plugins/ipc-trace.mjs', '--check'],
  screenshots: ['tests/visual/screenshots.mjs', '--check'],
  motion: ['tests/visual/motion-check.mjs', '--check'],
  chunks: ['scripts/plugins/chunk-graph.mjs', '--check'],
  evidence: ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.config.ts', 'src/ui-plugins/testing/__tests__/evidence', '--maxWorkers=2'],
};
export const BROWSER_LAYERS = ['dom', 'ipc', 'screenshots', 'motion'];

/** `--layers a,b` (default: all, in LAYERS order) → the selected names and the unknown ones. */
export function selectLayers(arg) {
  const selected = (arg ?? Object.keys(LAYERS).join(',')).split(',');
  return { selected, unknown: selected.filter((name) => !LAYERS[name]) };
}

/**
 * `git log --format='%h %s'` lines → the commits flagged `[待审]` among the leading title tags
 * (`[W18][待审] …`), not titles that merely mention it.
 */
export function flaggedCommits(logLines) {
  return logLines.filter((line) => /^\S+ (?:\[[^\]]*\]\s*)*\[待审\]/.test(line));
}

/** The boot preflight and `--build` only matter when a browser layer is selected. */
export function needsDemo(selected) {
  return selected.some((name) => BROWSER_LAYERS.includes(name));
}

/** Arguments of one layer's child process; `--main-dist` reaches the chunk layer only. */
export function layerArgs(name, { mainDist } = {}) {
  const args = [...LAYERS[name]];
  if (name === 'chunks' && mainDist) args.push('--dist', mainDist);
  return args;
}

/** Environment of one layer's child process: the evidence vitest run needs a build number, a given one wins. */
export function layerEnv(name, env) {
  return name === 'evidence' ? { ...env, DEEP_STUDENT_BUILD_NUMBER: env.DEEP_STUDENT_BUILD_NUMBER ?? '20000' } : env;
}

/** Exit status of the whole run: a failed boot preflight or any failed (not skipped) layer. */
export function runFailed(results, bootProblems) {
  return bootProblems.length > 0 || results.some((r) => r.status !== 0 && r.status !== 'skip');
}

/** The closing summary: the boot problem first, then one line per layer in run order. */
export function summaryLines(results, bootProblems) {
  const lines = ['FE-A1 regression summary'];
  if (bootProblems.length) lines.push(`  ✗ ${'boot'.padEnd(12)} ${bootProblems[0]}`);
  for (const r of results) {
    const mark = r.status === 'skip' ? '-' : r.status === 0 ? '✓' : '✗';
    lines.push(`  ${mark} ${r.name.padEnd(12)} ${r.status === 'skip' ? 'skipped (demo does not boot)' : `exit ${r.status}  ${r.seconds}s`}`);
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const { selected, unknown } = selectLayers(value('--layers'));
  if (unknown.length) {
    console.error(`unknown layer(s): ${unknown.join(', ')}; known: ${Object.keys(LAYERS).join(', ')}`);
    process.exit(2);
  }
  const demo = needsDemo(selected);
  if (argv.includes('--build') && demo) {
    const status = runBuildChild('demo', defaultDemoDir);
    if (status !== 0) process.exit(status);
  }

  let bootProblems = [];
  if (demo) {
    console.log('\n### preflight: demo boot (tests/visual/lib/boot-check.mjs)');
    const { bootCheck } = await import('./lib/boot-check.mjs');
    bootProblems = await bootCheck(defaultDemoDir);
    for (const problem of bootProblems) console.log(`  ✗ ${problem}`);
    console.log(`[boot-check] ${bootProblems.length ? 'FAILED — browser layers skipped' : 'passed'}`);
  }

  const results = [];
  for (const name of selected) {
    if (bootProblems.length && BROWSER_LAYERS.includes(name)) {
      results.push({ name, status: 'skip', seconds: 0 });
      continue;
    }
    const args = layerArgs(name, { mainDist: value('--main-dist') });
    console.log(`\n### layer ${name}: node ${args.join(' ')}`);
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env: layerEnv(name, process.env) });
    results.push({ name, status: result.status ?? 1, seconds: Math.round((Date.now() - started) / 1000) });
  }

  const base = value('--base');
  if (base) {
    const log = spawnSync('git', ['log', '--format=%h %s', '--grep=\\[待审\\]', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8' });
    const flagged = flaggedCommits(log.stdout.trim().split('\n'));
    console.log(`\n[待审] commits in ${base}..HEAD: ${flagged.length}`);
    for (const line of flagged) {
      const sha = line.split(' ')[0];
      const files = spawnSync('git', ['show', '--name-only', '--format=', sha], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
      console.log(`  ${line}`);
      for (const file of files.slice(0, 12)) console.log(`      ${file}`);
      if (files.length > 12) console.log(`      … ${files.length - 12} more files`);
    }
    if (flagged.length && runFailed(results, [])) {
      console.log('  A diff counts as intended only if one of these commits explains it; everything else is a regression.');
    }
  }

  console.log(`\n${summaryLines(results, bootProblems).join('\n')}`);
  process.exit(runFailed(results, bootProblems) ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
