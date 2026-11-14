#!/usr/bin/env node
// 本机：把 land-pack 的产物用 N 路并行 scp 传到服务器；单个文件失败按退避重试；传完在远端 sha256sum -c 校验，不一致的文件重传。
//
//   node scripts/electron-migration/landing/land-send.mjs --pack .landing/<to12> --host ser-38
//   node scripts/electron-migration/landing/land-send.mjs --pack .landing/<to12> --host ser-38 --dry-run    # 只打印命令，不连接
//
// 每个 scp 都走独立的 TCP 连接（ControlMaster=no、ControlPath=none）：单连接只有约 13KB/s，复用一条连接就失去了并行的意义。
// 传的是 SHA256SUMS 里列出的文件（分片、两份树清单、land-apply/land-test/lib 脚本、MANIFEST.json）加 SHA256SUMS 本身；
// 未压缩的 land.patch 不传。
//
// 选项：
//   --pack <dir>          land-pack 的输出目录（必填）
//   --host <host>         ssh 主机（默认 ser-38）
//   --remote-dir <dir>    远端目录（默认 /home/dsdev/dev/landing/inbox/<to12>）；父目录须事先由 dsdev 建好（LANDING-RUNBOOK.md 第 0 步）
//   -j, --jobs <n>        并行连接数（默认 8）
//   --retries <n>         每个文件最多重试次数（默认 5；退避 5s、10s、20s……封顶 60s）
//   --min-rate <B/s>      判定 scp 卡死的最低速率（默认 2048）：超时 = 60s + 文件大小 / 该速率
//   --only <file>         只传这些文件（可重复，用于补传；SHA256SUMS 总会一起传）
//   --resume              先传 SHA256SUMS 并在远端校验，已一致的文件跳过
//   --no-verify           传完不在远端校验，只打印校验命令（由主代理执行）
//   --ssh-opt <opt>       追加 -o 选项（可重复）
//   --dry-run             只打印将要执行的命令
//   --scp <cmd> / --ssh <cmd>   替换 scp/ssh 可执行文件（只用于离线测试）
// 退出码：0 全部传完且远端校验一致（--no-verify 时为全部传完）；1 有文件最终失败或校验不一致。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { MANIFEST_FILE, SUMS_FILE, LandingError, fail, readSums, checkSums, readJSON, writeJSONAtomic, short, log, printUsage, isEntry } from './lib.mjs';

const BASE_OPTS = ['BatchMode=yes', 'ConnectTimeout=20', 'ServerAliveInterval=15', 'ServerAliveCountMax=4', 'ControlMaster=no', 'ControlPath=none'];
const quote = (s) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: 127, stdout, stderr: e.message, ms: Date.now() - t0, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: timedOut ? 124 : code, stdout, stderr: stderr.trim(), ms: Date.now() - t0, timedOut });
    });
  });
}

/** `sha256sum -c` 的输出 → { ok: Set, bad: Set }。 */
export function parseSumCheck(stdout) {
  const ok = new Set();
  const bad = new Set();
  for (const line of stdout.split('\n')) {
    const m = /^(.+?): (OK|FAILED.*)$/.exec(line.trim());
    if (m) (m[2] === 'OK' ? ok : bad).add(m[1]);
  }
  return { ok, bad };
}

export async function landSend(opts) {
  const packDir = path.resolve(opts.pack ?? fail('缺少 --pack'));
  const host = opts.host ?? 'ser-38';
  const manifest = readJSON(path.join(packDir, MANIFEST_FILE));
  const remoteDir = opts.remoteDir ?? `/home/dsdev/dev/landing/inbox/${short(manifest.to.sha)}`;
  if (!/^[\w./~-]+$/.test(remoteDir) || remoteDir.includes('..')) fail(`远端目录只能含字母数字和 ._~/-：${remoteDir}`);
  if (!/^[\w.@-]+$/.test(host)) fail(`主机名不合法：${host}`);
  const jobs = Number(opts.jobs ?? 8);
  const retries = Number(opts.retries ?? 5);
  const minRate = Number(opts.minRate ?? 2048);
  const scp = opts.scp ?? 'scp';
  const ssh = opts.ssh ?? 'ssh';
  const oArgs = [...BASE_OPTS, ...(opts.sshOpt ?? [])].flatMap((o) => ['-o', o]);
  const dry = Boolean(opts.dryRun);

  const sums = readSums(packDir);
  const localBad = checkSums(packDir).filter((c) => !c.ok).map((c) => c.file);
  if (localBad.length) fail(`本机文件与 SHA256SUMS 不符（包被改过或不完整，重新 land-pack）：${localBad.join(', ')}`);
  const size = (f) => fs.statSync(path.join(packDir, f)).size;
  let files = sums.map((s) => s.file);
  if (opts.only?.length) {
    const unknown = opts.only.filter((f) => !files.includes(f));
    if (unknown.length) fail(`--only 里有包外文件：${unknown.join(', ')}`);
    files = opts.only;
  }

  const verifyCmd = `cd ${remoteDir} && sha256sum -c ${SUMS_FILE}`;
  const sshCmd = (remote) => [ssh, [...oArgs, host, remote]];
  const scpCmd = (f) => [scp, ['-q', ...oArgs, path.join(packDir, f), `${host}:${remoteDir}/${f}`]];
  const show = ([c, a]) => [c, ...a].map(quote).join(' ');
  const stats = { host, remoteDir, startedAt: new Date().toISOString(), files: {}, verifyRounds: [] };

  const exec = async ([c, a], timeoutMs) => {
    if (dry) {
      console.log(show([c, a]));
      return { code: 0, stdout: '', stderr: '', ms: 0 };
    }
    return run(c, a, timeoutMs);
  };

  async function sendOne(f) {
    const bytes = size(f);
    const timeoutMs = 60_000 + Math.ceil((bytes / minRate) * 1000);
    const rec = (stats.files[f] = { bytes, attempts: [] });
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const r = await exec(scpCmd(f), timeoutMs);
      rec.attempts.push({ code: r.code, ms: r.ms, stderr: r.stderr?.slice(0, 300) || undefined });
      if (r.code === 0) {
        if (!dry) log(`✓ ${f} ${kib(bytes)}，${(r.ms / 1000).toFixed(0)}s，${kib(bytes / Math.max(r.ms / 1000, 0.001))}/s${attempt > 1 ? `（第 ${attempt} 次）` : ''}`);
        rec.ok = true;
        return true;
      }
      const wait = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      log(`✗ ${f} 第 ${attempt} 次失败（${r.timedOut ? `超时 ${Math.round(timeoutMs / 1000)}s` : `退出码 ${r.code}`}）：${r.stderr || '无输出'}${attempt <= retries ? `；${wait / 1000}s 后重试` : '；放弃'}`);
      if (attempt <= retries) await sleep(opts.backoffMs ?? wait);
    }
    rec.ok = false;
    return false;
  }

  async function sendAll(list) {
    const queue = [...list].sort((a, b) => size(b) - size(a));
    const failed = [];
    await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, queue.length)) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) if (!(await sendOne(f))) failed.push(f);
    }));
    return failed;
  }

  async function remoteCheck() {
    const r = await exec(sshCmd(verifyCmd), 120_000);
    const parsed = parseSumCheck(r.stdout);
    stats.verifyRounds.push({ code: r.code, ok: parsed.ok.size, bad: [...parsed.bad] });
    if (r.code !== 0 && !parsed.ok.size && !parsed.bad.size) fail(`远端校验命令失败（退出码 ${r.code}）：${r.stderr}`);
    return { ...parsed, code: r.code };
  }

  const total = files.reduce((n, f) => n + size(f), 0) + size(SUMS_FILE);
  log(`发送 ${files.length + 1} 个文件（${kib(total)}）→ ${host}:${remoteDir}，${jobs} 路并行${dry ? '（dry-run）' : ''}`);
  const t0 = Date.now();
  const mk = await exec(sshCmd(`mkdir -p ${remoteDir}`), 60_000);
  if (mk.code !== 0) fail(`远端建目录失败（退出码 ${mk.code}）：${mk.stderr}`);

  let pending = files.filter((f) => f !== SUMS_FILE);
  if (!(await sendOne(SUMS_FILE))) fail('SHA256SUMS 传输失败');
  if (opts.resume && !dry) {
    const { ok } = await remoteCheck();
    const skipped = pending.filter((f) => ok.has(f));
    pending = pending.filter((f) => !ok.has(f));
    log(`--resume：远端已有 ${skipped.length} 个文件一致，跳过；待传 ${pending.length} 个`);
  }
  let failed = await sendAll(pending);
  if (failed.length) {
    stats.result = 'transfer-failed';
    writeJSONAtomic(path.join(packDir, `send-${host}-${Date.now()}.json`), stats);
    fail(`${failed.length} 个文件重试后仍失败：${failed.join(', ')}；之后用 --resume 补传`);
  }

  let verified = false;
  if (dry) {
    log(`dry-run 不做远端校验；实际运行时在 ${host} 上执行：${verifyCmd}`);
  } else if (opts.verify === false) {
    log(`未做远端校验（--no-verify）；请在服务器执行：${verifyCmd}`);
  } else {
    for (let round = 1; round <= 3; round++) {
      const { bad, ok, code } = await remoteCheck();
      const missing = files.filter((f) => !ok.has(f) && !bad.has(f));
      if (code === 0 && !bad.size && !missing.length) {
        verified = true;
        break;
      }
      const redo = [...new Set([...bad, ...missing])].filter((f) => files.includes(f));
      log(`远端校验第 ${round} 轮：${bad.size} 个不一致、${missing.length} 个缺失，重传 ${redo.join(', ')}`);
      if (round === 3 || !redo.length) break;
      failed = await sendAll(redo);
      if (failed.length) break;
    }
    if (!verified) {
      stats.result = 'verify-failed';
      writeJSONAtomic(path.join(packDir, `send-${host}-${Date.now()}.json`), stats);
      fail(`远端 sha256 校验未通过；手动检查：ssh ${host} '${verifyCmd}'`);
    }
  }
  const secs = (Date.now() - t0) / 1000;
  stats.result = dry ? 'dry-run' : verified ? 'verified' : 'sent';
  stats.finishedAt = new Date().toISOString();
  stats.seconds = Math.round(secs);
  if (!dry) writeJSONAtomic(path.join(packDir, `send-${host}-${Date.now()}.json`), stats);
  log(`${dry ? 'dry-run 结束' : `完成：${kib(total)}，${secs.toFixed(0)}s，合计 ${kib(total / Math.max(secs, 0.001))}/s`}${verified ? '，远端 sha256 全部一致' : ''}`);
  log(`服务器下一步（dsdev）：/opt/node26/bin/node ${remoteDir}/land-apply.mjs --pack ${remoteDir} --check-only，通过后去掉 --check-only`);
  return { verified, stats };
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        pack: { type: 'string' }, host: { type: 'string' }, 'remote-dir': { type: 'string' }, jobs: { type: 'string', short: 'j' },
        retries: { type: 'string' }, 'min-rate': { type: 'string' }, only: { type: 'string', multiple: true }, resume: { type: 'boolean' },
        'no-verify': { type: 'boolean' }, 'ssh-opt': { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' },
        scp: { type: 'string' }, ssh: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) printUsage(import.meta.url);
    await landSend({
      pack: values.pack, host: values.host, remoteDir: values['remote-dir'], jobs: values.jobs, retries: values.retries,
      minRate: values['min-rate'], only: values.only, resume: values.resume, verify: !values['no-verify'], sshOpt: values['ssh-opt'],
      dryRun: values['dry-run'], scp: values.scp, ssh: values.ssh,
    });
  } catch (e) {
    console.error(`land-send 失败：${e instanceof LandingError ? e.message : e.stack}`);
    process.exit(1);
  }
}
