import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { landPack } from './land-pack.mjs';
import { landApply, chownFix, foreignPaths } from './land-apply.mjs';
import { landSend, parseSumCheck } from './land-send.mjs';
import { planDeps, depsChanges, depsKey, shardTmpDir, DEFAULT_TMP_ROOT, suitesFor, suiteShards, shardCommand } from './land-test.mjs';
import { landStatus, resolveTarget, mergeMap, parseStatus } from './land-status.mjs';
import { compareTrees, lsTree, validateManifest, zoneOf, readJSON } from './lib.mjs';

const ID = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null'];
const roots = [];
const tmpRoot = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
};
after(() => {
  if (process.env.LANDING_TEST_KEEP) return;
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const g = (cwd, ...a) => execFileSync('git', [...ID, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gOk = (cwd, ...a) => spawnSync('git', a, { cwd }).status === 0;
function write(dir, f, data, mode) {
  const p = path.join(dir, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  if (mode) fs.chmodSync(p, mode);
}

// 本机：base（快照）→ int1（改、增二进制、增被忽略文件、删、改 mode、unicode 路径、带 src/version.ts）→ int2；服务器：base 树 + 一个服务器独有的被忽略文件。
function fixture() {
  const root = tmpRoot('landing-test-');
  const local = path.join(root, 'local');
  fs.mkdirSync(local);
  g(local, 'init', '-q', '-b', 'main');
  write(local, '.gitignore', '*.zip\n*.log\n');
  write(local, 'a.txt', 'a1\n');
  write(local, 'keep.txt', 'k\n');
  write(local, 'bin/old.dat', Buffer.from([0, 1, 2, 255, 0, 3]));
  write(local, 'run.sh', '#!/bin/sh\necho hi\n', 0o755);
  g(local, 'add', '-A');
  g(local, 'commit', '-qm', 'base: snapshot');
  const base = g(local, 'rev-parse', 'HEAD');

  write(local, 'a.txt', 'a2\n', 0o755);
  write(local, 'fixtures/x.zip', Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 255, 0]));
  write(local, 'bin/new.dat', crypto.randomBytes(4096));
  fs.rmSync(path.join(local, 'keep.txt'));
  write(local, 'src/version.ts', 'export const V = 1;\n');
  write(local, 'dir with space/ü.txt', 'unicode\n');
  g(local, 'add', '-A');
  g(local, 'add', '-f', 'fixtures/x.zip');
  g(local, 'commit', '-qm', '[INT] merge assault/W99-test (fixture)');
  const int1 = g(local, 'rev-parse', 'HEAD');

  write(local, 'a.txt', 'a3\n', 0o755);
  write(local, 'bin/old.dat', Buffer.from([9, 9, 9, 0]));
  write(local, 'fixtures/y.zip', Buffer.from([0x50, 0x4b, 5, 6, 0, 255]));
  g(local, 'add', '-A');
  g(local, 'add', '-f', 'fixtures/y.zip');
  g(local, 'commit', '-qm', '[INT] post-merge fixes');
  const int2 = g(local, 'rev-parse', 'HEAD');

  const server = path.join(root, 'srv', 'repo');
  fs.mkdirSync(server, { recursive: true });
  g(server, 'init', '-q', '-b', 'main');
  execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', local, base, server]);
  write(server, 'logs/server-only.log', 'srv\n');
  g(server, 'add', '-A');
  g(server, 'add', '-f', 'logs/server-only.log');
  g(server, 'commit', '-qm', 'server main');
  const ignoredList = path.join(root, 'ignored.txt');
  fs.writeFileSync(ignoredList, 'logs/server-only.log\n');
  return {
    root, local, server, base, int1, int2, ignoredList,
    main: g(server, 'rev-parse', 'main'),
    home: path.join(root, 'srv', 'landing'),
    wt: path.join(root, 'srv', 'ds-landing'),
  };
}

// 输出目录按 to 命名，同一个 to 的不同 from 各用一个输出根目录
const pack = (f, from, to, extra = {}) => landPack({
  from, to, repo: f.local, out: path.join(f.root, `out-${String(from).slice(0, 12)}`), baseSnapshot: f.base, serverBase: 'main',
  ignoredList: f.ignoredList, force: true, ...extra,
});
const apply = (f, outDir, extra = {}) => landApply({
  pack: outDir, repo: f.server, home: f.home, worktree: f.wt, user: os.userInfo().username, skipServiceChecks: true, ...extra,
});
const branchSha = (f) => (gOk(f.server, 'show-ref', '--verify', '--quiet', 'refs/heads/assault/landing') ? g(f.server, 'rev-parse', 'assault/landing') : null);

test('pack 核对二进制、被忽略但跟踪的文件，排除 src/version.ts', async () => {
  const f = fixture();
  const { manifest } = await pack(f, f.base, f.int1);
  assert.deepEqual(manifest.stats.files, 5);
  assert.equal(manifest.stats.binary, 2);
  assert.deepEqual(manifest.binaryFiles.map((b) => b.path), ['bin/new.dat', 'fixtures/x.zip']);
  assert.deepEqual(manifest.ignoredTrackedInPatch, ['fixtures/x.zip']);
  assert.equal(manifest.from.isBaseSnapshot, true);
  assert.deepEqual(manifest.intMerges.map((m) => m.branch), ['assault/W99-test']);
  const patch = fs.readFileSync(path.join(f.root, `out-${f.base.slice(0, 12)}`, f.int1.slice(0, 12), 'land.patch'), 'latin1');
  assert.ok(!patch.includes('src/version.ts'));
  assert.equal((patch.match(/^GIT binary patch$/gm) ?? []).length, 2);
});

test('首次落地、增量落地、幂等；结果树 = 本机树 + 服务器独有文件，main 不动', async () => {
  const f = fixture();
  const p1 = await pack(f, f.base, f.int1);
  const r1 = await apply(f, p1.outDir);
  const c1 = compareTrees(lsTree(f.local, f.int1), lsTree(f.server, r1.serverSha));
  assert.ok(c1.equal);
  assert.deepEqual(c1.extra, ['logs/server-only.log']);
  assert.equal(g(f.server, 'rev-parse', `${r1.serverSha}^`), f.main);
  assert.match(g(f.server, 'log', '-1', '--format=%B', r1.serverSha), new RegExp(`Local-To: ${f.int1}`));

  const p2 = await pack(f, f.int1, f.int2);
  const r2 = await apply(f, p2.outDir);
  assert.ok(compareTrees(lsTree(f.local, f.int2), lsTree(f.server, r2.serverSha)).equal);
  assert.equal(g(f.server, 'rev-parse', `${r2.serverSha}^`), r1.serverSha);
  const again = await apply(f, p2.outDir);
  assert.equal(again.already, true);
  assert.equal(again.serverSha, r2.serverSha);

  const map = readJSON(path.join(f.home, 'landing-map.json'));
  assert.deepEqual(map.entries.map((e) => [e.localFrom, e.localTo, e.serverSha]), [[f.base, f.int1, r1.serverSha], [f.int1, f.int2, r2.serverSha]]);
  assert.equal(map.byLocal[f.base], f.main);
  assert.equal(map.byServer[r2.serverSha], f.int2);
  assert.equal(g(f.server, 'rev-parse', 'main'), f.main);
  assert.equal(g(f.server, 'status', '--porcelain'), '');
});

test('拒绝：乱序包、from 不接续、工作树不干净、工作树里已有要新增的文件、坏分片', async () => {
  const f = fixture();
  const p12 = await pack(f, f.int1, f.int2);
  await assert.rejects(apply(f, p12.outDir), /首次落地的包必须从/);
  assert.equal(branchSha(f), null);
  assert.ok(!fs.existsSync(f.wt));

  const r1 = await apply(f, (await pack(f, f.base, f.int1)).outDir);
  const p02 = await pack(f, f.base, f.int2);
  await assert.rejects(apply(f, p02.outDir), /最后一次落地的是本机/);

  write(f.wt, 'stray.txt', 'x');
  await assert.rejects(apply(f, p12.outDir), /不干净/);
  fs.rmSync(path.join(f.wt, 'stray.txt'));
  write(f.wt, 'fixtures/y.zip', 'squatter');
  await assert.rejects(apply(f, p12.outDir), /已有补丁要新增的文件/);
  assert.equal(fs.readFileSync(path.join(f.wt, 'fixtures/y.zip'), 'utf8'), 'squatter');
  fs.rmSync(path.join(f.wt, 'fixtures/y.zip'));

  const part = path.join(p12.outDir, p12.manifest.parts[0].file);
  const good = fs.readFileSync(part);
  fs.writeFileSync(part, Buffer.concat([good.subarray(0, -1), Buffer.from([good.at(-1) ^ 1])]));
  await assert.rejects(apply(f, p12.outDir), /分片校验失败/);
  fs.writeFileSync(part, good);
  assert.equal(branchSha(f), r1.serverSha);
  await apply(f, p12.outDir);
});

test('pack 拒绝触及服务器独有的被忽略文件与未传输区', async () => {
  const f = fixture();
  write(f.local, 'logs/server-only.log', 'local\n');
  g(f.local, 'add', '-f', 'logs/server-only.log');
  g(f.local, 'commit', '-qm', 'touch server-only');
  await assert.rejects(pack(f, f.int2, 'HEAD'), /被忽略但跟踪/);
  g(f.local, 'reset', '-q', '--hard', f.int2);
  write(f.local, 'example/demo.txt', 'x\n');
  g(f.local, 'add', '-A');
  g(f.local, 'commit', '-qm', 'zone');
  await assert.rejects(pack(f, f.int2, 'HEAD'), /未传输的区域/);
  const ok = await pack(f, f.int2, 'HEAD', { allowZone: true });
  assert.deepEqual(ok.manifest.checks.untransferredZoneTouches, [{ path: 'example/demo.txt', zone: 'example/' }]);
});

test('回滚：首次落地失败删掉新建的分支与工作树；增量失败回到上一次落地', async () => {
  const f = fixture();
  const p1 = await pack(f, f.base, f.int1);
  await assert.rejects(apply(f, p1.outDir, { faults: { beforeCommit: () => { throw new Error('injected'); } } }), /injected/);
  assert.equal(branchSha(f), null);
  assert.ok(!fs.existsSync(f.wt));
  assert.ok(!fs.existsSync(path.join(f.home, 'landing-map.json')));
  assert.ok(!g(f.server, 'worktree', 'list').includes('ds-landing'));

  const r1 = await apply(f, p1.outDir);
  const p2 = await pack(f, f.int1, f.int2);
  await assert.rejects(apply(f, p2.outDir, { faults: { afterCommit: () => { throw new Error('injected'); } } }), /injected/);
  assert.equal(branchSha(f), r1.serverSha);
  assert.equal(g(f.wt, 'status', '--porcelain', '--untracked-files=all', '--ignored'), '');
  assert.equal(readJSON(path.join(f.home, 'landing-map.json')).entries.length, 1);
  assert.equal(g(f.server, 'rev-parse', 'main'), f.main);
  const r2 = await apply(f, p2.outDir);
  assert.equal(g(f.server, 'rev-parse', `${r2.serverSha}^`), r1.serverSha);
});

test('属主检查：只列出出问题的路径，给出 chown -h -P --from 的最小修复命令，不改任何东西', async () => {
  const { commands, unsafe } = chownFix([
    { path: '/r/.git/refs/heads/ops', uid: 0, type: 'dir' },
    { path: "/r/.git/logs/refs/heads/it's", uid: 0, type: 'dir' },
    { path: '/r/.git/objects/ab', uid: 1001, type: 'dir' },
    { path: '/r/.git/refs/heads/x\ny', uid: 0, type: 'dir' },
  ], { user: 'dsdev', group: 'dsdev' });
  assert.deepEqual(commands, [
    `sudo chown -h -P --from=root dsdev:dsdev -- '/r/.git/refs/heads/ops' '/r/.git/logs/refs/heads/it'\\''s'`,
    `sudo chown -h -P --from=1001 dsdev:dsdev -- '/r/.git/objects/ab'`,
  ]);
  assert.deepEqual(unsafe, ['/r/.git/refs/heads/x\ny']);
  const many = Array.from({ length: 85 }, (_, i) => ({ path: `/r/.git/objects/${i}`, uid: 0, type: 'dir' }));
  assert.equal(chownFix(many, { user: 'u', group: 'g' }).commands.length, 3);
  assert.ok(!chownFix(many, { user: 'u', group: 'g' }).commands.join('\n').includes(' -R'));

  const f = fixture();
  const p1 = await pack(f, f.base, f.int1);
  const commonDir = path.join(fs.realpathSync(f.server), '.git');
  assert.deepEqual(foreignPaths(commonDir), []);
  const found = [{ path: path.join(commonDir, 'refs/heads/ops'), uid: 0, type: 'dir' }, { path: path.join(commonDir, 'logs/refs/heads/ops'), uid: 0, type: 'dir' }];
  const err = await apply(f, p1.outDir, { checkOnly: true, group: 'dsdev', foreignPaths: () => found }).catch((e) => e);
  assert.match(err.message, /有 2 个路径不归/);
  assert.ok(err.message.includes(`sudo chown -h -P --from=root ${os.userInfo().username}:dsdev -- '${found[0].path}' '${found[1].path}'`));
  assert.ok(!/chown -R/.test(err.message.replace('不要对整个 .git 或仓库 chown -R', '')));
  assert.ok(!fs.existsSync(path.join(f.home, 'work', f.int1.slice(0, 12))));
  assert.equal(branchSha(f), null);
});

test('旁路分支：同一个 --home 里另开一条落地分支，各分支各自接续，包与分支不符时拒绝', async () => {
  const f = fixture();
  const r1 = await apply(f, (await pack(f, f.base, f.int1)).outDir);
  const side = { branch: 'assault/visual-base', worktree: path.join(f.root, 'srv', 'ds-visual-base') };
  const sideOut = path.join(f.root, 'out-side');
  const ps = await landPack({ from: f.base, to: f.int2, repo: f.local, out: sideOut, baseSnapshot: f.base, serverBase: 'main', ignoredList: f.ignoredList, branch: side.branch });
  assert.equal(ps.manifest.branch, side.branch);
  await assert.rejects(apply(f, ps.outDir), /是为 assault\/visual-base 打的/);
  const rs = await apply(f, ps.outDir, side);
  assert.equal(g(f.server, 'rev-parse', `${rs.serverSha}^`), f.main);
  assert.ok(compareTrees(lsTree(f.local, f.int2), lsTree(f.server, rs.serverSha)).equal);
  assert.equal((await apply(f, ps.outDir, side)).already, true);

  // 主落地分支照常接续自己的最后一次落地（int1），不受旁路分支影响
  const r2 = await apply(f, (await pack(f, f.int1, f.int2)).outDir);
  assert.equal(g(f.server, 'rev-parse', `${r2.serverSha}^`), r1.serverSha);
  const map = readJSON(path.join(f.home, 'landing-map.json'));
  assert.deepEqual(map.entries.map((e) => [e.branch, e.localTo]), [['assault/landing', f.int1], [side.branch, f.int2], ['assault/landing', f.int2]]);
  assert.equal(map.branches[side.branch].serverSha, rs.serverSha);
  assert.equal(map.branches[side.branch].serverBase, f.main);
  assert.equal(map.branches['assault/landing'].serverSha, r2.serverSha);
  assert.equal(map.branches['assault/landing'].landings, 2);
  assert.equal(map.byServer[rs.serverSha], f.int2);

  fs.copyFileSync(path.join(f.home, 'landing-map.json'), path.join(sideOut, 'landing-map.json'));
  write(f.local, 'a.txt', 'a4\n');
  g(f.local, 'commit', '-qam', 'side next');
  const auto = await landPack({ from: 'auto', to: 'HEAD', repo: f.local, out: sideOut, baseSnapshot: f.base, serverBase: 'main', ignoredList: f.ignoredList, branch: side.branch });
  assert.equal(auto.manifest.from.sha, f.int2);
  const rs2 = await apply(f, auto.outDir, side);
  assert.equal(g(f.server, 'rev-parse', `${rs2.serverSha}^`), rs.serverSha);
  assert.equal(g(f.server, 'rev-parse', 'main'), f.main);
});

test('land-test 分片 TMPDIR：默认在 /tmp/ds-land-test 下；含隐藏段或落在 home 下时拒绝', () => {
  assert.equal(shardTmpDir(DEFAULT_TMP_ROOT, 'abc123def456', 'run1', 'host', 3, '/home/dsdev'), '/tmp/ds-land-test/abc123def456/run1/host-3');
  assert.throws(() => shardTmpDir('/srv/.cache/t', 'abc123def456', 'run1', 'fe', 1, '/home/dsdev'), /隐藏段 \.cache/);
  assert.throws(() => shardTmpDir('/home/dsdev/oc-jobs-tmp', 'abc123def456', 'run1', 'fe', 1, '/home/dsdev'), /在 home/);
  assert.equal(shardTmpDir('/home/dsdev2/t', 'a', 'r', 'fe', 1, '/home/dsdev'), '/home/dsdev2/t/a/r/fe-1');
});

test('land-test 套件：all = host、fe、examples；examples 跑 CI 同一份 examples/vitest.config.ts、总是 1 片；host/fe 的命令不变', () => {
  assert.deepEqual(suitesFor(), ['host']);
  assert.deepEqual(suitesFor('all'), ['host', 'fe', 'examples']);
  assert.deepEqual(suitesFor('examples'), ['examples']);
  assert.throws(() => suitesFor('bogus'), /未知套件 bogus（host \| fe \| examples \| all）/);
  assert.equal(suiteShards('host', 8), 8);
  assert.equal(suiteShards('fe', 3), 3);
  assert.equal(suiteShards('examples', 8), 1);

  const shard = { tmp: '/tmp/ds-land-test/l/r/s-1', buildNumber: '20000', file: '/raw/s.json' };
  const head = ['env', 'TMPDIR=/tmp/ds-land-test/l/r/s-1', 'DEEP_STUDENT_BUILD_NUMBER=20000', 'VITEST_MAX_FORKS=2', 'VITEST_MAX_THREADS=2', 'npx', 'vitest', 'run'];
  const tail = ['--reporter=json', '--outputFile=/raw/s.json'];
  assert.deepEqual(shardCommand({ ...shard, suite: 'host', i: 3, shards: 8 }), [...head, '-c', 'vitest.host.config.ts', '--shard=3/8', ...tail]);
  assert.deepEqual(shardCommand({ ...shard, suite: 'fe', i: 1, shards: 1, filters: ['src/a.test.ts'] }), [...head, '-c', 'vitest.config.ts', ...tail, 'src/a.test.ts']);
  assert.deepEqual(shardCommand({ ...shard, suite: 'examples', i: 1, shards: suiteShards('examples', 8) }), [...head, '-c', 'examples/vitest.config.ts', ...tail]);

  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /^ {2}examples:\n(?: {4}.*\n|\n)*? {8}run: npx vitest run -c examples\/vitest\.config\.ts$/m);
  const required = /^ {2}required:\n(?: {4}.*\n)*? {4}needs: \[([^\]]*)\]$/m.exec(ci);
  assert.ok(required, 'CI Required 的 needs 行');
  assert.ok(required[1].split(',').map((s) => s.trim()).includes('examples'), 'CI Required 要等 examples 任务');
});

test('land-test --deps auto：lock/依赖字段变化 → npm ci；同指纹复用；来历不明的实体目录拒绝', () => {
  const r = tmpRoot('landing-deps-');
  g(r, 'init', '-q', '-b', 'main');
  write(r, 'package.json', JSON.stringify({ name: 'x', scripts: { a: '1' }, dependencies: { a: '1.0.0' } }));
  write(r, 'package-lock.json', '{"lockfileVersion":3,"a":"1.0.0"}');
  g(r, 'add', '-A');
  g(r, 'commit', '-qm', 'base');
  const base = g(r, 'rev-parse', 'HEAD');
  write(r, 'package.json', JSON.stringify({ name: 'x', scripts: { a: '2' }, dependencies: { a: '1.0.0' } }));
  g(r, 'commit', '-qam', 'scripts only');
  const scriptsOnly = g(r, 'rev-parse', 'HEAD');
  write(r, 'package-lock.json', '{"lockfileVersion":3,"a":"1.0.1"}');
  g(r, 'commit', '-qam', 'lock');
  const lock = g(r, 'rev-parse', 'HEAD');
  write(r, 'package.json', JSON.stringify({ name: 'x', scripts: { a: '2' }, dependencies: { a: '1.0.1' } }));
  write(r, 'patches/a+1.0.1.patch', 'diff\n');
  g(r, 'add', '-A');
  g(r, 'commit', '-qm', 'deps + patch');
  const both = g(r, 'rev-parse', 'HEAD');

  assert.deepEqual(depsChanges(r, base, scriptsOnly), []);
  assert.equal(depsKey(r, base), depsKey(r, scriptsOnly));
  assert.deepEqual(depsChanges(r, base, lock), ['package-lock.json']);
  assert.deepEqual(depsChanges(r, base, both), ['package-lock.json', 'patches/a+1.0.1.patch', 'package.json（依赖字段）']);
  assert.notEqual(depsKey(r, lock), depsKey(r, both));

  const none = { kind: 'none', stampKey: null };
  const K = 'k1';
  assert.equal(planDeps({ mode: 'auto', changed: [], nm: none, key: K }).action, 'link');
  assert.equal(planDeps({ mode: 'auto', changed: [], nm: { kind: 'link' }, key: K }).action, 'link');
  const ci = planDeps({ mode: 'auto', changed: ['package-lock.json'], nm: { kind: 'link' }, key: K });
  assert.equal(ci.action, 'ci');
  assert.match(ci.reason, /package-lock\.json.*npm ci/);
  assert.equal(planDeps({ mode: 'auto', changed: ['package-lock.json'], nm: { kind: 'dir', stampKey: K }, key: K }).action, 'reuse');
  assert.equal(planDeps({ mode: 'auto', changed: ['package-lock.json'], nm: { kind: 'dir', stampKey: 'old' }, key: K }).action, 'ci');
  assert.equal(planDeps({ mode: 'auto', changed: ['package-lock.json'], nm: none, key: K, sibling: '/t/x/node_modules' }).action, 'link-sibling');
  assert.equal(planDeps({ mode: 'auto', changed: [], nm: { kind: 'dir', stampKey: 'old' }, key: K }).action, 'link');
  assert.match(planDeps({ mode: 'auto', changed: [], nm: { kind: 'dir', stampKey: null }, key: K }).error, /来历不明/);
  assert.match(planDeps({ mode: 'link', changed: [], nm: { kind: 'dir', stampKey: K }, key: K }).error, /实体目录/);
  assert.equal(planDeps({ mode: 'ci', changed: [], nm: none, key: K }).action, 'ci');
  assert.match(planDeps({ mode: 'bogus', changed: [], nm: none, key: K }).error, /未知/);
  fs.rmSync(r, { recursive: true, force: true });
});

test('land-send：并行传输，失败重试，远端校验发现损坏后重传', { skip: spawnSync('sha256sum', ['--version']).status !== 0 && 'no sha256sum' }, async () => {
  const f = fixture();
  const p = await pack(f, f.base, f.int1, { partSize: '1K' });
  const bin = path.join(f.root, 'bin');
  const state = path.join(f.root, 'shim-state');
  fs.mkdirSync(state);
  write(bin, 'scp', `#!/bin/sh
for a; do src=$prev; prev=$a; done
dst=\${prev#*:}; name=$(basename "$dst")
if [ "$name" = "$FLAKY" ] && [ ! -e "$SHIM_STATE/flaky" ]; then touch "$SHIM_STATE/flaky"; echo "connection reset" >&2; exit 1; fi
if [ "$name" = "$CORRUPT" ] && [ ! -e "$SHIM_STATE/corrupt" ]; then touch "$SHIM_STATE/corrupt"; echo garbage > "$dst"; exit 0; fi
cp "$src" "$dst"
`, 0o755);
  write(bin, 'ssh', '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n', 0o755);
  Object.assign(process.env, { SHIM_STATE: state, FLAKY: p.manifest.parts[0].file, CORRUPT: 'to.tree.zst' });
  const remoteDir = path.join(f.root, 'remote', 'inbox');
  const { verified, stats } = await landSend({
    pack: p.outDir, host: 'fakehost', remoteDir, scp: path.join(bin, 'scp'), ssh: path.join(bin, 'ssh'), retries: 2, backoffMs: 10, jobs: 3,
  });
  assert.equal(verified, true);
  assert.equal(stats.files[p.manifest.parts[0].file].attempts.length, 2);
  assert.equal(stats.verifyRounds.length, 2);
  assert.deepEqual(stats.verifyRounds[0].bad, ['to.tree.zst']);
  assert.ok(p.manifest.parts.length > 1);
  const r = await landApply({ pack: remoteDir, repo: f.server, home: f.home, worktree: f.wt, user: os.userInfo().username, skipServiceChecks: true });
  assert.ok(compareTrees(lsTree(f.local, f.int1), lsTree(f.server, r.serverSha)).equal);
});

function statusFixture() {
  const root = tmpRoot('landing-status-');
  const bin = path.join(root, 'bin');
  const sd = path.join(root, 'systemd');
  const home = path.join(root, 'srv', 'landing');
  fs.mkdirSync(sd, { recursive: true });
  // systemctl show <unit> …：有 <unit>.show（或按调用次数的 <unit>.show.<n>）就打印，否则像已回收的 unit 一样 not-found
  write(bin, 'systemctl', `#!/bin/sh
[ "$1" = show ] || exit 1
n=$(cat "${sd}/$2.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${sd}/$2.count"
if [ -f "${sd}/$2.show.$n" ]; then cat "${sd}/$2.show.$n"; elif [ -f "${sd}/$2.show" ]; then cat "${sd}/$2.show"; else printf 'Id=%s\\nLoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nResult=success\\nExecMainStatus=0\\nMemoryPeak=[not set]\\n' "$2"; fi
`, 0o755);
  write(bin, 'journalctl', `#!/bin/sh\n[ -f "${sd}/$2.journal" ] && cat "${sd}/$2.journal"\nexit 0\n`, 0o755);
  write(bin, 'ssh', `#!/bin/sh\nfor a; do last=$a; done\n[ -e "${root}/ssh-down" ] && { echo "ssh: connect to host fakehost port 22: Connection refused" >&2; exit 255; }\nPATH="${bin}:$PATH" exec sh -c "$last"\n`, 0o755);
  const sha = (c) => c.repeat(40);
  const map = {
    schema: 'ds-landing-map/1', branch: 'assault/landing', serverBase: sha('0'), baseSnapshot: sha('b'),
    entries: [
      { localFrom: sha('b'), localTo: sha('1'), serverSha: sha('a'), branch: 'assault/landing', appliedAt: 't1', files: 3 },
      { localFrom: sha('1'), localTo: sha('2'), serverSha: sha('c'), branch: 'assault/landing', appliedAt: 't2', files: 4 },
    ],
    byLocal: { [sha('1')]: sha('a'), [sha('2')]: sha('c') }, byServer: { [sha('a')]: sha('1'), [sha('c')]: sha('2') },
  };
  write(home, 'landing-map.json', JSON.stringify(map));
  const local = path.join(root, 'local');
  write(local, '.landing/landing-map.json', JSON.stringify({ ...map, entries: map.entries.slice(0, 1) }));
  const id = sha('2').slice(0, 12);
  write(home, `reports/${id}/summary.json`, JSON.stringify({ ok: false, complete: true, deps: { action: 'ci' }, suites: { host: { numTotalTests: 10, numFailedTests: 1, numFailedTestSuites: 0 } } }));
  write(home, `reports/${id}/failures.txt`, '[host] a.test.ts > x\n');
  write(home, `applied/${id}/apply.json`, JSON.stringify({ serverSha: sha('c') }));
  const opts = { host: 'fakehost', home, ssh: path.join(bin, 'ssh'), out: path.join(local, '.reports/server'), map: path.join(local, '.landing/landing-map.json'), lines: 5 };
  return { root, sd, home, local, id, sha, map, opts };
}

test('land-status：失败的 unit → 状态、日志、报告与回执拉回、映射更新；退出码 1', async () => {
  const s = statusFixture();
  const unit = `ds-land-test-${s.id}.service`;
  write(s.sd, `${unit}.show`, `Id=${unit}\nLoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainCode=1\nExecMainStatus=1\nMemoryPeak=2147483648\nMemoryCurrent=[not set]\nCPUUsageNSec=754000000000\nExecMainStartTimestamp=Sat 2026-11-07 10:00:00 CST\nExecMainExitTimestamp=Sat 2026-11-07 10:40:00 CST\n`);
  write(s.sd, `${unit}.journal`, Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const r = await landStatus({ ...s.opts, target: s.id });
  assert.equal(r.exitCode, 1);
  assert.equal(r.unit, unit);
  assert.deepEqual([r.state.activeState, r.state.result, r.state.exitStatus, r.state.memoryPeak, r.state.cpu, r.state.source], ['failed', 'exit-code', 1, '2.00 GiB', '754s', 'systemctl']);
  assert.equal(r.journalTail.split('\n').length, 5);
  assert.deepEqual(r.map, { file: s.opts.map, action: 'write', added: 1, entries: 2 });
  assert.equal(readJSON(s.opts.map).entries.length, 2);
  assert.equal(readJSON(`${s.opts.map}.bak`).entries.length, 1);
  const dest = path.join(s.opts.out, s.id);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['apply.json', 'failures.txt', 'status.json', 'summary.json']);
  assert.equal(readJSON(path.join(dest, 'status.json')).state.result, 'exit-code');
  assert.deepEqual(r.report.summary.suites.host, { total: 10, failed: 1, failedSuites: 0 });
  assert.equal(r.landings[0].serverSha, s.sha('c'));

  // 再拉一次：映射无变化，报告目录整体替换（服务器上删掉的文件本机也消失）
  fs.rmSync(path.join(s.home, `reports/${s.id}/failures.txt`));
  const again = await landStatus({ ...s.opts, target: s.id });
  assert.equal(again.map.action, 'unchanged');
  assert.ok(!fs.existsSync(path.join(dest, 'failures.txt')));
});

test('land-status：unit 已回收时从日志补结果与 MemoryPeak；服务器 SHA 前缀可换成本机 id；--wait 等到结束', async () => {
  const s = statusFixture();
  const unit = `ds-land-test-${s.id}.service`;
  write(s.home, `reports/${s.id}/summary.json`, JSON.stringify({ ok: true, complete: true, deps: { action: 'link' }, suites: { host: { numTotalTests: 10, numFailedTests: 0, numFailedTestSuites: 0 } } }));
  write(s.sd, `${unit}.journal`, `2026-11-07T10:40:00+0800 ser-38 node[1]: 完成：全绿\n2026-11-07T10:40:01+0800 ser-38 systemd[1]: ${unit}: Deactivated successfully.\n2026-11-07T10:40:01+0800 ser-38 systemd[1]: ${unit}: Consumed 41min 12.345s CPU time, 3.1G memory peak.\n`);
  const r = await landStatus({ ...s.opts, target: s.sha('c').slice(0, 9) });
  assert.equal(r.id, s.id);
  assert.deepEqual([r.state.loadState, r.state.result, r.state.memoryPeak, r.state.cpu, r.state.source, r.exitCode], ['not-found', 'success', '3.1G', '41min 12.345s', 'journal', 0]);

  write(s.sd, `${unit}.show.1`, `Id=${unit}\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainStatus=0\nMemoryPeak=1048576000\nMemoryCurrent=524288000\nExecMainStartTimestamp=x\n`);
  fs.rmSync(path.join(s.sd, `${unit}.count`), { force: true });
  const running = await landStatus({ ...s.opts, target: unit, noMap: true, noReports: true });
  assert.equal(running.exitCode, 3);
  assert.equal(running.state.memoryCurrent, '500.0 MiB');
  fs.rmSync(path.join(s.sd, `${unit}.count`), { force: true });
  const waited = await landStatus({ ...s.opts, target: unit, wait: true, interval: 0.05 });
  assert.equal(waited.exitCode, 0);
  assert.equal(Number(fs.readFileSync(path.join(s.sd, `${unit}.count`), 'utf8')), 2);
});

test('land-status：本机映射有服务器没有的记录时不覆盖；ssh 失败退出码 2；--map-only', async () => {
  const s = statusFixture();
  const extra = { localFrom: s.sha('1'), localTo: s.sha('9'), serverSha: s.sha('e'), branch: 'assault/visual-base', appliedAt: 'tx' };
  const localMap = { ...s.map, entries: [...s.map.entries.slice(0, 1), extra] };
  write(s.local, '.landing/landing-map.json', JSON.stringify(localMap));
  const r = await landStatus({ ...s.opts, mapOnly: true });
  assert.equal(r.exitCode, 2);
  assert.equal(r.map.action, 'conflict');
  assert.deepEqual(readJSON(s.opts.map), localMap);
  assert.equal(readJSON(path.join(s.local, '.landing', 'landing-map.fakehost.json')).entries.length, 2);

  fs.rmSync(s.opts.map);
  const ok = await landStatus({ ...s.opts, mapOnly: true });
  assert.equal(ok.exitCode, 0);
  assert.equal(readJSON(s.opts.map).entries.length, 2);

  write(s.root, 'ssh-down', '');
  const down = await landStatus({ ...s.opts, target: s.id });
  assert.equal(down.exitCode, 2);
  assert.match(down.errors.join('\n'), /Connection refused/);

  assert.deepEqual(resolveTarget('ds-land-test-abc123def456'), { id: 'abc123def456', unit: 'ds-land-test-abc123def456.service' });
  assert.deepEqual(resolveTarget('ds-fulltest.service'), { id: null, unit: 'ds-fulltest.service' });
  assert.throws(() => resolveTarget('x; rm -rf /'), /不合法/);
  assert.equal(mergeMap(null, { schema: 'nope' }).action, 'invalid');
  assert.equal(parseStatus('LoadState=loaded\nActiveState=activating\nSubState=start\n', '').running, true);
});

test('小工具：sha256sum 输出解析、未传输区、清单校验', () => {
  const { ok, bad } = parseSumCheck('a.000: OK\nb.001: FAILED\nc: FAILED open or read\n');
  assert.deepEqual([...ok], ['a.000']);
  assert.deepEqual([...bad], ['b.001', 'c']);
  assert.equal(zoneOf('example/x.md'), 'example/');
  assert.equal(zoneOf('public/fonts/a.woff2'), '字体');
  assert.equal(zoneOf('src-tauri/resources/pdfium/libpdfium.so'), 'src-tauri/resources/');
  assert.equal(zoneOf('host/platform/native/pdfium/api.ts'), null);
  const sha = 'a'.repeat(40);
  const h = 'b'.repeat(64);
  const m = {
    schema: 'ds-landing/1', from: { sha }, to: { sha }, parts: [{ file: '../evil', sha256: h, bytes: 1 }], patch: { sha256: h }, archive: { sha256: h },
    trees: { from: { file: 'from.tree.zst' }, to: { file: 'to.tree.zst' } }, tools: [], baseSnapshot: { sha, server: 'x' },
  };
  assert.throws(() => validateManifest(m), /不安全的文件名/);
  m.parts[0].file = 'land.patch.zst.000';
  assert.equal(validateManifest(m), m);
});
