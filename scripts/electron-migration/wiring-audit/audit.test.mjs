import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { audit, checkFailed, createScanner, findCycles, loadPlugins } from './audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixtures');
const consumer = path.join(root, 'host/plugins/consumer/index.ts');
const unused = path.join(root, 'host/plugins/consumer/unused.ts');
const bridge = path.join(root, 'host/plugins/consumer/tests/bridge.ts');
const scanner = createScanner([consumer, unused, bridge]);
const report = await audit(root);

test('loads computed/imported runtime meta without executing apply()', async () => {
  const loaded = await loadPlugins(root);
  assert.deepEqual(loaded.loadErrors, []);
  const provider = loaded.plugins.find(p => p.id === 'fixture.provider');
  assert.deepEqual(provider.provides, ['real', 'rpc', 'unused', 'remoteOnly']);
  assert.deepEqual(provider.commands, ['fixture_command']);
  assert.deepEqual(provider.remote, { rpc: ['run'], remoteOnly: ['run'] });
});

test('extracts typed Context properties, bracket access, constants and child injections', () => {
  const refs = scanner.scan(consumer).references;
  for (const name of ['real', 'old@1', 'bracketMissing', 'rpc', 'childMissing', 'wrappedMissing']) {
    assert.ok(refs.some(r => r.name === name), name);
  }
  assert.equal(refs.find(r => r.name === 'old@1').line, 9);
  assert.equal(refs.find(r => r.name === 'rpc').kind, 'child-inject');
});

test('does not turn comments, strings, tool ctx fields or non-plugin apply into services', () => {
  const refs = scanner.scan(consumer).references;
  for (const name of ['commentOnly', 'commentMissing', 'stringOnly', 'toolField', 'notAService', 'apply']) {
    assert.ok(!refs.some(r => r.name === name), name);
  }
});

test('type-only imports do not make dormant production consumers reachable', () => {
  assert.ok(!scanner.imports(consumer).includes(unused));
  assert.ok(!report.missing.some(m => m.name === 'dormant'));
  assert.ok(report.dormantReferences.some(m => m.name === 'dormant'));
});

test('test-only bridges are reported but cannot satisfy production dependencies', () => {
  assert.ok(report.bridges.some(b => b.name === 'real' && b.file.endsWith('tests/bridge.ts')));
  assert.ok(report.bridges.some(b => b.name === 'rpc'));
  assert.ok(report.missing.some(m => m.name === 'old@1'));
  assert.ok(!report.services.some(s => s.name === 'old@1'));
});

test('captures failure diagnostics, without treating them as dependency names', () => {
  assert.ok(report.failures.some(f => f.text.includes('not available') && f.reachable));
  assert.ok(!report.missing.some(m => m.name.includes('not available')));
});

test('captures silent guards on locally resolved services without requiring an error string', () => {
  assert.ok(report.fallbacks.some(f => f.text.includes('optional === undefined') && f.reachable));
});

const p = (id, provides, inject = []) => ({ id, provides, inject });
test('finds all hard-inject SCCs, including self dependency, preserving service edges', () => {
  const cycles = findCycles([p('a', ['one'], ['two']), p('b', ['two'], ['one']),
    p('self', ['own'], ['own']), p('leaf', ['leaf'], ['one'])]);
  assert.deepEqual(cycles.map(c => c.plugins), [['a', 'b'], ['self']]);
  assert.equal(cycles[0].edges.length, 2);
  assert.equal(cycles[1].edges[0].service, 'own');
});

test('child-inject/lazy gets do not create false startup cycles', () => {
  assert.deepEqual(report.cycles, []);
  assert.equal(report.services.find(s => s.name === 'rpc').consumers[0].kind, 'child-inject');
});

test('--check fails for dangling names, cycles and load errors, not for isolated services alone', () => {
  assert.equal(checkFailed(report), true);
  const clean = { missing: [], cycles: [], loadErrors: [] };
  assert.equal(checkFailed(clean), false);
  assert.equal(checkFailed({ ...clean, cycles: [{}] }), true);
  assert.equal(checkFailed({ ...clean, loadErrors: [{}] }), true);
});

test('CLI --check returns 1 with a report; normal inventory is non-blocking', () => {
  const cli = path.join(here, 'audit.mjs');
  const checked = spawnSync(process.execPath, [cli, '--root', root, '--json', '--check'], { encoding: 'utf8' });
  assert.equal(checked.status, 1, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).summary.services, 4);
  const inventory = spawnSync(process.execPath, [cli, '--root', root, '--json'], { encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stderr);
});

test('new unused services need review, rather than being hidden by presence of commands', () => {
  assert.equal(report.services.find(s => s.name === 'unused').classification, 'needs-review');
  assert.equal(report.services.find(s => s.name === 'remoteOnly').classification, 'remote-surface');
  assert.equal(report.summary.missingHardInject, 0);
  assert.ok(report.missing.some(s => s.name === 'childMissing'));
});

test('reports profile omissions without hiding omitted plugin dependencies', () => {
  assert.deepEqual(report.profileOmissions.map(p => p.id), ['fixture.consumer']);
  assert.equal(report.summary.profileOmissions, 1);
  assert.ok(report.missing.some(s => s.name === 'old@1'));
});

test('fixtures carry no *.test/*.spec names that vitest would collect as suites', () => {
  // vitest.host.config.ts includes scripts/electron-migration/**/*.test.ts; fixture
  // test bridges are detected by their tests/ directory instead.
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  assert.deepEqual(walk(root).filter(f => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f)), []);
});
