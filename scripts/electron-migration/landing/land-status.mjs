#!/usr/bin/env node
// 本机：查服务器上一次落地/测试的状态，并把结果拉回本机。只读服务器，不在服务器上改任何东西。
//
//   node scripts/electron-migration/landing/land-status.mjs <落地 id | 服务器 SHA 前缀 | unit 名>
//   node scripts/electron-migration/landing/land-status.mjs 4384a3136d12              # = ds-land-test-4384a3136d12.service
//   node scripts/electron-migration/landing/land-status.mjs ds-land-test-4384a3136d12 --wait
//   node scripts/electron-migration/landing/land-status.mjs --map-only                # 只刷新 .landing/landing-map.json（land-apply 之后跑）
//
// 落地 id = 本机 to 提交前 12 位（= 上传目录名 = 报告目录名 = 第 6 步的 unit 后缀）。给服务器 SHA 前缀时用拉回的映射换成本机 id。
// 依次做三件事（三次 ssh，各自失败不影响其他）：
//   1. 拉回 $LH/landing-map.json → 校验 → 写 .landing/landing-map.json（旧的留 .bak）。本机有服务器没有的记录时不覆盖，
//      另存 landing-map.<host>.json 并提示。land-pack --from auto 读的就是它，所以 land-apply 成功后跑一次即可，不必手工 scp。
//   2. systemctl show（ActiveState、SubState、Result、ExecMainStatus、MemoryPeak、起止时间）+ journalctl 最后 N 行。
//      systemd-run 的 unit 成功结束后会被回收（LoadState=not-found），此时从日志尾部的 “Deactivated successfully”、
//      “Failed with result”、“Consumed … memory peak” 补出结果和内存峰值。
//   3. 用 tar 经 ssh 一次拉回 $LH/reports/<id>/ 与 $LH/applied/<id>/apply.json → .reports/server/<id>/（整体替换），
//      并写 .reports/server/<id>/status.json（unit 状态与日志尾）。
//
// 选项：
//   --host <host>        ssh 主机（默认 ser-38）
//   --home <dir>         服务器落地状态目录（默认 /home/dsdev/dev/landing）
//   --unit <name>        unit 名（默认 ds-land-test-<id>.service）
//   --lines <n>          日志行数（默认 40）
//   --wait               unit 还在跑时每 --interval 秒（默认 60）查一次状态，结束后再拉报告
//   --map-only           只做第 1 步；--no-map 跳过第 1 步；--no-reports 跳过第 3 步
//   --out <dir>          报告根目录（默认 <主仓库上一级>/.reports/server）；--map <file> 本机映射（默认 <主仓库上一级>/.landing/landing-map.json）
//   --ssh <cmd>          替换 ssh 可执行文件（离线测试用）；--ssh-opt <opt> 追加 -o 选项（可重复）
//   --json <file>        把结果另存一份
// 退出码：0 unit 已成功结束（或 --map-only 成功）；1 unit 失败或测试报告不是全绿；2 ssh/参数错误；3 unit 还在跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { MAP_SCHEMA, LandingError, fail, gitLine, readJSON, writeJSONAtomic, short, log, printUsage, isEntry, lastLanding, entryBranch } from './lib.mjs';

const BASE_OPTS = ['BatchMode=yes', 'ConnectTimeout=20', 'ServerAliveInterval=15', 'ServerAliveCountMax=4'];
const PROPS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus', 'MemoryPeak', 'MemoryCurrent',
  'CPUUsageNSec', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp'];
const SEP = '@@LAND-STATUS@@';
const RUNNING = ['active', 'activating', 'reloading', 'deactivating'];

function run(cmd, args, { timeoutMs = 120_000, binary = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout: binary ? Buffer.alloc(0) : '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      const buf = Buffer.concat(out);
      resolve({ code, stdout: binary ? buf : buf.toString('utf8'), stderr: stderr.trim() });
    });
  });
}

/** 参数 → { id, unit }。id 是报告目录名（本机 to 前 12 位），unit 是 systemd unit 全名。 */
export function resolveTarget(arg, { unit, map } = {}) {
  let id = null;
  let u = unit ?? null;
  if (arg && /^[0-9a-f]{7,40}$/.test(arg)) {
    const e = map?.entries?.find((x) => x.localTo.startsWith(arg)) ?? map?.entries?.find((x) => x.serverSha?.startsWith(arg));
    id = e ? short(e.localTo) : arg.slice(0, 12);
  } else if (arg) {
    if (!/^[\w@.:-]+$/.test(arg)) fail(`unit 名不合法：${arg}`);
    u = arg;
    id = /^ds-land-test-([\w.-]+?)(\.service)?$/.exec(arg)?.[1] ?? null;
  }
  if (u && !/^[\w@.:-]+$/.test(u)) fail(`unit 名不合法：${u}`);
  if (!u && id) u = `ds-land-test-${id}`;
  if (u && !/\.(service|scope|timer)$/.test(u)) u = `${u}.service`;
  return { id, unit: u };
}

const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB` : `${(n / (1 << 20)).toFixed(1)} MiB`);
const isNum = (v) => /^\d+$/.test(String(v ?? ''));

/** `systemctl show` 的输出与日志尾 → 状态对象。 */
export function parseStatus(showOut, journal) {
  const p = {};
  for (const line of showOut.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) p[line.slice(0, i)] = line.slice(i + 1);
  }
  const lines = journal.split('\n');
  const fromLog = {};
  for (const l of lines) {
    if (/Deactivated successfully/.test(l)) fromLog.result = 'success';
    const f = /Failed with result '([\w-]+)'/.exec(l);
    if (f) fromLog.result = f[1];
    const x = /Main process exited, code=(\w+), status=(\d+)/.exec(l);
    if (x) Object.assign(fromLog, { code: x[1], status: Number(x[2]) });
    const c = /Consumed (.+?) CPU time(?:, (.+?) memory peak)?/.exec(l);
    if (c) Object.assign(fromLog, { cpu: c[1], memoryPeak: c[2] ?? null });
  }
  const loaded = p.LoadState && p.LoadState !== 'not-found';
  const state = {
    loadState: p.LoadState ?? null,
    activeState: p.ActiveState ?? null,
    subState: p.SubState ?? null,
    result: loaded ? p.Result ?? null : fromLog.result ?? null,
    exitStatus: loaded && isNum(p.ExecMainStatus) && p.ExecMainStartTimestamp ? Number(p.ExecMainStatus) : fromLog.status ?? null,
    memoryPeak: isNum(p.MemoryPeak) ? fmtBytes(Number(p.MemoryPeak)) : fromLog.memoryPeak ?? null,
    memoryPeakBytes: isNum(p.MemoryPeak) ? Number(p.MemoryPeak) : null,
    memoryCurrent: isNum(p.MemoryCurrent) ? fmtBytes(Number(p.MemoryCurrent)) : null,
    cpu: isNum(p.CPUUsageNSec) ? `${(Number(p.CPUUsageNSec) / 1e9).toFixed(0)}s` : fromLog.cpu ?? null,
    startedAt: p.ExecMainStartTimestamp || p.ActiveEnterTimestamp || null,
    exitedAt: p.ExecMainExitTimestamp || p.InactiveEnterTimestamp || null,
    source: loaded ? 'systemctl' : fromLog.result ? 'journal' : 'none',
  };
  state.running = RUNNING.includes(state.activeState) && loaded;
  state.finished = !state.running && Boolean(state.result);
  state.ok = state.finished && state.result === 'success' && (state.exitStatus === null || state.exitStatus === 0);
  return state;
}

/** 本机映射与服务器映射合并：服务器为准；本机有服务器没有的记录时不覆盖。 */
export function mergeMap(local, remote) {
  if (!remote || remote.schema !== MAP_SCHEMA || !Array.isArray(remote.entries)) return { action: 'invalid' };
  if (!local) return { action: 'write', map: remote, added: remote.entries.length };
  const remoteShas = new Set(remote.entries.map((e) => e.serverSha));
  const localOnly = (local.entries ?? []).filter((e) => !remoteShas.has(e.serverSha));
  if (localOnly.length) return { action: 'conflict', localOnly };
  const localShas = new Set((local.entries ?? []).map((e) => e.serverSha));
  const added = remote.entries.filter((e) => !localShas.has(e.serverSha)).length;
  if (!added && JSON.stringify(local) === JSON.stringify(remote)) return { action: 'unchanged', map: remote, added: 0 };
  return { action: 'write', map: remote, added };
}

export async function landStatus(opts) {
  const host = opts.host ?? 'ser-38';
  const home = opts.home ?? '/home/dsdev/dev/landing';
  if (!/^[\w.@-]+$/.test(host)) fail(`主机名不合法：${host}`);
  if (!/^\/[\w./~-]+$/.test(home) || home.includes('..')) fail(`--home 只能是含字母数字和 ._~/- 的绝对路径：${home}`);
  const repo = gitLine(opts.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']);
  const workspace = path.dirname(path.dirname(path.resolve(repo, gitLine(repo, ['rev-parse', '--git-common-dir']))));
  const mapFile = path.resolve(opts.map ?? path.join(workspace, '.landing', 'landing-map.json'));
  const outRoot = path.resolve(opts.out ?? path.join(workspace, '.reports', 'server'));
  const ssh = opts.ssh ?? 'ssh';
  const oArgs = [...BASE_OPTS, ...(opts.sshOpt ?? [])].flatMap((o) => ['-o', o]);
  const remote = (cmd, o) => run(ssh, [...oArgs, host, cmd], o);
  const lines = Number(opts.lines ?? 40);
  if (!Number.isInteger(lines) || lines < 1 || lines > 5000) fail('--lines 要在 1–5000 之间');
  const result = { host, home, checkedAt: new Date().toISOString(), map: null, id: null, unit: null, state: null, report: null, errors: [] };

  // 1. 映射
  let map = readJSON(mapFile, null);
  if (!opts.noMap) {
    const r = await remote(`cat ${home}/landing-map.json`);
    let remoteMap = null;
    try {
      remoteMap = r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {
      remoteMap = null;
    }
    const m = r.code === 0 ? mergeMap(map, remoteMap) : { action: 'error' };
    if (m.action === 'error') result.errors.push(`拉映射失败（ssh 退出码 ${r.code}）：${r.stderr.split('\n').at(-1)}`);
    else if (m.action === 'invalid') result.errors.push(`服务器 ${home}/landing-map.json 不是 ${MAP_SCHEMA}`);
    else if (m.action === 'conflict') {
      const side = path.join(path.dirname(mapFile), `landing-map.${host}.json`);
      writeJSONAtomic(side, remoteMap);
      result.errors.push(`本机 ${mapFile} 有 ${m.localOnly.length} 条服务器没有的记录（${m.localOnly.map((e) => `${short(e.localTo)}→${short(e.serverSha)}`).join(', ')}），没有覆盖；服务器那份存为 ${side}，核对后手工替换`);
    } else {
      if (m.action === 'write') {
        fs.mkdirSync(path.dirname(mapFile), { recursive: true });
        if (fs.existsSync(mapFile)) fs.copyFileSync(mapFile, `${mapFile}.bak`);
        writeJSONAtomic(mapFile, m.map);
      }
      map = m.map;
    }
    result.map = { file: mapFile, action: m.action, added: m.added ?? 0, entries: map?.entries?.length ?? 0 };
    if (map && m.action !== 'error' && m.action !== 'invalid') {
      const branches = [...new Set(map.entries.map((e) => entryBranch(map, e)))];
      log(`映射：${mapFile} ${m.action === 'write' ? `已更新（新增 ${m.added} 条）` : m.action === 'unchanged' ? '无变化' : '未覆盖'}，共 ${map.entries.length} 条；`
        + branches.map((b) => `${b} 最后 本机 ${short(lastLanding(map, b).localTo)} → 服务器 ${short(lastLanding(map, b).serverSha)}`).join('；'));
    }
  }
  if (opts.mapOnly) {
    result.exitCode = result.errors.length ? 2 : 0;
    for (const e of result.errors) log(`✗ ${e}`);
    return result;
  }

  const { id, unit } = resolveTarget(opts.target, { unit: opts.unit, map });
  if (!unit) fail('给一个落地 id（本机 to 前 12 位）、服务器 SHA 前缀或 unit 名；或 --map-only');
  Object.assign(result, { id, unit });
  const landing = id ? map?.entries?.filter((e) => short(e.localTo) === id) ?? [] : [];
  for (const e of landing) log(`落地：本机 ${short(e.localTo)} → 服务器 ${e.serverSha}（${entryBranch(map, e)}，${e.appliedAt}，${e.files ?? '?'} 个文件）`);
  if (id && !landing.length && map) log(`落地：映射里没有本机 ${id} 的落地记录（还没 land-apply，或用的是别的 --home）`);
  result.landings = landing;

  // 2. unit 状态与日志
  const statusCmd = `systemctl show ${unit} --no-pager -p ${PROPS.join(',')}; echo ${SEP}; journalctl -u ${unit} -n ${lines} --no-pager -o short-iso 2>&1; true`;
  for (;;) {
    const r = await remote(statusCmd);
    if (r.code !== 0 && !r.stdout.includes(SEP)) {
      result.errors.push(`查 unit 失败（ssh 退出码 ${r.code}）：${r.stderr.split('\n').at(-1)}`);
      break;
    }
    const [show, journal = ''] = r.stdout.split(`${SEP}\n`);
    const state = parseStatus(show, journal);
    result.state = state;
    result.journalTail = journal.replace(/\n$/, '');
    if (!(opts.wait && state.running)) break;
    log(`${unit}：${state.activeState} (${state.subState})，内存 ${state.memoryCurrent ?? '?'}；${opts.interval ?? 60}s 后再查`);
    await new Promise((res) => setTimeout(res, Number(opts.interval ?? 60) * 1000));
  }
  if (result.state) {
    const s = result.state;
    log(`unit ${unit}：${s.loadState === 'not-found' ? '已回收（not-found）' : `${s.activeState} (${s.subState})`}，Result=${s.result ?? '?'}，`
      + `退出码 ${s.exitStatus ?? '?'}，MemoryPeak ${s.memoryPeak ?? '?'}，CPU ${s.cpu ?? '?'}${s.startedAt ? `，开始 ${s.startedAt}` : ''}${s.exitedAt && !s.running ? `，结束 ${s.exitedAt}` : ''}`
      + `（来源 ${s.source}）`);
    console.log(`—— journalctl -u ${unit} 最后 ${lines} 行 ——\n${result.journalTail || '（无日志；ssh 用户可能无权读日志，看报告里的 land-test.log）'}\n——`);
  }

  // 3. 报告
  if (id && !opts.noReports) {
    if (!/^[\w][\w.-]*$/.test(id)) fail(`id 不合法：${id}`);
    const tarCmd = `cd ${home} && set -- && for p in reports/${id} applied/${id}/apply.json; do [ -e "$p" ] && set -- "$@" "$p"; done; [ $# -gt 0 ] || exit 3; tar -cf - "$@"`;
    const r = await remote(tarCmd, { binary: true, timeoutMs: 600_000 });
    if (r.code === 3) {
      log(`报告：服务器上还没有 ${home}/reports/${id}/`);
    } else if (r.code !== 0) {
      result.errors.push(`拉报告失败（ssh 退出码 ${r.code}）：${r.stderr.split('\n').at(-1)}`);
    } else {
      fs.mkdirSync(outRoot, { recursive: true });
      const stage = fs.mkdtempSync(path.join(outRoot, '.land-status-'));
      try {
        const x = spawnSync('tar', ['-xf', '-', '-C', stage], { input: r.stdout });
        if (x.status !== 0) throw new LandingError(`解包报告失败：${String(x.stderr).trim()}`);
        const dest = path.join(outRoot, id);
        const got = path.join(stage, 'reports', id);
        fs.mkdirSync(outRoot, { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        if (fs.existsSync(got)) fs.renameSync(got, dest);
        else fs.mkdirSync(dest);
        const receipt = path.join(stage, 'applied', id, 'apply.json');
        if (fs.existsSync(receipt)) fs.copyFileSync(receipt, path.join(dest, 'apply.json'));
        const summary = readJSON(path.join(dest, 'summary.json'), null);
        result.report = { dir: dest, files: fs.readdirSync(dest).sort(), summary: summary && {
          ok: summary.ok, complete: summary.complete, finishedAt: summary.finishedAt ?? null, deps: summary.deps?.action ?? summary.deps?.mode ?? null,
          suites: Object.fromEntries(Object.entries(summary.suites ?? {}).map(([k, v]) => [k, { total: v.numTotalTests, failed: v.numFailedTests, failedSuites: v.numFailedTestSuites }])),
        } };
        const sm = result.report.summary;
        log(`报告：${dest}/（${result.report.files.join(' ')}）${sm ? `；${sm.ok ? '全绿' : sm.complete ? '有失败' : '不完整'}，${Object.entries(sm.suites).map(([k, v]) => `${k} 用例 ${v.total}、失败 ${v.failed}、失败套件 ${v.failedSuites}`).join('；')}，依赖 ${sm.deps}` : '；还没有 summary.json（测试未结束）'}`);
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
      }
    }
    const statusDir = result.report?.dir ?? path.join(outRoot, id);
    fs.mkdirSync(statusDir, { recursive: true });
    writeJSONAtomic(path.join(statusDir, 'status.json'), { host, unit, id, checkedAt: result.checkedAt, state: result.state, journalTail: result.journalTail ?? null, landings: result.landings });
  }

  for (const e of result.errors) log(`✗ ${e}`);
  const s = result.state;
  const sm = result.report?.summary;
  if (!s) result.exitCode = 2;
  else if (s.running) result.exitCode = 3;
  else if (s.finished) result.exitCode = s.ok && (!sm || sm.ok) ? 0 : 1;
  else result.exitCode = sm ? (sm.ok ? 0 : 1) : 2;
  if (s && !s.finished && !s.running && !sm) log('unit 不存在且日志里没有结束记录：名字对吗？（第 6 步的 --unit=ds-land-test-<本机12位>）');
  return result;
}

if (isEntry(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        host: { type: 'string' }, home: { type: 'string' }, unit: { type: 'string' }, lines: { type: 'string' }, wait: { type: 'boolean' },
        interval: { type: 'string' }, 'map-only': { type: 'boolean' }, 'no-map': { type: 'boolean' }, 'no-reports': { type: 'boolean' },
        out: { type: 'string' }, map: { type: 'string' }, ssh: { type: 'string' }, 'ssh-opt': { type: 'string', multiple: true },
        repo: { type: 'string' }, json: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || (!positionals.length && !values['map-only'] && !values.unit)) printUsage(import.meta.url);
    const r = await landStatus({
      target: positionals[0], host: values.host, home: values.home, unit: values.unit, lines: values.lines, wait: values.wait,
      interval: values.interval, mapOnly: values['map-only'], noMap: values['no-map'], noReports: values['no-reports'],
      out: values.out, map: values.map, ssh: values.ssh, sshOpt: values['ssh-opt'], repo: values.repo,
    });
    if (values.json) fs.writeFileSync(values.json, `${JSON.stringify(r, null, 2)}\n`);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`land-status 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(2);
  }
}
