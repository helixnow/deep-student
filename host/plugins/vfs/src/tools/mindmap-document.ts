/** builtin_resource_executor.rs:2056-2253,2424-2490. */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { parseSerdeJson } from '../../repository/json.ts';
export const recordOf = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const valueString = (value: unknown): string | null => typeof value === 'string' ? value : null;
const childNodes = (node: unknown): unknown[] => { const children = recordOf(node)?.children; return Array.isArray(children) ? children : []; };
export function fixMindmapNode(value: unknown, log: Context['logger'], depth = 0): void {
  if (depth > 100) { log.warn('[BuiltinResourceExecutor] Mindmap node depth exceeds limit (%d), truncating', 100); return; }
  const node = recordOf(value);
  if (node === null) return;
  if (typeof node.text !== 'string' || node.text === '') {
    const key = ['name', 'label', 'title', 'value', 'content'].find(key => Object.hasOwn(node, key));
    node.text = key === undefined ? '未命名' : node[key];
  }
  if (!Object.hasOwn(node, 'children')) node.children = [];
  for (const child of childNodes(node)) fixMindmapNode(child, log, depth + 1);
}
export function sanitizeMindmapAssociations(value: unknown, log: Context['logger']): void {
  const doc = recordOf(value);
  if (doc === null || !Object.hasOwn(doc, 'root')) return;
  const ids = new Set<string>();
  const collect = (value: unknown, depth: number) => {
    if (depth > 100) return;
    const node = recordOf(value), id = valueString(node?.id);
    if (id !== null && rustTrim(id) !== '') ids.add(id);
    for (const child of childNodes(value)) collect(child, depth + 1);
  };
  collect(doc.root, 0);
  if (!Object.hasOwn(doc, 'associations')) return;
  const raw = doc.associations; delete doc.associations;
  if (!Array.isArray(raw)) { log.warn('[BuiltinResourceExecutor] mindmap associations is not an array; dropping field'); return; }
  const cleaned: Record<string, unknown>[] = [], used = new Set<string>();
  let generated = 0;
  for (const value of raw) {
    const item = recordOf(value), source = rustTrim(valueString(item?.source) ?? ''), target = rustTrim(valueString(item?.target) ?? '');
    if (source === '' || target === '' || source === target || !ids.has(source) || !ids.has(target)) continue;
    let id = rustTrim(valueString(item?.id) ?? '');
    while (id === '' || used.has(id)) id = `assoc_g${++generated}`;
    used.add(id);
    const assoc: Record<string, unknown> = { id, source, target }, label = rustTrim(valueString(item?.label) ?? '');
    if (label !== '') assoc.label = label;
    if (recordOf(item?.style) !== null) assoc.style = structuredClone(item!.style);
    cleaned.push(assoc);
  }
  if (cleaned.length > 0) doc.associations = cleaned;
}
export function fixMindmapContent(content: string, log: Context['logger']): string {
  let value: unknown;
  try { value = parseSerdeJson(content); }
  catch (error) { log.warn('[BuiltinResourceExecutor] Failed to parse mindmap content for fixing: %s', error instanceof Error ? error.message : String(error)); return content; }
  const doc = recordOf(value);
  if (doc !== null) {
    if (Object.hasOwn(doc, 'root')) fixMindmapNode(doc.root, log);
    if (!Object.hasOwn(doc, 'version')) doc.version = '1.0';
    if (!Object.hasOwn(doc, 'meta')) doc.meta = { createdAt: '' };
    sanitizeMindmapAssociations(doc, log);
  }
  return JSON.stringify(value);
}
export function parseMindmapDocument(content: string): Record<string, unknown> {
  let value: unknown;
  try { value = parseSerdeJson(content); }
  catch (error) { throw new Error(`Invalid mindmap JSON content: ${error instanceof Error ? error.message : String(error)}`); }
  const doc = recordOf(value);
  if (doc === null || !Object.hasOwn(doc, 'root')) throw new Error('Mindmap document missing required `root` field');
  return doc;
}
export interface MindmapNodeSnapshot { id: string; text: string; parentId: string | null; path: string; signature: string }
export function collectMindmapNodes(value: unknown, parentId: string | null, path: string, output: Map<string, MindmapNodeSnapshot>): void {
  const node = recordOf(value), text = valueString(node?.text) ?? '未命名节点', rawId = valueString(node?.id) ?? `path:${path}`;
  let id = rawId, index = 2;
  while (output.has(id)) id = `${rawId}#${index++}`;
  // The Rust signature is a fixed JSON object, not serialization of the HashMap.
  const signature = JSON.stringify({ text: node?.text ?? null, note: node?.note ?? null, collapsed: node?.collapsed ?? null,
    completed: node?.completed ?? null, style: node?.style ?? null, blankedRanges: node?.blankedRanges ?? null, refs: node?.refs ?? null });
  output.set(id, { id, text, parentId, path, signature });
  for (const child of childNodes(value)) collectMindmapNodes(child, id, `${path}/${valueString(recordOf(child)?.text) ?? '未命名节点'}`, output);
}
