#!/usr/bin/env node
// Rust 原有 bug 修复登记门禁（WAVE2-BRIEF §7）。校验 host/e2e/differential/rust-fixes/*.json：
//   schema         格式、必填字段、kind/status 枚举、approved 带 approvedBy/approvedAt、选择器足够窄
//                  （db 要 table+column，event 要 event，ipc 要 command，fs 要 path；scenario 为 * 的 db 选择器
//                  还要 jsonPath 或非通配的 column）——见 rust-fixes.schema.json；
//   id             与文件名一致、全局唯一；
//   marker         源码（host/、electron/、src/）里的 `RUST-FIX(<id>)` 与登记一一对应：没有孤立标记，
//                  fix.files 里每个文件都有该 id 的标记，带标记的文件都列在 fix.files 里；
//   test           tests[].file 存在，name 以 id 开头，且文件里有以 id 开头的测试标题；
//   rust           rust.file 存在；
//   commit         写了 commits 时，每个都是本仓库里存在的提交（git cat-file -e）。
// deliberate（产品决策与优化）条目必须写 userVisible 与 dataCompat。
// 目录不存在或为空时通过（仍检查孤立标记）。不是棘轮：任何问题都拦截。
// --review 只读输出待审报表：每个 proposed 条目、登记的 commits 与提交信息里带该 id 的提交（git log --grep），
// 供主代理审核与按 id revert。
//
//   node scripts/electron-migration/gate-checks/rust-fixes.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/rust-fixes.mjs --review [--json] [--root <dir>] [--rev <rev>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';
import { ROOT, files } from './common.mjs';

export const REGISTRY_DIR = 'host/e2e/differential/rust-fixes';
export const SCHEMA_FILE = 'scripts/electron-migration/gate-checks/rust-fixes.schema.json';
const MARKER_ROOTS = ['host', 'electron', 'src'];
const SOURCE = /\.(?:[cm]?[jt]sx?|rs)$/;
const MARKER = /RUST-FIX\(([^)\s]*)\)/g;

const Ajv = AjvModule.default ?? AjvModule;
const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'rust-fixes.schema.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exists = (root, f) => {
  try {
    return fs.statSync(path.join(root, f)).isFile();
  } catch {
    return false;
  }
};

/** 源码中的 RUST-FIX(<id>) 标记。 */
export function scanMarkers(root) {
  const out = [];
  for (const dir of MARKER_ROOTS) {
    for (const file of files(root, dir)) {
      if (!SOURCE.test(file) || file.includes('/node_modules/')) continue;
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      if (!text.includes('RUST-FIX(')) continue;
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(MARKER)) out.push({ id: m[1], file, line: i + 1 });
      });
    }
  }
  return out;
}

const schemaMessage = (e) => {
  const where = e.instancePath || '/';
  if (e.keyword === 'required') return `${where} 缺少 ${e.params.missingProperty}`;
  if (e.keyword === 'additionalProperties') return `${where} 不认识的字段 ${e.params.additionalProperty}`;
  if (e.keyword === 'enum') return `${where} 只能是 ${e.params.allowedValues.join(' / ')}`;
  if (e.keyword === 'not' && /selectors\/\d+\/(table|event|command|path)$/.test(where)) return `${where} 不能是通配 *（选择器过宽）`;
  if (e.keyword === 'not') return `${where} 带了与 surface 不符的定位字段`;
  if (e.keyword === 'anyOf' && /selectors\/\d+$/.test(where)) return `${where} scenario 为 * 的 db 选择器必须给 jsonPath 或非通配的 column（选择器过宽）`;
  return `${where} ${e.message}`;
};

const TEST_CALL = String.raw`\b(?:it|test|describe)(?:\.\w+(?:\([^)]*\))?)*\s*\(\s*`;

/**
 * 文件里是否有以 id 开头的测试标题。只认两种写法：字面量（'…'、"…"、无插值的 `…`），
 * 以及同一文件里 `const NAME = '<id>'`（可带 `as const`）后用 `${NAME}` 开头的模板字符串。
 * 其余动态形式（let/var、拼接、导入的常量、成员访问）不认。
 */
export function hasIdTitle(text, id) {
  if (new RegExp(`${TEST_CALL}(['"\`])${escape(id)}`).test(text)) return true;
  const constants = String.raw`\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])${escape(id)}\2(?:\s+as\s+const)?\s*(?:;|$)`;
  for (const m of text.matchAll(new RegExp(constants, 'gm'))) {
    if (new RegExp(`${TEST_CALL}\`\\$\\{\\s*${escape(m[1])}\\s*\\}`).test(text)) return true;
  }
  return false;
}

/** @returns {{ entries: object[], markers: object[], findings: {rule: string, file: string, line?: number, message: string}[] }} */
export function checkRustFixes(root = ROOT) {
  const findings = [];
  const add = (rule, file, message, line = 1) => findings.push({ rule, file, line, message, severity: 'error' });
  const dir = path.join(root, REGISTRY_DIR);
  const registryFiles = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const entries = [];
  for (const name of registryFiles) {
    const file = `${REGISTRY_DIR}/${name}`;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      add('schema', file, `不是合法 JSON：${e.message}`);
      continue;
    }
    if (!validate(data)) {
      for (const e of validate.errors.filter((x) => x.keyword !== 'if')) add('schema', file, schemaMessage(e));
    }
    if (typeof data?.id !== 'string') continue;
    if (`${data.id}.json` !== name) add('id', file, `id ${data.id} 与文件名不一致（应为 ${data.id}.json）`);
    entries.push({ ...data, file });
  }

  const byId = new Map();
  for (const e of entries) {
    if (byId.has(e.id)) add('id', e.file, `id ${e.id} 重复（另见 ${byId.get(e.id).file}）`);
    else byId.set(e.id, e);
  }

  const markers = scanMarkers(root);
  for (const m of markers) {
    const entry = byId.get(m.id);
    if (!entry) add('marker', m.file, `孤立的 RUST-FIX(${m.id}) 标记：${REGISTRY_DIR}/ 里没有这个登记`, m.line);
    else if (Array.isArray(entry.fix?.files) && !entry.fix.files.includes(m.file)) add('marker', m.file, `RUST-FIX(${m.id}) 所在文件没有列在 ${entry.file} 的 fix.files 里`, m.line);
  }
  for (const e of byId.values()) {
    for (const f of Array.isArray(e.fix?.files) ? e.fix.files : []) {
      if (!exists(root, f)) add('marker', e.file, `fix.files 中的 ${f} 不存在`);
      else if (!markers.some((m) => m.id === e.id && m.file === f)) add('marker', e.file, `fix.files 中的 ${f} 没有 RUST-FIX(${e.id}) 标记`);
    }
    if (typeof e.rust?.file === 'string' && !exists(root, e.rust.file)) add('rust', e.file, `rust.file ${e.rust.file} 不存在`);
    for (const sha of Array.isArray(e.commits) ? e.commits : []) {
      if (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) && !commitExists(root, sha)) add('commit', e.file, `commits 中的 ${sha} 不是本仓库里存在的提交（或缩写有歧义）`);
    }
    for (const t of Array.isArray(e.tests) ? e.tests : []) {
      if (typeof t?.file !== 'string') continue;
      if (typeof t.name === 'string' && !t.name.startsWith(e.id)) add('test', e.file, `tests[].name 必须以 ${e.id} 开头：${t.name}`);
      if (!exists(root, t.file)) add('test', e.file, `测试文件 ${t.file} 不存在`);
      else if (!hasIdTitle(fs.readFileSync(path.join(root, t.file), 'utf8'), e.id)) add('test', e.file, `测试文件 ${t.file} 里没有以 ${e.id} 开头的测试标题`);
    }
  }
  return { entries, markers, findings: findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line) };
}

export function run({ root = ROOT } = {}) {
  const { entries, markers, findings } = checkRustFixes(root);
  const byStatus = {};
  for (const e of entries) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  return { gate: 'rust-fixes', findings, entries, markers, summary: { entries: entries.length, markers: markers.length, byStatus, errors: findings.length } };
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const FORMAT = '--format=%H%x09%h%x09%cI%x09%s';
const parseLog = (out, source) => out.split('\n').filter(Boolean).map((line) => {
  const [sha, short, date, subject] = line.split('\t');
  return { sha, short, date, subject, source };
});

/** sha 是否为本仓库里存在（且无歧义）的提交。 */
export function commitExists(root, sha) {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** 提交信息里带 id 的提交（按时间倒序）；不是 git 仓库或 rev 不存在时返回 null。 */
export function commitsFor(root, id, rev = 'HEAD') {
  try {
    return parseLog(git(root, ['log', '--fixed-strings', `--grep=${id}`, FORMAT, rev, '--']), 'grep');
  } catch {
    return null;
  }
}

/** 登记里 commits 字段的提交（解析不了的只给 sha），再并上 grep 到的提交（按完整 sha 去重）；git 不可用且没有登记提交时返回 null。 */
export function reviewCommits(root, entry, rev = 'HEAD') {
  const registered = (Array.isArray(entry.commits) ? entry.commits : []).map((sha) => {
    try {
      return parseLog(git(root, ['log', '-1', FORMAT, `${sha}^{commit}`, '--']), 'registered')[0];
    } catch {
      return { sha, short: sha, date: null, subject: null, source: 'registered' };
    }
  });
  const grepped = commitsFor(root, entry.id, rev);
  if (grepped === null && !registered.length) return null;
  const seen = new Set(registered.map((c) => c.sha));
  return [...registered, ...(grepped ?? []).filter((c) => !seen.has(c.sha))];
}

/** 待审报表（只读）：所有 proposed 条目、关键字段与对应提交。 */
export function review({ root = ROOT, rev = 'HEAD' } = {}) {
  const { entries, findings } = checkRustFixes(root);
  const proposed = entries.filter((e) => e.status === 'proposed').map((e) => ({
    id: e.id, kind: e.kind, title: e.title, file: e.file,
    fixFiles: e.fix?.files ?? [], userVisible: e.userVisible ?? null, dataCompat: e.dataCompat ?? null,
    g3: { affects: e.g3?.affects ?? null, selectors: e.g3?.selectors?.length ?? 0 },
    tests: (e.tests ?? []).map((t) => t.file),
    commits: reviewCommits(root, e, rev),
  }));
  return { gate: 'rust-fixes-review', rev, proposed, approved: entries.filter((e) => e.status === 'approved').map((e) => e.id), errors: findings.length };
}

function printReview(r) {
  console.log(`rust-fixes review @ ${r.rev}: ${r.proposed.length} proposed, ${r.approved.length} approved, ${r.errors} gate errors`);
  for (const p of r.proposed) {
    console.log(`\n${p.id} [${p.kind}] ${p.title}`);
    console.log(`  登记: ${p.file}`);
    console.log(`  修复文件: ${p.fixFiles.join(', ') || '—'}`);
    if (p.userVisible !== null) console.log(`  用户可感知: ${p.userVisible}`);
    if (p.dataCompat !== null) console.log(`  数据兼容: ${p.dataCompat}`);
    console.log(`  G3: ${p.g3.affects ? `影响（${p.g3.selectors} 个选择器）` : '不影响'}；测试: ${p.tests.join(', ') || '—'}`);
    if (p.commits === null) console.log('  提交: （无法读取 git 历史）');
    else if (!p.commits.length) console.log('  提交: （没有提交信息带此 id 的提交，无法按 id revert）');
    else {
      for (const c of p.commits) {
        const label = c.source === 'registered' ? '登记提交' : '提交';
        console.log(c.subject === null ? `  ${label}: ${c.short} （本仓库里找不到）` : `  ${label}: ${c.short} ${c.date} ${c.subject}`);
      }
    }
  }
}

function main(argv) {
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  if (argv.includes('--review')) {
    const r = review({ root, rev: argv.includes('--rev') ? argv[argv.indexOf('--rev') + 1] : 'HEAD' });
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else printReview(r);
    return;
  }
  const result = run({ root });
  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    const s = result.summary;
    const status = Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    console.log(`rust-fixes: ${s.entries} entries (${status}), ${s.markers} RUST-FIX markers, ${s.errors} errors`);
    for (const f of result.findings) console.log(`${f.file}:${f.line} [${f.rule}] ${f.message}`);
  }
  if (argv.includes('--check') && result.findings.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
