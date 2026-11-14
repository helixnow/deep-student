// Throwaway recording tree for g3-batch / g3-supervise CLI tests: the real record/ code,
// fake A/B runners (fake-g3-runner.mjs), small scenario suites, and PATH shims for the
// Linux-only wrappers. The unshare shim drops the namespace and its init script entirely,
// so nothing here needs (or emulates) a PID namespace.
// makeSplitRepo adds what A-store / B-only input fingerprints read: the real seed generator
// (its import closure) and the real normalization approvals, so A2-normalized compares run.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const FAKE_RUNNER = fileURLToPath(new URL('./fake-g3-runner.mjs', import.meta.url));
export const SUITE = 'fixtures/w13/suite.json';
const SHIMS = {
  unshare: 'while [ "$#" -gt 0 ] && [ "$1" != g3-worker ]; do shift; done; shift; exec "$@"',
  'xvfb-run': '[ "$1" = -a ] && shift; exec "$@"',
  'dbus-run-session': '[ "$1" = -- ] && shift; exec "$@"',
  ip: 'exit 0',
};

const scenario = id => ({ id, seed: 'empty', steps: [{ cmd: 'get_app_version' }], capture: { events: false, db: [] }, normalize: [] });
export const suiteText = (domain, ids) => JSON.stringify({ domain, commands: ['get_app_version'], scenarios: ids.map(scenario) }, null, 2);

export function makeBatchRepo(root, ids, { suites = { [SUITE]: ids }, inputFiles = null } = {}) {
  const copy = (from, to = from) => { mkdirSync(dirname(join(root, to)), { recursive: true }); cpSync(join(REPO, from), join(root, to), { recursive: true }); };
  copy('scripts/electron-migration/record');
  copy('scripts/electron-migration/lib/resource-budget.mjs');
  // The real 768-command denominator, so g3-report runs unmodified in this tree.
  copy('scripts/electron-migration/frontend-audit/wave0-inventory.json');
  // g3-compare's DB comparison (better-sqlite3 via the shared node_modules, as on the server).
  copy('host/e2e/data-compat/__fixtures__/database-state.ts');
  symlinkSync(realpathSync(join(REPO, 'node_modules')), join(root, 'node_modules'));
  mkdirSync(join(root, 'electron'));
  mkdirSync(join(root, 'fixtures/differential/g3'), { recursive: true });
  if (inputFiles) {
    for (const file of inputFiles) copy(file);
    copy('fixtures/differential/g3/normalize-approvals.json');
  } else {
    // The batch only hashes the approvals; this tree needs no real normalization rules.
    writeFileSync(join(root, 'fixtures/differential/g3/normalize-approvals.json'), '{"schema":"g3-normalize-approvals/v1","rules":[]}\n');
  }
  for (const runner of ['g3-run-a.mjs', 'g3-run-b.mjs']) cpSync(FAKE_RUNNER, join(root, 'scripts/electron-migration/record', runner));
  for (const [file, list] of Object.entries(suites)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), suiteText(file === SUITE ? 'w13' : file.split('/')[2], list));
  }
  writeFileSync(join(root, '.gitignore'), 'out*/\nstore*/\nbin/\nnode_modules\n*.receipt.json\npids\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture recording tree');
  // A side build receipt: the fake runner never opens it, provenance only hashes it.
  const receipt = join(root, 'a-build.receipt.json');
  writeFileSync(receipt, JSON.stringify({ schema: 'wp043-tauri-build', job: 'fixture-build', code: 0, binary: process.execPath, binarySha256: 'f'.repeat(64) }));
  /** A new commit of the recording tree (a later B revision); returns its head. */
  const commit = (message, files) => {
    for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return { root, receipt, head: git('rev-parse', 'HEAD'), commit, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` } };
}

/** A tree for A-store / B-only runs: `suites` maps suite file → scenario ids. */
export async function makeSplitRepo(root, suites) {
  const { importClosure, SEED_MODULE } = await import('../../../../scripts/electron-migration/record/g3-inputs.mjs');
  return makeBatchRepo(root, null, { suites, inputFiles: importClosure(REPO, [SEED_MODULE]).files.map(item => item.file) });
}
