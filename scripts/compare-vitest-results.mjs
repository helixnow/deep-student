#!/usr/bin/env node
// ============================================================================
// Vitest 结果对比（重构回归守卫）
//
// 职责：比较两份 `vitest run --reporter=json` 输出（基线 vs 当前），按
// `相对文件路径 + '\t' + fullName` 识别同一个测试，报告：
//   - 回归（退出码 1）：基线中 passed 的测试，当前 failed / 缺失 / 被跳过；
//   - 新增测试、由非通过转为通过的测试、基线里就失败且仍失败的测试（仅提示）。
// 两次运行可在不同 worktree：文件路径统一归一为仓库相对、正斜杠。仓库根
// 默认从测试文件公共目录向上找 package.json；路径已不存在时退回到公共目录中
// 第一个 `src` / `tests` 段之前；也可用 --base-root / --current-root 显式指定。
// 同一文件内重名测试按出现顺序追加 `\t#2`、`\t#3` 区分。
//
// 测试文件挪动/改名时用 --rename 把基线侧路径映射到新路径（以 `/` 结尾表示
// 目录前缀整体映射），或用 --renames 读取 JSON（{ "旧": "新" } 或
// [{ "from": "旧", "to": "新" }]）。
//
// 用法：
//   node scripts/compare-vitest-results.mjs <baseline.json> <current.json>
//   node scripts/compare-vitest-results.mjs base.json cur.json --rename src/a.test.ts=src/b/a.test.ts
//   node scripts/compare-vitest-results.mjs base.json cur.json --rename src/old/=src/new/ --renames moves.json
//   node scripts/compare-vitest-results.mjs base.json cur.json --json      # 机器可读输出
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toPosix = (p) => p.replace(/\\/g, '/');
const isAbsolute = (p) => /^([A-Za-z]:)?\//.test(toPosix(p));
const SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 测试文件公共目录（posix） */
export function commonDir(files) {
  const abs = files.map(toPosix).filter(isAbsolute);
  if (!abs.length) return null;
  let parts = abs[0].split('/').slice(0, -1);
  for (const f of abs.slice(1)) {
    const fp = f.split('/');
    let i = 0;
    while (i < parts.length && i < fp.length - 1 && sameSegment(parts[i], fp[i], i)) i += 1;
    parts = parts.slice(0, i);
  }
  return parts.join('/') || '/';
}

// Windows 盘符大小写不敏感
function sameSegment(a, b, i) {
  return i === 0 && /^[A-Za-z]:$/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 推断仓库根：向上找 package.json；路径不存在时取第一个 src/tests 段之前 */
export function detectRoot(files, exists = (p) => fs.existsSync(p)) {
  const dir = commonDir(files);
  if (!dir) return null;
  const parts = dir.split('/');
  for (let i = parts.length; i > 0; i -= 1) {
    const candidate = parts.slice(0, i).join('/');
    if (exists(`${candidate}/package.json`)) return candidate;
  }
  const idx = parts.findIndex((p, i) => i > 0 && (p === 'src' || p === 'tests'));
  return idx > 0 ? parts.slice(0, idx).join('/') : dir;
}

// 盘符统一小写（D:/x 与 d:/x 视为同一路径），其余部分保持大小写敏感
const normDrive = (p) => p.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);

export function relativize(file, root) {
  const f = toPosix(file);
  if (!root || !isAbsolute(f)) return f.replace(/^\.\//, '');
  const r = normDrive(toPosix(root).replace(/\/$/, ''));
  const nf = normDrive(f);
  return nf.startsWith(`${r}/`) ? nf.slice(r.length + 1) : f;
}

/** 解析 rename 规则：[{ from, to }]，目录前缀以 / 结尾 */
export function parseRenames(pairs = [], fileContents = []) {
  const out = [];
  const add = (from, to) => {
    if (!from || !to) throw new Error(`无效的 rename：${from}=${to}`);
    out.push({ from: toPosix(from).replace(/^\.\//, ''), to: toPosix(to).replace(/^\.\//, '') });
  };
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new Error(`--rename 需要 old=new 形式：${p}`);
    add(p.slice(0, i), p.slice(i + 1));
  }
  for (const data of fileContents) {
    if (Array.isArray(data)) for (const e of data) add(e.from, e.to);
    else for (const [from, to] of Object.entries(data)) add(from, to);
  }
  return out;
}

export function applyRenames(file, renames) {
  for (const { from, to } of renames) {
    if (from.endsWith('/') ? file.startsWith(from) : file === from) {
      return from.endsWith('/') ? to.replace(/\/?$/, '/') + file.slice(from.length) : to;
    }
  }
  return file;
}

/**
 * 把一份 vitest JSON 报告归一为 identity → { file, fullName, status }。
 * @returns {{ root: string|null, tests: Map<string, object>, brokenSuites: Array<{file: string, message: string}> }}
 */
export function normalizeRun(report, { root, renames = [] } = {}) {
  const files = (report.testResults ?? []).map((r) => r.name);
  const usedRoot = root ? toPosix(root) : detectRoot(files);
  const tests = new Map();
  const brokenSuites = [];
  for (const suite of report.testResults ?? []) {
    const file = applyRenames(relativize(suite.name, usedRoot), renames);
    const assertions = suite.assertionResults ?? [];
    if (suite.status === 'failed' && assertions.length === 0) {
      brokenSuites.push({ file, message: String(suite.message ?? '').split('\n')[0] });
    }
    const seen = new Map();
    for (const a of assertions) {
      const fullName = a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ');
      const base = `${file}\t${fullName}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const id = n === 1 ? base : `${base}\t#${n}`;
      tests.set(id, { id, file, fullName, status: normalizeStatus(a.status) });
    }
  }
  return { root: usedRoot, tests, brokenSuites };
}

function normalizeStatus(s) {
  if (s === 'passed' || s === 'failed') return s;
  if (SKIPPED.has(s)) return 'skipped';
  return s ?? 'unknown';
}

/** 比较两次归一后的运行 */
export function compareRuns(base, current) {
  const nowFailing = [];
  const missing = [];
  const nowSkipped = [];
  const newTests = [];
  const newlyPassing = [];
  const stillFailing = [];
  for (const [id, b] of base.tests) {
    const c = current.tests.get(id);
    if (b.status === 'passed') {
      if (!c) missing.push(b);
      else if (c.status === 'failed') nowFailing.push(c);
      else if (c.status !== 'passed') nowSkipped.push(c);
    } else if (c?.status === 'passed') newlyPassing.push({ ...c, was: b.status });
    else if (b.status === 'failed' && c?.status === 'failed') stillFailing.push(c);
  }
  for (const [id, c] of current.tests) if (!base.tests.has(id)) newTests.push(c);
  const byId = (a, b) => cmp(a.id, b.id);
  for (const list of [nowFailing, missing, nowSkipped, newTests, newlyPassing, stillFailing]) list.sort(byId);
  return {
    regressions: nowFailing.length + missing.length + nowSkipped.length,
    nowFailing,
    missing,
    nowSkipped,
    newTests,
    newlyPassing,
    stillFailing,
    counts: { base: countStatuses(base.tests), current: countStatuses(current.tests) },
  };
}

function countStatuses(tests) {
  const out = { total: tests.size, passed: 0, failed: 0, skipped: 0 };
  for (const t of tests.values()) out[t.status] = (out[t.status] ?? 0) + 1;
  return out;
}

/** 缺失测试按文件聚合：整文件缺失时提示可能挪动 */
export function groupMissingByFile(missing, base) {
  const perFile = new Map();
  for (const t of base.tests.values()) if (t.status === 'passed') perFile.set(t.file, (perFile.get(t.file) ?? 0) + 1);
  const groups = new Map();
  for (const t of missing) groups.set(t.file, (groups.get(t.file) ?? 0) + 1);
  return [...groups].map(([file, n]) => ({ file, missing: n, wholeFile: n === perFile.get(file) })).sort((a, b) => cmp(a.file, b.file));
}

function parseArgs(argv) {
  const opts = { positional: [], rename: [], renamesFiles: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (!a.startsWith('--')) {
      opts.positional.push(a);
      continue;
    }
    // --flag value 与 --flag=value 两种写法
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) throw new Error(`${flag} 缺少参数值`);
    if (flag === '--rename') opts.rename.push(val);
    else if (flag === '--renames') opts.renamesFiles.push(val);
    else if (flag === '--base-root') opts.baseRoot = val;
    else if (flag === '--current-root') opts.currentRoot = val;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function printList(title, list, fmt, limit = Infinity) {
  if (!list.length) return;
  console.log(`\n${title}（${list.length}）：`);
  for (const t of list.slice(0, limit)) console.log(`  - ${fmt(t)}`);
  if (list.length > limit) console.log(`  … 另有 ${list.length - limit} 条（--json 查看全部）`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.positional.length !== 2) throw new Error('需要两个参数：<baseline.json> <current.json>');
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const read = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  const renames = parseRenames(opts.rename, opts.renamesFiles.map(read));
  const base = normalizeRun(read(opts.positional[0]), { root: opts.baseRoot, renames });
  const current = normalizeRun(read(opts.positional[1]), { root: opts.currentRoot });
  const result = compareRuns(base, current);

  if (opts.json) {
    const strip = (list) => list.map(({ file, fullName, status, was }) => ({ file, fullName, status, ...(was ? { was } : {}) }));
    console.log(JSON.stringify({
      roots: { base: base.root, current: current.root },
      counts: result.counts,
      regressions: result.regressions,
      nowFailing: strip(result.nowFailing),
      missing: strip(result.missing),
      nowSkipped: strip(result.nowSkipped),
      newTests: strip(result.newTests),
      newlyPassing: strip(result.newlyPassing),
      stillFailing: strip(result.stillFailing),
      brokenSuites: current.brokenSuites,
    }, null, 2));
  } else {
    const c = result.counts;
    console.log(`基线根：${base.root}\n当前根：${current.root}`);
    console.log(`基线：${c.base.total} 个测试（通过 ${c.base.passed}，失败 ${c.base.failed}，跳过 ${c.base.skipped}）`);
    console.log(`当前：${c.current.total} 个测试（通过 ${c.current.passed}，失败 ${c.current.failed}，跳过 ${c.current.skipped}）`);
    const name = (t) => `${t.file} › ${t.fullName}`;
    printList('回归：由通过变为失败', result.nowFailing, name);
    if (result.missing.length) {
      const groups = groupMissingByFile(result.missing, base);
      console.log(`\n回归：基线通过、当前缺失（${result.missing.length}，涉及 ${groups.length} 个文件）：`);
      for (const g of groups) {
        console.log(`  - ${g.file}: ${g.missing} 个${g.wholeFile ? '（整文件缺失：若已挪动请用 --rename 旧=新）' : ''}`);
      }
      printList('缺失测试明细', result.missing, name, 30);
    }
    printList('回归：由通过变为跳过', result.nowSkipped, name);
    printList('当前运行中加载失败的测试文件', current.brokenSuites, (s) => `${s.file}: ${s.message}`);
    printList('新增测试', result.newTests, (t) => `[${t.status}] ${name(t)}`, 30);
    printList('新转为通过', result.newlyPassing, (t) => `[${t.was} → passed] ${name(t)}`, 30);
    printList('基线即失败、当前仍失败（不计回归）', result.stillFailing, name, 30);
    console.log(result.regressions ? `\n共 ${result.regressions} 个回归` : '\n无回归');
  }
  process.exit(result.regressions ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
