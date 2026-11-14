#!/usr/bin/env node
// 本机：在临时目录模拟服务器落地，证明补丁能干净应用。每次 land-pack 之后、land-send 之前跑一遍。
//
//   node scripts/electron-migration/landing/land-simulate.mjs --pack .landing/<to12>
//   node scripts/electron-migration/landing/land-simulate.mjs --pack .landing/<a> --pack .landing/<b> --server-sim   # 依次落地（增量链）
//
// 检出模拟（总是做）：每个包的 from 检出到临时工作树，用分片重新拼出补丁（与服务器同一段代码）→ git apply --index --binary
//   → git diff --stat <to> 与 git diff --cached --stat <to>（都排除 src/version.ts）为空，且没有任何未跟踪文件。
// 服务器模拟（--server-sim）：用快照源码包（含 28 个被忽略但跟踪的文件）建一个假的服务器仓库并核对它 = 本机基线 + 这 28 个文件；
//   每个包只拷贝 SHA256SUMS 列出的文件到假 inbox 并 sha256sum -c，用包里的 land-apply.mjs 依次落地，核对 landing-map 链、
//   结果树（本机 to 树的每个路径一致，服务器独有的只剩那 28 个）、main 未动、重复落地幂等、坏分片与乱序包被拒。
//   --test-filter <path>   落地后再用包里的 land-test.mjs 对最后一个服务器提交跑这段 host vitest（direct 模式，可重复）。
//                          只有这一步经 bin/heavy 排队（vitest 吃 CPU/内存）；检出、git apply、树比对是轻量的 git I/O，直接跑，
//                          不必排在全量 tsc/vitest 后面。--heavy <path> 指定，--no-heavy 不排队（默认 <主仓库上一级>/bin/heavy 或 $LAND_HEAVY）
//   --deps auto|link|ci    传给 land-test（默认 auto）。auto 时核对它的决定：包的 to 与假 main 依赖不同 → ci，相同 → link；
//                          npm 默认用桩（软链主仓库 node_modules 的条目，不联网、不写共享 node_modules），并验证重跑复用；--real-npm 用真 npm ci
// 其他选项：--repo、--tarball <file>（默认 <主仓库上一级>/.transfer/ds-main-ae4efdf9e.tar.zst）、--ignored-list <file>、--keep（保留临时目录）
// 退出码：0 全部通过；1 有核对失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  BASE_SNAPSHOT, EXCLUDED_PATHS, MANIFEST_FILE, SUMS_FILE, LandingError, fail, git, gitLine, lsTree, compareTrees,
  readSums, readJSON, reassemble, short, log, printUsage, isEntry,
} from './lib.mjs';
import { depsChanges } from './land-test.mjs';

const PATHSPEC = ['--', '.', ...EXCLUDED_PATHS.map((p) => `:(exclude)${p}`)];
const ID = ['-c', 'user.name=land-simulate', '-c', 'user.email=land-simulate@localhost'];

function sumCheck(dir) {
  const tool = spawnSync('sha256sum', ['--version']).status === 0 ? ['sha256sum', ['-c', SUMS_FILE]] : ['shasum', ['-a', '256', '-c', SUMS_FILE]];
  const r = spawnSync(tool[0], tool[1], { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

function node(script, args, { heavy = null, env } = {}) {
  const [cmd, argv] = heavy ? [heavy, [process.execPath, script, ...args]] : [process.execPath, [script, ...args]];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 1 << 26, env: env ? { ...process.env, ...env } : process.env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// npm 桩：记录调用；ci 时按主仓库 node_modules 的顶层条目逐个软链，拼出一个实体 node_modules 目录。
// 只读共享的 node_modules，不联网，不装任何东西；只验证 land-test 的依赖决定和 npm ci 之后的流程。
const NPM_STUB = `#!/bin/sh
echo "$PWD|$*" >> "$LAND_SIM_NPM_LOG"
[ "$1" = ci ] || exit 2
rm -rf node_modules && mkdir node_modules || exit 1
for e in "$LAND_SIM_NM"/* "$LAND_SIM_NM"/.[!.]*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  ln -s "$e" node_modules/ || exit 1
done
`;

/** 只给 land-test 那一步用：机器级重任务槽（bin/heavy）。显式 --no-heavy 或找不到时直接跑。 */
function heavyCommand(workspace, opt) {
  if (opt === false) return null;
  const p = typeof opt === 'string' ? path.resolve(opt) : process.env.LAND_HEAVY ?? path.join(workspace, 'bin', 'heavy');
  return fs.existsSync(p) ? p : null;
}

async function checkoutSim(repo, packDir, tmp, keep) {
  const m = readJSON(path.join(packDir, MANIFEST_FILE));
  const wt = path.join(tmp, `checkout-${short(m.to.sha)}`);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, m.from.sha]);
  try {
    const patch = await reassemble(packDir, m, path.join(tmp, `work-${short(m.to.sha)}`));
    const t0 = Date.now();
    git(wt, ['apply', '--index', '--binary', '--whitespace=nowarn', patch]);
    const applyMs = Date.now() - t0;
    const stat = gitLine(wt, ['diff', '--stat', m.to.sha, ...PATHSPEC]);
    const statCached = gitLine(wt, ['diff', '--cached', '--stat', m.to.sha, ...PATHSPEC]);
    const untracked = git(wt, ['ls-files', '--others', '-z']).split('\0').filter(Boolean);
    const ok = !stat && !statCached && !untracked.length;
    log(`[检出模拟] ${short(m.from.sha)} → ${short(m.to.sha)}：git apply --index --binary ${applyMs}ms；git diff --stat ${m.to.sha.slice(0, 9)} ${stat ? '非空' : '为空'}，--cached ${statCached ? '非空' : '为空'}，未跟踪文件 ${untracked.length} 个${ok ? '' : ' ← 失败'}`);
    if (stat) console.log(stat.split('\n').slice(-20).join('\n'));
    if (statCached) console.log(statCached.split('\n').slice(-20).join('\n'));
    if (untracked.length) console.log(untracked.slice(0, 20).join('\n'));
    return { pack: packDir, from: m.from.sha, to: m.to.sha, applyMs, diffStatEmpty: !stat, cachedStatEmpty: !statCached, untracked: untracked.length, ok };
  } finally {
    if (!keep) git(repo, ['worktree', 'remove', '--force', wt]);
  }
}

function buildFakeServer(repo, tmp, tarball, ignored) {
  const server = path.join(tmp, 'server', 'deep-student');
  fs.mkdirSync(server, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', server]);
  execFileSync('sh', ['-c', 'zstd -dc "$1" | tar -xf - -C "$2"', 'sh', tarball, server]);
  git(server, ['add', '-A']);
  const present = ignored.filter((p) => fs.existsSync(path.join(server, p)));
  if (present.length) git(server, ['add', '-f', '--', ...present]);
  git(server, [...ID, 'commit', '-q', '--no-verify', '-m', 'fake server main = snapshot tarball of ae4efdf9e']);
  const main = gitLine(server, ['rev-parse', 'HEAD']);
  const cmp = compareTrees(lsTree(repo, BASE_SNAPSHOT.sha), lsTree(server, main));
  const extraOk = JSON.stringify(cmp.extra) === JSON.stringify([...ignored].sort());
  log(`[服务器模拟] 假服务器 main ${short(main)}：与本机基线 ${cmp.equal ? '一致' : `不一致（缺 ${cmp.missing.length}，不同 ${cmp.mismatch.length}）`}，多出 ${cmp.extra.length} 个路径${extraOk ? '（正是被忽略但跟踪的清单）' : ' ← 与清单不符'}`);
  if (!cmp.equal || !extraOk) fail('假服务器仓库与“本机基线 + 被忽略但跟踪的文件”不一致，模拟不可信');
  return { server, main };
}

function inboxCopy(packDir, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const { file } of readSums(packDir)) fs.copyFileSync(path.join(packDir, file), path.join(dest, file));
  fs.copyFileSync(path.join(packDir, SUMS_FILE), path.join(dest, SUMS_FILE));
  return dest;
}

async function serverSim({ repo, packs, tmp, tarball, ignored, testFilters, nodeModules, deps, realNpm, heavy }) {
  const results = [];
  const { server, main } = buildFakeServer(repo, tmp, tarball, ignored);
  const home = path.join(tmp, 'server', 'landing');
  const landingWt = path.join(tmp, 'server', 'ds-landing');
  const common = ['--repo', server, '--home', home, '--worktree', landingWt, '--server-base', 'main', '--user', os.userInfo().username, '--skip-service-checks'];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    log(`[服务器模拟] ${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`);
  };

  const inboxes = packs.map((p) => {
    const m = readJSON(path.join(p, MANIFEST_FILE));
    const dir = inboxCopy(p, path.join(home, 'inbox', short(m.to.sha)));
    const s = sumCheck(dir);
    check(`inbox ${short(m.to.sha)} sha256sum -c`, s.ok, s.ok ? `${readSums(dir).length} 个文件 OK` : s.out.slice(0, 300));
    return { dir, m };
  });

  const bad = path.join(tmp, 'inbox-bad');
  fs.cpSync(inboxes[0].dir, bad, { recursive: true });
  const part0 = path.join(bad, inboxes[0].m.parts[0].file);
  const buf = fs.readFileSync(part0);
  buf[buf.length >> 1] ^= 0xff;
  fs.writeFileSync(part0, buf);
  const rBad = node(path.join(bad, 'land-apply.mjs'), ['--pack', bad, ...common, '--check-only']);
  check('坏分片被拒（--check-only）', rBad.code === 1 && /分片校验失败/.test(rBad.out), rBad.out.trim().split('\n').at(-1));

  if (inboxes.length > 1) {
    const rOrder = node(path.join(inboxes[1].dir, 'land-apply.mjs'), ['--pack', inboxes[1].dir, ...common]);
    check('乱序包被拒（分支不存在时先来增量包）', rOrder.code === 1 && /首次落地的包必须从/.test(rOrder.out), rOrder.out.trim().split('\n').at(-1));
  }

  let lastServer = null;
  for (const { dir, m } of inboxes) {
    const rc = node(path.join(dir, 'land-apply.mjs'), ['--pack', dir, ...common, '--check-only']);
    check(`land-apply --check-only ${short(m.to.sha)}`, rc.code === 0 && /CHECK_OK/.test(rc.out), rc.out.split('\n').find((l) => l.includes('干跑')) ?? rc.out.slice(-300));
    const t0 = Date.now();
    const r = node(path.join(dir, 'land-apply.mjs'), ['--pack', dir, ...common]);
    const serverSha = /^SERVER_SHA=([0-9a-f]{40})$/m.exec(r.out)?.[1];
    check(`land-apply ${short(m.from.sha)} → ${short(m.to.sha)}`, r.code === 0 && Boolean(serverSha), serverSha ? `服务器 ${short(serverSha)}，${((Date.now() - t0) / 1000).toFixed(1)}s` : r.out.slice(-800));
    if (!serverSha) break;
    const cmp = compareTrees(lsTree(repo, m.to.sha), lsTree(server, serverSha));
    const extraOk = JSON.stringify(cmp.extra) === JSON.stringify([...ignored].sort());
    check(`结果树 ${short(serverSha)} = 本机 ${short(m.to.sha)} + 服务器独有`, cmp.equal && extraOk, `缺 ${cmp.missing.length}，不同 ${cmp.mismatch.length}，服务器独有 ${cmp.extra.length}`);
    const parent = gitLine(server, ['rev-parse', `${serverSha}^`]);
    check(`父提交是${lastServer ? '上一次落地' : '假服务器 main'}`, parent === (lastServer ?? main), short(parent));
    const msg = gitLine(server, ['log', '-1', '--format=%B', serverSha]);
    check('提交信息带本机 from/to', msg.includes(`Local-From: ${m.from.sha}`) && msg.includes(`Local-To: ${m.to.sha}`));
    const again = node(path.join(dir, 'land-apply.mjs'), ['--pack', dir, ...common]);
    check('同一个包再落地一次是幂等的', again.code === 0 && again.out.includes(`SERVER_SHA=${serverSha}`) && gitLine(server, ['rev-parse', 'assault/landing']) === serverSha);
    lastServer = serverSha;
  }
  const map = readJSON(path.join(home, 'landing-map.json'), null);
  const chainOk = map && map.entries.length === inboxes.length && map.entries.every((e, k) => e.localTo === inboxes[k].m.to.sha && e.localFrom === inboxes[k].m.from.sha)
    && map.byLocal[inboxes[0].m.baseSnapshot.sha] === main;
  check('landing-map.json 链完整（含 base → 假 main）', Boolean(chainOk), map ? `${map.entries.length} 条` : '缺失');
  check('main 未被改动', gitLine(server, ['rev-parse', 'main']) === main);
  check('主工作树仍在 main 且干净', gitLine(server, ['symbolic-ref', '--short', 'HEAD']) === 'main' && !git(server, ['status', '--porcelain']));

  if (testFilters.length && lastServer) {
    const last = inboxes.at(-1).dir;
    const lastTo = inboxes.at(-1).m.to.sha;
    const npmLog = path.join(tmp, 'npm-calls.log');
    const stub = path.join(tmp, 'npm-stub.sh');
    fs.writeFileSync(stub, NPM_STUB, { mode: 0o755 });
    const args = ['--sha', lastServer, '--repo', server, '--home', home, '--runner', 'direct', '--deps', deps, '--node-modules', nodeModules,
      '--user', os.userInfo().username, ...(realNpm ? [] : ['--npm', stub]), ...testFilters.flatMap((f) => ['--filter', f])];
    log(`[服务器模拟] land-test${heavy ? `（经 ${heavy} 排队）` : ''}：--deps ${deps}${realNpm ? '，真实 npm ci' : '，npm 用桩'}`);
    const t0 = Date.now();
    const r = node(path.join(last, 'land-test.mjs'), args, { heavy, env: { LAND_SIM_NPM_LOG: npmLog, LAND_SIM_NM: nodeModules } });
    const label = short(map.byServer[lastServer]);
    const summary = readJSON(path.join(home, 'reports', label, 'summary.json'), null);
    const files = fs.existsSync(path.join(home, 'reports', label)) ? fs.readdirSync(path.join(home, 'reports', label)).sort() : [];
    check(`land-test 冒烟（${testFilters.join(', ')}）`, r.code === 0 && summary?.ok === true,
      summary ? `用例 ${summary.suites.host.numTotalTests}，失败 ${summary.suites.host.numFailedTests}，${((Date.now() - t0) / 1000).toFixed(0)}s；报告目录 ${files.join(' ')}` : r.out.slice(-800));
    if (deps === 'auto') {
      // 假服务器 main 的树 = 本机基线 + 服务器独有文件，依赖文件与本机基线相同
      const changed = depsChanges(repo, BASE_SNAPSHOT.sha, lastTo);
      const want = changed.length ? 'ci' : 'link';
      check(`--deps auto 的决定是 ${want}`, summary?.deps?.action === want && JSON.stringify(summary.deps.changed) === JSON.stringify(changed),
        `${summary?.deps?.action ?? '无 summary'}：${summary?.deps?.reason ?? r.out.slice(-300)}`);
      const calls = fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean) : [];
      if (!realNpm) {
        const wt = path.join(home, 'test-worktrees', short(lastServer));
        const nmDir = path.join(wt, 'node_modules');
        const stamp = readJSON(path.join(nmDir, '.land-deps.json'), null);
        check(want === 'ci' ? 'npm ci 在测试工作树里调用一次，装完写指纹' : '没有调用 npm',
          want === 'ci'
            ? calls.length === 1 && fs.realpathSync(calls[0].split('|')[0]) === fs.realpathSync(wt) && calls[0].endsWith('|ci --no-audit --no-fund')
              && fs.lstatSync(nmDir).isDirectory() && stamp?.sha === lastServer
            : calls.length === 0 && fs.lstatSync(nmDir).isSymbolicLink(),
          calls.join(' ; ') || '无调用');
        if (want === 'ci') {
          const again = node(path.join(last, 'land-test.mjs'), args, { heavy, env: { LAND_SIM_NPM_LOG: npmLog, LAND_SIM_NM: nodeModules } });
          const s2 = readJSON(path.join(home, 'reports', label, 'summary.json'), null);
          const calls2 = fs.readFileSync(npmLog, 'utf8').split('\n').filter(Boolean);
          check('同一提交重跑复用已装的 node_modules（不再 npm ci）', again.code === 0 && s2?.deps?.action === 'reuse' && calls2.length === 1, s2?.deps?.reason ?? again.out.slice(-300));
        }
      }
    }
  }
  return results;
}

export async function landSimulate(opts) {
  const repo = gitLine(opts.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']);
  const commonDir = path.resolve(repo, gitLine(repo, ['rev-parse', '--git-common-dir']));
  const mainRoot = path.dirname(commonDir);
  const workspace = path.dirname(mainRoot);
  const packs = (opts.pack ?? []).map((p) => path.resolve(p));
  if (!packs.length) fail('至少给一个 --pack');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-land-sim-'));
  log(`模拟目录 ${tmp}`);
  const report = { tmp, checkout: [], server: [] };
  try {
    for (const p of packs) report.checkout.push(await checkoutSim(repo, p, tmp, opts.keep));
    if (opts.serverSim) {
      const tarball = opts.tarball ?? path.join(workspace, '.transfer', 'ds-main-ae4efdf9e.tar.zst');
      const ignoredFile = opts.ignoredList ?? path.join(workspace, '.transfer', 'ignored-tracked-files.txt');
      const ignored = fs.readFileSync(ignoredFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      report.server = await serverSim({
        repo, packs, tmp, tarball, ignored, testFilters: opts.testFilter ?? [], nodeModules: path.join(mainRoot, 'node_modules'),
        deps: opts.deps ?? 'auto', realNpm: Boolean(opts.realNpm), heavy: heavyCommand(workspace, opts.heavy),
      });
    }
  } finally {
    if (!opts.keep) {
      // 假服务器仓库里 git commit 触发的后台 gc --auto 可能还在写 .git
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
      git(repo, ['worktree', 'prune']);
    }
  }
  const ok = report.checkout.every((c) => c.ok) && report.server.every((s) => s.ok);
  log(`模拟${ok ? '全部通过' : '有失败'}：检出模拟 ${report.checkout.filter((c) => c.ok).length}/${report.checkout.length}${opts.serverSim ? `，服务器模拟 ${report.server.filter((s) => s.ok).length}/${report.server.length}` : ''}${opts.keep ? `；临时目录保留在 ${tmp}` : ''}`);
  return { ok, report };
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        pack: { type: 'string', multiple: true }, repo: { type: 'string' }, 'server-sim': { type: 'boolean' }, tarball: { type: 'string' },
        'ignored-list': { type: 'string' }, 'test-filter': { type: 'string', multiple: true }, keep: { type: 'boolean' }, json: { type: 'string' },
        deps: { type: 'string' }, 'real-npm': { type: 'boolean' }, heavy: { type: 'string' }, 'no-heavy': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) printUsage(import.meta.url);
    const { ok, report } = await landSimulate({
      pack: values.pack, repo: values.repo, serverSim: values['server-sim'], tarball: values.tarball,
      ignoredList: values['ignored-list'], testFilter: values['test-filter'], keep: values.keep,
      deps: values.deps, realNpm: values['real-npm'], heavy: values['no-heavy'] ? false : values.heavy,
    });
    if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`land-simulate 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(1);
  }
}
