// 产物渲染：定义命名（ser/de 形状相同则合并）、按 lane 拆分（多 lane 共用 → _shared.json）、
// JSON 契约、TS 类型、UNRESOLVED.md、SUMMARY.md。所有集合按键排序，输出确定。
import type { Extraction, EventOut } from './main.ts';
import { closureOf, unresolvedOf } from './main.ts';
import { semText, type DefInstance, type Sem, type UnresItem } from './schema.ts';
import { FORCED_SHARED_DEFS, STABLE_TYPE_EXPORTS, type CompatExport } from '../../../contracts/type-exports.ts';
import type { CommandContract, EventContract, JsonSchema, LaneContract } from '../../../../host/kernel/contract.ts';

type Ref = { lane: string | null; name: string };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function baseOf(key: string): string { return key.replace(/\|(ser|de)$/, ''); }
function dirOf(key: string): 'ser' | 'de' { return key.endsWith('|de') ? 'de' : 'ser'; }

function mangleSem(s: Sem): string {
  switch (s.k) {
    case 'prim': return s.name;
    case 'def': return [s.def.name, ...s.args.map(mangleSem)].join('_');
    case 'ext': return [s.path.split('::').pop()!, ...s.args.map(mangleSem)].join('_');
    case 'tuple': return ['Tuple', ...s.elems.map(mangleSem)].join('_');
    case 'array': return `Array${s.len}_${mangleSem(s.elem)}`;
    case 'slice': return `Slice_${mangleSem(s.elem)}`;
    case 'unit': return 'Unit';
    case 'never': return 'Never';
    case 'generic': return s.name;
    case 'unres': return 'Unresolved';
  }
}

function walkRefs(s: unknown, f: (ref: string) => string): unknown {
  if (Array.isArray(s)) return s.map((x) => walkRefs(x, f));
  if (s && typeof s === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) {
      if (v === undefined) continue;
      o[k] = k === '$ref' && typeof v === 'string' ? f(v) : walkRefs(v, f);
    }
    return o;
  }
  return s;
}

const hasUnresolved = (s: unknown): boolean => JSON.stringify(s).includes('"x-unresolved"');

export function renderOutputs(ex: Extraction, generator: string, refPrefix: string): { files: Map<string, string>; summary: string } {
  const { sb } = ex;
  const insts = sb.instances;

  // ---------- ser/de 合并：最大不动点
  const pairs = new Map<string, { ser?: DefInstance; de?: DefInstance }>();
  for (const inst of insts.values()) {
    const b = baseOf(inst.key);
    const p = pairs.get(b) ?? {};
    p[inst.dir] = inst;
    pairs.set(b, p);
  }
  const canon = (s: unknown): string => JSON.stringify(walkRefs(s, (r) => baseOf(r)));
  const eq = new Map<string, boolean>();
  for (const [b, p] of pairs) eq.set(b, !!(p.ser && p.de && canon(p.ser.schema) === canon(p.de.schema)));
  for (let changed = true; changed;) {
    changed = false;
    for (const [b, p] of pairs) {
      if (!eq.get(b)) continue;
      for (const r of [...p.ser!.refs, ...p.de!.refs]) {
        const cb = baseOf(r);
        const cp = pairs.get(cb)!;
        if (cp.ser && cp.de && !eq.get(cb)) { eq.set(b, false); changed = true; break; }
      }
    }
  }
  const finalId = (key: string): string => (eq.get(baseOf(key)) ? `${baseOf(key)}|both` : key);

  // ---------- 命名
  const finals = new Map<string, DefInstance>();
  for (const inst of insts.values()) {
    const f = finalId(inst.key);
    if (!finals.has(f) || inst.dir === 'ser') finals.set(f, inst);
  }
  const proposed = new Map<string, string>();
  for (const [f, inst] of finals) {
    let n = mangleSem({ k: 'def', def: inst.def, args: inst.args }).replace(/[^A-Za-z0-9_]/g, '_');
    const p = pairs.get(baseOf(f))!;
    if (!f.endsWith('|both') && dirOf(f) === 'de' && p.ser) n += '__De';
    proposed.set(f, n);
  }
  const byName = new Map<string, string[]>();
  for (const [f, n] of proposed) byName.set(n, [...(byName.get(n) ?? []), f]);
  const names = new Map<string, string>();
  for (const [n, fs] of byName) {
    if (fs.length === 1) { names.set(fs[0]!, n); continue; }
    const qualified = new Map<string, string>();
    for (const f of fs) {
      const inst = finals.get(f)!;
      const scopePath = [inst.def.scope.crate, ...inst.def.scope.path].join('__');
      const fnPart = /\{fn ([A-Za-z0-9_]+)#/.exec(inst.def.scope.id)?.[1];
      qualified.set(f, `${scopePath}${fnPart ? `__fn_${fnPart}` : ''}__${n}`);
    }
    const counts = new Map<string, number>();
    for (const q of qualified.values()) counts.set(q, (counts.get(q) ?? 0) + 1);
    const sorted = [...qualified.entries()].sort((a, b) => cmp(a[0], b[0]));
    const seen = new Map<string, number>();
    for (const [f, q] of sorted) {
      if (counts.get(q)! > 1) { const i = (seen.get(q) ?? 0) + 1; seen.set(q, i); names.set(f, `${q}_${i}`); }
      else names.set(f, q);
    }
  }

  // ---------- lane 归属
  const lanes = new Set<string>([...ex.commands.map((c) => c.lane), ...ex.events.map((e) => e.lane)]);
  const eventGroups = new Map<string, EventOut[]>();
  for (const e of ex.events) eventGroups.set(e.record.name, [...(eventGroups.get(e.record.name) ?? []), e]);
  const laneEvents = new Map<string, string[]>();
  for (const [name, es] of eventGroups) for (const l of new Set(es.map((e) => e.lane))) laneEvents.set(l, [...(laneEvents.get(l) ?? []), name]);

  const laneRoots = new Map<string, Set<string>>();
  for (const l of lanes) laneRoots.set(l, new Set());
  for (const c of ex.commands) for (const r of c.owner.refs) laneRoots.get(c.lane)!.add(r);
  for (const [l, evs] of laneEvents) for (const n of evs) for (const e of eventGroups.get(n)!) for (const r of e.owner.refs) laneRoots.get(l)!.add(r);
  const laneDefs = new Map<string, Set<string>>();
  const defLanes = new Map<string, Set<string>>();
  for (const [l, roots] of laneRoots) {
    const fs2 = new Set([...closureOf(sb, roots)].map(finalId));
    laneDefs.set(l, fs2);
    for (const f of fs2) defLanes.set(f, new Set([...(defLanes.get(f) ?? []), l]));
  }
  const forcedShared = new Set(FORCED_SHARED_DEFS);
  const isShared = (f: string): boolean => forcedShared.has(names.get(f)!) || (defLanes.get(f)?.size ?? 0) > 1;

  const refFor = (fromLane: string | null) => (r: string): string => {
    const key = r.slice(refPrefix.length);
    const f = finalId(key);
    const n = names.get(f)!;
    if (fromLane === null) return `#/$defs/${n}`;
    return isShared(f) ? `_shared.json#/$defs/${n}` : `#/$defs/${n}`;
  };
  const fix = (s: unknown, lane: string | null): JsonSchema => walkRefs(s, refFor(lane)) as JsonSchema;

  const files = new Map<string, string>();
  const tsRefs = new Map<string, Ref>();
  for (const [f, n] of names) tsRefs.set(f, { lane: isShared(f) ? null : '', name: n });

  // ---------- 事件合约
  const eventContract = (name: string, lane: string): EventContract => {
    const es = eventGroups.get(name)!;
    const payloads = new Map<string, JsonSchema>();
    for (const e of es) {
      const p = fix(e.payload, lane);
      payloads.set(JSON.stringify(p), p);
    }
    const ps = [...payloads.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, p]) => p);
    const emitters = es.map((e) => ({
      file: e.record.file, line: e.record.line, fn: e.record.fn.name, lane: e.lane, method: e.record.method,
      ...(e.record.via ? { via: e.record.via } : {}),
      ...(e.record.receiverNote ? { note: e.record.receiverNote } : {}),
    })).sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.fn, b.fn));
    return { name, dynamic: es.some((e) => e.record.dynamic), payload: ps.length === 1 ? ps[0]! : { anyOf: ps, 'x-note': 'emitters send different payload shapes' }, emitters };
  };

  // ---------- lane 文件
  const laneContracts = new Map<string, LaneContract>();
  for (const lane of [...lanes].sort(cmp)) {
    const commands: CommandContract[] = ex.commands.filter((c) => c.lane === lane).map((c) => {
      const cc: CommandContract & Record<string, unknown> = {
        name: c.name, lane, rust: { file: c.fn.loc.file, line: c.attrLine, fn: c.fn.name }, async: c.async,
        ...(c.renameAll ? { renameAll: c.renameAll } : {}),
        args: c.args.map((a) => ({ key: a.key, rustName: a.rustName, schema: fix(a.schema, lane), optional: a.optional })),
        injected: c.injected.map((i) => (i.kind === 'channel' ? { ...i, schema: fix(i.schema, lane) } : i)) as CommandContract['injected'],
        result: fix(c.result, lane),
        ...(c.error ? { error: fix(c.error, lane) } : {}),
        frontend: c.frontend,
      };
      if (c.fn.cfg && !c.fn.cfg.always) cc['x-platforms'] = c.fn.cfg.platforms;
      if (!c.inInventory) cc['x-not-in-inventory'] = true;
      if (c.registered === false) cc['x-rust-registered'] = false;
      return cc;
    });
    const events = (laneEvents.get(lane) ?? []).slice().sort(cmp).map((n) => eventContract(n, lane));
    const $defs: Record<string, JsonSchema> = {};
    const laneExt = ex.hostNative?.defExtensions?.[lane];
    for (const f of [...laneDefs.get(lane)!].filter((x) => !isShared(x)).sort((a, b) => cmp(names.get(a)!, names.get(b)!))) {
      const defName = names.get(f)!;
      const baseSchema = fix(finals.get(f)!.schema, lane);
      const extraProps = laneExt?.[defName];
      if (extraProps && baseSchema && typeof baseSchema === 'object' && baseSchema.type === 'object' && baseSchema.properties && typeof baseSchema.properties === 'object' && !Array.isArray(baseSchema.properties)) {
        $defs[defName] = { ...baseSchema, properties: { ...(baseSchema.properties as Record<string, JsonSchema>), ...extraProps } };
      } else {
        $defs[defName] = baseSchema;
      }
    }
    const lc: LaneContract = { lane, generator, commands, events, $defs };
    laneContracts.set(lane, lc);
    files.set(`contracts/ipc/${lane}.json`, JSON.stringify(withHostNative(lc, ex.hostNative), null, 2) + '\n');
  }
  if (ex.hostNative && !lanes.has(ex.hostNative.lane)) {
    const lc: LaneContract = { lane: ex.hostNative.lane, generator, commands: [], events: [], $defs: {} };
    files.set(`contracts/ipc/${lc.lane}.json`, JSON.stringify(withHostNative(lc, ex.hostNative), null, 2) + '\n');
  }
  const shared$defs: Record<string, JsonSchema> = {};
  for (const f of [...defLanes.keys()].filter(isShared).sort((a, b) => cmp(names.get(a)!, names.get(b)!))) shared$defs[names.get(f)!] = fix(finals.get(f)!.schema, null);
  const shared: LaneContract = { lane: '_shared', generator, commands: [], events: [], $defs: shared$defs };
  files.set('contracts/ipc/_shared.json', JSON.stringify(shared, null, 2) + '\n');

  // ---------- TS
  files.set('contracts/ipc/generated/_shared.ts', renderTs(shared, true, generator, shared, laneContracts));
  for (const [lane, lc] of laneContracts) files.set(`contracts/ipc/generated/${lane}.ts`, renderTs(lc, false, generator, shared, laneContracts));

  // ---------- 报告
  const { unresolvedMd, summaryMd, summary } = renderReports(ex, laneContracts, names, finalId, finals, generator);
  files.set('contracts/ipc/UNRESOLVED.md', unresolvedMd);
  files.set('contracts/ipc/SUMMARY.md', summaryMd);
  void tsRefs;
  return { files, summary };
}

/** 把 host-native 条目作为 `hostNative` 段附到其所属 lane 的契约 JSON 上（键序：放在 `$defs` 之前）。 */
function withHostNative(lc: LaneContract, hostNative: Extraction['hostNative']): LaneContract | (Omit<LaneContract, '$defs'> & { hostNative: unknown; $defs: LaneContract['$defs'] }) {
  if (!hostNative || hostNative.lane !== lc.lane) return lc;
  const commands = hostNative.commands.map((c) => ({ name: c.name, 'x-host-native': true, host: c.host, ...(c.description ? { description: c.description } : {}), args: c.args, result: c.result, ...(c.error ? { error: c.error } : {}) }));
  const events = hostNative.events.map((e) => ({ name: e.name, 'x-host-native': true, host: e.host, ...(e.description ? { description: e.description } : {}), dynamic: false, payload: e.payload }));
  const { $defs, ...rest } = lc;
  return { ...rest, hostNative: { commands, events }, $defs };
}

// ======================================================================== TS

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const pascal = (s: string): string => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

function tsOf(s: JsonSchema | boolean | undefined, ind: string, sharedCtx = false): string {
  if (s === undefined || s === true) return 'unknown';
  if (s === false) return 'never';
  if (s['x-unresolved']) return `unknown /* x-unresolved: ${String(s['x-unresolved']).replace(/\*\//g, '*\\/').slice(0, 160)} */`;
  if (typeof s.$ref === 'string') {
    const ref = s.$ref;
    const n = ref.split('/').pop()!;
    return ref.startsWith('_shared.json') ? (sharedCtx ? n : `Shared.${n}`) : n;
  }
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const alt = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (alt) return alt.map((x) => paren(tsOf(x, ind, sharedCtx))).join(' | ');
  if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as JsonSchema[]).map((x) => paren(tsOf(x, ind, sharedCtx)));
    return parts.join(' & ');
  }
  if (s.not && typeof s.not === 'object' && !Object.keys(s.not).length) return 'never';
  const t = s.type;
  if (Array.isArray(t)) return t.map((x) => tsOf({ ...s, type: x }, ind, sharedCtx)).join(' | ');
  switch (t) {
    case 'string': return 'string';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': {
      if (Array.isArray(s.prefixItems)) return `[${(s.prefixItems as JsonSchema[]).map((x) => tsOf(x, ind, sharedCtx)).join(', ')}]`;
      return `${paren(tsOf(s.items as JsonSchema, ind, sharedCtx))}[]`;
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set((s.required ?? []) as string[]);
      const inner = ind + '  ';
      const lines = Object.entries(props).map(([k, v]) => `${inner}${IDENT.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsOf(v, inner, sharedCtx)};`);
      const ap = s.additionalProperties as JsonSchema | boolean | undefined;
      if (ap !== undefined && ap !== false && !Object.keys(props).length) {
        const pn = s.propertyNames as JsonSchema | undefined;
        const keyT = pn && Array.isArray(pn.enum) ? pn.enum.map((v) => JSON.stringify(v)).join(' | ') : 'string';
        return `{ [key in ${keyT}]?: ${tsOf(ap === true ? undefined : ap, ind, sharedCtx)} }`.replace('[key in string]?', '[key: string]');
      }
      if (!lines.length) return ap === false ? 'Record<string, never>' : 'Record<string, unknown>';
      return `{\n${lines.join('\n')}\n${ind}}`;
    }
    default: return 'unknown';
  }
}

const paren = (t: string): string => (/[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) && !/^\[[\s\S]*\]$/.test(t) ? `(${t})` : t);

function renderCompat(lc: LaneContract, isShared: boolean, shared: LaneContract, lanes: Map<string, LaneContract>): string[] {
  const lane = isShared ? '_shared' : lc.lane;
  const entries = [...(STABLE_TYPE_EXPORTS[lane] ?? [])].sort((a, b) => cmp(a.name, b.name));
  const exported = new Set(Object.keys(lc.$defs));
  const out: string[] = [];
  for (const e of entries) {
    if (exported.has(e.name)) continue;
    if ('from' in e) {
      const def = e.def ?? e.name;
      if (isShared) {
        const s = shared.$defs[def];
        if (!s) throw new Error(`compat export ${lane}.${e.name}: missing shared def ${def}`);
        out.push(`/** 兼容导出：${def}（保留旧名） */`);
        out.push(`export type ${e.name} = ${tsOf(s, '', true)};`);
      } else {
        out.push(`/** 兼容导出：_shared.${def}（保留旧名） */`);
        out.push(def === e.name ? `export type { ${def} } from './_shared.ts';` : `export type { ${def} as ${e.name} } from './_shared.ts';`);
      }
    } else if ('fromLane' in e) {
      const src = lanes.get(e.fromLane);
      const s = src?.$defs[e.def];
      if (!src || !s) throw new Error(`compat export ${lane}.${e.name}: missing ${e.fromLane}.${e.def}`);
      out.push(`/** 兼容导出：${e.fromLane}.${e.def}（保留旧名） */`);
      out.push(`export type ${e.name} = ${tsOf(s, '', isShared)};`);
    } else {
      out.push(`/** 兼容导出：保留旧名 ${e.name} */`);
      out.push(`export type ${e.name} = ${e.alias};`);
    }
    exported.add(e.name);
  }
  return out;
}

export function renderTs(lc: LaneContract, isShared: boolean, generator: string, shared: LaneContract, lanes: Map<string, LaneContract>): string {
  const out: string[] = [
    '// 自动生成，勿手改：npm run contracts:extract',
    `// 生成器：${generator}；来源：contracts/ipc/${isShared ? '_shared' : lc.lane}.json`,
    '/* eslint-disable */',
  ];
  const compat = renderCompat(lc, isShared, shared, lanes);
  const body = JSON.stringify(lc);
  if (!isShared && (body.includes('_shared.json#') || compat.some((line) => line.includes('Shared.')))) out.push("import type * as Shared from './_shared.ts';");
  out.push('');
  for (const [n, s] of Object.entries(lc.$defs)) {
    out.push(`/** ${String(s['x-rust'] ?? n)} */`);
    out.push(`export type ${n} = ${tsOf(s, '', isShared)};`);
  }
  if (compat.length) {
    out.push('');
    out.push('/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */');
    out.push(...compat);
  }
  if (!isShared) {
    out.push('');
    out.push('export interface Commands {');
    for (const c of lc.commands) {
      const args = c.args.map((a) => `      ${IDENT.test(a.key) ? a.key : JSON.stringify(a.key)}${a.optional ? '?' : ''}: ${tsOf(a.schema, '      ')};`);
      if (c.rust) out.push(`  /** ${c.rust.file}:${c.rust.line} \`${c.rust.fn}\` */`);
      out.push(`  ${IDENT.test(c.name) ? c.name : JSON.stringify(c.name)}: {`);
      out.push(args.length ? `    args: {\n${args.join('\n')}\n    };` : '    args: Record<string, never>;');
      out.push(`    result: ${tsOf(c.result, '    ')};`);
      out.push(`    error: ${c.error ? tsOf(c.error, '    ') : 'never'};`);
      out.push('  };');
    }
    out.push('}');
    out.push('');
    out.push('export interface Events {');
    const evKeys = new Map<string, string[]>();
    for (const e of lc.events) {
      const key = e.dynamic ? `[name: \`${e.name.replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{[A-Za-z0-9_]*\}/g, '${string}')}\`]` : JSON.stringify(e.name);
      evKeys.set(key, [...(evKeys.get(key) ?? []), paren(tsOf(e.payload, '  '))]);
    }
    for (const [key, ts] of evKeys) out.push(`  ${key}: ${[...new Set(ts)].join(' | ')};`);
    out.push('}');
    out.push('');
    out.push(`export type CommandName = keyof Commands;`);
    for (const c of lc.commands) {
      if (!IDENT.test(c.name)) continue;
      const p = pascal(c.name);
      out.push(`export type ${p}CommandArgs = Commands['${c.name}']['args'];`);
      out.push(`export type ${p}CommandResult = Commands['${c.name}']['result'];`);
    }
  }
  return out.join('\n') + '\n';
}

// ======================================================================== 报告

function category(reason: string): string {
  if (reason.startsWith('manual `impl')) return 'manual impl Serialize/Deserialize';
  if (reason.includes('has no #[derive(')) return 'type without serde derive';
  if (reason.startsWith('external type')) return 'external type not modelled';
  if (reason.startsWith('cannot resolve type path')) return 'unresolved type path';
  if (reason.startsWith('ambiguous type path')) return 'ambiguous type path (cfg variants)';
  if (reason.startsWith('payload type of')) return 'event payload type not determinable';
  if (reason.startsWith('json! value')) return 'json! payload value type not determinable';
  if (reason.includes('serialize_with') || reason.includes('deserialize_with')) return 'custom serialize_with/deserialize_with';
  if (reason.startsWith('unsupported type syntax')) return 'unsupported type syntax (impl/dyn Trait, …)';
  if (reason.startsWith('unbound generic')) return 'generic parameter';
  if (reason.includes('internally tagged')) return 'internally tagged enum edge case';
  if (reason.startsWith('map key type')) return 'non-string map key';
  if (reason.includes('flatten')) return 'flatten edge case';
  if (reason.includes('payload is parameter')) return 'event payload from wrapper parameter';
  return reason.replace(/`[^`]*`/g, '`…`').slice(0, 80);
}

function renderReports(ex: Extraction, lcs: Map<string, LaneContract>, names: Map<string, string>, finalId: (k: string) => string, finals: Map<string, DefInstance>, generator: string) {
  const { sb } = ex;
  const loc = (u: UnresItem): string => `${u.file}:${u.line}`;
  const catCount = new Map<string, number>();
  const lines: string[] = [];
  const sumRows: string[] = [];
  let totC = 0, totCR = 0, totE = 0, totER = 0, totS = 0;
  const lanesSorted = [...lcs.keys()].sort(cmp);
  const laneSections: string[] = [];
  const seenItems = new Set<string>();
  const countItem = (u: UnresItem): void => {
    const k = `${u.file}:${u.line}:${u.reason}`;
    if (seenItems.has(k)) return;
    seenItems.add(k);
    catCount.set(category(u.reason), (catCount.get(category(u.reason)) ?? 0) + 1);
  };
  for (const lane of lanesSorted) {
    const cmds = ex.commands.filter((c) => c.lane === lane);
    const evNames = lcs.get(lane)!.events.map((e) => e.name);
    const evs = ex.events.filter((e) => evNames.includes(e.record.name));
    const typeItems = new Map<string, { name: string; rust: string; items: UnresItem[] }>();
    const cmdLines: string[] = [];
    let cr = 0;
    for (const c of cmds) {
      const u = unresolvedOf(sb, c.owner);
      if (!u.direct.length && !u.viaDefs.length) { cr++; continue; }
      cmdLines.push(`- \`${c.name}\` — ${c.fn.loc.file}:${c.attrLine}`);
      for (const d of u.direct) { cmdLines.push(`  - ${d.reason} (${loc(d)})`); countItem(d); }
      for (const v of u.viaDefs) {
        const n = names.get(finalId(v.inst.key))!;
        cmdLines.push(`  - 经由类型 \`${n}\``);
        typeItems.set(n, { name: n, rust: v.inst.rustName, items: v.items });
      }
    }
    const evLines: string[] = [];
    const evResolved = new Set<string>();
    const evUnres = new Set<string>();
    for (const e of evs) {
      const u = unresolvedOf(sb, e.owner);
      if (!u.direct.length && !u.viaDefs.length) { continue; }
      evUnres.add(e.record.name);
      evLines.push(`- \`${e.record.name}\` — ${e.record.file}:${e.record.line}（${e.record.fn.name}）`);
      for (const d of u.direct) { evLines.push(`  - ${d.reason} (${loc(d)})`); countItem(d); }
      for (const v of u.viaDefs) {
        const n = names.get(finalId(v.inst.key))!;
        evLines.push(`  - 经由类型 \`${n}\``);
        typeItems.set(n, { name: n, rust: v.inst.rustName, items: v.items });
      }
    }
    for (const n of evNames) if (!evUnres.has(n)) evResolved.add(n);
    const skipped = ex.skippedEmits.filter((s) => s.lane === lane).sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
    for (const t of typeItems.values()) for (const i of t.items) countItem(i);
    totC += cmds.length; totCR += cr; totE += evNames.length; totER += evResolved.size; totS += skipped.length;
    const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
    sumRows.push(`| ${lane} | ${cmds.length} | ${cr} | ${pct(cr, cmds.length)} | ${evNames.length} | ${evResolved.size} | ${skipped.length} |`);
    if (!cmdLines.length && !evLines.length && !skipped.length) continue;
    const sec: string[] = [`## ${lane}`, '', `命令未完全解析 ${cmds.length - cr}/${cmds.length}；事件未完全解析 ${evUnres.size}/${evNames.length}；未计入契约的 emit ${skipped.length}。`, ''];
    if (cmdLines.length) sec.push('### 命令', '', ...cmdLines, '');
    if (evLines.length) sec.push('### 事件', '', ...evLines, '');
    if (typeItems.size) {
      sec.push('### 类型', '');
      for (const t of [...typeItems.values()].sort((a, b) => cmp(a.name, b.name))) {
        sec.push(`- \`${t.name}\`（\`${t.rust}\`）`);
        for (const i of t.items) sec.push(`  - ${i.reason} (${loc(i)})`);
      }
      sec.push('');
    }
    if (skipped.length) {
      sec.push('### 未计入契约的 emit（事件名无法静态确定或接收者无法确认是 tauri Emitter）', '');
      for (const s of skipped) sec.push(`- ${s.file}:${s.line}（${s.fn}）：${s.reason}`);
      sec.push('');
    }
    laneSections.push(sec.join('\n'));
  }
  for (const s of ex.skippedEmits) catCount.set(`emit skipped: ${s.reason.startsWith('receiver') ? 'receiver/name not static' : s.reason.startsWith('call to emit wrapper') ? 'wrapper call with dynamic name' : 'dynamic event name'}`, (catCount.get(`emit skipped: ${s.reason.startsWith('receiver') ? 'receiver/name not static' : s.reason.startsWith('call to emit wrapper') ? 'wrapper call with dynamic name' : 'dynamic event name'}`) ?? 0) + 1);

  lines.push('# IPC 契约未解析清单', '', `由 \`npm run contracts:extract\` 生成（${generator}），勿手改。每一项都需要人工核对 Rust 源码后补齐。`, '');
  lines.push('## 分类计数', '', '| 类别 | 条数 |', '|---|---|');
  for (const [k, v] of [...catCount.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push(...laneSections);
  const unresolvedMd = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

  // ---------- SUMMARY
  const inv = ex.inventory;
  const contractKeys = new Set(ex.commands.map((c) => `${c.lane}|${c.name}`));
  const invMissing = inv.filter((c) => !contractKeys.has(`${c.lane}|${c.name}`));
  const inactiveByLoc = new Map(ex.inactiveCommands.map((c) => [`${c.file}:${c.line}`, c]));
  const invCovered = inv.length - invMissing.length;
  const extra = ex.commands.filter((c) => !c.inInventory);
  const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const s: string[] = [
    '# IPC 契约汇总', '', `由 \`npm run contracts:extract\` 生成（${generator}），勿手改。`, '',
    '## 覆盖', '',
    `- inventory 命令条目：${inv.length}；有契约的：${invCovered}（按 lane + 命令名匹配）。`,
    `- 契约命令：${totC}；完全解析（参数、结果、错误及其引用的全部类型都没有 x-unresolved）：${totCR}（${pct(totCR, totC)}）。`,
    `- 事件：${totE} 个名字，其中 payload 完全解析 ${totER}（${pct(totER, totE)}）；未计入契约的 emit 调用 ${totS} 处（见 UNRESOLVED.md）。`,
    `- 类型定义：${finals.size} 个（ser/de 形状相同的已合并）。`,
    '',
  ];
  if (invMissing.length) {
    s.push('### inventory 中没有对应契约的条目', '');
    for (const c of invMissing) s.push(`- \`${c.name}\` ${c.file}:${c.line}（${c.lane}）${inactiveByLoc.has(`${c.file}:${c.line + 1}`) || inactiveByLoc.has(`${c.file}:${c.line}`) ? '' : ''}`);
    s.push('');
  }
  const inactiveInv = inv.filter((c) => [...ex.inactiveCommands].some((i) => i.file === c.file && i.name === c.name && Math.abs(i.line - c.line) <= 3));
  if (inactiveInv.length) {
    s.push('### 桌面默认 feature 下被 cfg 排除的命令变体（同名的启用变体已有契约）', '');
    for (const c of inactiveInv) s.push(`- \`${c.name}\` ${c.file}:${c.line}`);
    s.push('');
  }
  if (extra.length) {
    s.push('### inventory 未收录、但源码中确有 `#[tauri::command]` 的命令', '', 'inventory.mjs 的正则不允许属性之间夹 `//` 注释，以下命令被它漏掉；契约照常生成并标 `x-not-in-inventory`。', '');
    for (const c of extra) s.push(`- \`${c.name}\` ${c.fn.loc.file}:${c.attrLine}（${c.lane}）`);
    s.push('');
  }
  const unregistered = ex.commands.filter((c) => c.registered === false);
  if (unregistered.length) {
    s.push('### Rust 定义了 `#[tauri::command]` 但未列入 `generate_handler!` 的命令', '',
      '在 Tauri 版里前端调用这些命令会得到 "command not found"；契约照常生成并标 `x-rust-registered: false`。该标记只描述 Rust 原状，Host 是否实现另由插件注册决定。', '');
    for (const c of unregistered) s.push(`- \`${c.name}\` ${c.fn.loc.file}:${c.attrLine}（${c.lane}，前端：${c.frontend}）`);
    s.push('');
  }
  if (ex.hostNative) {
    s.push('### Host 内核自有的命令与事件（非 Rust）', '',
      `来自 \`scripts/electron-migration/contracts/host-native.json\`，写入 \`${ex.hostNative.lane}.json\` 的 \`hostNative\` 段（\`x-host-native: true\`）；不计入上面的命令/事件统计，kernel 也不按它们做参数校验。`, '');
    for (const c of ex.hostNative.commands) s.push(`- 命令 \`${c.name}\`（${c.host.file} \`${c.host.const}\`）`);
    for (const e of ex.hostNative.events) s.push(`- 事件 \`${e.name}\`（${e.host.file} \`${e.host.const}\`）`);
    s.push('');
  }
  s.push('## 按 lane', '', '| lane | 命令 | 完全解析 | 比例 | 事件 | 事件已解析 | 未计入的 emit |', '|---|---|---|---|---|---|---|', ...sumRows, `| **合计** | ${totC} | ${totCR} | ${pct(totCR, totC)} | ${totE} | ${totER} | ${totS} |`, '');
  s.push('## 约定', '',
    '- `x-option: "null"`：`Option` 缺值输出 `null`；`"omit"`：`skip_serializing_if = "Option::is_none"`，缺值不出现该键。',
    '- `x-int` / `x-float`：原 Rust 数值类型；`u64`/`i64` 超过 2^53 时 serde_json 仍输出整数字面量。浮点 NaN/∞ 被 serde_json 输出为 `null`（与 `JSON.stringify` 相同）。',
    '- `x-skip-serializing-if`：该字段按谓词可能不出现（非 `Option::is_none` 的谓词）。`x-aliases`：反序列化接受的别名键。',
    '- `x-key-order: "unspecified"`：HashMap 序列化键序不确定（AGENTS.md：禁止对其序列化结果做哈希/比对）。',
    '- 命令参数中的 `ipc::Channel<T>`：前端按 key 传 `"__CHANNEL__:<id>"`（tauri ipc/channel.rs），同时出现在 `args`（字符串校验）与 `injected`（`kind: "channel"`，`schema` 为推送消息的 payload，附 `key`/`rustName`）。',
    '- `x-platforms`：命令只在部分桌面平台编译（cfg）。`x-not-in-inventory`、`x-rust-registered: false`、`hostNative` / `x-host-native`：见上。',
    '- 事件 `emitters[].via`：经项目内包装函数发出；`note`：接收者类型未能推断，因事件名为静态字面量而计入。',
    '- 结果用 `serde_json::to_string`、错误用 `serde_json::to_value` 序列化（tauri ipc/mod.rs）；`tauri::Error` 错误为 Display 文本。',
    '- 反序列化方向：`Option<T>` 参数/字段可省略；外部标签全单元枚举另接受 `{"Variant": null}`（`x-also-accepts`）。',
    '');
  const summaryMd = s.join('\n') + '\n';
  const summary = `commands ${totC} (fully resolved ${totCR}, ${pct(totCR, totC)}); inventory covered ${invCovered}/${inv.length}; events ${totE} (resolved ${totER}); skipped emits ${totS}; defs ${finals.size}`;
  void semText;
  return { unresolvedMd, summaryMd, summary };
}
