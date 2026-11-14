// 读取 F5 生成的 contracts/ipc/*.json（格式见 host/kernel/contract.ts），按命令名索引。
// 契约文件可能尚未生成：此时返回空索引，调用方显示"契约未生成"。
import path from 'node:path';
import { readHead, trackedFiles } from './git-source.mjs';

/** 读取 HEAD 中已提交的契约（与 CI 检出一致）。 */
export function loadContracts() {
  const commands = new Map();
  const events = new Map();
  const files = new Map();
  const names = trackedFiles(['contracts/ipc']).filter((p) => /^contracts\/ipc\/[^/]+\.json$/.test(p) && !path.posix.basename(p).startsWith('_'));
  for (const [p, text] of readHead(names)) {
    const doc = JSON.parse(text);
    if (!doc || !Array.isArray(doc.commands)) continue;
    files.set(doc.lane ?? path.posix.basename(p, '.json'), p);
    for (const c of doc.commands) commands.set(c.name, { ...c, contractFile: p });
    for (const e of doc.events ?? []) events.set(e.name, { ...e, contractFile: p });
  }
  return { commands, events, files };
}

/** JSON Schema 的一行摘要。 */
export function schemaSummary(s, depth = 0) {
  if (!s || typeof s !== 'object') return '?';
  if (s['x-unresolved']) return `UNRESOLVED(${s['x-unresolved']})`;
  if (s.$ref) return String(s.$ref).split('/').pop();
  if (s['x-rust'] && depth > 0) return String(s['x-rust']).split('::').pop();
  if (Array.isArray(s.anyOf ?? s.oneOf)) return (s.anyOf ?? s.oneOf).map((x) => schemaSummary(x, depth + 1)).join(' | ');
  if (s.type === 'array') return `${schemaSummary(s.items, depth + 1)}[]`;
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type === 'object' && s.properties && depth === 0) {
    const keys = Object.keys(s.properties);
    return `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`;
  }
  if (s.enum) return s.enum.map((x) => JSON.stringify(x)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  const t = s.type ?? (s['x-rust'] ? String(s['x-rust']).split('::').pop() : 'any');
  return s['x-int'] ? `${t}(${s['x-int']})` : String(t);
}

/** 契约中是否存在 x-unresolved（任意深度）。 */
export function hasUnresolved(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(hasUnresolved);
  if ('x-unresolved' in v) return true;
  return Object.values(v).some(hasUnresolved);
}

export function commandContractSummary(c) {
  const args = c.args.map((a) => `${a.key}${a.optional ? '?' : ''}: ${schemaSummary(a.schema, 1)}`).join(', ');
  const injected = (c.injected ?? []).map((i) => i.kind).join(', ');
  return {
    args: args || '（无）',
    result: schemaSummary(c.result, 1),
    error: c.error ? schemaSummary(c.error, 1) : null,
    injected: injected || null,
    renameAll: c.renameAll ?? null,
    unresolved: hasUnresolved(c),
  };
}
