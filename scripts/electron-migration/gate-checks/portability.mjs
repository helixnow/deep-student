#!/usr/bin/env node
// 可移植性门禁接线（扫描器归 W14：scripts/portability/scan.mjs）。同一个扫描器、同一份白名单基线分别扫 base 与 HEAD：
//   portability     `scan.mjs --check` 报的 NEW（基线之外的 Node 专有依赖），按 文件+依赖 计数，HEAD 比 base 多才拦；
//   mobile-profile  `scan.mjs --profile host/profiles/mobile.json` 的运行时闭包违规，按 profile 模块+文件+依赖 计数，同上。
// 集成分支上已有的 NEW 与闭包违规（白名单落后于代码）不拦截，只拦本次改动新引入的；没有 --base 时按扫描器原生退出码判定。
// base 树只导出 host/ 下的源码与 profile（git ls-tree + cat-file，不依赖 tar），用完删除。
//
//   node scripts/electron-migration/gate-checks/portability.mjs --base <rev> [--root <dir>] [--scanner <rel>] [--profile <rel>]
//        [--baseline <file>]（缺省为扫描器同目录的 baseline.json）
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_SOURCE = /^host\/.*\.(?:[cm]?[jt]s|tsx)$|^host\/profiles\/[^/]+\.json$/;

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

/** 把 rev 的 host/ 源码导出到 dest。 */
export function exportHostSources(cwd, rev, dest) {
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', rev, '--', 'host'], { cwd, maxBuffer: 256 << 20 }).toString('utf8')
    .split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const [, type, oid] = line.slice(0, tab).split(' ');
      return { type, oid, file: line.slice(tab + 1) };
    }).filter((e) => e.type === 'blob' && HOST_SOURCE.test(e.file));
  if (!listed.length) return 0;
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd, input: `${listed.map((e) => e.oid).join('\n')}\n`, maxBuffer: 1 << 30 });
  let pos = 0;
  for (const e of listed) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString('utf8').split(' ')[2]);
    const target = path.join(dest, e.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return listed.length;
}

function scanner(cwd, scannerAbs, args) {
  const r = spawnSync(process.execPath, [scannerAbs, ...args], { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${path.basename(scannerAbs)} ${args.join(' ')} exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout).slice(0, 2000)}`);
  return r;
}

/** `--check` 的 NEW 条目：[{ file, line, key, label }]。 */
export function scanNew(root, scannerAbs, baselineAbs, tmp) {
  const json = path.join(tmp, `scan-${path.basename(root)}-${process.pid}.json`);
  scanner(root, scannerAbs, ['--root', root, '--check', '--json', json, ...(baselineAbs ? ['--baseline', baselineAbs] : [])]);
  const added = JSON.parse(fs.readFileSync(json, 'utf8')).comparison?.added ?? [];
  fs.rmSync(json, { force: true });
  return added.map((e) => ({ file: e.file, line: e.line, key: e.key, label: `${e.key}${e.replacement ? ` → ${e.replacement}` : ''}` }));
}

/** `--profile` 的闭包违规：[{ module, file, line, key, label }]（解析扫描器文档化的文本输出）。 */
export function scanProfile(root, scannerAbs, profile) {
  if (!fs.existsSync(path.join(root, profile))) return [];
  const r = scanner(root, scannerAbs, ['--root', root, '--profile', profile]);
  const out = [];
  let module = null;
  for (const line of r.stdout.split('\n')) {
    const head = /^(?:ok|FAIL) {1,3}(\S+) \(/.exec(line);
    if (head) { module = head[1]; continue; }
    const v = /^\s+(\S+):(\d+) (.+)$/.exec(line);
    if (v && module) out.push({ module, file: v[1], line: Number(v[2]), key: v[3], label: v[3] });
  }
  return out;
}

/** HEAD 中计数超过 base 的条目（按 keyOf 分组，超出部分取 HEAD 中靠后的出现）。 */
export function introduced(head, base, keyOf) {
  const budget = new Map();
  for (const e of base) budget.set(keyOf(e), (budget.get(keyOf(e)) ?? 0) + 1);
  const used = new Map();
  const out = [];
  for (const e of head) {
    const k = keyOf(e);
    used.set(k, (used.get(k) ?? 0) + 1);
    if (used.get(k) > (budget.get(k) ?? 0)) out.push(e);
  }
  return out;
}

export function run({ root, base, scanner: scannerRel = 'scripts/portability/scan.mjs', profile = 'host/profiles/mobile.json', baseline }) {
  const scannerAbs = path.resolve(root, scannerRel);
  const baselineCandidate = baseline ? path.resolve(root, baseline) : path.join(path.dirname(scannerAbs), 'baseline.json');
  const baselineAbs = fs.existsSync(baselineCandidate) ? baselineCandidate : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w09-portability-'));
  try {
    const headNew = scanNew(root, scannerAbs, baselineAbs, tmp);
    const headProfile = scanProfile(root, scannerAbs, profile);
    let baseNew = [];
    let baseProfile = [];
    if (base) {
      const baseRoot = path.join(tmp, 'base');
      exportHostSources(root, base, baseRoot);
      baseNew = scanNew(baseRoot, scannerAbs, baselineAbs, tmp);
      baseProfile = scanProfile(baseRoot, scannerAbs, profile);
    }
    const findings = [
      ...introduced(headNew, baseNew, (e) => `${e.file}\0${e.key}`).map((e) => ({ rule: 'portability', ...e, message: `新增 Node 专有依赖 ${e.label}` })),
      ...introduced(headProfile, baseProfile, (e) => `${e.module}\0${e.file}\0${e.key}`).map((e) => ({ rule: 'mobile-profile', ...e, message: `${profile} 的 ${e.module} 运行时闭包新触达 ${e.label}` })),
    ];
    return {
      gate: 'portability',
      base: base ?? null,
      findings,
      summary: { headNew: headNew.length, baseNew: baseNew.length, headProfile: headProfile.length, baseProfile: baseProfile.length, introduced: findings.length },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv) {
  const root = path.resolve(arg(argv, '--root', process.cwd()));
  const scannerRel = arg(argv, '--scanner', 'scripts/portability/scan.mjs');
  if (!fs.existsSync(path.resolve(root, scannerRel))) {
    console.log(`portability: 扫描器 ${scannerRel} 不存在，跳过`);
    return;
  }
  const result = run({
    root, base: arg(argv, '--base', null), scanner: scannerRel, profile: arg(argv, '--profile', 'host/profiles/mobile.json'), baseline: arg(argv, '--baseline', undefined),
  });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    const s = result.summary;
    console.log(`portability: NEW ${s.headNew} (base ${result.base ? s.baseNew : '—'}), mobile profile violations ${s.headProfile} (base ${result.base ? s.baseProfile : '—'}); ${s.introduced} introduced${result.base ? ` since ${result.base}` : ' (no --base: every NEW/violation counts)'}`);
    for (const f of result.findings) console.log(`${f.file}:${f.line} [${f.rule}] ${f.message}`);
  }
  if (result.findings.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
