/** builtin_resource_executor.rs:2740-2788,2918-3187,3494-3602,4237-4265. */
import { rustTrim, rustTrimStart } from '../../../../platform/util/portable.ts';
import { utf8Decode } from '../../../../platform/crypto/encoding.ts';
import type { ZipReader } from '../../../../platform/zip/core/index.ts';
import { parseSerdeJson } from '../../repository/json.ts';
import { recordOf, valueString } from './mindmap-document.ts';
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export interface ImportStats { nodeCount: number; droppedImages: number; droppedSummaries: number; droppedBoundaries: number; droppedHyperlinks: number }
export const newImportStats = (): ImportStats => ({ nodeCount: 0, droppedImages: 0, droppedSummaries: 0, droppedBoundaries: 0, droppedHyperlinks: 0 });
export type ImportNode = Record<string, unknown>;
export interface ImportCounter { value: number }
export function claimNode(stats: ImportStats, depth: number): void {
  if (depth > 100) throw new Error('导入内容层级过深，超过最大限制（100 层）');
  if (++stats.nodeCount > 10_000) throw new Error('导入节点数超过最大限制（10000）');
}
export const allocId = (counter: ImportCounter, root = false) => root ? 'root' : `n${++counter.value}`;
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, ch => ch.toLowerCase());
export function stripHtmlTags(text: string): string {
  let output = '', inTag = false;
  for (const ch of text) { if (ch === '<') inTag = true; else if (ch === '>') inTag = false; else if (!inTag) output += ch; }
  return rustTrim(output);
}
export function detectImportFormat(name: string, bytes: Uint8Array): string {
  const dot = name.lastIndexOf('.'), ext = dot < 0 ? '' : asciiLower(name.slice(dot + 1));
  if (['xmind', 'mmap', 'opml', 'mm', 'json'].includes(ext)) return ext;
  if (ext === 'md' || ext === 'markdown') return 'markdown'; if (ext === 'txt') return 'text';
  if (bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4) return 'zip';
  const head = rustTrimStart(utf8Decode(bytes.subarray(0, 2048)));
  if (head.startsWith('{')) return 'json';
  if (head.startsWith('<')) { const lower = asciiLower(head); return lower.includes('<opml') ? 'opml' : lower.includes('<map') ? 'mm' : 'opml'; }
  return 'markdown';
}
export async function readImportZipEntry(archive: ZipReader, name: string): Promise<string | null> {
  let entry;
  try { entry = archive.find(name) ?? null; } catch (error) { throw new Error(`Failed to read zip entry '${name}': ${error instanceof Error ? error.message : String(error)}`); }
  if (entry === null) return null;
  const oversized = `zip 条目 '${name}' 超过解压大小上限（32 MB）`;
  if (entry.size > MAX_IMPORT_BYTES) throw new Error(oversized);
  let bytes;
  try { bytes = await archive.readEntry(entry); }
  catch (error) { throw new Error(`Failed to decompress zip entry '${name}': ${error instanceof Error ? error.message : String(error)}`); }
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error(oversized);
  return utf8Decode(bytes);
}
export type ImportLink = [string, string, string | null];
export function remapAssociations(links: ImportLink[], ids: Map<string, string>): ImportNode[] {
  const result: ImportNode[] = [];
  for (const [start, end, text] of links) {
    const source = ids.get(start), target = ids.get(end);
    if (source === undefined || target === undefined || source === target) continue;
    const label = text === null ? '' : rustTrim(text);
    result.push({ id: `assoc_${result.length + 1}`, source, target, ...(label === '' ? {} : { label }) });
  }
  return result;
}
export function parseOutline(text: string, fallback: string, stats: ImportStats): ImportNode {
  const counter = { value: 0 }, items: Array<[number, ImportNode]> = [];
  let heading: number | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (rustTrim(raw) === '') continue;
    let width = 0;
    for (const ch of raw) { if (ch === ' ') width++; else if (ch === '\t') width += 2; else break; }
    const content = rustTrimStart(raw), hashes = /^#+/.exec(content)?.[0].length ?? 0;
    if (hashes >= 1 && hashes <= 6 && content[hashes] === ' ') {
      const depth = hashes - 1; claimNode(stats, depth);
      items.push([depth, { id: allocId(counter), text: rustTrim(content.slice(hashes)) || '未命名主题', children: [] }]); heading = depth; continue;
    }
    let rest = content, list = false;
    for (const bullet of ['- ', '* ', '+ ', '• ', '‣ ', '◦ ']) if (rest.startsWith(bullet)) { rest = rest.slice(bullet.length); list = true; break; }
    if (!list) { const match = /^\d+[.)] /.exec(rest); if (match !== null) { rest = rest.slice(match[0].length); list = true; } }
    let completed: boolean | null = null;
    if (list && rest.startsWith('[ ] ')) { completed = false; rest = rest.slice(4); }
    else if (list && (rest.startsWith('[x] ') || rest.startsWith('[X] '))) { completed = true; rest = rest.slice(4); }
    const value = rustTrim(rest); if (value === '') continue;
    const depth = (heading === null ? 0 : heading + 1) + Math.floor(width / 2); claimNode(stats, depth);
    items.push([depth, { id: allocId(counter), text: value, children: [], ...(completed === null ? {} : { completed }) }]);
  }
  if (items.length === 0) throw new Error('导入内容为空：没有解析到任何大纲条目');
  const top: ImportNode[] = [], stack: Array<[number, ImportNode]> = [];
  const attach = (node: ImportNode) => { const parent = stack.at(-1); if (parent) (parent[1].children as ImportNode[]).push(node); else top.push(node); };
  for (const [depth, node] of items) { while (stack.length > 0 && stack.at(-1)![0] >= depth) attach(stack.pop()![1]); stack.push([depth, node]); }
  while (stack.length > 0) attach(stack.pop()![1]);
  if (top.length === 1) { top[0]!.id = 'root'; return top[0]!; }
  claimNode(stats, 0); return { id: 'root', text: fallback, children: top };
}
export function validateJsonNode(value: unknown, depth: number, stats: ImportStats, counter: ImportCounter): void {
  claimNode(stats, depth); const node = recordOf(value);
  if (node === null) throw new Error('无效的导图 JSON：节点必须是对象');
  if (typeof node.id !== 'string' || rustTrim(node.id) === '') node.id = allocId(counter, depth === 0);
  if (Array.isArray(node.children)) for (const child of node.children) validateJsonNode(child, depth + 1, stats, counter);
}
export function xmindJsonTopic(value: unknown, depth: number, stats: ImportStats, counter: ImportCounter, ids: Map<string, string>, root: boolean): ImportNode {
  claimNode(stats, depth); const topic = recordOf(value) ?? {}, id = allocId(counter, root), original = valueString(topic.id);
  if (original !== null && !ids.has(original)) ids.set(original, id);
  if (Object.hasOwn(topic, 'image')) stats.droppedImages++;
  if (rustTrim(valueString(topic.href) ?? '') !== '') stats.droppedHyperlinks++;
  const child = recordOf(topic.children), summaries = Array.isArray(topic.summaries) ? topic.summaries : child?.summary;
  if (Array.isArray(summaries)) stats.droppedSummaries += summaries.length;
  if (Array.isArray(topic.boundaries)) stats.droppedBoundaries += topic.boundaries.length;
  const text = rustTrim(valueString(topic.title) ?? '') || '未命名主题';
  const notes = recordOf(topic.notes), plain = rustTrim(valueString(recordOf(notes?.plain)?.content) ?? '');
  const note = plain || stripHtmlTags(valueString(recordOf(notes?.html)?.content) ?? '');
  let completed: boolean | null = null;
  if (Array.isArray(topic.markers)) for (const marker of topic.markers) {
    const id = valueString(recordOf(marker)?.markerId); if (id?.startsWith('task-')) { completed = id === 'task-done'; break; }
  }
  const children = Array.isArray(child?.attached) ? child.attached.map(child => xmindJsonTopic(child, depth + 1, stats, counter, ids, false)) : [];
  return { id, text, children, ...(note === '' ? {} : { note }), ...(completed === null ? {} : { completed }) };
}
export function parseXmindJson(text: string, fallback: string, stats: ImportStats): [ImportNode, ImportNode[]] {
  let raw: unknown;
  try { raw = parseSerdeJson(text); } catch (error) { throw new Error(`无效的 .xmind content.json: ${error instanceof Error ? error.message : String(error)}`); }
  const sheets = (Array.isArray(raw) ? raw : [raw]).map(recordOf).filter(sheet => sheet !== null && recordOf(sheet.rootTopic) !== null);
  if (sheets.length === 0) throw new Error('无效的 .xmind：缺少根主题');
  const links: ImportLink[] = [], counter = { value: 0 }, ids = new Map<string, string>();
  for (const sheet of sheets) if (Array.isArray(sheet!.relationships)) for (const raw of sheet!.relationships) {
    const rel = recordOf(raw), start = valueString(rel?.end1Id), end = valueString(rel?.end2Id);
    if (start !== null && end !== null) links.push([start, end, valueString(rel?.title)]);
  }
  let root: ImportNode;
  if (sheets.length === 1) root = xmindJsonTopic(sheets[0]!.rootTopic, 0, stats, counter, ids, true);
  else { claimNode(stats, 0); root = { id: 'root', text: fallback, note: `合并自 ${sheets.length} 个 .xmind 画布`,
    children: sheets.map(sheet => xmindJsonTopic(sheet!.rootTopic, 1, stats, counter, ids, false)) }; }
  return [root, remapAssociations(links, ids)];
}
