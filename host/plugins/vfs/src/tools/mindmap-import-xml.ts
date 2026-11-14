/** builtin_resource_executor.rs:3193-3487,3604-3717,3820-3956. */
import { rustTrim } from '../../../../platform/util/portable.ts';
import { allocId, asciiLower, claimNode, remapAssociations, type ImportCounter, type ImportLink, type ImportNode, type ImportStats } from './mindmap-import-formats.ts';
/** Parser boundary must preserve roxmltree local names, namespaces and text-node order. */
export interface MindmapXmlNode {
  kind: 'element' | 'text' | 'other';
  localName: string;
  attributes: Array<{ localName: string; namespace: string | null; value: string }>;
  children: MindmapXmlNode[];
  text: string | null;
}
export interface MindmapXmlParser { parse(text: string): MindmapXmlNode }
const elements = (node: MindmapXmlNode, name: string) => node.children.filter(child => child.kind === 'element' && asciiLower(child.localName) === asciiLower(name));
function* descendants(node: MindmapXmlNode): Generator<MindmapXmlNode> { yield node; for (const child of node.children) yield* descendants(child); }
const attr = (node: MindmapXmlNode, name: string) => node.attributes.find(attr => attr.namespace === null && attr.localName === name)?.value ?? null;
const text = (node: MindmapXmlNode | undefined) => node?.kind === 'text' ? node.text : node?.children[0]?.kind === 'text' ? node.children[0].text : null;
function parse(parser: MindmapXmlParser, xml: string, prefix: string): MindmapXmlNode {
  try { return parser.parse(xml); } catch (error) { throw new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`); }
}
export function parseOpml(parser: MindmapXmlParser, xml: string, fallback: string, stats: ImportStats): ImportNode {
  const doc = parse(parser, xml, 'OPML 解析失败'), body = [...descendants(doc)].find(n => n.kind === 'element' && asciiLower(n.localName) === 'body');
  if (!body) throw new Error('无效的 OPML：缺少 body 元素');
  const outlines = elements(body, 'outline'); if (outlines.length === 0) throw new Error('无效的 OPML：没有 outline 元素');
  const counter = { value: 0 };
  const convert = (node: MindmapXmlNode, depth: number): ImportNode => {
    claimNode(stats, depth);
    const title = rustTrim(attr(node, 'text') ?? attr(node, 'title') ?? '') || '未命名主题';
    const note = rustTrim(attr(node, '_note') ?? attr(node, 'note') ?? '');
    const complete = attr(node, '_complete'), status = attr(node, '_status');
    const completed = complete === 'true' ? true : complete === 'false' ? false : status === 'checked' ? true : status === 'unchecked' ? false : null;
    const children = elements(node, 'outline').map(child => convert(child, depth + 1));
    return { id: allocId(counter), text: title, children, ...(note === '' ? {} : { note }), ...(completed === null ? {} : { completed }) };
  };
  if (outlines.length === 1) { const root = convert(outlines[0]!, 0); root.id = 'root'; return root; }
  claimNode(stats, 0);
  const children = outlines.map(node => convert(node, 1)), titleNode = [...descendants(doc)].find(n => n.kind === 'element' && asciiLower(n.localName) === 'title');
  return { id: 'root', text: rustTrim(text(titleNode) ?? '') || fallback, children };
}
function richContent(node: MindmapXmlNode, type: string): string | null {
  const rich = elements(node, 'richcontent').find(n => asciiLower(attr(n, 'TYPE') ?? attr(n, 'type') ?? '') === asciiLower(type));
  if (!rich) return null;
  const raw = [...descendants(rich)].filter(n => n.kind === 'text').map(n => n.text ?? '').join(' ');
  const value = type === 'NODE' ? raw.split(/\p{White_Space}+/u).filter(Boolean).join(' ') : raw.split(/\r?\n/).map(rustTrim).filter(Boolean).join('\n');
  return value === '' ? null : value;
}
export function parseMm(parser: MindmapXmlParser, xml: string, fallback: string, stats: ImportStats): [ImportNode, ImportNode[]] {
  const doc = parse(parser, xml, '.mm XML 解析失败');
  if (asciiLower(doc.localName) !== 'map') throw new Error('无效的 .mm 文件：缺少 map 根元素');
  const roots = elements(doc, 'node'); if (roots.length === 0) throw new Error('无效的 .mm 文件：没有 node 元素');
  const counter = { value: 0 }, ids = new Map<string, string>(), links: ImportLink[] = [];
  const convert = (node: MindmapXmlNode, depth: number, root: boolean): ImportNode => {
    claimNode(stats, depth); const id = allocId(counter, root), original = attr(node, 'ID') ?? attr(node, 'id') ?? id;
    if (!ids.has(original)) ids.set(original, id);
    const title = rustTrim(attr(node, 'TEXT') ?? attr(node, 'text') ?? '') || richContent(node, 'NODE') || '未命名主题', note = richContent(node, 'NOTE');
    let completed: boolean | null = null;
    for (const icon of elements(node, 'icon')) { const marker = attr(icon, 'BUILTIN'); if (marker === 'button_ok') { completed = true; break; } if (marker === 'button_cancel') completed = false; }
    for (const arrow of elements(node, 'arrowlink')) { const target = attr(arrow, 'DESTINATION') ?? attr(arrow, 'destination'); if (target !== null) links.push([original, target, attr(arrow, 'MIDDLE_LABEL')]); }
    const children = elements(node, 'node').map(child => convert(child, depth + 1, false));
    return { id, text: title, children, ...(note === null ? {} : { note }), ...(completed === null ? {} : { completed }) };
  };
  let root: ImportNode;
  if (roots.length === 1) root = convert(roots[0]!, 0, true);
  else { claimNode(stats, 0); root = { id: 'root', text: fallback, children: roots.map(node => convert(node, 1, false)) }; }
  return [root, remapAssociations(links, ids)];
}
function xmindTopic(node: MindmapXmlNode, depth: number, stats: ImportStats, counter: ImportCounter, ids: Map<string, string>, root: boolean): ImportNode {
  claimNode(stats, depth); const id = allocId(counter, root), original = attr(node, 'id');
  if (original !== null && !ids.has(original)) ids.set(original, id);
  stats.droppedImages += elements(node, 'img').length;
  for (const container of elements(node, 'summaries')) stats.droppedSummaries += elements(container, 'summary').length;
  for (const container of elements(node, 'boundaries')) stats.droppedBoundaries += elements(container, 'boundary').length;
  if (node.attributes.some(attr => attr.localName === 'href')) stats.droppedHyperlinks++;
  const title = rustTrim(text(elements(node, 'title')[0]) ?? '') || '未命名主题';
  const notes = elements(node, 'notes')[0], plain = notes ? [...descendants(notes)].find(n => n.kind === 'element' && asciiLower(n.localName) === 'plain') : undefined;
  const note = plain ? rustTrim([...descendants(plain)].filter(n => n.kind === 'text').map(n => n.text ?? '').join('')) : '';
  let completed: boolean | null = null;
  for (const refs of elements(node, 'marker-refs')) for (const marker of elements(refs, 'marker-ref')) {
    const id = attr(marker, 'marker-id'); if (id?.startsWith('task-')) { completed = id === 'task-done'; break; }
  }
  const children: ImportNode[] = [];
  for (const container of elements(node, 'children')) for (const topics of elements(container, 'topics')) {
    if ((attr(topics, 'type') ?? 'attached') !== 'attached') continue;
    for (const child of elements(topics, 'topic')) children.push(xmindTopic(child, depth + 1, stats, counter, ids, false));
  }
  return { id, text: title, children, ...(note === '' ? {} : { note }), ...(completed === null ? {} : { completed }) };
}
export function parseXmindXml(parser: MindmapXmlParser, xml: string, fallback: string, stats: ImportStats): [ImportNode, ImportNode[]] {
  const doc = parse(parser, xml, '无效的 .xmind content.xml'), sheets = [...descendants(doc)].filter(n => n.kind === 'element' && asciiLower(n.localName) === 'sheet');
  const topics = sheets.flatMap(sheet => elements(sheet, 'topic').slice(0, 1));
  if (topics.length === 0) throw new Error('无效的 .xmind：缺少根主题');
  const links: ImportLink[] = [], ids = new Map<string, string>(), counter = { value: 0 };
  for (const sheet of sheets) for (const container of elements(sheet, 'relationships')) for (const rel of elements(container, 'relationship')) {
    const start = attr(rel, 'end1'), end = attr(rel, 'end2'); if (start !== null && end !== null) links.push([start, end, text(elements(rel, 'title')[0])]);
  }
  let root: ImportNode;
  if (topics.length === 1) root = xmindTopic(topics[0]!, 0, stats, counter, ids, true);
  else { claimNode(stats, 0); root = { id: 'root', text: fallback, note: `合并自 ${topics.length} 个 .xmind 画布`,
    children: topics.map(topic => xmindTopic(topic, 1, stats, counter, ids, false)) }; }
  return [root, remapAssociations(links, ids)];
}
export function parseMmapXml(parser: MindmapXmlParser, xml: string, stats: ImportStats): ImportNode {
  const doc = parse(parser, xml, '无效的 .mmap Document.xml'), oneTopic = [...descendants(doc)].find(n => n.kind === 'element' && asciiLower(n.localName) === 'onetopic');
  if (!oneTopic) throw new Error('无效的 .mmap 文件：缺少 OneTopic 元素');
  const root = elements(oneTopic, 'Topic')[0]; if (!root) throw new Error('无效的 .mmap 文件：OneTopic 下缺少 Topic');
  const counter = { value: 0 };
  const convert = (node: MindmapXmlNode, depth: number, root: boolean): ImportNode => {
    claimNode(stats, depth); const title = elements(node, 'Text')[0];
    const name = rustTrim(title ? attr(title, 'PlainText') ?? '' : '') || '未命名主题';
    const children = elements(node, 'SubTopics').flatMap(container => elements(container, 'Topic')).map(child => convert(child, depth + 1, false));
    return { id: allocId(counter, root), text: name, children };
  };
  return convert(root, 0, true);
}
