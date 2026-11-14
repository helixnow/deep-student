import type { JsonSchema, LaneContract } from '../../host/kernel/contract.ts';
import { STABLE_TYPE_EXPORTS } from './type-exports.ts';

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const pascal = (s: string): string => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join('');
const paren = (t: string): string => /[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) && !/^\[[\s\S]*\]$/.test(t) ? `(${t})` : t;

/** JSON Schema → IPC 类型；不读取任何实现源码。 */
function tsOf(s: JsonSchema | boolean | undefined, ind: string, sharedCtx = false): string {
  if (s === undefined || s === true) return 'unknown';
  if (s === false) return 'never';
  if (s['x-unresolved']) return `unknown /* x-unresolved: ${String(s['x-unresolved']).replace(/\*\//g, '*\\/').slice(0, 160)} */`;
  if (typeof s.$ref === 'string') {
    const n = s.$ref.split('/').pop()!;
    return s.$ref.startsWith('_shared.json') ? (sharedCtx ? n : `Shared.${n}`) : n;
  }
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join(' | ');
  const alt = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  if (alt) return alt.map(x => paren(tsOf(x, ind, sharedCtx))).join(' | ');
  if (Array.isArray(s.allOf)) return (s.allOf as JsonSchema[]).map(x => paren(tsOf(x, ind, sharedCtx))).join(' & ');
  if (s.not && typeof s.not === 'object' && !Object.keys(s.not).length) return 'never';
  const t = s.type;
  if (Array.isArray(t)) return t.map(x => tsOf({ ...s, type: x }, ind, sharedCtx)).join(' | ');
  switch (t) {
    case 'string': return 'string';
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array':
      if (Array.isArray(s.prefixItems)) return `[${(s.prefixItems as JsonSchema[]).map(x => tsOf(x, ind, sharedCtx)).join(', ')}]`;
      return `${paren(tsOf(s.items as JsonSchema, ind, sharedCtx))}[]`;
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set((s.required ?? []) as string[]);
      const inner = ind + '  ';
      const lines = Object.entries(props).map(([k, v]) => `${inner}${IDENT.test(k) ? k : JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${tsOf(v, inner, sharedCtx)};`);
      const ap = s.additionalProperties as JsonSchema | boolean | undefined;
      if (ap !== undefined && ap !== false && !Object.keys(props).length) {
        const pn = s.propertyNames as JsonSchema | undefined;
        const keyT = pn && Array.isArray(pn.enum) ? pn.enum.map(v => JSON.stringify(v)).join(' | ') : 'string';
        return `{ [key in ${keyT}]?: ${tsOf(ap === true ? undefined : ap, ind, sharedCtx)} }`.replace('[key in string]?', '[key: string]');
      }
      if (!lines.length) return ap === false ? 'Record<string, never>' : 'Record<string, unknown>';
      return `{\n${lines.join('\n')}\n${ind}}`;
    }
    default: return 'unknown';
  }
}

function renderCompat(lc: LaneContract, isShared: boolean, shared: LaneContract, lanes: Map<string, LaneContract>): string[] {
  const lane = isShared ? '_shared' : lc.lane;
  const entries = [...(STABLE_TYPE_EXPORTS[lane] ?? [])].sort((a, b) => cmp(a.name, b.name));
  const exported = new Set(Object.keys(lc.$defs));
  const out: string[] = [];
  for (const e of entries) {
    if (exported.has(e.name)) continue;
    if ('from' in e) {
      const def = e.def ?? e.name;
      if (!shared.$defs[def]) throw new Error(`compat export ${lane}.${e.name}: missing shared def ${def}`);
      if (isShared) {
        out.push(`/** 兼容导出：${def}（保留旧名） */`);
        out.push(`export type ${e.name} = ${tsOf(shared.$defs[def], '', true)};`);
      } else {
        out.push(`/** 兼容导出：_shared.${def}（保留旧名） */`);
        out.push(def === e.name ? `export type { ${def} } from './_shared.ts';` : `export type { ${def} as ${e.name} } from './_shared.ts';`);
      }
    } else if ('fromLane' in e) {
      const s = lanes.get(e.fromLane)?.$defs[e.def];
      if (!s) throw new Error(`compat export ${lane}.${e.name}: missing ${e.fromLane}.${e.def}`);
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
  const out = [
    '// 自动生成，勿手改：npm run contracts:generate',
    `// 生成器：${generator}；来源：contracts/ipc/${isShared ? '_shared' : lc.lane}.json`,
    '/* eslint-disable */',
  ];
  const compat = renderCompat(lc, isShared, shared, lanes);
  if (!isShared && (JSON.stringify(lc).includes('_shared.json#') || compat.some(line => line.includes('Shared.')))) out.push("import type * as Shared from './_shared.ts';");
  out.push('');
  for (const [n, s] of Object.entries(lc.$defs)) {
    out.push(`/** ${String(s['x-rust'] ?? n)} */`);
    out.push(`export type ${n} = ${tsOf(s, '', isShared)};`);
  }
  if (compat.length) out.push('', '/* ---------- 历史导出名（兼容既有 import，勿删） ---------- */', ...compat);
  if (!isShared) {
    out.push('', 'export interface Commands {');
    for (const c of lc.commands) {
      const args = c.args.map(a => `      ${IDENT.test(a.key) ? a.key : JSON.stringify(a.key)}${a.optional ? '?' : ''}: ${tsOf(a.schema, '      ')};`);
      if (c.source) out.push(`  /** ${c.source} */`);
      else if (c.rust) out.push(`  /** ${c.rust.file}:${c.rust.line} \`${c.rust.fn}\` */`);
      out.push(`  ${IDENT.test(c.name) ? c.name : JSON.stringify(c.name)}: {`);
      out.push(args.length ? `    args: {\n${args.join('\n')}\n    };` : '    args: Record<string, never>;');
      out.push(`    result: ${tsOf(c.result, '    ')};`);
      out.push(`    error: ${c.error ? tsOf(c.error, '    ') : 'never'};`, '  };');
    }
    out.push('}', '', 'export interface Events {');
    const evKeys = new Map<string, string[]>();
    for (const e of lc.events) {
      const key = e.dynamic ? `[name: \`${e.name.replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\{[A-Za-z0-9_]*\}/g, '${string}')}\`]` : JSON.stringify(e.name);
      evKeys.set(key, [...(evKeys.get(key) ?? []), paren(tsOf(e.payload, '  '))]);
    }
    for (const [key, ts] of evKeys) out.push(`  ${key}: ${[...new Set(ts)].join(' | ')};`);
    out.push('}', '', 'export type CommandName = keyof Commands;');
    for (const c of lc.commands) {
      if (!IDENT.test(c.name)) continue;
      out.push(`export type ${pascal(c.name)}CommandArgs = Commands['${c.name}']['args'];`);
      out.push(`export type ${pascal(c.name)}CommandResult = Commands['${c.name}']['result'];`);
    }
  }
  return out.join('\n') + '\n';
}
