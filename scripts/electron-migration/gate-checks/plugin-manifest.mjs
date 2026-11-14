#!/usr/bin/env node
// 插件 manifest 门禁（decisions/2026-11-07-plugin-ecosystem-v1.md，W09）：
// 按 contracts/plugin-manifest/v1.schema.json 校验 package.json#deepStudent，并补上 schema 表达不了的检查：
//   - schema：结构、id 格式与禁用 publisher、engines.deepStudent 必填且语法合法、permissions 的 kind 封闭集合、未知字段；
//   - id-context：官方插件（host/、src/ui-plugins/ 下的 package.json）id 必须是 dstu.*，示例插件（examples/plugins/*）必须是 example.*；
//   - engines-unsatisfied：engines.deepStudent 不包含当前应用版本（根 package.json#version）——官方与示例都随应用发布，必须能装；
//     应用版本是预发布时与 Host 一样按 semver 7 includePrerelease 判断；
//   - range-empty：>=A <B 区间为空；requires-self：依赖自己；
//   - manifest-missing：examples/plugins/ 下的插件目录没有 package.json；json-invalid：package.json 解析失败。
// 现存问题按 规则+文件+细节 计数记入基线，只拦新增；重写基线时计数只能减少（--allow-increase 例外）。
// 版本范围按 schema $defs/range 的 npm 子集求值（semver 不是直接依赖，不新增依赖）。
//
//   node scripts/electron-migration/gate-checks/plugin-manifest.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/plugin-manifest.mjs --write-baseline [--allow-increase]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SCHEMA_FILE = 'contracts/plugin-manifest/v1.schema.json';
export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/plugin-manifest-baseline.json';
export const OFFICIAL_ROOTS = ['host', 'src/ui-plugins'];
export const EXAMPLES_DIR = 'examples/plugins';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__tests__', '__fixtures__', 'tests', 'fixtures']);

// ------------------------------------------------------------------ 版本与范围（schema $defs/range 子集）

const N = '(0|[1-9][0-9]*)';
const VERSION_RE = new RegExp(`^${N}\\.${N}\\.${N}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const PARTIAL_RE = new RegExp(`^([\\^~])${N}\\.${N}(?:\\.${N})?$`);
const EXACT_RE = new RegExp(`^${N}\\.${N}\\.${N}$`);
const BOUNDED_RE = new RegExp(`^>=${N}\\.${N}\\.${N}(?: <${N}\\.${N}\\.${N})?$`);

/** `X.Y.Z[-pre][+build]` → { v: [X, Y, Z], pre }；不合法返回 null。 */
export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text));
  return m ? { v: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** 范围 → { min（含）, max（不含，null 为无上界） }；不在子集内返回 null。语义同 npm semver。 */
export function parseRange(text) {
  const s = String(text);
  let m = PARTIAL_RE.exec(s);
  if (m) {
    const [major, minor, patch] = [Number(m[2]), Number(m[3]), m[4] === undefined ? null : Number(m[4])];
    const min = [major, minor, patch ?? 0];
    if (m[1] === '~') return { min, max: [major, minor + 1, 0] };
    if (major > 0) return { min, max: [major + 1, 0, 0] };
    if (minor > 0 || patch === null) return { min, max: [0, minor + 1, 0] };
    return { min, max: [0, 0, patch + 1] };
  }
  if ((m = EXACT_RE.exec(s))) {
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    return { min: v, max: [v[0], v[1], v[2] + 1] };
  }
  if ((m = BOUNDED_RE.exec(s))) {
    return { min: [Number(m[1]), Number(m[2]), Number(m[3])], max: m[4] === undefined ? null : [Number(m[4]), Number(m[5]), Number(m[6])] };
  }
  return null;
}

/** 区间为空（上界不大于下界）。 */
export const rangeIsEmpty = (r) => r.max !== null && cmp(r.max, r.min) <= 0;

/**
 * version 是否落在 range 内；任一不合法返回 null。
 * 默认同 npm：带预发布标签的版本不满足任何范围。includePrerelease 同 npm semver 7 的同名选项（与 Host
 * host/kernel/manifest.ts 的 satisfies 逐条一致，主代理决定 1）：`X.Y.Z-pre` < `X.Y.Z`；省略补丁号的 `^X.Y` / `~X.Y`
 * 下界是 `>=X.Y.0-0`（含 X.Y.0 的预发布），其余下界不含；`^` / `~` / 精确版本的上界是 `<A.B.C-0`，显式 `<A.B.C` 含。
 */
export function satisfies(version, range, { includePrerelease = false } = {}) {
  const v = parseVersion(version);
  const r = parseRange(range);
  if (!v || !r) return null;
  if (!v.pre) return cmp(v.v, r.min) >= 0 && (r.max === null || cmp(v.v, r.max) < 0);
  if (!includePrerelease) return false;
  // 范围不含预发布标签，`T-pre` 与边界的比较只看 T：`>=min-0` ⇔ T>=min，`>=min` ⇔ T>min，`<max-0` ⇔ T<max，`<max` ⇔ T<=max。
  const caretOrTilde = PARTIAL_RE.exec(String(range));
  const partial = caretOrTilde !== null && caretOrTilde[4] === undefined;
  const explicitMax = BOUNDED_RE.exec(String(range))?.[4] !== undefined;
  const aboveMin = partial ? cmp(v.v, r.min) >= 0 : cmp(v.v, r.min) > 0;
  const belowMax = r.max === null || (explicitMax ? cmp(v.v, r.max) <= 0 : cmp(v.v, r.max) < 0);
  return aboveMin && belowMax;
}

// ------------------------------------------------------------------ schema

const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, SCHEMA_FILE), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
const validate = ajv.compile(SCHEMA);

const PERMISSION_STEPS = ['语法应为 <kind>:<target>', '未知权限 kind（v1 只有 service）', 'service 的目标应为 lowerCamelCase 服务名'];

function schemaMessage(e) {
  const at = e.instancePath || '/';
  switch (e.keyword) {
    case 'required': return `${at} 缺少 ${e.params.missingProperty}`;
    case 'additionalProperties': return `${at} 不认识的字段 ${e.params.additionalProperty}`;
    case 'anyOf': return `${at} host 与 ui 至少写一个`;
    case 'const': return `${at} 必须是 ${JSON.stringify(e.params.allowedValue)}`;
    case 'not': return e.schemaPath.includes('/id/') ? `${at} 使用了保留的 publisher` : `${at} 不得含 .. 段`;
    case 'pattern': {
      const step = /\/allOf\/(\d)\/pattern$/.exec(e.schemaPath);
      if (step) return `${at} ${PERMISSION_STEPS[Number(step[1])]}`;
      if (e.schemaPath.includes('/range/')) return `${at} 不是合法的版本范围（只接受 ^X.Y[.Z]、~X.Y[.Z]、X.Y.Z、>=X.Y.Z[ <A.B.C]）`;
      if (e.schemaPath.includes('/id/')) return `${at} 不是合法的插件 id（dstu.<段>… 或 <publisher>.<name>）`;
      return `${at} 格式不合法（${e.params.pattern}）`;
    }
    case 'propertyNames': return `${at} 的键不是合法的插件 id`;
    default: return `${at} ${e.message}`;
  }
}

/** schema 校验：返回去重后的中文问题（anyOf 分支、allOf 包装和 propertyNames 的子错误已折叠；权限只报第一个不满足的步骤）。 */
export function schemaProblems(pkg) {
  if (validate(pkg)) return [];
  const out = new Set();
  const permissionReported = new Set();
  for (const e of validate.errors) {
    if (e.keyword === 'allOf' || e.propertyName !== undefined || /\/anyOf\/\d+\//.test(e.schemaPath)) continue;
    if (/\/allOf\/\d\/pattern$/.test(e.schemaPath)) {
      if (permissionReported.has(e.instancePath)) continue;
      permissionReported.add(e.instancePath);
    }
    out.add(schemaMessage(e));
  }
  return [...out];
}

// ------------------------------------------------------------------ 发现与检查

function walkPackages(root, dir, acc) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walkPackages(root, `${dir}/${e.name}`, acc);
    } else if (e.name === 'package.json') {
      acc.push(`${dir}/package.json`);
    }
  }
  return acc;
}

/** 门禁对象：官方插件（有 package.json 的）与 examples/plugins/ 下的每个插件目录。 */
export function targets(root = ROOT) {
  const official = OFFICIAL_ROOTS.flatMap((r) => walkPackages(root, r, [])).sort().map((file) => ({ kind: 'official', file }));
  const dir = path.join(root, EXAMPLES_DIR);
  const examples = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
        .map((name) => ({ kind: 'example', file: `${EXAMPLES_DIR}/${name}/package.json` }))
    : [];
  return [...official, ...examples];
}

function lineOf(text, key) {
  const i = text.indexOf(`"${key}"`);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

const CONTEXT_PUBLISHER = { official: 'dstu', example: 'example' };

/** 单个 package.json 的问题。appVersion 为根 package.json#version。 */
export function checkManifest({ file, kind, text, appVersion }) {
  const findings = [];
  const add = (rule, detail, line = 1) => findings.push({ rule, file, line, detail, message: detail });
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    add('json-invalid', `package.json 无法解析：${e.message}`);
    return findings;
  }
  for (const p of schemaProblems(pkg)) add('schema', p, lineOf(text, p.split(' ')[0].split('/').filter(Boolean).at(-1) ?? 'deepStudent'));

  const ds = pkg && typeof pkg.deepStudent === 'object' ? pkg.deepStudent : null;
  const id = typeof ds?.id === 'string' ? ds.id : null;
  const publisher = CONTEXT_PUBLISHER[kind];
  if (id && publisher && !id.startsWith(`${publisher}.`)) {
    add('id-context', `${kind === 'official' ? '官方' : '示例'}插件的 id 必须以 ${publisher}. 开头：${id}`, lineOf(text, 'id'));
  }

  const engines = pkg?.engines?.deepStudent;
  const enginesRange = typeof engines === 'string' ? parseRange(engines) : null;
  if (enginesRange && rangeIsEmpty(enginesRange)) add('range-empty', `/engines/deepStudent 区间为空：${engines}`, lineOf(text, 'engines'));
  else if (enginesRange && !satisfies(appVersion, engines, { includePrerelease: true })) {
    add('engines-unsatisfied', `/engines/deepStudent ${engines} 不包含当前应用版本 ${appVersion}`, lineOf(text, 'engines'));
  }

  const requires = ds?.requires && typeof ds.requires === 'object' ? ds.requires : {};
  for (const [dep, range] of Object.entries(requires)) {
    const r = typeof range === 'string' ? parseRange(range) : null;
    if (r && rangeIsEmpty(r)) add('range-empty', `/deepStudent/requires/${dep} 区间为空：${range}`, lineOf(text, dep));
    if (id && dep === id) add('requires-self', `/deepStudent/requires 依赖了自己：${dep}`, lineOf(text, dep));
  }
  return findings;
}

export function scan(root = ROOT) {
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const list = targets(root);
  const findings = [];
  for (const t of list) {
    const abs = path.join(root, t.file);
    if (!fs.existsSync(abs)) {
      findings.push({ rule: 'manifest-missing', file: t.file, line: 1, detail: '示例插件目录没有 package.json（manifest 唯一载体是 package.json#deepStudent）', message: '示例插件目录没有 package.json（manifest 唯一载体是 package.json#deepStudent）' });
      continue;
    }
    findings.push(...checkManifest({ ...t, text: fs.readFileSync(abs, 'utf8'), appVersion }));
  }
  return { appVersion, targets: list, findings };
}

// ------------------------------------------------------------------ 基线

const keyOf = (f) => `${f.rule}\u0000${f.file}\u0000${f.detail}`;
export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, keyOf);
export const baselineFrom = (findings, previous = { entries: [] }) =>
  countBaselineEntries(findings, previous, keyOf, (f) => ({ rule: f.rule, file: f.file, detail: f.detail }), [(e) => e.file, (e) => e.rule, (e) => e.detail]);

export function baselineGrowth(previous, entries) {
  const before = new Map((previous?.entries ?? []).map((e) => [keyOf(e), e.count ?? 1]));
  return entries.filter((e) => e.count > (before.get(keyOf(e)) ?? 0)).map((e) => ({ ...e, from: before.get(keyOf(e)) ?? 0, to: e.count }));
}

export function run({ root = ROOT } = {}) {
  const { appVersion, targets: list, findings } = scan(root);
  const baselinePath = path.join(root, BASELINE_FILE);
  const hasBaseline = fs.existsSync(baselinePath);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  const count = (kind) => list.filter((t) => t.kind === kind).length;
  return {
    gate: 'plugin-manifest',
    findings: [...fresh, ...stale.map((e) => ({ ...e, line: 1, message: `基线项已不再出现（现 ${e.present}/${e.count ?? 1}），请重写基线把计数降下来：${e.detail}` }))],
    all: findings,
    summary: { appVersion, official: count('official'), examples: count('example'), existing: findings.length, byRule, baselined: findings.length - fresh.length, fresh: fresh.length, stale: stale.length },
    baseline,
    hasBaseline,
  };
}

function main(argv) {
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  const result = run({ root });
  if (argv.includes('--write-baseline')) {
    const entries = baselineFrom(result.all, result.baseline);
    const growth = result.hasBaseline ? baselineGrowth(result.baseline, entries) : [];
    if (growth.length && !argv.includes('--allow-increase')) {
      console.log('plugin-manifest: 基线计数只能减少；以下项会增加（确需登记请加 --allow-increase 并在评审中说明）：');
      for (const g of growth) console.log(`  ${g.file} [${g.rule}] ${g.detail} ${g.from} → ${g.to}`);
      process.exitCode = 1;
      return;
    }
    const description = result.baseline.description
      ?? '插件 manifest 门禁基线（按 规则+文件+细节 计数，只减不增）。示例插件由 W17 在 P0 修；官方插件补 package.json 后另排。见 plugin-manifest.mjs 文件头。';
    fs.mkdirSync(path.dirname(path.join(root, BASELINE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ description, entries }, null, 1)}\n`);
    console.log(`wrote ${entries.length} baseline entries (${result.all.length} findings)`);
    return;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, baseline: undefined }, null, 2));
  else {
    const s = result.summary;
    const rules = Object.entries(s.byRule).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
    console.log(`plugin-manifest: app ${s.appVersion}; ${s.official} official + ${s.examples} example packages; ${s.existing} known (${rules}), ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}`);
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
