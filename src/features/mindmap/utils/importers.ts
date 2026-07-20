/**
 * 知识导图导入器
 *
 * 支持格式：
 * - XMind（Zen content.json / XMind 8 content.xml，zip 流式读 + 体积上限）
 * - OPML (Outline Processor Markup Language)
 * - Markdown（大纲格式，与粘贴解析共用 pasteMarkdown 真源）
 * - FreeMind / Freeplane (.mm XML)
 * - JSON（原生格式）
 */

import { nanoid } from 'nanoid';
import i18n from 'i18next';
import JSZip from 'jszip';
import type { MindMapAssociation, MindMapDocument, MindMapNode } from '../types';
import { markdownListToNodes } from './pasteMarkdown';

/**
 * 最大导入深度限制，防止恶意数据导致栈溢出
 * ★ P0 修复
 */
const MAX_IMPORT_DEPTH = 100;

/**
 * 最大导入节点数量限制
 */
const MAX_IMPORT_NODES = 10000;

const XMIND_CONTENT_JSON = 'content.json';
const XMIND_CONTENT_XML = 'content.xml';

export const MAX_XMIND_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_XMIND_CONTENT_BYTES = 32 * 1024 * 1024;

interface XMindTopicJson {
  id?: string;
  title?: string;
  notes?: {
    plain?: { content?: string };
    html?: { content?: string };
  };
  markers?: Array<{ markerId?: string }>;
  labels?: string[];
  children?: {
    attached?: XMindTopicJson[];
  };
}

/** XMind Zen sheet 级关联线（自由连线，非父子边） */
interface XMindRelationshipJson {
  id?: string;
  end1Id?: string;
  end2Id?: string;
  title?: string;
}

/**
 * XMind 任务进度 marker → completed。
 * task-done 视为已完成，其余 task-*（start/half/quarter 等中间进度）视为未完成任务。
 */
function taskMarkerToCompleted(markerIds: string[]): boolean | undefined {
  const taskMarker = markerIds.find((id) => id.startsWith('task-'));
  if (!taskMarker) return undefined;
  return taskMarker === 'task-done';
}

/**
 * XMind 非任务元数据 → 可用字段的降级映射（B9）：
 * - `priority-N` marker → 正文前缀 `[PN] `（优先级在 XMind 中高可见，保留到标题）；
 * - labels → 备注附注行「标签：…」；
 * - 其余非 task/priority marker（flag/star/smiley 等）→ 备注附注行「XMind 标记：…」。
 *
 * 明确不支持（导入时静默丢弃）：主题样式/结构样式、图片与附件、概要（summary）、
 * 外框（boundary）、超链接、录音备注、标注（callout）；detached 浮动主题为有意忽略
 * （见 importFromXMind 各转换器与既有测试）。
 */
function collectXMindExtras(
  markerIds: string[],
  labels: string[],
): { textPrefix: string; noteSuffixLines: string[] } {
  const priority = markerIds.find((id) => /^priority-\d+$/.test(id));
  const textPrefix = priority ? `[P${priority.slice('priority-'.length)}] ` : '';
  const otherMarkers = markerIds.filter(
    (id) => !id.startsWith('task-') && id !== priority,
  );
  const noteSuffixLines: string[] = [];
  if (labels.length > 0) {
    noteSuffixLines.push(i18n.t('mindmap:import.labelsNote', { labels: labels.join(', ') }));
  }
  if (otherMarkers.length > 0) {
    noteSuffixLines.push(i18n.t('mindmap:import.markersNote', { markers: otherMarkers.join(', ') }));
  }
  return { textPrefix, noteSuffixLines };
}

/** 组合原始备注与附注行；两者皆空时返回 undefined */
function composeNote(baseNote: string | undefined, suffixLines: string[]): string | undefined {
  const parts = [...(baseNote ? [baseNote] : []), ...suffixLines];
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function createImportStats() {
  return { nodeCount: 0 };
}

function claimImportedNode(stats: { nodeCount: number }, depth: number, format: string): void {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(`${format} depth exceeds maximum limit (${MAX_IMPORT_DEPTH})`);
  }
  stats.nodeCount += 1;
  if (stats.nodeCount > MAX_IMPORT_NODES) {
    throw new Error(`Node count exceeds maximum limit (${MAX_IMPORT_NODES})`);
  }
}

function stripHtml(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new DOMParser().parseFromString(value, 'text/html');
  return parsed.body.textContent?.trim() || undefined;
}

function allocateXMindNodeId(
  requestedId: string | undefined,
  usedIds: Set<string>,
  forceRoot: boolean,
): string {
  if (forceRoot) {
    usedIds.add('root');
    return 'root';
  }
  if (requestedId && !usedIds.has(requestedId)) {
    usedIds.add(requestedId);
    return requestedId;
  }
  let generated = nanoid(10);
  while (usedIds.has(generated)) generated = nanoid(10);
  usedIds.add(generated);
  return generated;
}

function xmindJsonTopicToNode(
  topic: XMindTopicJson,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, 'XMind');
  const plainNote = topic.notes?.plain?.content?.trim();
  const htmlNote = stripHtml(topic.notes?.html?.content);
  const assignedId = allocateXMindNodeId(topic.id, usedIds, forceRoot);
  // 记录 原始 topic id → 实际节点 id，供 relationships 端点重映射
  if (topic.id && !idMap.has(topic.id)) {
    idMap.set(topic.id, assignedId);
  }
  const markerIds = (topic.markers || [])
    .map((marker) => marker?.markerId)
    .filter((id): id is string => typeof id === 'string');
  const completed = taskMarkerToCompleted(markerIds);
  const labels = (topic.labels || []).filter(
    (label): label is string => typeof label === 'string' && label.trim().length > 0,
  );
  const extras = collectXMindExtras(markerIds, labels);
  return {
    id: assignedId,
    text: extras.textPrefix + (topic.title?.trim() || i18n.t('mindmap:import.unnamedTopic')),
    note: composeNote(plainNote || htmlNote, extras.noteSuffixLines),
    ...(completed !== undefined ? { completed } : {}),
    children: (topic.children?.attached || []).map((child) =>
      xmindJsonTopicToNode(child, depth + 1, stats, usedIds, idMap)),
  };
}

function directChildrenByLocalName(element: Element, localName: string): Element[] {
  return Array.from(element.children).filter(
    (child) => child.localName.toLowerCase() === localName.toLowerCase(),
  );
}

function firstDescendantByLocalName(element: Element, localName: string): Element | null {
  return Array.from(element.getElementsByTagName('*')).find(
    (child) => child.localName.toLowerCase() === localName.toLowerCase(),
  ) || null;
}

function xmindXmlTopicToNode(
  topic: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, 'XMind');
  const title = directChildrenByLocalName(topic, 'title')[0]?.textContent?.trim();
  const notes = directChildrenByLocalName(topic, 'notes')[0];
  const note = notes
    ? firstDescendantByLocalName(notes, 'plain')?.textContent?.trim()
      || firstDescendantByLocalName(notes, 'html')?.textContent?.trim()
      || undefined
    : undefined;
  // XMind 8 marker：<marker-refs><marker-ref marker-id="task-done"/></marker-refs>
  const markerRefs = directChildrenByLocalName(topic, 'marker-refs')[0];
  const markerIds = markerRefs
    ? directChildrenByLocalName(markerRefs, 'marker-ref')
      .map((ref) => ref.getAttribute('marker-id'))
      .filter((id): id is string => !!id)
    : [];
  const completed = taskMarkerToCompleted(markerIds);
  // XMind 8 labels：<labels><label>…</label></labels>
  const labelsContainer = directChildrenByLocalName(topic, 'labels')[0];
  const labels = labelsContainer
    ? directChildrenByLocalName(labelsContainer, 'label')
      .map((label) => label.textContent?.trim())
      .filter((label): label is string => !!label)
    : [];
  const extras = collectXMindExtras(markerIds, labels);
  const childrenContainer = directChildrenByLocalName(topic, 'children')[0];
  const topicsGroups = childrenContainer
    ? directChildrenByLocalName(childrenContainer, 'topics').filter(
      (group) => !group.getAttribute('type') || group.getAttribute('type') === 'attached',
    )
    : [];
  const childTopics = topicsGroups.flatMap((group) => directChildrenByLocalName(group, 'topic'));
  const originalId = topic.getAttribute('id') || undefined;
  const assignedId = allocateXMindNodeId(originalId, usedIds, forceRoot);
  if (originalId && !idMap.has(originalId)) {
    idMap.set(originalId, assignedId);
  }
  return {
    id: assignedId,
    text: extras.textPrefix + (title || i18n.t('mindmap:import.unnamedTopic')),
    note: composeNote(note, extras.noteSuffixLines),
    ...(completed !== undefined ? { completed } : {}),
    children: childTopics.map((child) => xmindXmlTopicToNode(child, depth + 1, stats, usedIds, idMap)),
  };
}

/**
 * 把 XMind 关联线端点重映射到导入后的节点 id，丢弃端点缺失/自指的连线。
 */
function remapXMindRelationships(
  relationships: Array<{ end1?: string; end2?: string; label?: string }>,
  idMap: Map<string, string>,
): MindMapAssociation[] {
  const associations: MindMapAssociation[] = [];
  for (const rel of relationships) {
    const source = rel.end1 ? idMap.get(rel.end1) : undefined;
    const target = rel.end2 ? idMap.get(rel.end2) : undefined;
    if (!source || !target || source === target) continue;
    const label = rel.label?.trim();
    associations.push({
      id: `assoc_${nanoid(10)}`,
      source,
      target,
      ...(label ? { label } : {}),
    });
  }
  return associations;
}

function createXMindDocument(
  root: MindMapNode,
  associations?: MindMapAssociation[],
): MindMapDocument {
  return {
    version: '1.0',
    root,
    meta: { createdAt: new Date().toISOString() },
    ...(associations && associations.length > 0 ? { associations } : {}),
  };
}

/**
 * 多 sheet 文件保持「合成虚拟根」策略（本应用是单树模型，不支持多画布），
 * 但在根备注中说明来源，避免用户误以为丢失了画布信息。
 */
function createMultiSheetRoot(children: MindMapNode[], sheetTitles: string[]): MindMapNode {
  const titles = sheetTitles
    .map((title) => title.trim() || i18n.t('mindmap:import.unnamedTopic'))
    .join(', ');
  return {
    id: 'root',
    text: i18n.t('mindmap:import.importedMap'),
    note: i18n.t('mindmap:import.multiSheetNote', { count: children.length, titles }),
    children,
  };
}

interface XMindStreamHelper {
  on(event: 'data', callback: (chunk: Uint8Array) => void): XMindStreamHelper;
  on(event: 'end', callback: () => void): XMindStreamHelper;
  on(event: 'error', callback: (error: Error) => void): XMindStreamHelper;
  pause(): XMindStreamHelper;
  resume(): XMindStreamHelper;
}

async function readXMindContent(entry: JSZip.JSZipObject): Promise<string> {
  const advertisedSize = (entry as unknown as {
    _data?: { uncompressedSize?: number };
  })._data?.uncompressedSize;
  if (typeof advertisedSize === 'number' && advertisedSize > MAX_XMIND_CONTENT_BYTES) {
    throw new Error(`XMind content exceeds maximum size (${MAX_XMIND_CONTENT_BYTES} bytes)`);
  }

  const stream = (entry as unknown as {
    internalStream(type: 'uint8array'): XMindStreamHelper;
  }).internalStream('uint8array');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    stream
      .on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_XMIND_CONTENT_BYTES) {
          settled = true;
          stream.pause();
          reject(new Error(`XMind content exceeds maximum size (${MAX_XMIND_CONTENT_BYTES} bytes)`));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(combined);
      })
      .resume();
  });
  return new TextDecoder().decode(bytes);
}

/** Import XMind Zen (content.json) and XMind 8 (content.xml) as the existing tree model. */
export async function importFromXMind(data: Uint8Array | ArrayBuffer): Promise<MindMapDocument> {
  if (data.byteLength > MAX_XMIND_ARCHIVE_BYTES) {
    throw new Error(`XMind archive exceeds maximum size (${MAX_XMIND_ARCHIVE_BYTES} bytes)`);
  }
  const zip = await JSZip.loadAsync(data);
  const jsonEntry = zip.file(XMIND_CONTENT_JSON);
  if (jsonEntry) {
    const raw = JSON.parse(await readXMindContent(jsonEntry)) as unknown;
    const candidates = Array.isArray(raw) ? raw : [raw];
    const sheets = candidates.filter((candidate): candidate is {
      title?: string;
      rootTopic: XMindTopicJson;
      relationships?: XMindRelationshipJson[];
    } => {
      if (!candidate || typeof candidate !== 'object' || !('rootTopic' in candidate)) return false;
      const rootTopic = (candidate as { rootTopic?: unknown }).rootTopic;
      return !!rootTopic && typeof rootTopic === 'object';
    });
    if (sheets.length === 0) throw new Error('Invalid XMind: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
    // sheet 级关联线（拓扑转换完成后统一按 idMap 重映射）
    const rawRelationships = sheets.flatMap((sheet) =>
      (Array.isArray(sheet.relationships) ? sheet.relationships : []).map((rel) => ({
        end1: rel?.end1Id,
        end2: rel?.end2Id,
        label: rel?.title,
      })));
    if (sheets.length === 1) {
      const root = xmindJsonTopicToNode(sheets[0].rootTopic, 0, stats, usedIds, idMap, true);
      return createXMindDocument(root, remapXMindRelationships(rawRelationships, idMap));
    }
    claimImportedNode(stats, 0, 'XMind');
    usedIds.add('root');
    const children = sheets.map((sheet) =>
      xmindJsonTopicToNode(sheet.rootTopic, 1, stats, usedIds, idMap));
    const sheetTitles = sheets.map((sheet) => sheet.title || sheet.rootTopic.title || '');
    return createXMindDocument(
      createMultiSheetRoot(children, sheetTitles),
      remapXMindRelationships(rawRelationships, idMap),
    );
  }

  const xmlEntry = zip.file(XMIND_CONTENT_XML);
  if (xmlEntry) {
    const xml = new DOMParser().parseFromString(await readXMindContent(xmlEntry), 'text/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError) throw new Error(`Invalid XMind XML: ${parserError.textContent}`);
    const sheetElements = Array.from(xml.getElementsByTagName('*'))
      .filter((element) => element.localName === 'sheet');
    const rootTopics = sheetElements
      .map((sheet) => directChildrenByLocalName(sheet, 'topic')[0])
      .filter((topic): topic is Element => !!topic);
    if (rootTopics.length === 0) throw new Error('Invalid XMind: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
    // XMind 8：<relationships><relationship end1=".." end2=".."><title>..</title></relationship>
    const rawRelationships = sheetElements
      .flatMap((sheet) => directChildrenByLocalName(sheet, 'relationships'))
      .flatMap((container) => directChildrenByLocalName(container, 'relationship'))
      .map((rel) => ({
        end1: rel.getAttribute('end1') ?? undefined,
        end2: rel.getAttribute('end2') ?? undefined,
        label: directChildrenByLocalName(rel, 'title')[0]?.textContent ?? undefined,
      }));
    if (rootTopics.length === 1) {
      const root = xmindXmlTopicToNode(rootTopics[0], 0, stats, usedIds, idMap, true);
      return createXMindDocument(root, remapXMindRelationships(rawRelationships, idMap));
    }
    claimImportedNode(stats, 0, 'XMind');
    usedIds.add('root');
    const children = rootTopics.map((topic) => xmindXmlTopicToNode(topic, 1, stats, usedIds, idMap));
    // sheet 标题优先取 <sheet><title>，缺失时回退到该 sheet 根主题标题
    const sheetTitles = sheetElements
      .filter((sheet) => directChildrenByLocalName(sheet, 'topic').length > 0)
      .map((sheet) =>
        directChildrenByLocalName(sheet, 'title')[0]?.textContent?.trim()
        || directChildrenByLocalName(
          directChildrenByLocalName(sheet, 'topic')[0], 'title',
        )[0]?.textContent?.trim()
        || '');
    return createXMindDocument(
      createMultiSheetRoot(children, sheetTitles),
      remapXMindRelationships(rawRelationships, idMap),
    );
  }

  throw new Error('Invalid XMind: content.json or content.xml not found');
}

// ============================================================================
// OPML 导入
// ============================================================================

interface OpmlOutline {
  text: string;
  _note?: string;
  completed?: boolean;
  children: OpmlOutline[];
}

/**
 * 解析 OPML 完成态属性：
 * - _complete="true|false"（本应用导出 / Workflowy 风格）
 * - _status="checked"（OmniOutliner 等工具的勾选态）
 */
function parseOpmlCompleted(element: Element): boolean | undefined {
  const complete = element.getAttribute('_complete');
  if (complete === 'true') return true;
  if (complete === 'false') return false;
  const status = element.getAttribute('_status');
  if (status === 'checked') return true;
  if (status === 'unchecked') return false;
  return undefined;
}

/**
 * 解析 OPML outline 元素
 * ★ P0 修复：添加深度限制
 */
function parseOpmlOutline(
  element: Element,
  depth: number = 0,
  stats: { nodeCount: number }
): OpmlOutline {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(`OPML depth exceeds maximum limit (${MAX_IMPORT_DEPTH})`);
  }

  stats.nodeCount += 1;
  if (stats.nodeCount > MAX_IMPORT_NODES) {
    throw new Error(`Node count exceeds maximum limit (${MAX_IMPORT_NODES})`);
  }

  // 部分工具（如 OmniOutliner 导出）用 title 属性而非 text
  const text = element.getAttribute('text') || element.getAttribute('title') || '';
  // Workflowy 等工具的注释属性为 _note；note 作为兼容兜底
  const note = element.getAttribute('_note') || element.getAttribute('note') || undefined;
  const completed = parseOpmlCompleted(element);
  const children: OpmlOutline[] = [];

  const childElements = Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === 'outline'
  );
  childElements.forEach((child) => {
    children.push(parseOpmlOutline(child, depth + 1, stats));
  });

  return { text, _note: note, completed, children };
}

/**
 * 将 OPML outline 转换为 MindMapNode
 * ★ P0 修复：添加深度限制
 */
function opmlOutlineToNode(outline: OpmlOutline, depth: number = 0): MindMapNode {
  // 深度限制检查
  const children = depth < MAX_IMPORT_DEPTH
    ? outline.children.map(child => opmlOutlineToNode(child, depth + 1))
    : [];
    
  return {
    id: nanoid(10),
    text: outline.text,
    note: outline._note,
    ...(outline.completed !== undefined ? { completed: outline.completed } : {}),
    children,
  };
}

/**
 * 从 OPML 格式导入
 */
export function importFromOpml(opmlContent: string): MindMapDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(opmlContent, 'text/xml');

  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`Invalid OPML: ${parserError.textContent}`);
  }

  const body = doc.querySelector('body');
  if (!body) {
    throw new Error('Invalid OPML: missing body element');
  }

  const outlines = body.querySelectorAll(':scope > outline');
  if (outlines.length === 0) {
    throw new Error('Invalid OPML: no outline elements found');
  }

  // 如果只有一个顶级 outline，用它作为根节点
  // 否则创建一个虚拟根节点
  let root: MindMapNode;
  if (outlines.length === 1) {
    const stats = { nodeCount: 0 };
    root = opmlOutlineToNode(parseOpmlOutline(outlines[0], 0, stats));
    root.id = 'root';
  } else {
    const children: MindMapNode[] = [];
    const stats = { nodeCount: 0 };
    outlines.forEach((outline) => {
      children.push(opmlOutlineToNode(parseOpmlOutline(outline, 0, stats)));
    });
    root = {
      id: 'root',
      text: doc.querySelector('head > title')?.textContent || i18n.t('mindmap:import.importedMap'),
      children,
    };
  }

  return {
    version: '1.0',
    root,
    meta: {
      createdAt: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Markdown 导入
// ============================================================================

/**
 * 从 Markdown 格式导入。
 *
 * ★ B5 修复：文件导入与剪贴板粘贴共用 pasteMarkdown.markdownListToNodes 作为
 * 唯一解析真源，因此文件导入同样支持：
 * - `- * + •  ‣ ◦` 无序列表与 `1.` / `1)` 有序列表；
 * - `# 标题` 层级、GFM 任务项 `- [ ]` / `- [x]`；
 * - 幕布等工具导出的纯缩进大纲（无项目符号）；
 * - 多个顶级条目（森林）——合成虚拟根，而非旧行为的「首行强制为单根」。
 *
 * 深度（100）/节点数（10000）上限由 markdownListToNodes 内部守卫。
 */
export function importFromMarkdown(markdown: string): MindMapDocument {
  const forest = markdownListToNodes(markdown);

  let root: MindMapNode;
  if (forest.length === 0) {
    root = { id: 'root', text: i18n.t('mindmap:import.emptyMap'), children: [] };
  } else if (forest.length === 1) {
    root = { ...forest[0], id: 'root' };
  } else {
    root = {
      id: 'root',
      text: i18n.t('mindmap:import.importedMap'),
      children: forest,
    };
  }

  return {
    version: '1.0',
    root,
    meta: {
      createdAt: new Date().toISOString(),
    },
  };
}

// ============================================================================
// FreeMind (.mm) 导入
// ============================================================================

/**
 * 提取 FreeMind 节点的 richcontent 文本。
 * - TYPE="NODE"：富文本正文（替代 TEXT 属性），折叠为单行；
 * - TYPE="NOTE"：备注，保留行结构（逐行 trim 后以 \n 连接）。
 */
function freeMindRichContentText(
  element: Element,
  type: 'NODE' | 'NOTE',
): string | undefined {
  const rich = directChildrenByLocalName(element, 'richcontent').find(
    (el) => (el.getAttribute('TYPE') || el.getAttribute('type') || '').toUpperCase() === type,
  );
  if (!rich) return undefined;
  const raw = rich.textContent?.replace(/\u00a0/g, ' ');
  if (!raw) return undefined;
  if (type === 'NODE') {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    return collapsed || undefined;
  }
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function freeMindNodeToNode(
  element: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  arrows: Array<{ end1?: string; end2?: string; label?: string }>,
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, 'FreeMind');
  const attrText = element.getAttribute('TEXT') ?? element.getAttribute('text');
  const text =
    attrText?.trim()
    || freeMindRichContentText(element, 'NODE')
    || i18n.t('mindmap:import.unnamedTopic');
  const note = freeMindRichContentText(element, 'NOTE');

  const originalId = element.getAttribute('ID') || element.getAttribute('id') || undefined;
  const assignedId = allocateXMindNodeId(originalId, usedIds, forceRoot);
  // 源 ID → 实际节点 ID；无源 ID 时登记 assignedId 自映射，供 arrowlink 端点重映射
  const mapKey = originalId ?? assignedId;
  if (!idMap.has(mapKey)) idMap.set(mapKey, assignedId);

  // FreeMind 完成态图标：button_ok → 已完成，button_cancel → 未完成任务
  const icons = directChildrenByLocalName(element, 'icon')
    .map((icon) => icon.getAttribute('BUILTIN'))
    .filter((id): id is string => !!id);
  const completed = icons.includes('button_ok')
    ? true
    : icons.includes('button_cancel')
      ? false
      : undefined;

  // <arrowlink DESTINATION="…"/>：FreeMind 自由连线 → 关联线
  for (const arrow of directChildrenByLocalName(element, 'arrowlink')) {
    const destination = arrow.getAttribute('DESTINATION') || arrow.getAttribute('destination');
    if (destination) {
      arrows.push({
        end1: mapKey,
        end2: destination,
        label: arrow.getAttribute('MIDDLE_LABEL') ?? undefined,
      });
    }
  }

  return {
    id: assignedId,
    text,
    note,
    ...(completed !== undefined ? { completed } : {}),
    children: directChildrenByLocalName(element, 'node').map((child) =>
      freeMindNodeToNode(child, depth + 1, stats, usedIds, idMap, arrows)),
  };
}

/**
 * 从 FreeMind / Freeplane `.mm`（XML）导入：标题 + 备注层级、
 * button_ok/button_cancel 图标 → 完成态、arrowlink → 关联线。
 * 不支持（静默丢弃）：云朵（cloud）、节点样式/颜色/字体、内嵌图片、
 * 属性（attribute）、hook 插件数据。
 */
export function importFromFreeMind(xmlContent: string): MindMapDocument {
  const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`Invalid FreeMind XML: ${parserError.textContent}`);
  }

  const mapElement = doc.documentElement?.localName?.toLowerCase() === 'map'
    ? doc.documentElement
    : null;
  if (!mapElement) {
    throw new Error('Invalid FreeMind: missing map element');
  }

  const rootElements = directChildrenByLocalName(mapElement, 'node');
  if (rootElements.length === 0) {
    throw new Error('Invalid FreeMind: no node elements found');
  }

  const stats = createImportStats();
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  const arrows: Array<{ end1?: string; end2?: string; label?: string }> = [];

  let root: MindMapNode;
  if (rootElements.length === 1) {
    root = freeMindNodeToNode(rootElements[0], 0, stats, usedIds, idMap, arrows, true);
  } else {
    claimImportedNode(stats, 0, 'FreeMind');
    usedIds.add('root');
    root = {
      id: 'root',
      text: i18n.t('mindmap:import.importedMap'),
      children: rootElements.map((element) =>
        freeMindNodeToNode(element, 1, stats, usedIds, idMap, arrows)),
    };
  }

  const associations = remapXMindRelationships(arrows, idMap);
  return {
    version: '1.0',
    root,
    meta: { createdAt: new Date().toISOString() },
    ...(associations.length > 0 ? { associations } : {}),
  };
}

// ============================================================================
// JSON 导入
// ============================================================================

/**
 * 验证并计算树的深度和节点数
 * ★ P0 修复：防止恶意数据导致问题
 */
function validateTree(node: unknown, depth: number = 0): { depth: number; nodeCount: number } {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(`Tree depth exceeds maximum limit (${MAX_IMPORT_DEPTH})`);
  }
  
  if (typeof node !== 'object' || node === null) {
    throw new Error('Invalid node: expected object');
  }
  
  const nodeObj = node as Record<string, unknown>;
  let maxChildDepth = depth;
  let totalNodes = 1;
  
  if (Array.isArray(nodeObj.children)) {
    for (const child of nodeObj.children) {
      const result = validateTree(child, depth + 1);
      maxChildDepth = Math.max(maxChildDepth, result.depth);
      totalNodes += result.nodeCount;
      
      if (totalNodes > MAX_IMPORT_NODES) {
        throw new Error(`Node count exceeds maximum limit (${MAX_IMPORT_NODES})`);
      }
    }
  }
  
  return { depth: maxChildDepth, nodeCount: totalNodes };
}

/**
 * 从 JSON 格式导入
 * ★ P0 修复：添加 try-catch、深度验证和节点数量限制
 */
export function importFromJson(jsonContent: string): MindMapDocument {
  // 修复: 添加 try-catch 包装 JSON.parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (e) {
    throw new Error(`Invalid JSON format: ${e instanceof Error ? e.message : 'parse error'}`);
  }

  // 类型验证
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid JSON: expected object');
  }
  
  const doc = parsed as Record<string, unknown>;
  
  // 验证基本结构
  if (!doc.version || !doc.root) {
    throw new Error('Invalid JSON: missing version or root');
  }

  // 修复: 验证树的深度和节点数量
  validateTree(doc.root);

  // 确保所有节点都有 ID（带深度限制）
  function ensureIds(node: MindMapNode, depth: number = 0): MindMapNode {
    // 深度限制检查
    if (depth > MAX_IMPORT_DEPTH) {
      return {
        ...node,
        id: node.id || nanoid(10),
        children: [],
      };
    }
    
    return {
      ...node,
      id: node.id || nanoid(10),
      children: (node.children || []).map(child => ensureIds(child, depth + 1)),
    };
  }

  const rawMeta = doc.meta as Record<string, unknown> | undefined;
  const createdAt =
    typeof rawMeta?.createdAt === 'string'
      ? rawMeta.createdAt
      : new Date().toISOString();

  return {
    version: '1.0',
    root: ensureIds(doc.root as MindMapNode, 0),
    meta: {
      ...(rawMeta || {}),
      createdAt,
    },
  };
}

// ============================================================================
// 通用导入接口
// ============================================================================

export type ImportFormat = 'opml' | 'markdown' | 'json' | 'freemind' | 'xmind' | 'auto';

/** zip 包（.xmind）魔数：PK\x03\x04 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * 自动检测格式（基于文本内容）。
 * - zip 魔数被解码为文本时也能识别为 xmind（但二进制内容需走 importFromFile /
 *   importFromXMind 的字节路径，本函数只做提示性识别）；
 * - XML 按根元素区分 opml / freemind，无法识别时保持旧行为回退 opml。
 */
export function detectFormat(content: string): Exclude<ImportFormat, 'auto'> {
  const trimmed = content.trim();

  if (trimmed.startsWith('PK\u0003\u0004')) {
    return 'xmind';
  }

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    // 只嗅探开头片段，避免对超大文件做整体正则
    const head = trimmed.slice(0, 2048);
    if (/<opml[\s>]/i.test(head)) return 'opml';
    if (/<map[\s>]/i.test(head)) return 'freemind';
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<opml')) return 'opml';
  }

  if (trimmed.startsWith('{')) {
    return 'json';
  }

  return 'markdown';
}

/**
 * 统一导入接口（文本内容）。
 * XMind 是 zip 二进制格式，无法从字符串导入——请使用 importFromFile 或 importFromXMind。
 */
export function importMindMap(
  content: string,
  format: ImportFormat = 'auto'
): MindMapDocument {
  const actualFormat = format === 'auto' ? detectFormat(content) : format;

  switch (actualFormat) {
    case 'opml':
      return importFromOpml(content);
    case 'markdown':
      return importFromMarkdown(content);
    case 'json':
      return importFromJson(content);
    case 'freemind':
      return importFromFreeMind(content);
    case 'xmind':
      throw new Error('XMind import requires binary data; use importFromFile or importFromXMind');
    default:
      throw new Error(`Unsupported import format: ${actualFormat}`);
  }
}

/**
 * 从文件导入。
 * ★ B11 修复：扩展名路由补齐 .xmind（二进制 zip）与 .mm（FreeMind XML）；
 * 无扩展名时按 zip 魔数嗅探（zip 内容按文本解码会损坏，必须走字节路径）。
 */
export async function importFromFile(file: File): Promise<MindMapDocument> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'xmind') {
    return importFromXMind(await file.arrayBuffer());
  }

  if (extension !== 'opml' && extension !== 'json' && extension !== 'md'
    && extension !== 'markdown' && extension !== 'mm') {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (looksLikeZip(head)) {
      return importFromXMind(await file.arrayBuffer());
    }
  }

  const content = await file.text();

  let format: ImportFormat = 'auto';
  if (extension === 'opml') {
    format = 'opml';
  } else if (extension === 'json') {
    format = 'json';
  } else if (extension === 'md' || extension === 'markdown') {
    format = 'markdown';
  } else if (extension === 'mm') {
    format = 'freemind';
  }

  return importMindMap(content, format);
}
