/**
 * 知识导图导入器
 *
 * 支持格式：
 * - OPML (Outline Processor Markup Language)
 * - Markdown (大纲格式)
 * - JSON
 */

import { nanoid } from 'nanoid';
import i18n from 'i18next';
import JSZip from 'jszip';
import type { MindMapDocument, MindMapNode } from '../types';

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
  children?: {
    attached?: XMindTopicJson[];
  };
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
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, 'XMind');
  const plainNote = topic.notes?.plain?.content?.trim();
  const htmlNote = stripHtml(topic.notes?.html?.content);
  return {
    id: allocateXMindNodeId(topic.id, usedIds, forceRoot),
    text: topic.title?.trim() || i18n.t('mindmap:import.unnamedTopic'),
    note: plainNote || htmlNote,
    children: (topic.children?.attached || []).map((child) =>
      xmindJsonTopicToNode(child, depth + 1, stats, usedIds)),
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
  const childrenContainer = directChildrenByLocalName(topic, 'children')[0];
  const topicsGroups = childrenContainer
    ? directChildrenByLocalName(childrenContainer, 'topics').filter(
      (group) => !group.getAttribute('type') || group.getAttribute('type') === 'attached',
    )
    : [];
  const childTopics = topicsGroups.flatMap((group) => directChildrenByLocalName(group, 'topic'));
  return {
    id: allocateXMindNodeId(topic.getAttribute('id') || undefined, usedIds, forceRoot),
    text: title || i18n.t('mindmap:import.unnamedTopic'),
    note,
    children: childTopics.map((child) => xmindXmlTopicToNode(child, depth + 1, stats, usedIds)),
  };
}

function createXMindDocument(root: MindMapNode): MindMapDocument {
  return {
    version: '1.0',
    root,
    meta: { createdAt: new Date().toISOString() },
  };
}

function createMultiSheetRoot(children: MindMapNode[]): MindMapNode {
  return {
    id: 'root',
    text: i18n.t('mindmap:import.importedMap'),
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
    const sheets = candidates.filter((candidate): candidate is { rootTopic: XMindTopicJson } => {
      if (!candidate || typeof candidate !== 'object' || !('rootTopic' in candidate)) return false;
      const rootTopic = (candidate as { rootTopic?: unknown }).rootTopic;
      return !!rootTopic && typeof rootTopic === 'object';
    });
    if (sheets.length === 0) throw new Error('Invalid XMind: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    if (sheets.length === 1) {
      return createXMindDocument(xmindJsonTopicToNode(sheets[0].rootTopic, 0, stats, usedIds, true));
    }
    claimImportedNode(stats, 0, 'XMind');
    usedIds.add('root');
    const children = sheets.map((sheet) =>
      xmindJsonTopicToNode(sheet.rootTopic, 1, stats, usedIds));
    return createXMindDocument(createMultiSheetRoot(children));
  }

  const xmlEntry = zip.file(XMIND_CONTENT_XML);
  if (xmlEntry) {
    const xml = new DOMParser().parseFromString(await readXMindContent(xmlEntry), 'text/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError) throw new Error(`Invalid XMind XML: ${parserError.textContent}`);
    const rootTopics = Array.from(xml.getElementsByTagName('*'))
      .filter((element) => element.localName === 'sheet')
      .map((sheet) => directChildrenByLocalName(sheet, 'topic')[0])
      .filter((topic): topic is Element => !!topic);
    if (rootTopics.length === 0) throw new Error('Invalid XMind: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    if (rootTopics.length === 1) {
      return createXMindDocument(xmindXmlTopicToNode(rootTopics[0], 0, stats, usedIds, true));
    }
    claimImportedNode(stats, 0, 'XMind');
    usedIds.add('root');
    const children = rootTopics.map((topic) => xmindXmlTopicToNode(topic, 1, stats, usedIds));
    return createXMindDocument(createMultiSheetRoot(children));
  }

  throw new Error('Invalid XMind: content.json or content.xml not found');
}

// ============================================================================
// OPML 导入
// ============================================================================

interface OpmlOutline {
  text: string;
  _note?: string;
  children: OpmlOutline[];
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

  const text = element.getAttribute('text') || '';
  const note = element.getAttribute('_note') || undefined;
  const children: OpmlOutline[] = [];

  const childElements = Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === 'outline'
  );
  childElements.forEach((child) => {
    children.push(parseOpmlOutline(child, depth + 1, stats));
  });

  return { text, _note: note, children };
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

interface ParsedLine {
  level: number;
  text: string;
  isHeading: boolean;
}

function parseMarkdownLines(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n');
  const parsed: ParsedLine[] = [];
  let lastHeadingLevel = 0; // 跟踪最近标题层级，用于列表项相对偏移

  for (const rawLine of lines) {
    // ★ 2026-02 修复：将 tab 展开为空格，防止 tab 缩进文件层级扁平化
    const trimmed = rawLine.replace(/\t/g, '    ').trimEnd();
    if (!trimmed) continue;

    // 检查是否是标题 — 使用实际标题层级而非硬编码 0
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length - 1; // # → 0, ## → 1, ### → 2
      lastHeadingLevel = level;
      parsed.push({
        level,
        text: headingMatch[2],
        isHeading: true,
      });
      continue;
    }

    // 检查是否是列表项 — 相对于最近标题层级偏移
    const listMatch = trimmed.match(/^(\s*)[-*+]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const level = lastHeadingLevel + 1 + Math.floor(indent / 2);
      parsed.push({
        level,
        text: listMatch[2],
        isHeading: false,
      });
      continue;
    }

    // 检查是否是缩进文本（可能是注释）
    const indentMatch = trimmed.match(/^(\s+)(.+)$/);
    if (indentMatch && parsed.length > 0) {
      const lastParsed = parsed[parsed.length - 1];
      lastParsed.text += '\n' + indentMatch[2].replace(/^>\s*/, '');
    }
  }

  return parsed;
}

function buildTreeFromParsedLines(lines: ParsedLine[]): MindMapNode {
  if (lines.length === 0) {
    return {
      id: 'root',
      text: i18n.t('mindmap:import.emptyMap'),
      children: [],
    };
  }

  // 第一行作为根节点
  const rootLine = lines[0];
  const root: MindMapNode = {
    id: 'root',
    text: rootLine.text.split('\n')[0],
    note: rootLine.text.includes('\n')
      ? rootLine.text.split('\n').slice(1).join('\n')
      : undefined,
    children: [],
  };

  // 使用栈来构建树
  const stack: { node: MindMapNode; level: number }[] = [
    { node: root, level: 0 },
  ];
  let nodeCount = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.level > MAX_IMPORT_DEPTH) {
      throw new Error(`Markdown depth exceeds maximum limit (${MAX_IMPORT_DEPTH})`);
    }
    const newNode: MindMapNode = {
      id: nanoid(10),
      text: line.text.split('\n')[0],
      note: line.text.includes('\n')
        ? line.text.split('\n').slice(1).join('\n')
        : undefined,
      children: [],
    };
    nodeCount += 1;
    if (nodeCount > MAX_IMPORT_NODES) {
      throw new Error(`Node count exceeds maximum limit (${MAX_IMPORT_NODES})`);
    }

    // 找到正确的父节点
    while (stack.length > 1 && stack[stack.length - 1].level >= line.level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    parent.children.push(newNode);
    stack.push({ node: newNode, level: line.level });
  }

  return root;
}

/**
 * 从 Markdown 格式导入
 */
export function importFromMarkdown(markdown: string): MindMapDocument {
  const parsed = parseMarkdownLines(markdown);
  const root = buildTreeFromParsedLines(parsed);

  return {
    version: '1.0',
    root,
    meta: {
      createdAt: new Date().toISOString(),
    },
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

export type ImportFormat = 'opml' | 'markdown' | 'json' | 'auto';

/**
 * 自动检测格式
 */
function detectFormat(content: string): ImportFormat {
  const trimmed = content.trim();

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<opml')) {
    return 'opml';
  }

  if (trimmed.startsWith('{')) {
    return 'json';
  }

  return 'markdown';
}

/**
 * 统一导入接口
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
    default:
      throw new Error(`Unsupported import format: ${actualFormat}`);
  }
}

/**
 * 从文件导入
 */
export async function importFromFile(file: File): Promise<MindMapDocument> {
  const content = await file.text();
  const extension = file.name.split('.').pop()?.toLowerCase();

  let format: ImportFormat = 'auto';
  if (extension === 'opml') {
    format = 'opml';
  } else if (extension === 'json') {
    format = 'json';
  } else if (extension === 'md' || extension === 'markdown') {
    format = 'markdown';
  }

  return importMindMap(content, format);
}
