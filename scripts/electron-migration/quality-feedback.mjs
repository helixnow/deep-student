#!/usr/bin/env node
// 自动质量反馈：在 main 上计算可机械发现的问题，按 lane 归组，只输出"新出现"的问题（带 file:line），
// 供守护进程在每次自动集成后排入对应 lane 的指令队列。DeepSeek 对具体定位的反馈响应远好于一般性规则。
//
//   node scripts/electron-migration/quality-feedback.mjs            人类可读报告（不更新状态）
//   node scripts/electron-migration/quality-feedback.mjs --json     {lane: [finding...]}，只含新问题，并更新状态
//   node scripts/electron-migration/quality-feedback.mjs --spool [--if-changed]
//        ds-quality-feedback.timer 用：新问题写入 .oc-runs/reports/quality-feedback/ 由调度守护进程投递（lib/quality-feedback-spool.mjs）；
//        --if-changed 时 main 未前进就跳过扫描
//
// 检查项（都不阻塞合入；阻塞项在集成门禁中）：
//   strict 边界违规（console.*、只含 void 的 catch）· ported 但所测模块未接入 · 平台模块已发布后仍保留的本地重复实现
//   · 超大文件 · 测试被削弱（相对上次报告：断言数明显减少、新增 .skip/.todo、测试文件被删除）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, allLanes, laneOfFile } from './lib/lane-paths.mjs';
import { generate } from './lib/quality-feedback-spool.mjs';

const STATE = path.join(ROOT, '.oc-runs/feedback-state.json');
const spool = process.argv.includes('--spool');
const json = spool || process.argv.includes('--json');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { sent: {}, lastCommit: null, expectCounts: {} };
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

function scan() {
  const lanes = allLanes();

  const findings = []; // { lane, key, text }
  const add = (file, key, text) => {
    const lane = laneOfFile(file, lanes);
    if (lane) findings.push({ lane, key: `${key}|${file}`, text });
  };

  const tracked = execFileSync('git', ['ls-files', 'host/plugins', 'host/platform'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const isTest = (f) => /\.test\.ts$/.test(f) || /\/tests\//.test(f) || /__fixtures__/.test(f);
  const prod = tracked.filter((f) => f.endsWith('.ts') && !isTest(f) && !f.includes('/generated/'));
  const tests = tracked.filter((f) => /\.test\.ts$/.test(f));

  // 1. strict 边界违规
  try {
    execFileSync(process.execPath, ['scripts/electron-migration/boundaries.mjs'], { cwd: ROOT, env: { ...process.env, DSTU_BOUNDARY_STRICT: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    for (const line of String(e.stdout || '').split('\n')) {
      const m = /^\s*(host\/\S+?):(\d+):\d+ \[([a-z-]+)\] /.exec(line);
      if (m && !line.includes('(allowed)')) add(m[1], `${m[3]}:${m[2]}`, `${m[1]}:${m[2]} [${m[3]}] ${m[3] === 'console-log' ? '改为 ctx.log / 插件 logger（Rust 若是 warn! 就记 warn）' : '按 Rust 语义处理：记录日志或写明真实理由的 boundary-allow，不能只写 void'}`);
    }
  }

  // 2. ported 但未接入
  try {
    const w = JSON.parse(execFileSync(process.execPath, ['scripts/electron-migration/wiring.mjs', '--json'], { cwd: ROOT, encoding: 'utf8' }));
    for (const r of w) for (const [file, n] of r.files) add(file, 'unwired', `${file}：${n} 个 TESTMAP 行标了 ported，但被测模块没有生产调用方——接入（注册命令/工具、provide 服务）或改回 pending 注明缺什么`);
  } catch {
    // wiring 检查失败不影响其余检查
  }

  // 3. 平台模块已发布后仍保留的本地重复实现
  const exists = (p) => fs.existsSync(path.join(ROOT, p));
  const DUPES = [
    ['host/platform/time/api.ts', /(?:function|const)\s+(\w*[Rr]fc3339\w*|\w*[Nn]owIso\w*)\s*[=(]/, '时间格式化改用 host/platform/time'],
    ['host/platform/util/api.ts', /(?:function|const)\s+(rustTrim\w*|trimRust\w*|\w*[Uu]tf8ByteLen\w*)\s*[=(]/, 'trim/UTF-8 工具改用 host/platform/util'],
    ['host/platform/net-policy/api.ts', /(?:function|const)\s+(is(Private|Loopback|Internal)(Ip|Ipv4|Ipv6|Address|Host)\w*)\s*[=(]/, 'IP/SSRF 判定改用 host/platform/net-policy'],
  ];
  for (const f of prod.filter((x) => x.startsWith('host/plugins/'))) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((ln, i) => {
      for (const [api, re, hint] of DUPES) {
        const m = exists(api) && re.exec(ln);
        if (m) add(f, `dupe:${m[1]}`, `${f}:${i + 1} 本地实现 ${m[1]}——${hint}，删除本地副本`);
      }
    });
    // 4. 超大文件
    if (lines.length > 1200) add(f, 'giant', `${f} 有 ${lines.length} 行，按职责拆分（quality.md §2.4）`);
  }

  // 5. 测试被削弱（相对上次报告）
  const counts = {};
  for (const t of tests) {
    const text = fs.readFileSync(path.join(ROOT, t), 'utf8');
    counts[t] = (text.match(/\bexpect\s*\(/g) || []).length;
    if (/\b(it|test|describe)\.(skip|todo)\s*\(/.test(text)) add(t, 'skip', `${t} 含 .skip/.todo——移植的测试不能跳过；做不到就改回 pending`);
  }
  for (const [t, before] of Object.entries(state.expectCounts ?? {})) {
    if (!(t in counts)) add(t, 'deleted-test', `${t} 被删除（上次报告时有 ${before} 个断言）——说明原因，确认对应 TESTMAP 行没有虚报`);
    else if (before - counts[t] >= 3) add(t, `weakened:${counts[t]}`, `${t} 断言数从 ${before} 降到 ${counts[t]}——不得削弱断言来让测试通过，请恢复或说明`);
  }

  // 汇总：只输出未发送过的
  const fresh = {};
  for (const f of findings) {
    const k = `${f.lane}|${f.key}`;
    if (state.sent[k]) continue;
    (fresh[f.lane] ??= []).push(f.text);
    if (json) state.sent[k] = head;
  }
  if (json) {
    state.lastCommit = head;
    state.expectCounts = counts;
  }
  return { fresh, state, findings };
}

if (spool) {
  const r = generate({
    runs: path.join(ROOT, '.oc-runs'), head, lastCommit: state.lastCommit, ifChanged: process.argv.includes('--if-changed'),
    scan, saveState: (next) => fs.writeFileSync(STATE, JSON.stringify(next, null, 2)),
  });
  console.log(r.skipped ? `quality-feedback: main 未前进（${head.slice(0, 12)}），跳过` : `quality-feedback: ${r.lanes} 个 lane 有新问题`);
} else if (json) {
  const { fresh } = scan();
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(fresh));
} else {
  const { fresh, findings } = scan();
  const all = {};
  for (const f of findings) (all[f.lane] ??= []).push(f.text);
  for (const [lane, items] of Object.entries(all).sort()) {
    console.log(`== ${lane}（${items.length}，其中新 ${fresh[lane]?.length ?? 0}）`);
    for (const t of items.slice(0, 8)) console.log(`   ${t}`);
    if (items.length > 8) console.log(`   … 另 ${items.length - 8} 条`);
  }
}
