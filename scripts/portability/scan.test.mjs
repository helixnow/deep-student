// 可移植性扫描器测试：node --test scripts/portability/scan.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSource, buildBaseline, checkModulesClosure, checkProfileClosure, compareWithBaseline, declaredPlatforms, findingKey, mobileReadiness, scanPlugins,
} from './lib/portability.mjs';
import { renderReport } from './scan.mjs';

const SCAN = fileURLToPath(new URL('./scan.mjs', import.meta.url));
const roots = [];

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-portability-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const keys = (text) => analyzeSource('host/plugins/x/a.ts', text).findings.map(findingKey).sort();

describe('analyzeSource', () => {
  it('classifies builtins, natives and Node-only packages, and ignores portable packages and relative imports', () => {
    assert.deepEqual(keys(`import { readFile } from 'node:fs/promises';`), ['node-builtin:fs']);
    assert.deepEqual(keys(`import path from 'path';`), ['node-builtin:path']);
    assert.deepEqual(keys(`const db = require('better-sqlite3');`), ['native:better-sqlite3']);
    assert.deepEqual(keys(`import { connect } from '@lancedb/lancedb';`), ['native:@lancedb/lancedb']);
    assert.deepEqual(keys(`import { Agent } from 'undici';`), ['node-package:undici']);
    assert.deepEqual(keys(`import { nanoid } from 'nanoid'; import { sha256 } from '@noble/hashes/sha2.js'; import x from './local.ts';`), []);
  });

  it('treats only `import type` / `export type` / import() types as type-only (verbatimModuleSyntax keeps `{ type X }` imports)', () => {
    assert.deepEqual(keys(`import type { Stats } from 'node:fs';`), ['node-builtin-type:fs']);
    assert.deepEqual(keys(`export type * from 'node:os';`), ['node-builtin-type:os']);
    assert.deepEqual(keys(`let s: import('node:stream').Readable;`), ['node-builtin-type:stream']);
    assert.deepEqual(keys(`import { type Stats } from 'node:fs';`), ['node-builtin:fs']);
    assert.deepEqual(keys(`const cp = await import('node:child_process');`), ['node-builtin:child_process']);
    assert.deepEqual(analyzeSource('host/plugins/x/a.ts', `import type { X } from './types.ts'; import { y } from './y.ts'; export * from './z';`).runtimeSpecifiers, ['./y.ts', './z']);
  });

  it('detects Node globals by reference, separating value and type positions and skipping shadowed names', () => {
    assert.deepEqual(keys(`const b = Buffer.from('x'); let c: Buffer;`), ['node-global:Buffer']);
    assert.deepEqual(keys(`let c: Buffer = make();`), ['node-global-type:Buffer']);
    assert.deepEqual(keys(`if (process.platform === 'win32') {}`), ['node-global:process']);
    assert.deepEqual(keys(`let t: NodeJS.Timeout;`), ['node-global-type:NodeJS']);
    assert.deepEqual(keys(`const o = { process: 1, Buffer: 2 }; o.process; type T = { Buffer: string };`), []);
    assert.deepEqual(keys(`function run(process: { pid: number }) { return process.pid; }`), []);
    assert.deepEqual(keys(`const { process } = job; process.start();`), []);
    assert.deepEqual(keys(`declare global { interface Window { x: number } }\nexport {};`), []);
    assert.deepEqual(keys(`globalThis.x = 1; global.y = 2;`), ['node-global:global']);
  });

  it('counts *Sync calls', () => {
    const result = analyzeSource('host/plugins/x/a.ts', `import fs, { readFileSync } from 'node:fs'; readFileSync('a'); fs.existsSync('b'); obj.Sync(); doSync;`);
    assert.equal(result.syncCalls, 2);
  });
});

describe('declaredPlatforms', () => {
  it('reads array literals and same-file constants without executing the module', () => {
    assert.deepEqual(declaredPlatforms(`export default definePlugin({ meta: { id: 'a', platforms: ['desktop', 'mobile'] } });`), ['desktop', 'mobile']);
    assert.deepEqual(declaredPlatforms(`const P: readonly PluginPlatform[] = ['desktop'];\nexport default definePlugin({ meta: { id: 'a', platforms: P } });`), ['desktop']);
    assert.deepEqual(declaredPlatforms(`export default { meta: { id: 'a', platforms: ['mobile'] as const } };`), ['mobile']);
    assert.equal(declaredPlatforms(`export default definePlugin({ meta: { id: 'a' } });`), null);
  });
});

const TREE = {
  'host/kernel/api.ts': `export { helper } from './helper.ts';\nexport function definePlugin(p) { return p; }\n`,
  'host/kernel/helper.ts': `import { randomUUID } from 'node:crypto';\nexport const helper = () => randomUUID();\n`,
  'host/kernel/types.ts': `import type { Stats } from 'node:fs';\nexport type S = Stats;\n`,
  'host/plugins/alpha/index.ts': `import { definePlugin } from '../../kernel/api.ts';\nimport type { S } from '../../kernel/types.ts';\nimport { load } from './src/io.ts';\nexport default definePlugin({ meta: { id: 'dstu.alpha' }, apply() { load(); } });\n`,
  'host/plugins/alpha/src/io.ts': `import { readFileSync, existsSync } from 'node:fs';\nimport { join } from 'node:path';\nexport function load() { return existsSync('x') ? readFileSync(join('a', 'b')) : Buffer.alloc(0); }\n`,
  'host/plugins/alpha/src/pure.ts': `export const add = (a: number, b: number) => a + b;\n`,
  'host/plugins/alpha/tests/io.test.ts': `import { writeFileSync } from 'node:fs';\n`,
  'host/plugins/desk/index.ts': `import { spawn } from 'node:child_process';\nconst PLATFORMS = ['desktop'];\nexport default { meta: { id: 'dstu.desk', platforms: PLATFORMS }, apply() { spawn('true'); } };\n`,
  'host/plugins/beta/index.ts': `export default { meta: { id: 'dstu.beta', platforms: ['desktop', 'mobile'] }, apply() {} };\n`,
};

describe('scanPlugins', () => {
  it('aggregates per plugin, excludes tests, orders by effort and finds transitive gateways', () => {
    const root = fixture(TREE);
    const scan = scanPlugins(root);
    assert.equal(scan.summary.plugins, 3);
    assert.equal(scan.summary.files, 5);
    assert.equal(scan.summary.cleanFiles, 3);
    assert.deepEqual(scan.plugins.map((plugin) => plugin.name), ['alpha', 'desk', 'beta']);
    const alpha = scan.plugins.find((plugin) => plugin.name === 'alpha');
    assert.equal(alpha.files, 3);
    assert.equal(alpha.cleanFiles, 2);
    assert.equal(alpha.runtimePortableFiles, 2);
    assert.deepEqual(alpha.modules, { 'node-builtin:fs': 1, 'node-builtin:path': 1, 'node-global:Buffer': 1 });
    assert.equal(alpha.syncCalls, 2);
    assert.equal(alpha.effort.units, 3 + 0.5 + 1 + 2 * 0.25);
    assert.equal(alpha.suggestion, 'migrate');
    assert.deepEqual(alpha.gateways, [{ file: 'host/kernel/api.ts', modules: ['node-builtin:crypto'] }]);
    const desk = scan.plugins.find((plugin) => plugin.name === 'desk');
    assert.deepEqual(desk.declaredPlatforms, ['desktop']);
    assert.equal(desk.suggestion, 'declared-desktop-only');
    assert.deepEqual(desk.desktopOnlySignals, ['node-builtin:child_process']);
    assert.deepEqual(scan.plugins.find((plugin) => plugin.name === 'beta').declaredPlatforms, ['desktop', 'mobile']);
    assert.equal(scanPlugins(root, { includeTests: true }).summary.files, 6);
  });

  it('baseline comparison reports only new (file, dependency) pairs and exempts declared desktop-only plugins', () => {
    const root = fixture(TREE);
    const baseline = buildBaseline(scanPlugins(root));
    assert.deepEqual(Object.keys(baseline.files), ['host/plugins/alpha/src/io.ts', 'host/plugins/desk/index.ts']);
    assert.deepEqual(baseline.files['host/plugins/alpha/src/io.ts'], ['node-builtin:fs', 'node-builtin:path', 'node-global:Buffer']);
    assert.deepEqual(compareWithBaseline(scanPlugins(root), baseline), { added: [], resolved: [] });

    fs.writeFileSync(path.join(root, 'host/plugins/alpha/src/pure.ts'), `import os from 'node:os';\nexport const home = () => os.homedir();\n`);
    fs.writeFileSync(path.join(root, 'host/plugins/alpha/src/io.ts'), `import { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nexport const load = () => readFile('x');\n`);
    fs.writeFileSync(path.join(root, 'host/plugins/desk/extra.ts'), `import net from 'node:net';\n`);
    const { added, resolved } = compareWithBaseline(scanPlugins(root), baseline);
    assert.deepEqual(added.map((entry) => `${entry.file}|${entry.key}|${entry.line}`), [
      'host/plugins/alpha/src/io.ts|node-builtin:crypto|2',
      'host/plugins/alpha/src/pure.ts|node-builtin:os|1',
    ]);
    assert.equal(added[0].replacement, 'ctx.crypto；无 ctx 的同步小输入用 host/platform/crypto/sync.ts');
    assert.deepEqual(resolved, [
      { file: 'host/plugins/alpha/src/io.ts', key: 'node-builtin:path' },
      { file: 'host/plugins/alpha/src/io.ts', key: 'node-global:Buffer' },
    ]);
  });

  it('rewriting a baseline never adds keys for exempt files, so --write-baseline is only ever a shrink when --check is clean', () => {
    const root = fixture(TREE);
    const baseline = buildBaseline(scanPlugins(root));
    fs.writeFileSync(path.join(root, 'host/plugins/desk/extra.ts'), `import net from 'node:net';\n`);
    fs.writeFileSync(path.join(root, 'host/plugins/desk/index.ts'), `${fs.readFileSync(path.join(root, 'host/plugins/desk/index.ts'), 'utf8')}export const pid = () => process.pid;\n`);
    fs.writeFileSync(path.join(root, 'host/plugins/alpha/src/io.ts'), `import { readFile } from 'node:fs/promises';\nexport const load = () => readFile('x');\n`);
    const scan = scanPlugins(root);
    assert.deepEqual(compareWithBaseline(scan, baseline).added, []);

    const rewritten = buildBaseline(scan, baseline);
    assert.deepEqual(rewritten.files, {
      'host/plugins/alpha/src/io.ts': ['node-builtin:fs'],
      'host/plugins/desk/index.ts': baseline.files['host/plugins/desk/index.ts'],
    });
    assert.deepEqual(compareWithBaseline(scan, rewritten), { added: [], resolved: [] });
    assert.ok(buildBaseline(scan).files['host/plugins/desk/extra.ts'], 'without a previous baseline every finding is recorded');
  });

  it('desktop-only exemption: declared [\'desktop\'] only, never undeclared plugins, and never for files portable code reaches', () => {
    const files = {
      'host/kernel/api.ts': `export function definePlugin(p) { return p; }\n`,
      // 仅桌面插件：私有文件豁免；api.ts 被可移植插件导入，是共享面；mobile.ts 变体可达的 shared.ts 也不豁免。
      'host/plugins/desk/index.ts': `import { spawn } from 'node:child_process';\nexport default { meta: { id: 'dstu.desk', platforms: ['desktop'] }, apply() { spawn('true'); } };\n`,
      'host/plugins/desk/api.ts': `import { readFile } from 'node:fs/promises';\nexport const load = () => readFile('x');\n`,
      'host/plugins/desk/mobile.ts': `import { pick } from './shared.ts';\nexport default { meta: { id: 'dstu.desk', platforms: ['mobile'] }, apply() { pick(); } };\n`,
      'host/plugins/desk/shared.ts': `export const pick = () => Buffer.alloc(1);\n`,
      'host/plugins/portable/index.ts': `import { load } from '../desk/api.ts';\nexport default { meta: { id: 'dstu.portable', platforms: ['desktop', 'mobile'] }, apply() { load(); } };\n`,
      // 未声明 platforms：不豁免。
      'host/plugins/legacy/index.ts': `import os from 'node:os';\nexport default { meta: { id: 'dstu.legacy' }, apply() { os.homedir(); } };\n`,
    };
    const root = fixture(files);
    const scan = scanPlugins(root);
    const exempt = Object.fromEntries(scan.files.map((file) => [file.file, file.exempt]));
    assert.equal(exempt['host/plugins/desk/index.ts'], true);
    assert.equal(exempt['host/plugins/desk/api.ts'], false);
    assert.equal(exempt['host/plugins/desk/shared.ts'], false);
    assert.equal(exempt['host/plugins/legacy/index.ts'], false);
    const { added } = compareWithBaseline(scan, { files: {} });
    assert.deepEqual(added.map((entry) => `${entry.file}|${entry.key}|${entry.sharedWith ?? ''}`).sort(), [
      'host/plugins/desk/api.ts|node-builtin:fs|host/plugins/portable/index.ts',
      'host/plugins/desk/shared.ts|node-global:Buffer|host/plugins/desk/mobile.ts',
      'host/plugins/legacy/index.ts|node-builtin:os|',
    ]);
  });

  it('profile closure check follows runtime imports only', () => {
    const root = fixture({
      ...TREE,
      'host/platform/svc/mobile.ts': `import type { S } from '../../kernel/types.ts';\nimport { a } from './a.ts';\nexport default { meta: { id: 'svc' }, apply() { a(); } };\n`,
      'host/platform/svc/a.ts': `export const a = () => 1;\n`,
      'host/platform/bad/mobile.ts': `import { definePlugin } from '../../kernel/api.ts';\nexport default definePlugin({ meta: { id: 'bad' }, apply() {} });\n`,
      'host/profiles/mobile.json': JSON.stringify({ plugins: [{ id: 'svc', module: '../platform/svc/mobile.ts' }, { id: 'bad', module: '../platform/bad/mobile.ts' }] }),
    });
    const results = checkProfileClosure(root, 'host/profiles/mobile.json');
    assert.deepEqual(results.map((result) => [result.id, result.violations.map((violation) => `${violation.file}:${violation.line} ${violation.key}`)]), [
      ['svc', []],
      ['bad', ['host/kernel/helper.ts:1 node-builtin:crypto']],
    ]);
    assert.deepEqual(checkModulesClosure(root, ['host/platform/svc/a.ts']), []);
  });
});

describe('mobileReadiness', () => {
  it('reports ready entries and attributes blockers to own files or out-of-plugin gateways', () => {
    const root = fixture({
      ...TREE,
      'host/plugins/gamma/index.ts': `import { pure } from './src/pure.ts';\nimport { helper } from '../../kernel/api.ts';\nexport default { meta: { id: 'dstu.gamma' }, apply() { pure(); helper(); } };\n`,
      'host/plugins/gamma/src/pure.ts': `export const pure = () => 1;\n`,
    });
    const byName = Object.fromEntries(mobileReadiness(root).map((result) => [result.name, result]));
    assert.equal(byName.beta.ready, true);
    assert.deepEqual(byName.beta.declaredPlatforms, ['desktop', 'mobile']);
    assert.equal(byName.alpha.ready, false);
    assert.deepEqual(byName.alpha.own, ['host/plugins/alpha/src/io.ts']);
    assert.deepEqual(byName.gamma.own, []);
    assert.deepEqual(byName.gamma.gateways, [{ file: 'host/kernel/api.ts', reaches: ['host/kernel/helper.ts'] }]);
  });
});

describe('CLI', () => {
  it('--write-baseline, --check (exit 1 on new findings), --report and --profile', () => {
    const root = fixture({ ...TREE, 'host/profiles/mobile.json': JSON.stringify({ plugins: [{ id: 'beta', module: '../plugins/beta/index.ts' }] }) });
    const run = (...args) => spawnSync(process.execPath, [SCAN, '--root', root, ...args], { encoding: 'utf8' });
    assert.equal(run('--write-baseline').status, 0);
    assert.ok(fs.existsSync(path.join(root, 'scripts/portability/baseline.json')));
    const clean = run('--check');
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /baseline scripts\/portability\/baseline.json: 0 new, 0 resolved/);
    fs.writeFileSync(path.join(root, 'host/plugins/beta/net.ts'), `import { lookup } from 'node:dns/promises';\n`);
    const dirty = run('--check', '--report', 'report.md', '--json', 'scan.json');
    assert.equal(dirty.status, 1);
    assert.match(dirty.stdout, /NEW host\/plugins\/beta\/net.ts:1 node:dns/);
    const report = fs.readFileSync(path.join(root, 'report.md'), 'utf8');
    assert.match(report, /## 按插件排序的迁移工作量/);
    assert.match(report, /新增 1 条/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'scan.json'), 'utf8')).comparison.added.length, 1);
    assert.equal(run('--profile', 'host/profiles/mobile.json').status, 0);
    assert.equal(run('--bogus').status, 2);
  });

  it('--check also enforces the mobile profile closure unless --no-profile', () => {
    const root = fixture({ ...TREE, 'host/profiles/mobile.json': JSON.stringify({ plugins: [{ id: 'dstu.alpha', module: '../plugins/alpha/index.ts' }] }) });
    const run = (...args) => spawnSync(process.execPath, [SCAN, '--root', root, ...args], { encoding: 'utf8' });
    assert.equal(run('--write-baseline').status, 0);
    const checked = run('--check');
    assert.equal(checked.status, 1, checked.stdout);
    assert.match(checked.stdout, /baseline scripts\/portability\/baseline.json: 0 new/);
    assert.match(checked.stdout, /FAIL dstu.alpha \(host\/plugins\/alpha\/index.ts\)/);
    assert.equal(run('--check', '--no-profile').status, 0);
  });

  it('renders a report without a baseline comparison', () => {
    const root = fixture(TREE);
    const report = renderReport(scanPlugins(root), { head: 'abc1234' });
    assert.match(report, /提交 `abc1234`/);
    assert.match(report, /\| 1 \| alpha \|.*\| 5 \/ 0.21 \| 迁到平台服务 \|/);
    assert.match(report, /`host\/kernel\/api.ts` \| 1 \| node:crypto/);
    assert.doesNotMatch(report, /与基线比较/);
  });
});
