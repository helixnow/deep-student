import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './prod-reachable.mjs';

function fixture(code, modules, imports) {
  const root = fs.mkdtempSync('/tmp/opencode/reachability-');
  const entries = { 'index.ts': code, ...modules, 'tests/a.test.ts': imports,
    'TESTMAP.md': '| `src/a.rs::tests::test_a` | test | L1 | ported:host/plugins/p/tests/a.test.ts |' };
  for (const [file, text] of Object.entries(entries)) { const p = path.join(root, 'host/plugins/p', file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  return root;
}
test('resolves aliases/barrels and calls; disconnected function in same module is not reached by file import', () => {
  const root = fixture('import { live as run } from "./barrel.ts"; export default { apply(ctx) { ctx.commands.register("x", () => run()); } };',
    { 'barrel.ts': 'export { live, dead } from "./logic.ts";', 'logic.ts': 'export function live() { return 1; } export function dead() { return 2; }' },
    'import { live, dead } from "../barrel.ts"; test("test_a", () => { expect(live()).toBe(1); expect(dead()).toBe(2); });');
  try { const r = run({ root, changed: null }); assert.deepEqual(r.findings.map(f => f.symbol), ['dead']); assert.equal(r.impact.unreachableTests, 1); assert.equal(run({ root, changed: [] }).findings.length, 0); }
  finally { fs.rmSync(root, { recursive: true }); }
});
test('constructing a class alone does not publish methods; provide exposes public method paths', () => {
  for (const provided of [false, true]) {
    const root = fixture(`import { Service } from './service.ts'; export default { apply(ctx) { const s = new Service(); ctx.commands.register('x', () => 1); ${provided ? "ctx.provide('service', s);" : ''} } };`,
      { 'service.ts': 'import { work } from "./logic.ts"; export class Service { run() { return work(); } }', 'logic.ts': 'export function work() { return 1; }' },
      'import { work } from "../logic.ts"; test("test_a", () => expect(work()).toBe(1));');
    try { assert.equal(run({ root, changed: null }).findings.length, provided ? 0 : 1); }
    finally { fs.rmSync(root, { recursive: true }); }
  }
});
test('other-plugin harness imports are ignored; api.ts symbol called by another plugin is reachable', () => {
  const root = fixture('export default { apply(ctx) { ctx.commands.register("x", () => 1); } };',
    { 'api.ts': 'export { helper } from "./logic.ts";', 'logic.ts': 'export function helper() { return 1; }' },
    'import q from "../../q/index.ts"; import { helper } from "../logic.ts"; test("test_a", () => { q; expect(helper()).toBe(1); });');
  const q = path.join(root, 'host/plugins/q');
  fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, 'index.ts'), 'import { helper } from "../p/api.ts"; export default { apply(ctx) { ctx.commands.register("y", () => helper()); } };');
  try { const r = run({ root, changed: null }); assert.deepEqual(r.findings, []); assert.equal(r.tests[0].state, 'reachable'); }
  finally { fs.rmSync(root, { recursive: true }); }
});
test('symbols are charged only to the TESTMAP row whose case uses them', () => {
  const root = fixture('import { live } from "./logic.ts"; export default { apply(ctx) { ctx.commands.register("x", () => live()); } };',
    { 'logic.ts': 'export function live() { return 1; } export function dead() { return 2; }' },
    'import { live, dead } from "../logic.ts"; test("test_a", () => expect(live()).toBe(1)); test("test_b", () => expect(dead()).toBe(2));');
  fs.appendFileSync(path.join(root, 'host/plugins/p/TESTMAP.md'), '\n| `src/a.rs::tests::test_b` | test | L2 | ported:host/plugins/p/tests/a.test.ts |');
  try {
    const r = run({ root, changed: null });
    assert.deepEqual(r.findings.map(f => [f.symbol, f.testIds]), [['dead', ['src/a.rs::tests::test_b']]]);
    assert.deepEqual(r.tests.map(t => t.state), ['reachable', 'unreachable']);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('dead nested declaration does not create an edge and type-only imports are excluded', () => {
  const root = fixture('import { work } from "./logic.ts"; export default { apply(ctx) { function never() { work(); } ctx.commands.register("x", () => 1); } };',
    { 'logic.ts': 'export function work() { return 1; } export interface Shape { x: number }' },
    'import { work, type Shape } from "../logic.ts"; test("test_a", () => expect(work()).toBe(1));');
  try { assert.deepEqual(run({ root, changed: ['host/plugins/p/index.ts'] }).findings.map(f => f.symbol), ['work']); }
  finally { fs.rmSync(root, { recursive: true }); }
});

function launchFixture(body) {
  return fixture('import { connect } from "./logic.ts"; export default { apply(ctx) { ctx.commands.register("x", () => connect({})); } };', {
    'logic.ts': 'export function connect(config) { return { name: "server", config }; }',
    'equivalence/runtime.ts': 'export function launchSettings() { return { command: process.execPath, env: {} }; } export function dead() { return 2; }',
    'tests/fixtures/server.mjs': 'process.stdout.write("server");',
  }, `import { fileURLToPath as toPath } from 'node:url';
import { launchSettings as settings, dead } from '../equivalence/runtime.ts';
import { connect } from '../logic.ts';
test('test_a', () => {
  const script = toPath(new URL('./fixtures/server.mjs', import.meta.url));
  ${body}
});`);
}
const launch = `const runtime = settings();
  const transport = connect({ type: 'stdio', command: runtime.command, args: [script], env: runtime.env });`;

test('local-script command/env assembly is fixture input; reachable consumer remains the subject', () => {
  const root = launchFixture(`${launch} expect(transport.name).toBe('server');`);
  try {
    const r = run({ root, changed: ['host/plugins/p/tests/a.test.ts'] });
    assert.deepEqual(r.findings, []);
    assert.equal(r.tests[0].state, 'reachable');
    assert.deepEqual(r.fixtureInputs.map(f => [f.symbol, f.declaration, f.script]), [
      ['settings', 'host/plugins/p/equivalence/runtime.ts:1', 'host/plugins/p/tests/fixtures/server.mjs'],
    ]);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('a directly asserted dead function in the very same helper module is still unreachable', () => {
  const root = launchFixture(`${launch} expect(transport.name).toBe('server'); expect(dead()).toBe(2);`);
  try {
    const r = run({ root, changed: null });
    assert.equal(r.tests[0].state, 'unreachable');
    assert.deepEqual(r.findings.map(f => [f.symbol, f.testIds]), [['dead', ['src/a.rs::tests::test_a']]]);
    assert.equal(r.fixtureInputs.length, 1);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('live/dead argument calls, function aliases, and observed or escaped return values are not exempted', () => {
  const counterexamples = [
    'expect(connect(dead()).config).toBe(2);',
    'const result = dead(); expect(connect(result).config).toBe(2);',
    'const invoke = settings; const result = invoke(); expect(result.command).not.toBe("");',
    'const result = settings(); const alias = result; expect(alias.command).not.toBe("");',
    `${launch} expect(runtime.command).not.toBe('');`,
    `${launch} const escaped = { runtime }; expect(escaped.runtime.env).toEqual({});`,
    'const runtime = settings(); expect({ type: "stdio", command: runtime.command, args: [script], env: runtime.env }).toBeDefined();',
  ];
  for (const body of counterexamples) {
    const root = launchFixture(body);
    try {
      const r = run({ root, changed: null });
      assert.equal(r.tests[0].state, 'unreachable', body);
      assert.deepEqual(r.findings.map(f => f.symbol), [body.includes('dead()') ? 'dead' : 'settings'], body);
      assert.deepEqual(r.fixtureInputs, [], body);
    } finally { fs.rmSync(root, { recursive: true }); }
  }
});

test('fixture classification is per expression and per case, not per imported symbol', () => {
  const root = launchFixture(`${launch} expect(settings().command).not.toBe('');`);
  fs.appendFileSync(path.join(root, 'host/plugins/p/tests/a.test.ts'), '\ntest("test_b", () => expect(settings().env).toEqual({}));');
  fs.appendFileSync(path.join(root, 'host/plugins/p/TESTMAP.md'), '\n| `src/a.rs::tests::test_b` | test | L2 | ported:host/plugins/p/tests/a.test.ts |');
  try {
    const r = run({ root, changed: null });
    assert.deepEqual(r.tests.map(t => t.state), ['unreachable', 'unreachable']);
    assert.deepEqual(r.findings.map(f => [f.symbol, f.testIds]), [['settings', ['src/a.rs::tests::test_a', 'src/a.rs::tests::test_b']]]);
    assert.deepEqual(r.fixtureInputs.map(f => f.id), ['src/a.rs::tests::test_a']);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('harness-only launch without a resolved tested production target remains unknown', () => {
  const root = launchFixture(`function harness(config) { return config; } ${launch.replace('connect({', 'harness({')}`);
  try {
    const r = run({ root, changed: null });
    assert.deepEqual(r.findings, []);
    assert.equal(r.fixtureInputs.length, 1);
    assert.equal(r.tests[0].state, 'unknown');
    assert.match(r.unknown[0].reason, /no statically resolved production symbol/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
