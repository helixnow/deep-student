// g3-slice: the declaration-level slice the A fingerprint (g3-inputs/v2) hashes. Its rules on
// small modules; then the slice of the real A process against what runs: every function V8
// sees executed while the A runner loads, its helpers run, the LLM, cloud and MCP services
// start, answer and stop, and the MCP stdio program serves a session, lies inside a statement
// of the slice; and loading the seed generator and building every seed (its product imports
// are not on the slice) leaves the process globals, environment, listeners and handles as
// they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL, arrayText, evaluateSlice, excludedBindings, literalStrings, pureExpression, sliceFiles, sliceProgram } from '../../../scripts/electron-migration/record/g3-slice.mjs';
import { A_ENTRY, PROGRAMS, SEED_MODULE, SERVICE_MODULES, aLaunch, aSlice } from '../../../scripts/electron-migration/record/g3-inputs.mjs';

const ts = createRequire(import.meta.url)('typescript');
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const readRepo = path => { try { return readFileSync(join(REPO, path)); } catch { return null; } };
const reader = files => path => (Object.hasOwn(files, path) ? Buffer.from(files[path]) : null);
const entryOf = (slice, file) => slice.files.find(item => item.file === file);
const statementsOf = (slice, file) => entryOf(slice, file)?.statements ?? null;

test('effects of every loaded module run; a declaration is in only when included code names it; unused bindings are free to change', () => {
  const read = reader({
    'a.mjs': "import { used } from './b.mjs';\nimport './c.mjs';\nconst unused = () => 1;\nfunction helper() { return used(); }\nconsole.log(helper());\n",
    'b.mjs': "export const used = () => other();\nfunction other() { return 1; }\nexport function notUsed() { return 2; }\nexport const table = { x: 1 };\nsideEffect();\nfunction sideEffect() {}\n",
    'c.mjs': 'globalThis.loaded = true;\nexport const never = 1;\n',
  });
  const slice = sliceProgram({ read, entries: [{ file: 'a.mjs', program: true }] });
  assert.deepEqual(slice.files.map(item => item.file), ['a.mjs', 'b.mjs', 'c.mjs']);
  assert.deepEqual(statementsOf(slice, 'a.mjs'), ['function helper() { return used(); }', 'console.log(helper());']);
  assert.deepEqual(statementsOf(slice, 'b.mjs'), ['export const used = () => other();', 'function other() { return 1; }', 'sideEffect();', 'function sideEffect() {}']);
  assert.deepEqual(statementsOf(slice, 'c.mjs'), ['globalThis.loaded = true;']);
  assert.deepEqual(entryOf(slice, 'a.mjs').imports, [{ specifier: './b.mjs', bindings: ['used=used'] }, { specifier: './c.mjs', bindings: [] }]);
  assert.deepEqual(entryOf(slice, 'b.mjs').exports, [['used', 'used']]);
  assert.deepEqual(excludedBindings(slice, read, 'a.mjs'), ['unused']);
  assert.deepEqual(excludedBindings(slice, read, 'b.mjs'), ['notUsed', 'table']);
  assert.deepEqual(excludedBindings(slice, read, 'c.mjs'), ['never']);

  // Editing what is out leaves every file digest; editing what is in changes that file's.
  const before = sliceFiles(slice);
  const edit = (file, from, to) => sliceFiles(sliceProgram({ read: path => (path === file ? Buffer.from(read(path).toString().replace(from, to)) : read(path)), entries: [{ file: 'a.mjs', program: true }] }));
  assert.deepEqual(edit('b.mjs', 'return 2', 'return 3'), before);
  assert.deepEqual(edit('a.mjs', '() => 1', '() => 9'), before);
  const changed = edit('b.mjs', 'return 1', 'return 4');
  assert.deepEqual(Object.keys(before).filter(file => before[file] !== changed[file]), ['b.mjs']);

  // A module with nothing included and no import that runs code is not an input at all.
  const typesOnly = sliceProgram({ read: reader({ 'e.mjs': "import { t } from './t.mjs';\nexport const x = () => t;\n", 't.mjs': 'export const t = 1;\n' }), entries: [{ file: 'e.mjs' }] });
  assert.deepEqual(typesOnly.files, []);
});

test('pure declarations and effects: literals and functions bind; calls, heritage, static parts and decorators evaluate', () => {
  const pure = text => pureExpression(ts.createSourceFile('x.ts', `(${text});`, ts.ScriptTarget.Latest, true).statements[0].expression.expression);
  for (const text of ['1', '-1', "'s'", '`t`', '/r/', 'true', 'null', 'undefined', '() => 1', 'function () {}', "[1, 'a', () => 2]", '{ a: 1, b() {}, get c() { return 1; } }', 'class { m() {} }', '1 as number'])
    assert.equal(pure(text), true, text);
  for (const text of ['f()', 'x', 'new Map()', '`${x}`', '[...xs]', '{ [k]: 1 }', '{ ...o }', 'class extends B {}', 'class { static s = f(); }', 'class { static { f(); } }', '!1', 'await x'])
    assert.equal(pure(text), false, text);

  const read = reader({
    'p.ts': [
      'class Base {}', 'class Derived extends Base {}', 'class Plain { m() { return 1; } }', 'enum E { A }', 'export default function () { return 1; }',
      'interface I { a: number }', 'type T = string;', 'declare const d: number;', 'const helper = 1;', 'export function shadow() { const helper = 2; return helper; }',
    ].join('\n'),
  });
  const slice = sliceProgram({ read, entries: [{ file: 'p.ts', names: ['shadow'] }] });
  assert.deepEqual(statementsOf(slice, 'p.ts'), ['class Base {}', 'class Derived extends Base {}', 'enum E { A }', 'const helper = 1;',
    'export function shadow() { const helper = 2; return helper; }'], 'heritage and enums evaluate; a shadowing local counts as a reference');
  assert.deepEqual(statementsOf(sliceProgram({ read, entries: [{ file: 'p.ts', names: ['default'] }] }), 'p.ts').at(-1), 'export default function () { return 1; }');
});

test('imports: named, default, namespace, re-exports, star exports and dynamic imports request what they name; packages are externals', () => {
  const read = reader({
    'main.mjs': [
      "import def, { a as aa } from './lib.mjs';", "import * as ns from './ns.mjs';", "import { join } from 'node:path';", "import { pick } from 'pkg/sub';",
      "export { r } from './re.mjs';", "export * from './star.mjs';",
      "const { only } = await import('./dyn.mjs');", "const whole = await import('./whole.mjs');", "const url = await import(new URL('./u.mjs', import.meta.url));",
      'console.log(def, aa, ns, join, pick, only, whole, url);',
    ].join('\n'),
    'lib.mjs': 'export default function d() { return 1; }\nexport const a = 1;\nexport const b = 2;\n',
    'ns.mjs': 'export const x = 1;\nexport const y = 2;\n',
    're.mjs': 'export const r = 1;\nexport const s = 2;\n',
    'star.mjs': 'export const st = 1;\n',
    'dyn.mjs': 'export const only = 1;\nexport const other = 2;\n',
    'whole.mjs': 'export const w1 = 1;\nexport const w2 = 2;\n',
    'u.mjs': 'export const u1 = 1;\n',
  });
  const slice = sliceProgram({ read, entries: [{ file: 'main.mjs', program: true, names: ['r', 'st'] }] });
  assert.deepEqual(statementsOf(slice, 'lib.mjs'), ['export default function d() { return 1; }', 'export const a = 1;']);
  assert.deepEqual(statementsOf(slice, 'ns.mjs'), ['export const x = 1;', 'export const y = 2;'], 'a namespace import requests every export');
  assert.deepEqual(statementsOf(slice, 're.mjs'), ['export const r = 1;']);
  assert.deepEqual(statementsOf(slice, 'star.mjs'), ['export const st = 1;']);
  assert.deepEqual(statementsOf(slice, 'dyn.mjs'), ['export const only = 1;'], 'a destructured dynamic import requests its names');
  assert.deepEqual(statementsOf(slice, 'whole.mjs'), ['export const w1 = 1;', 'export const w2 = 2;'], 'an undestructured one requests all');
  assert.deepEqual(statementsOf(slice, 'u.mjs'), ['export const u1 = 1;'], 'import(new URL(literal, import.meta.url)) is that module');
  assert.deepEqual(entryOf(slice, 'main.mjs').externals, ['node:path#join', 'pkg/sub#pick']);
  assert.ok(!entryOf(slice, 'main.mjs').exports.some(([name]) => name === ALL));
});

test('a CLI main guard runs only in the process entry; contained, stop, boundaries and resources', () => {
  const guard = "if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { run(); }";
  const read = reader({
    'cli.mjs': `import { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\nexport const api = () => 1;\n${guard}\nfunction run() { return 2; }\n`,
    'user.mjs': "import { api } from './cli.mjs';\napi();\n",
    'seed.mjs': "import { product } from './product.mjs';\nexport const SEED_NAMES = product();\nexport function createSeed() { return product(); }\nexport function resolveSeed(name) { return name; }\nexport function bad() { return product(); }\n",
    'product.mjs': 'export const product = () => [];\nglobalThis.p = 1;\n',
    'runner.mjs': "import { createSeed, SEED_NAMES, resolveSeed } from './seed.mjs';\nimport { svc } from './svc.mjs';\nconsole.log(createSeed, SEED_NAMES, resolveSeed('x'), svc);\nconst data = new URL('./data.json', import.meta.url);\nconst listed = NAMES.map(name => new URL(name, import.meta.url));\nconst NAMES = ['a.txt'];\n",
    'svc.mjs': 'export const svc = 1;\n',
  });
  const entry = sliceProgram({ read, entries: [{ file: 'cli.mjs', program: true }] });
  assert.deepEqual(statementsOf(entry, 'cli.mjs'), [guard, 'function run() { return 2; }']);
  const imported = sliceProgram({ read, entries: [{ file: 'user.mjs', program: true }] });
  assert.deepEqual(statementsOf(imported, 'cli.mjs'), ['export const api = () => 1;'], 'elsewhere the guard is false and its body unreachable');

  const options = { read, entries: [{ file: 'runner.mjs', program: true }], contained: ['seed.mjs'], stop: { 'seed.mjs': ['createSeed', 'SEED_NAMES'] },
    boundaries: { 'svc.mjs': 'svc' }, resources: { 'runner.mjs': () => ['a.txt'] } };
  const slice = sliceProgram(options);
  assert.deepEqual(statementsOf(slice, 'seed.mjs'), ['export function resolveSeed(name) { return name; }'], 'stopped names and the contained module\'s effects are left out');
  assert.equal(entryOf(slice, 'product.mjs'), undefined, 'a contained module\'s imports are not followed');
  assert.deepEqual(slice.boundaries, { 'svc.mjs': ['<load>', 'svc'] });
  assert.deepEqual(slice.resources, ['a.txt', 'data.json']);
  assert.throws(() => sliceProgram({ ...options, resources: {} }), /computed resource new URL\(name, import\.meta\.url\) without a declared file list/);
  assert.throws(() => sliceProgram({ ...options, stop: {} , entries: [{ file: 'seed.mjs', names: ['bad'] }] }), /included code uses product of \.\/product\.mjs, which is not followed/);
});

test('followContained: a binding a contained module\'s included code uses is taken from its import, which is contained in turn; effects that can reach included bindings count', () => {
  const read = reader({
    'runner.mjs': "import { resolveSeed, SEED_NAMES } from './seed.mjs';\nconsole.log(resolveSeed('x'), SEED_NAMES);\n",
    'seed.mjs': [
      "import { LISTED, available } from './listed.mjs';", "import { unrelated } from './other.mjs';",
      'export const SEED_NAMES = [...available()];', 'function describe(name) { return LISTED.includes(name) ? \'listed\' : \'plain\'; }',
      'export function resolveSeed(name) { return describe(name); }', 'export function createSeed() { return unrelated(); }',
    ].join('\n'),
    'listed.mjs': [
      "import { deep } from './deep.mjs';", "import './loads.mjs';", "export const LISTED = ['l1'];", 'export function available() { return deep(); }',
      'globalThis.listedLoaded = true;', 'register(LISTED);', 'function register(list) { list.push(extra()); }', 'function extra() { return EXTRA; }',
      "const EXTRA = 'l2';", 'tweak();', 'function tweak() { LISTED.sort(); }', 'unrelatedEffect();', 'function unrelatedEffect() {}',
    ].join('\n'),
    'deep.mjs': 'export const deep = () => [];\nglobalThis.deep = 1;\n',
    'loads.mjs': 'globalThis.loads = 1;\n',
    'other.mjs': 'export const unrelated = () => 1;\n',
  });
  const options = { read, entries: [{ file: 'runner.mjs', program: true }], contained: ['seed.mjs'], stop: { 'seed.mjs': ['createSeed', 'SEED_NAMES'] } };
  assert.throws(() => sliceProgram(options), /seed\.mjs: included code uses LISTED of \.\/listed\.mjs, which is not followed/, 'still the default');
  const slice = sliceProgram({ ...options, followContained: true });
  assert.deepEqual(slice.files.map(item => item.file), ['listed.mjs', 'runner.mjs', 'seed.mjs']);
  assert.deepEqual(statementsOf(slice, 'seed.mjs'), ["function describe(name) { return LISTED.includes(name) ? 'listed' : 'plain'; }",
    'export function resolveSeed(name) { return describe(name); }']);
  assert.deepEqual(entryOf(slice, 'seed.mjs').imports, [{ specifier: './listed.mjs', bindings: ['LISTED=LISTED'] }]);
  assert.deepEqual(statementsOf(slice, 'listed.mjs'), ["export const LISTED = ['l1'];", 'register(LISTED);', 'function register(list) { list.push(extra()); }',
    'function extra() { return EXTRA; }', "const EXTRA = 'l2';", 'tweak();', 'function tweak() { LISTED.sort(); }'],
    'the binding, and the effects that can change it directly or through the module\'s functions; not its other effects or imports');
  assert.deepEqual(entryOf(slice, 'listed.mjs').imports, [], 'a contained module keeps only imports its included code uses');

  // A module reached through a contained one and also loaded normally is loaded in full.
  const both = sliceProgram({ ...options, followContained: true, read: path => (path === 'runner.mjs'
    ? Buffer.from("import { resolveSeed } from './seed.mjs';\nimport './listed.mjs';\nconsole.log(resolveSeed('x'));\n") : read(path)) });
  assert.ok(statementsOf(both, 'listed.mjs').includes('globalThis.listedLoaded = true;'));
  assert.deepEqual(statementsOf(both, 'deep.mjs'), ['globalThis.deep = 1;']);
  assert.throws(() => sliceProgram({ ...options, followContained: true, read: path => (path === 'seed.mjs'
    ? Buffer.from("export const SEED_NAMES = [];\nexport async function resolveSeed() { return (await import('./listed.mjs')).LISTED; }\n") : read(path)) }),
  /included code imports \.\/listed\.mjs, which is not followed/, 'a dynamic import from a contained module still throws');
});

test('what cannot be analysed throws or keeps the whole file', () => {
  const sliceOf = text => sliceProgram({ read: reader({ 'x.mjs': text, 'y.mjs': 'export const y = 1;\n' }), entries: [{ file: 'x.mjs', program: true }] });
  for (const [text, message] of [
    ["const name = 'y';\nawait import(`./${name}.mjs`);\n", /computed dynamic import/],
    ["eval('1');\n", /uses eval/],
    ["require('./y.mjs');\n", /uses require/],
    ["new Function('return 1')();\n", /uses Function\(\)/],
    ['console.log(import.meta.dirname);\n', /uses import\.meta\.dirname/],
  ]) assert.throws(() => sliceOf(text), message, text);
  assert.match(entryOf(sliceOf('const = ;\n'), 'x.mjs').whole, /^parse error/);
  const whole = (file, text) => entryOf(sliceProgram({ read: reader({ 'm.ts': `import './${file}';\n`, [file]: text }), entries: [{ file: 'm.ts', program: true }] }), file);
  assert.equal(whole('data.json', '{}').whole, 'not code');
  assert.equal(whole('cjs.ts', 'export = 1;\n').whole, 'export =');
  assert.equal(whole('eq.ts', "import fs = require('fs');\n").whole, 'import =');
  assert.equal(entryOf(sliceProgram({ read: reader({ 'm.mjs': "import './gone.mjs';\n" }), entries: [{ file: 'm.mjs', program: true }] }), 'gone.mjs').missing, true);
});

test('evaluateSlice runs a function from its slice alone; arrayText and literalStrings read declared lists; the real A argv array is unique', () => {
  const read = reader({
    'e.mjs': "import { join } from 'node:path';\nimport { other } from './other.mjs';\nexport function f(x) { return join('a', x); }\nexport function g() { return other(); }\nawait fetch('http://invalid');\n",
    'other.mjs': 'export const other = () => 1;\n',
    'argv.mjs': "const one = ['node', 'x.mjs', '--flag', value];\nconst two = [1, 2];\n",
    'argv2.mjs': "const one = [\n  'node',\n  'x.mjs',   '--flag',\n  value\n];\n",
    'list.ts': "export const FILES = ['a.ts', 'b.ts'] as const;\nexport const MIXED = ['a', x];\n",
  });
  assert.equal(evaluateSlice(read, 'e.mjs', ['f']).f('b'), 'a/b', 'the module\'s effects (a network call) are not run');
  assert.throws(() => evaluateSlice(read, 'e.mjs', ['g']), /included code uses other of \.\/other\.mjs, which is not followed/);
  assert.equal(arrayText(read, 'argv.mjs', 'x.mjs'), "[ 'node' , 'x.mjs' , '--flag' , value ]");
  assert.equal(arrayText(read, 'argv2.mjs', 'x.mjs'), arrayText(read, 'argv.mjs', 'x.mjs'), 'layout is not an input; tokens are');
  assert.throws(() => arrayText(read, 'argv.mjs', 'absent'), /has 0 arrays holding absent, expected 1/);
  assert.deepEqual(literalStrings(read, 'list.ts', 'FILES'), ['a.ts', 'b.ts']);
  assert.throws(() => literalStrings(read, 'list.ts', 'MIXED'), /is not an array of string literals/);
  assert.match(aLaunch(readRepo, null), /^[0-9a-f]{64}$/, 'g3-batch.mjs holds exactly one array with the A runner path');
});

const DRIVE_A = `
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { repo, entry, llm, cloud, program, script } = JSON.parse(process.env.W13_DRIVE);
const at = path => pathToFileURL(join(repo, path)).href;
const runA = await import(at(entry));
runA.unsupported({ steps: [{ cmd: 'x', extra: 1 }] });
const { patterns } = runA.frontendEvents(join(repo, 'contracts/ipc'), join(repo, 'src'));
runA.dynamicChannels(patterns, JSON.stringify({ session: 'sess_0001', nested: ['note-abc'] }));
const services = await import(at('scripts/electron-migration/record/g3-services.mjs'));
services.serviceGap({ steps: [{ cmd: 'x', args: { url: '\${llm.baseUrl}', key: '\${mcp.sse.url}' } }] }, { mcp: await services.mcpBindingKinds() });
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.text()).catch(() => null);
const { startLlmService, scripts } = await import(at(llm));
const llmService = await startLlmService({ port: 0 });
const base = llmService.baseUrl(Object.keys(scripts)[0]);
await post(base + '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
await post(base + '/v1/embeddings', { model: 'm', input: 'hi' });
await post(base.replace(/\\/s\\/.*/, '/nowhere'), {});
await llmService.stop();
const { startCloudService } = await import(at(cloud));
const cloudService = await startCloudService({ seed: 'empty', webdavPort: 0, s3Port: 0, controlPort: 0 });
await fetch(cloudService.webdavEndpoint, { method: 'PROPFIND', headers: { depth: '1' } }).then(r => r.text()).catch(() => null);
cloudService.snapshot();
await cloudService.stop();
const log = mkdtempSync(join(tmpdir(), 'w13-stdio-'));
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repo, program), script, '--log', join(log, 'records.jsonl')], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.resume();
  child.on('error', reject);
  child.on('close', resolve);
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'w13', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map(message => JSON.stringify(message) + '\\n').join(''));
});
rmSync(log, { recursive: true, force: true });
// Control: only the B runner resolves bindings this way; the check must report it.
services.lookupBinding({ llm: { baseUrl: 'u' } }, 'llm.baseUrl');
process.stdout.write(String(process.pid));
`;

/** Source ranges [pos, end) of the top-level statements a slice entry includes (the whole file for whole entries). */
function includedRanges(entry) {
  if (entry.whole) return [[0, Infinity]];
  const text = readFileSync(join(REPO, entry.file), 'utf8');
  const source = ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true, /\.[mc]?ts$/.test(entry.file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const kept = new Set(entry.statements);
  return source.statements.filter(node => kept.has(node.getText(source))).map(node => [node.pos, node.end]);
}

test('the A process slice holds every function that runs: the runner loading and its helpers, the LLM, cloud and MCP services, the MCP stdio program', { timeout: 180_000 }, async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const dir = await mkdtemp('/tmp/opencode/w13-slice-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { SCRIPT_IDS } = await import(pathToFileURL(join(REPO, 'host/plugins/mcp/equivalence/protocol.ts')).href);
  const coverage = join(dir, 'coverage'), drive = join(dir, 'drive.mjs');
  writeFileSync(drive, DRIVE_A);
  const run = spawnSync(process.execPath, [drive], { cwd: REPO, encoding: 'utf8', timeout: 150_000, env: { ...process.env, NODE_V8_COVERAGE: coverage, TMPDIR: dir,
    W13_DRIVE: JSON.stringify({ repo: REPO, entry: A_ENTRY, llm: SERVICE_MODULES.llm, cloud: SERVICE_MODULES.cloud, program: PROGRAMS[0], script: SCRIPT_IDS[0] }) } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const driver = Number(run.stdout.trim());

  const slices = { a: aSlice(readRepo, Object.keys(SERVICE_MODULES)), program: sliceProgram({ read: readRepo, entries: [{ file: PROGRAMS[0], program: true }] }) };
  const ranges = Object.fromEntries(Object.entries(slices).map(([name, slice]) => [name, new Map(slice.files.filter(item => !item.missing).map(item => [item.file, includedRanges(item)]))]));
  const outside = [], seen = { a: new Map(), program: new Map() };
  const repoUrl = pathToFileURL(REPO).href;
  for (const name of readdirSync(coverage)) {
    const pid = Number(/^coverage-(\d+)-/.exec(name)?.[1]);
    const which = pid === driver ? 'a' : 'program';
    for (const script of JSON.parse(readFileSync(join(coverage, name), 'utf8')).result) {
      if (!script.url.startsWith(repoUrl)) continue;
      const file = relative(REPO, fileURLToPath(script.url)).split('\\').join('/');
      if (file.split('/').includes('node_modules')) continue;
      const length = readFileSync(join(REPO, file), 'utf8').length;
      const ran = script.functions.filter(fn => fn.ranges[0].count > 0 && !(fn.ranges[0].startOffset === 0 && fn.ranges[0].endOffset >= length));
      seen[which].set(file, (seen[which].get(file) ?? 0) + ran.length);
      const included = ranges[which].get(file);
      if (!included) { outside.push(`${which}: ${file} is loaded but not on the slice`); continue; }
      for (const fn of ran) {
        const at = fn.ranges[0].startOffset;
        if (!included.some(([from, to]) => at >= from && at < to)) outside.push(`${which}: ${file}@${at} ${fn.functionName || '(anonymous)'} runs outside the slice`);
      }
    }
  }
  const control = outside.filter(item => / lookupBinding runs outside the slice$/.test(item));
  assert.equal(control.length, 1, `the control call (B-only lookupBinding) is reported: ${outside.join('; ')}`);
  assert.deepEqual(outside.filter(item => !control.includes(item)), []);
  for (const file of [A_ENTRY, 'scripts/electron-migration/record/g3-services.mjs', SERVICE_MODULES.llm, SERVICE_MODULES.cloud, SERVICE_MODULES.mcp])
    assert.ok(seen.a.get(file) > 0, `functions of ${file} ran in the A process (${seen.a.get(file) ?? 'not loaded'})`);
  assert.ok(seen.program.get(PROGRAMS[0]) > 0, 'the stdio program ran');
  const total = [...seen.a.values(), ...seen.program.values()].reduce((sum, count) => sum + count, 0);
  assert.ok(total > 50, `${total} executed functions checked`);
});

const DRIVE_SEEDS = `
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { repo, seed } = JSON.parse(process.env.W13_DRIVE);
const ids = new WeakMap();
let next = 0;
const id = value => ((value !== null && typeof value === 'object') || typeof value === 'function' ? (ids.has(value) || ids.set(value, ++next), ids.get(value)) : value);
const own = object => Object.getOwnPropertyNames(object).sort().map(name => {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  return [name, 'value' in descriptor ? (typeof descriptor.value === 'number' && Number.isNaN(descriptor.value) ? 'NaN' : id(descriptor.value)) : [id(descriptor.get), id(descriptor.set)]];
});
const PROTOTYPES = { Object, Array, String, Number, Boolean, Function, Promise, RegExp, Date, Map, Set, WeakMap, Error, Symbol, ArrayBuffer, Uint8Array, Buffer, URL, EventTarget };
const snapshot = () => ({
  globals: own(globalThis),
  statics: Object.fromEntries(Object.entries({ ...PROTOTYPES, JSON, Math, Reflect, Intl, console, process }).map(([name, value]) => [name, own(value)])),
  prototypes: Object.fromEntries(Object.entries(PROTOTYPES).map(([name, value]) => [name, own(value.prototype)])),
  env: { ...process.env },
  listeners: Object.fromEntries(process.eventNames().map(name => [String(name), process.listeners(name).map(id)])),
  cwd: process.cwd(), exitCode: process.exitCode ?? null, stackTraceLimit: Error.stackTraceLimit,
  prepareStackTrace: id(Error.prepareStackTrace), intl: Intl.DateTimeFormat().resolvedOptions(),
  handles: process.getActiveResourcesInfo().filter(name => name !== 'TTYWrap').sort(),
});
// Pending callbacks run first: a handle counts only if it outlives them.
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
await settle();
const before = snapshot();
const { createSeed, SEED_NAMES } = await import(pathToFileURL(join(repo, seed)).href);
const catalog = mkdtempSync(join(tmpdir(), 'w13-seeds-'));
try { for (const name of SEED_NAMES) createSeed(name, catalog); } finally { rmSync(catalog, { recursive: true, force: true }); }
await settle();
const after = snapshot();
process.stdout.write(JSON.stringify({ seeds: SEED_NAMES.length, before, after }));
`;

test('the seed generator and its product imports (not on the slice) leave the process as it was: globals, builtins, environment, listeners, handles', { timeout: 180_000 }, async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const dir = await mkdtemp('/tmp/opencode/w13-seeds-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const drive = join(dir, 'drive.mjs');
  writeFileSync(drive, DRIVE_SEEDS);
  const run = spawnSync(process.execPath, [drive], { cwd: REPO, encoding: 'utf8', timeout: 150_000, maxBuffer: 1 << 28,
    env: { ...process.env, TZ: 'UTC', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: dir, W13_DRIVE: JSON.stringify({ repo: REPO, seed: SEED_MODULE }) } });
  assert.equal(run.status, 0, run.stderr);
  const { seeds, before, after } = JSON.parse(run.stdout);
  assert.ok(seeds > 10, `${seeds} seeds built`);
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], key);
});
