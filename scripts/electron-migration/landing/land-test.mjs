#!/usr/bin/env node
// 服务器（以 dsdev 运行）：对落地后的服务器提交跑 host 全量 vitest，结果放到 <home>/reports/<本机 SHA 前 12 位>/，本机 land-status 拉回：
//
//   sudo -u dsdev /opt/node26/bin/node <上传目录>/land-test.mjs --sha <SERVER_SHA>
//   本机：node scripts/electron-migration/landing/land-status.mjs <本机12位>
//
// 复用 ds-fulltest 的机制：独立的分离工作树 + node_modules 软链到主仓库 + 8 个分片经全局作业队列（jobs/job.mjs，受 test 类并发上限约束）
// + lib/fulltest-result.mjs 的判定（套件崩溃、分片缺失不算绿）。与 fulltest.mjs 不同：测指定提交而不是 main，
// 不读写 .oc-runs/fulltest/latest.json（看板的 main 指标），不往 lane 分派 main 红灯。
// 报告目录只放小文件：summary.json、failures.txt、version.ts、vitest-<suite>.json.zst、land-test.log；分片原件在 <home>/test-raw/。
// 每个分片的 TMPDIR 是 <tmp-root>/<label>/<runId>/<suite>-<i>（不含隐藏段、不在 home 下，结束后删除）。
//
// 选项：
//   --sha <rev>                  要测的服务器提交（默认 assault/landing 的 HEAD）
//   --local <sha>                对应的本机提交（默认从 landing-map.json 反查）
//   --label <name>               报告目录名（默认本机 SHA 前 12 位；测非落地提交时必填）
//   --repo <dir> / --home <dir>  同 land-apply（默认 /home/dsdev/dev/deep-student、<repo>/../landing）
//   --suite host|fe|examples|all host = vitest.host.config.ts（默认）；fe = vitest.config.ts；examples = examples/vitest.config.ts
//                                （社区插件示例，与 CI 的 examples 任务同一配置）；all = host、fe、examples 依次跑
//   --shards <n>                 分片数（默认 8；带 --filter 时默认 1）；examples 只有几个文件，总是 1 片
//   --runner auto|queue|direct   auto：ds-jobs 在跑就走作业队列，否则直接跑（默认 auto）
//   --parallel <n>               direct 模式同时跑的分片数（默认 2）
//   --build-number <n|auto>      DEEP_STUDENT_BUILD_NUMBER，并据此生成 src/version.ts（默认 20000，与本机测试一致；auto = 由服务器 git 历史计算）
//   --deps auto|link|ci          auto（默认）：package-lock.json、.npmrc、patches/ 与 package.json 依赖字段都和主仓库 HEAD 相同 → 软链主仓库 node_modules；
//                                有任何不同 → 在测试工作树里 npm ci（同一依赖指纹之前装过的，复用本工作树或软链到别的测试工作树那份）。
//                                link：总是软链；ci：总是 npm ci。决定和原因写进 summary.json 的 deps
//   --node-modules <dir>         软链来源（默认 <repo>/node_modules）
//   --npm <cmd>                  npm 可执行文件（默认 npm；本机模拟用桩）
//   --filter <path>              只跑这些测试路径（可重复；冒烟用）
//   --tmp-root <dir>             分片 TMPDIR 的根（默认 /tmp/ds-land-test；不能含隐藏段，不能在 home 下）
//   --user <name>                要求的运行用户（默认 dsdev）
//   --remove-worktree            结束后删除测试工作树（默认保留：便于复查，同一提交重跑会复用）
// 退出码：0 全绿；1 有失败用例或套件；2 不完整（分片缺失、源码漂移）或环境错误。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BRANCH, LandingError, fail, git, gitLine, gitOk, revParse, readJSON, writeJSONAtomic, acquireLock,
  systemctlState, zstdCompress, safeName, short, log, printUsage, isEntry,
} from './lib.mjs';

const SUITES = { host: 'vitest.host.config.ts', fe: 'vitest.config.ts', examples: 'examples/vitest.config.ts' };
// 分片数多于测试文件时，空分片的 vitest 以"No test files found"失败，判定为不完整。
const SINGLE_SHARD_SUITES = new Set(['examples']);
const DEP_PATHS = ['package-lock.json', '.npmrc', 'patches'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];
const SHARD_TIMEOUT_MS = 45 * 60_000;

// 与 scripts/electron-migration/lib/fulltest-result.mjs 相同；只在服务器仓库里加载不到它时使用。
function builtinVerdict(shards, expected, stable) {
  const missing = shards.filter((s) => !s.report || !Array.isArray(s.report.testResults)).map((s) => s.i);
  const rawFailures = shards.filter((s) => s.code !== 0).map((s) => ({ shard: s.i, code: s.code }));
  const failed = shards.reduce((n, s) => n + (s.report?.numFailedTests ?? 0) + (s.report?.numFailedTestSuites ?? 0), 0);
  const complete = shards.length === expected && missing.length === 0 && shards.every((s) => {
    const r = s.report;
    return Number.isInteger(r.numTotalTests) && r.numTotalTests > 0 &&
      r.numPassedTests + r.numFailedTests + (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0) === r.numTotalTests;
  });
  return { complete, stable, missing, rawFailures, ok: stable && complete && rawFailures.length === 0 && failed === 0 && shards.every((s) => s.report.success === true) };
}

function depFields(repo, rev) {
  const pkg = JSON.parse(git(repo, ['show', `${rev}:package.json`]));
  return JSON.stringify(DEP_FIELDS.map((k) => pkg[k] ?? null));
}

/** 依赖相关内容的指纹：DEP_PATHS 的对象 id + package.json 依赖字段。npm ci 装好后写进 node_modules/.land-deps.json。 */
export function depsKey(repo, rev) {
  const oids = DEP_PATHS.map((p) => `${p}=${gitOk(repo, ['rev-parse', '--verify', '-q', `${rev}:${p}`]) ? gitLine(repo, ['rev-parse', `${rev}:${p}`]) : '-'}`);
  return crypto.createHash('sha256').update(JSON.stringify([oids, depFields(repo, rev)])).digest('hex');
}

/** 与主仓库 HEAD 相比变了哪些依赖内容（空数组 = 相同）。 */
export function depsChanges(repo, rootHead, rev) {
  const changed = git(repo, ['diff', '--name-only', rootHead, rev, '--', ...DEP_PATHS]).split('\n').filter(Boolean);
  if (depFields(repo, rootHead) !== depFields(repo, rev)) changed.push('package.json（依赖字段）');
  return changed;
}

const STAMP = '.land-deps.json';
function readStamp(nmDir) {
  return readJSON(path.join(nmDir, STAMP), null);
}

/**
 * 决定测试工作树的 node_modules 怎么来。nm：{ kind: 'none'|'link'|'dir', stampKey }；sibling：别的测试工作树里指纹相同的 node_modules。
 * 返回 { action: 'link'|'ci'|'reuse'|'link-sibling', reason }，或 { error }。
 */
export function planDeps({ mode, changed, nm, key, sibling }) {
  const own = nm.kind === 'dir' && nm.stampKey === key;
  if (mode === 'ci') return { action: 'ci', reason: '--deps ci' };
  if (mode === 'link') {
    if (nm.kind === 'dir') return { error: '测试工作树的 node_modules 是实体目录（之前 npm ci 装的）；用 --deps auto 或 --deps ci，或手动删除后再软链' };
    return { action: 'link', reason: `--deps link${changed.length ? `（强行复用，依赖与主仓库 HEAD 不同：${changed.join('、')}）` : ''}` };
  }
  if (mode !== 'auto') return { error: `未知的 --deps ${mode}（auto | link | ci）` };
  if (!changed.length) {
    if (nm.kind === 'dir' && !nm.stampKey) return { error: '测试工作树的 node_modules 是来历不明的实体目录（没有 .land-deps.json）；核对后手动删除再跑' };
    if (own) return { action: 'reuse', reason: '依赖与主仓库 HEAD 相同，复用本工作树之前装好的 node_modules' };
    return { action: 'link', reason: '依赖与主仓库 HEAD 相同，软链主仓库的 node_modules' };
  }
  const why = `依赖与主仓库 HEAD 不同：${changed.join('、')}`;
  if (own) return { action: 'reuse', reason: `${why}；本工作树之前 npm ci 装的指纹相同，复用` };
  if (sibling) return { action: 'link-sibling', reason: `${why}；${sibling} 是同一指纹的 npm ci 结果，软链过去` };
  return { action: 'ci', reason: `${why} → npm ci` };
}

function findSibling(testRoot, self, key) {
  let names = [];
  try {
    names = fs.readdirSync(testRoot);
  } catch {
    return null;
  }
  for (const n of names) {
    const d = path.join(testRoot, n, 'node_modules');
    if (path.join(testRoot, n) === self) continue;
    try {
      if (!fs.lstatSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    if (readStamp(d)?.key === key) return d;
  }
  return null;
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 测试夹具多由 os.tmpdir() 派生。产品代码按 Rust deny_hidden_local_path 拒绝含隐藏段的路径，Electron 测试又断言
// 隔离目录不在真实 home 下；服务器作业队列的 TMPDIR 在 ~/.oc-jobs/tmp，两条都违反，所以每个分片在命令里自带 TMPDIR。
export const DEFAULT_TMP_ROOT = '/tmp/ds-land-test';

export function shardTmpDir(tmpRoot, label, runId, suite, i, home = os.homedir()) {
  const root = path.resolve(tmpRoot);
  const dir = path.join(root, label, runId, `${suite}-${i}`);
  const hidden = dir.split(path.sep).find((c) => c.startsWith('.') && c !== '.' && c !== '..');
  if (hidden) fail(`分片 TMPDIR 含隐藏段 ${hidden}：${dir}；用 --tmp-root 换一个目录`);
  if (root === home || root.startsWith(home + path.sep)) fail(`分片 TMPDIR 在 home（${home}）下：${dir}；用 --tmp-root 换一个目录`);
  return dir;
}

/** --suite 要跑的套件，按顺序；all 是全部套件。 */
export function suitesFor(suite = 'host') {
  const suites = suite === 'all' ? Object.keys(SUITES) : [suite];
  for (const s of suites) if (!SUITES[s]) fail(`未知套件 ${s}（${Object.keys(SUITES).join(' | ')} | all）`);
  return suites;
}

export function suiteShards(suite, shards) {
  return SINGLE_SHARD_SUITES.has(suite) ? 1 : shards;
}

export function shardCommand({ suite, i, shards, tmp, buildNumber, file, filters = [] }) {
  return ['env', `TMPDIR=${tmp}`, `DEEP_STUDENT_BUILD_NUMBER=${buildNumber}`, 'VITEST_MAX_FORKS=2', 'VITEST_MAX_THREADS=2', 'npx', 'vitest', 'run',
    '-c', SUITES[suite], ...(shards > 1 ? [`--shard=${i}/${shards}`] : []), '--reporter=json', `--outputFile=${file}`, ...filters];
}

function runQueued({ job, jobsDir, wt, cmd, file, i, suite, rawDir }) {
  const id = execFileSync(process.execPath, [job, 'submit', '--', ...cmd], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  fs.writeFileSync(path.join(rawDir, `${suite}-shard-${i}.submitted.json`), JSON.stringify({ i, jobId: id, cmd, file }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [job, 'wait', id, '--tail', '5'], { cwd: wt, stdio: 'ignore' });
    child.on('close', (clientCode) => {
      const receipt = readJSON(path.join(jobsDir, 'done', `${id}.json`), null);
      try {
        fs.copyFileSync(path.join(jobsDir, 'done', `${id}.log`), path.join(rawDir, `${suite}-shard-${i}.log`));
      } catch {
        // 作业日志缺失不影响判定
      }
      resolve({ i, jobId: id, code: receipt?.code ?? clientCode, signal: receipt?.signal ?? null, report: readReport(file) });
    });
  });
}

function runDirect({ wt, cmd, file, i, suite, rawDir }) {
  return new Promise((resolve) => {
    const out = fs.openSync(path.join(rawDir, `${suite}-shard-${i}.log`), 'w');
    const child = spawn(cmd[0], cmd.slice(1), { cwd: wt, stdio: ['ignore', out, out], env: process.env });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
    }, SHARD_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      fs.closeSync(out);
      resolve({ i, code: timedOut ? 124 : code, signal, report: readReport(file) });
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const k = next++;
      results[k] = await fn(items[k]);
    }
  }));
  return results;
}

function failuresOf(testResults) {
  const out = [];
  for (const t of testResults) {
    const ar = t.assertionResults ?? [];
    const failed = ar.filter((a) => a.status === 'failed');
    if (t.status === 'failed' && !ar.length) {
      out.push({ file: t.name, loadError: String(t.message ?? '').split('\n')[0].slice(0, 300) });
    } else if (failed.length) {
      out.push({
        file: t.name,
        tests: failed.slice(0, 50).map((a) => [...(a.ancestorTitles ?? []), a.title].join(' > ')),
        firstMessage: String(failed[0].failureMessages?.[0] ?? '').split('\n')[0].slice(0, 300),
      });
    }
  }
  return out;
}

export async function landTest(opts) {
  const repo = path.resolve(opts.repo ?? '/home/dsdev/dev/deep-student');
  const home = path.resolve(opts.home ?? path.join(repo, '..', 'landing'));
  const user = opts.user ?? 'dsdev';
  if (process.getuid?.() === 0) fail('不要以 root 运行；用 sudo -u dsdev');
  if (user && os.userInfo().username !== user) fail(`必须以 ${user} 运行，当前是 ${os.userInfo().username}`);

  const sha = revParse(repo, opts.sha ?? DEFAULT_BRANCH) || fail(`服务器上找不到提交 ${opts.sha ?? DEFAULT_BRANCH}`);
  const map = readJSON(path.join(home, 'landing-map.json'), null);
  const local = opts.local ?? map?.byServer?.[sha] ?? null;
  const label = opts.label ?? (local ? short(local) : fail(`landing-map.json 里没有服务器 ${short(sha)} 的落地记录；用 --local 或 --label 指定报告目录名`));
  if (!safeName(label)) fail(`报告目录名不合法：${label}`);
  const suites = suitesFor(opts.suite);
  const filters = opts.filter ?? [];
  const shards = Number(opts.shards ?? (filters.length ? 1 : 8));

  const reportsRoot = path.join(home, 'reports');
  fs.mkdirSync(reportsRoot, { recursive: true });
  const releaseLock = acquireLock(path.join(reportsRoot, `${label}.lock`));
  const reportDir = path.join(reportsRoot, label);
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '')}-${process.pid}`;
  const rawDir = path.join(home, 'test-raw', label, runId);
  fs.mkdirSync(rawDir, { recursive: true });
  const tmpRoot = path.resolve(opts.tmpRoot ?? DEFAULT_TMP_ROOT);
  const logFile = path.join(reportDir, 'land-test.log');
  const say = (m) => {
    log(m);
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  };
  const startedAt = new Date();
  const wt = path.join(home, 'test-worktrees', short(sha));

  try {
    say(`land-test：服务器 ${sha}${local ? `（本机 ${local}）` : ''}，套件 ${suites.join('+')}，${shards} 片，报告 ${reportDir}`);

    // 工作树
    if (fs.existsSync(wt)) {
      if (gitLine(wt, ['rev-parse', 'HEAD']) !== sha || !gitOk(wt, ['diff', '--quiet', 'HEAD'])) git(wt, ['checkout', '-q', '-f', '--detach', sha]);
      say(`复用测试工作树 ${wt}`);
    } else {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      git(repo, ['worktree', 'add', '-q', '--detach', wt, sha]);
      say(`建测试工作树 ${wt}`);
    }

    // 依赖
    const rootHead = gitLine(repo, ['rev-parse', 'HEAD']);
    const changed = depsChanges(repo, rootHead, sha);
    const depsSame = changed.length === 0;
    const depsMode = opts.deps ?? 'auto';
    const nmSrc = path.resolve(opts.nodeModules ?? path.join(repo, 'node_modules'));
    const nm = path.join(wt, 'node_modules');
    let nmStat = null;
    try {
      nmStat = fs.lstatSync(nm);
    } catch {
      nmStat = null;
    }
    const key = depsKey(repo, sha);
    const nmKind = !nmStat ? 'none' : nmStat.isSymbolicLink() ? 'link' : nmStat.isDirectory() ? 'dir' : 'file';
    const stampKey = nmKind === 'dir' ? readStamp(nm)?.key ?? null : null;
    const sibling = depsMode === 'auto' && !depsSame && stampKey !== key ? findSibling(path.dirname(wt), wt, key) : null;
    const plan = planDeps({ mode: depsMode, changed, nm: { kind: nmKind, stampKey }, key, sibling });
    if (plan.error) fail(`${plan.error}（${nm}）`);
    say(`依赖：${plan.action}，${plan.reason}`);
    const linkTo = (target) => {
      if (!fs.existsSync(target)) fail(`找不到 ${target}`);
      if (nmKind === 'link' || nmKind === 'file') fs.rmSync(nm);
      else if (nmKind === 'dir') fs.rmSync(nm, { recursive: true, force: true });
      fs.symlinkSync(target, nm, 'dir');
    };
    if (plan.action === 'ci') {
      // 先拆软链：npm ci 会清空 node_modules，经软链清的就是主仓库的
      if (nmKind === 'link' || nmKind === 'file') fs.rmSync(nm);
      const npm = opts.npm ?? 'npm';
      const npmLog = path.join(rawDir, 'npm-ci.log');
      say(`${npm} ci ……（日志 ${npmLog}，上限 40 分钟）`);
      const t0 = Date.now();
      const out = fs.openSync(npmLog, 'w');
      try {
        execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: wt, stdio: ['ignore', out, out], timeout: 40 * 60_000 });
      } catch (e) {
        fail(`npm ci 失败（${e.status ?? e.signal ?? e.code}），见 ${npmLog}`);
      } finally {
        fs.closeSync(out);
      }
      if (!fs.lstatSync(nm, { throwIfNoEntry: false })?.isDirectory()) fail(`npm ci 结束但 ${nm} 不是目录`);
      writeJSONAtomic(path.join(nm, STAMP), { key, sha, installedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) });
      say(`npm ci 完成，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
    } else if (plan.action === 'link') {
      linkTo(nmSrc);
    } else if (plan.action === 'link-sibling') {
      linkTo(sibling);
    }

    // 版本文件
    let buildNumber = String(opts.buildNumber ?? '20000');
    let buildNumberSource = 'fixed';
    const envNoBn = { ...process.env };
    delete envNoBn.DEEP_STUDENT_BUILD_NUMBER;
    if (buildNumber === 'auto') {
      buildNumber = execFileSync(process.execPath, ['scripts/generate-version.mjs', '--print-build-number'], { cwd: wt, env: envNoBn, encoding: 'utf8' }).trim();
      buildNumberSource = 'git';
    }
    if (!/^\d+$/.test(buildNumber)) fail(`DEEP_STUDENT_BUILD_NUMBER 不是整数：${buildNumber}`);
    execFileSync(process.execPath, ['scripts/generate-version.mjs'], {
      cwd: wt, env: { ...envNoBn, DEEP_STUDENT_BUILD_NUMBER: buildNumber }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000,
    });
    fs.copyFileSync(path.join(wt, 'src', 'version.ts'), path.join(reportDir, 'version.ts'));
    say(`src/version.ts 已生成（DEEP_STUDENT_BUILD_NUMBER=${buildNumber}，${buildNumberSource === 'git' ? '由 git 历史计算' : '固定值'}）`);

    // 执行方式与判定
    const job = path.join(repo, 'scripts/electron-migration/jobs/job.mjs');
    const jobsDir = process.env.OC_JOBS_DIR ?? path.join(os.homedir(), '.oc-jobs');
    let runner = opts.runner ?? 'auto';
    if (runner === 'auto') runner = fs.existsSync(job) && systemctlState('ds-jobs.service') === 'active' ? 'queue' : 'direct';
    if (runner === 'queue' && !fs.existsSync(job)) fail(`找不到作业客户端 ${job}`);
    if (systemctlState('ds-fulltest.service') === 'active') say('注意：ds-fulltest 正在跑 main 的全量测试，会和本次争用作业队列');
    let verdictFn = builtinVerdict;
    let verdictSource = 'builtin';
    try {
      ({ fulltestVerdict: verdictFn } = await import(pathToFileURL(path.join(repo, 'scripts/electron-migration/lib/fulltest-result.mjs')).href));
      verdictSource = 'repo:scripts/electron-migration/lib/fulltest-result.mjs';
    } catch {
      verdictFn = builtinVerdict;
    }
    const parallel = Number(opts.parallel ?? 2);
    say(`执行方式：${runner === 'queue' ? `作业队列（${job}）` : `直接运行，并发 ${parallel}`}；判定：${verdictSource}`);

    const summary = {
      schema: 'ds-landing-test/1', label, localSha: local, serverSha: sha, runId,
      startedAt: startedAt.toISOString(), host: os.hostname(), platform: `${process.platform}-${process.arch}`, node: process.version,
      runner, shards, parallel: runner === 'direct' ? parallel : null, filters, buildNumber, buildNumberSource,
      deps: { mode: depsMode, action: plan.action, reason: plan.reason, changed, sameAsRootHead: depsSame, rootHead, key, linkedTo: plan.action === 'link' ? nmSrc : plan.action === 'link-sibling' ? sibling : null }, worktree: wt, rawDir, verdictSource, suites: {},
    };
    for (const suite of suites) {
      const t0 = Date.now();
      const n = suiteShards(suite, shards);
      const tasks = Array.from({ length: n }, (_, k) => {
        const i = k + 1;
        const file = path.join(rawDir, `${suite}-shard-${i}.json`);
        const tmp = shardTmpDir(tmpRoot, label, runId, suite, i);
        fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
        const cmd = shardCommand({ suite, i, shards: n, tmp, buildNumber, file, filters });
        return { i, file, cmd, suite, wt, rawDir, job, jobsDir };
      });
      say(`${suite}：${n} 个分片开始（${SUITES[suite]}）`);
      const results = runner === 'queue'
        ? await Promise.all(tasks.map(runQueued))
        : await pool(tasks, parallel, runDirect);
      const stable = gitLine(wt, ['rev-parse', 'HEAD']) === sha && gitOk(wt, ['diff', '--quiet', 'HEAD']);
      const verdict = verdictFn(results, n, stable);
      const reported = results.filter((r) => r.report);
      const sum = (k) => reported.reduce((a, r) => a + (r.report[k] ?? 0), 0);
      const testResults = reported.flatMap((r) => r.report.testResults ?? []).map((r) => ({ ...r, name: path.isAbsolute(r.name) ? path.relative(wt, r.name) : r.name }));
      const merged = {
        suite, config: SUITES[suite], serverSha: sha, localSha: local, at: new Date().toISOString(), runId,
        complete: verdict.complete, stable: verdict.stable, ok: verdict.ok, success: verdict.ok, missing: verdict.missing, rawFailures: verdict.rawFailures,
        shards: results.map(({ i, code, signal, jobId }) => ({ i, code, signal, jobId: jobId ?? null })),
        numTotalTests: sum('numTotalTests'), numPassedTests: sum('numPassedTests'), numFailedTests: sum('numFailedTests'),
        numPendingTests: sum('numPendingTests'), numTodoTests: sum('numTodoTests'),
        numTotalTestSuites: sum('numTotalTestSuites'), numFailedTestSuites: sum('numFailedTestSuites'),
        testResults,
      };
      const mergedJson = JSON.stringify(merged);
      fs.writeFileSync(path.join(rawDir, `${suite}-merged.json`), mergedJson);
      fs.writeFileSync(path.join(reportDir, `vitest-${suite}.json.zst`), zstdCompress(Buffer.from(mergedJson), 19));
      const failures = failuresOf(testResults);
      const { testResults: _omit, ...counts } = merged;
      summary.suites[suite] = { ...counts, durationSec: Math.round((Date.now() - t0) / 1000), failedFiles: failures.length, failures: failures.slice(0, 500) };
      say(`${suite}：用例 ${merged.numTotalTests}，通过 ${merged.numPassedTests}，失败 ${merged.numFailedTests}，pending ${merged.numPendingTests}，失败套件 ${merged.numFailedTestSuites}；完整 ${verdict.complete}，稳定 ${verdict.stable}${verdict.ok ? '' : ' ← 未通过'}`);
      fs.appendFileSync(path.join(reportDir, 'failures.txt'), failures.map((f) => f.loadError
        ? `[${suite}] ${f.file}（文件加载失败：${f.loadError}）\n`
        : f.tests.map((t) => `[${suite}] ${f.file} > ${t}\n`).join('')).join(''));
    }
    const all = Object.values(summary.suites);
    summary.ok = all.every((s) => s.ok);
    summary.complete = all.every((s) => s.complete && s.stable);
    summary.finishedAt = new Date().toISOString();
    summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
    summary.pull = `node scripts/electron-migration/landing/land-status.mjs ${label}${home === '/home/dsdev/dev/landing' ? '' : ` --home ${home}`}`;
    writeJSONAtomic(path.join(reportDir, 'summary.json'), summary);
    say(`完成：${summary.ok ? '全绿' : summary.complete ? '有失败' : '不完整'}；本机拉回：${summary.pull}`);
    return summary;
  } finally {
    fs.rmSync(path.join(tmpRoot, label, runId), { recursive: true, force: true });
    if (opts.removeWorktree) {
      try {
        git(repo, ['worktree', 'remove', '--force', wt]);
      } catch (e) {
        say(`删除测试工作树失败：${e.message}`);
      }
    }
    releaseLock();
  }
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        sha: { type: 'string' }, local: { type: 'string' }, label: { type: 'string' }, repo: { type: 'string' }, home: { type: 'string' },
        suite: { type: 'string' }, shards: { type: 'string' }, runner: { type: 'string' }, parallel: { type: 'string' },
        'build-number': { type: 'string' }, deps: { type: 'string' }, 'node-modules': { type: 'string' }, filter: { type: 'string', multiple: true },
        user: { type: 'string' }, 'remove-worktree': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, npm: { type: 'string' },
        'tmp-root': { type: 'string' },
      },
    });
    if (values.help) printUsage(import.meta.url);
    const s = await landTest({
      npm: values.npm,
      sha: values.sha, local: values.local, label: values.label, repo: values.repo, home: values.home, suite: values.suite,
      shards: values.shards, runner: values.runner, parallel: values.parallel, buildNumber: values['build-number'], deps: values.deps,
      nodeModules: values['node-modules'], filter: values.filter, user: values.user, removeWorktree: values['remove-worktree'],
      tmpRoot: values['tmp-root'],
    });
    process.exit(s.ok ? 0 : s.complete ? 1 : 2);
  } catch (e) {
    console.error(`land-test 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(2);
  }
}
