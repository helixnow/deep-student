#!/usr/bin/env node
// Full-repo serde representation audit: host DB JSON writes and IPC results vs Rust.
//
// Usage: node scripts/serde-audit/audit.mjs [DIFF-TRIAGE.json[.gz]] [--out-dir scripts/serde-audit]
// Writes REPORT.md (human) and audit.json (every entry). Static + G3 evidence; see REPORT.md 方法.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTriage } from './g3-goldens.mjs';
import { aggregateTriage } from './lib/g3.mjs';
import { scanRustTypes, scanRustWrites, typeTextFeatures, namedType, rustFiles } from './lib/rust-scan.mjs';
import { loadHost, scanHostWrites, scanHashInputs, pluginOf } from './lib/host-scan.mjs';
import { decideDbSource, decideIpc } from './lib/decide.mjs';
import { loadContracts, commandFeatures, hostRegistrations } from './lib/ipc.mjs';
import { renderReport } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function g3Tags(site) {
  if (!site) return undefined;
  const tags = {};
  for (const f of site.findings.values()) (tags[f.tag] ??= []).push({ path: f.path, count: f.count, direction: f.direction, a: f.a, b: f.b });
  return { tags, occurrences: site.occurrences, scenarios: [...site.scenarios].slice(0, 3) };
}

export async function runAudit({ root = ROOT, triagePath } = {}) {
  const triageDoc = triagePath ? readTriage(triagePath) : undefined;
  const triage = triageDoc ? JSON.parse(triageDoc.text) : { groups: [] };
  const { columns: g3Columns, commands: g3Commands } = aggregateTriage(triage);
  const g3ByColumn = new Map();
  for (const site of g3Columns.values()) g3ByColumn.set(`${site.table}.${site.column}`, site);

  const rFiles = rustFiles(root);
  const { types } = await scanRustTypes(root, rFiles);
  const rustWrites = await scanRustWrites(root, types, rFiles);
  const rustByCol = new Map();
  for (const w of rustWrites) (rustByCol.get(`${w.table}.${w.column}`) ?? rustByCol.set(`${w.table}.${w.column}`, []).get(`${w.table}.${w.column}`)).push(w);

  const rustInfo = (key) => {
    const writes = rustByCol.get(key) ?? [];
    const typed = writes.filter((w) => w.valueTypeText && (w.valueType || /\bValue\b|Vec|HashMap|BTreeMap/.test(w.valueTypeText)));
    const primary = typed[0] ?? writes[0];
    let features = null, structOrder, decl;
    if (typed.length) {
      features = new Map();
      for (const w of typed) for (const [k, ps] of typeTextFeatures(types, w.valueTypeText, w.crate)) {
        const l = features.get(k) ?? [];
        for (const p of ps) if (!l.includes(p) && l.length < 6) l.push(p);
        features.set(k, l);
      }
      const named = namedType(types, primary.valueTypeText);
      decl = types.get(named)?.find((d) => d.crate === primary.crate) ?? types.get(named)?.[0];
      if (decl?.kind === 'struct' && named === primary.valueTypeText) structOrder = decl.fields.filter((f) => !f.flatten).map((f) => f.wire);
    } else if (writes.some((w) => w.how === 'json!' || w.how === 'Value::to_string')) {
      features = new Map([['value', ['$']]]);
    }
    return {
      writes, primary, features, structOrder,
      how: primary?.how,
      ref: primary ? `${primary.file}:${primary.line}` : null,
      typeRef: decl ? `${decl.file}:${decl.line}` : null,
      typeName: primary?.valueTypeText ?? null,
    };
  };

  const ctx = loadHost(root);
  const hostWrites = scanHostWrites(ctx);
  const entries = [];
  const seen = new Set();
  const hostCols = new Set();
  for (const w of hostWrites) {
    const key = `${w.table}.${w.column}`;
    const rust = rustInfo(key);
    const g3 = g3Tags(g3ByColumn.get(key));
    const isJsonCol = w.sources.length > 0 || rust.writes.length > 0;
    if (!isJsonCol) continue;
    hostCols.add(key);
    if (w.sources.length === 0) {
      const id = `unres|${w.file}:${w.line}|${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const decisions = rust.features || g3
        ? decideDbSource({ writer: rust.features ? '?' : 'JSON.stringify' }, rust, g3)
        : [{ type: 'other', detail: `宿主写入值来源未静态解析（${w.expr}）`, confidence: 'low', decision: '需人工核对', g3: 0 }];
      entries.push({ kind: 'db', plugin: w.plugin, site: key, host: `${w.file}:${w.line}`, sink: `${w.file}:${w.line}`, writer: '?', rust: rust.ref, rustType: rust.typeName, rustTypeRef: rust.typeRef, g3: g3?.occurrences ?? 0, decisions });
      continue;
    }
    for (const s of w.sources) {
      const id = `${s.file}:${s.line}|${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let decisions;
      if (rust.writes.length === 0) {
        decisions = s.writer.startsWith('safe:') ? [] : [{ type: 'other', detail: '未找到 Rust 对该列的 serde_json 写入（宿主独有列、Rust 动态 SQL 或非 JSON 列）', confidence: 'low', decision: '需人工核对', g3: 0 }];
        if (g3) decisions = decideDbSource(s, { ...rust, features: null }, g3);
      } else {
        decisions = decideDbSource(s, rust, g3);
      }
      entries.push({
        kind: 'db', plugin: pluginOf(s.file), site: key, host: `${s.file}:${s.line}`, sink: `${w.file}:${w.line}`,
        writer: s.writer, arg: s.arg, via: s.via, rust: rust.ref, rustHow: rust.how, rustType: rust.typeName, rustTypeRef: rust.typeRef,
        g3: g3?.occurrences ?? 0, decisions,
      });
    }
  }
  const rustOnly = [];
  for (const [key, writes] of rustByCol) {
    if (hostCols.has(key)) continue;
    const rust = rustInfo(key);
    rustOnly.push({ site: key, rust: rust.ref, rustType: rust.typeName, writes: writes.length, g3: g3ByColumn.get(key)?.occurrences ?? 0 });
  }

  const docs = loadContracts(root);
  const cmds = commandFeatures(docs);
  const sources = new Map([...ctx.sources].filter(([f]) => f.startsWith('host/plugins/') || f.startsWith('host/platform/')).map(([f, sf]) => [f, sf.text]));
  const reg = hostRegistrations(cmds.map((c) => c.command), sources);
  for (const c of cmds) {
    const g3sites = ['outcome', 'events'].map((k) => g3Commands.get(`${k}:${c.command}`)).filter(Boolean);
    const merged = g3sites.length ? { tags: {}, occurrences: 0 } : undefined;
    for (const s of g3sites) {
      const t = g3Tags(s);
      merged.occurrences += t.occurrences;
      for (const [k, v] of Object.entries(t.tags)) (merged.tags[k] ??= []).push(...v);
    }
    const decisions = decideIpc(c.features, merged);
    if (!decisions.length) continue;
    const r = reg.get(c.command);
    entries.push({
      kind: 'ipc', plugin: r ? pluginOf(r.file) : `(未注册) ${c.lane}`, site: c.command, host: r ? `${r.file}:${r.line}` : null,
      rust: c.rust ? `src-tauri/${c.rust.file}:${c.rust.line}` : null, contract: c.contract, g3: merged?.occurrences ?? 0, decisions,
    });
  }

  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return {
    meta: {
      head, triage: triagePath ? { file: path.basename(triagePath), sha256: triageDoc.sha256, at: triage.at, groups: triage.groups.length } : null,
      rustFiles: rFiles.length, rustTypes: types.size, rustJsonWrites: rustWrites.length, rustJsonColumns: rustByCol.size,
      hostFiles: ctx.files.length, hostSqlBindings: hostWrites.length, contracts: Object.keys(docs).length, commands: cmds.length,
    },
    g3: {
      columns: [...g3Columns.values()].map((s) => ({ site: `${s.table}.${s.column}`, db: s.db, occurrences: s.occurrences, findings: [...s.findings.values()] })),
      commands: [...g3Commands.values()].map((s) => ({ site: s.key, occurrences: s.occurrences, findings: [...s.findings.values()] })),
    },
    entries, rustOnly, hashInputs: scanHashInputs(ctx),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out-dir');
  const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'scripts/serde-audit');
  const triagePath = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  const result = await runAudit({ triagePath });
  fs.writeFileSync(path.join(outDir, 'audit.json'), `${JSON.stringify(result, null, 1)}\n`);
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(result));
  const n = result.entries.filter((e) => e.decisions.length).length;
  console.log(`serde-audit: ${n} entries with differences (${result.entries.length} sites) -> ${path.relative(process.cwd(), outDir)}/REPORT.md`);
}
