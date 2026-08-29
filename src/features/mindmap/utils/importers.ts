/**
 * 知识导图导入器
 *
 * 支持格式：
 * - .xmind（content.json / content.xml，zip 流式读 + 体积上限）
 * - .mmap（MindManager，zip 内 Document.xml，与后端 chat 导入能力对齐）
 * - OPML (Outline Processor Markup Language)
 * - Markdown（大纲格式，与粘贴解析共用 pasteMarkdown 真源）
 * - .mm 大纲文件（XML）
 * - JSON（原生格式）
 */

import { nanoid } from 'nanoid';
import i18n from 'i18next';
import JSZip from 'jszip';
import type {
  MindMapAssociation, MindMapDocument, MindMapImage, MindMapNode, MindMapSheetMeta,
} from '../types';
import { markdownListToNodes } from './pasteMarkdown';
import { createImageSanitizeBudget, sanitizeNodeImages } from './imageSanitize';

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

interface XmindTopicJson {
  id?: string;
  title?: string;
  notes?: {
    plain?: { content?: string };
    html?: { content?: string };
  };
  markers?: Array<{ markerId?: string }>;
  labels?: string[];
  /** 主题图片（可解析的小图内联嵌入；其余计数上报并留备注占位） */
  image?: { src?: string; width?: unknown; height?: unknown };
  /** 主题概要（导入时丢弃，仅计数用于导入报告） */
  summaries?: unknown[];
  children?: {
    attached?: XmindTopicJson[];
    summary?: XmindTopicJson[];
  };
}

/**
 * .xmind 导入丢弃项统计（P3 导入报告）。
 * 传入 importFromXmindZip 可选参数收集静默丢弃的图片/概要数量，供 UI toast 展示。
 * embeddedImages 记录成功内联为 data URL 的小图数量（不算丢弃）。
 */
export interface XmindImportReport {
  droppedImages: number;
  droppedSummaries: number;
  embeddedImages: number;
}

export function createXmindImportReport(): XmindImportReport {
  return { droppedImages: 0, droppedSummaries: 0, embeddedImages: 0 };
}

/** .xmind sheet 级关联线（自由连线，非父子边） */
interface XmindRelationshipJson {
  id?: string;
  end1Id?: string;
  end2Id?: string;
  title?: string;
}

/**
 * .xmind 任务进度 marker → completed。
 * task-done 视为已完成，其余 task-*（start/half/quarter 等中间进度）视为未完成任务。
 */
function taskMarkerToCompleted(markerIds: string[]): boolean | undefined {
  const taskMarker = markerIds.find((id) => id.startsWith('task-'));
  if (!taskMarker) return undefined;
  return taskMarker === 'task-done';
}

/**
 * .xmind 非任务元数据 → 可用字段的降级映射（B9）：
 * - `priority-N` marker → 正文前缀 `[PN] `（优先级在源文件中高可见，保留到标题）；
 * - labels → 备注附注行「标签：…」；
 * - 其余非 task/priority marker（flag/star/smiley 等）→ 备注附注行「.xmind 标记：…」。
 *
 * 明确不支持（导入时静默丢弃）：主题样式/结构样式、图片与附件、概要（summary）、
 * 外框（boundary）、超链接、录音备注、标注（callout）；detached 浮动主题为有意忽略
 * （见 importFromXmindZip 各转换器与既有测试）。
 */
function collectXmindExtras(
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

function allocateXmindNodeId(
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

/**
 * 图片节点降级占位（B12）：无法内联嵌入的图片不再完全静默丢弃，
 * 而是在备注中保留占位说明（原主题含几张图片），配合导入报告 toast 提示。
 */
function imagePlaceholderLines(droppedImageCount: number): string[] {
  if (droppedImageCount <= 0) return [];
  return [i18n.t('mindmap:import.imagePlaceholderNote', {
    count: droppedImageCount,
    defaultValue: '[Image placeholder] The original topic contained {{count}} image(s) that could not be embedded',
  })];
}

// ============================================================================
// 内嵌图片提取（.xmind zip 内 resources/attachments 小图 → data URL）
// ============================================================================

/** 单张内联图片的体积上限；超过则降级为备注占位（避免文档 JSON 膨胀） */
export const MAX_INLINE_IMAGE_BYTES = 256 * 1024;

/** 整次导入可内联的图片数量上限；超出的引用直接降级为备注占位 */
export const MAX_IMPORT_IMAGE_COUNT = 128;

/**
 * 整次导入的图片累计解压字节预算（瞬时内存防线）：
 * 高度可压缩的重复内容可以把大量图片装进 16 MiB 压缩包，
 * 单图 256 KiB 上限乘以节点数上限（10000）理论上仍可达 GiB 级，必须有累计硬顶。
 * 该预算按「实际解压出的字节」记账（含最终未内联的图片），在流式读取中途硬中断。
 */
export const MAX_IMPORT_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * 整次导入的内联 data URL 累计字符预算（文档持久化体积防线）：
 * base64 比原始字节膨胀约 1/3，这里限制的是真正写进文档 JSON 的字符量。
 */
export const MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/** 转换阶段（同步）收集的图片引用；zip 解析（异步）在拓扑构建完成后统一进行 */
interface PendingNodeImage {
  node: MindMapNode;
  src?: string;
  width?: number;
  height?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : value;
  return typeof num === 'number' && Number.isFinite(num) && num > 0 ? num : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * 单次导入的图片预算（对整个 resolvePendingImages 调用即整次导入生效）。
 * 三条独立防线：图片数量、累计解压字节（瞬时内存）、累计内联字符（文档体积）。
 */
interface ImageImportBudget {
  imagesRemaining: number;
  decompressedBytesRemaining: number;
  inlineBytesRemaining: number;
}

function createImageImportBudget(): ImageImportBudget {
  return {
    imagesRemaining: MAX_IMPORT_IMAGE_COUNT,
    decompressedBytesRemaining: MAX_IMPORT_IMAGE_TOTAL_BYTES,
    inlineBytesRemaining: MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES,
  };
}

/** 尝试把一条图片引用内联进节点；成功返回 true，失败（缺资源/超限/超预算/类型不明）返回 false */
async function tryEmbedImage(
  zip: JSZip,
  item: PendingNodeImage,
  budget: ImageImportBudget,
): Promise<boolean> {
  const raw = item.src?.trim();
  if (!raw) return false;
  // .xmind 内部引用形如 xap:resources/xxx.png 或 xap:attachments/xxx.png
  const path = raw.replace(/^xap:/i, '').replace(/^\/+/, '');
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_MIME_BY_EXT[ext];
  if (!mime) return false;
  const entry = zip.file(path);
  if (!entry) return false;
  if (budget.imagesRemaining <= 0) return false;

  // 解压前前置拒绝：advertised uncompressed size 超过单图上限或剩余累计预算时
  // 一个字节都不解压。zip 头部字段可伪造，所以这只是省内存的快路径，
  // 真正的防线是 readZipEntryWithLimit 内的流式累计硬中断。
  const perImageLimit = Math.min(MAX_INLINE_IMAGE_BYTES, budget.decompressedBytesRemaining);
  if (perImageLimit <= 0) return false;
  const advertised = zipEntryAdvertisedSize(entry);
  if (advertised !== undefined && advertised > perImageLimit) return false;

  let bytes: Uint8Array;
  try {
    bytes = await readZipEntryWithLimit(
      entry,
      perImageLimit,
      `image exceeds inline limit (${perImageLimit} bytes)`,
    );
  } catch {
    return false;
  }
  if (bytes.byteLength === 0) return false;
  // 解压预算按实际解压字节记账，即使后面因内联预算不足而放弃该图
  budget.decompressedBytesRemaining -= bytes.byteLength;

  const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  if (dataUrl.length > budget.inlineBytesRemaining) return false;
  budget.imagesRemaining -= 1;
  budget.inlineBytesRemaining -= dataUrl.length;

  const image: MindMapImage = {
    src: dataUrl,
    name: path.split('/').pop(),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
  };
  item.node.images = [...(item.node.images ?? []), image];
  return true;
}

/**
 * 统一解析转换阶段收集的图片引用：
 * 可内联的挂到 node.images（导入报告计 embeddedImages），
 * 其余按节点聚合计入 droppedImages 并在备注追加占位行（保持既有降级行为）。
 * 整次导入共享一份图片预算（数量/累计解压字节/累计内联字符）。
 */
async function resolvePendingImages(
  zip: JSZip,
  pending: PendingNodeImage[],
  report?: XmindImportReport,
): Promise<void> {
  const budget = createImageImportBudget();
  const droppedByNode = new Map<MindMapNode, number>();
  for (const item of pending) {
    if (await tryEmbedImage(zip, item, budget)) {
      if (report) report.embeddedImages += 1;
    } else {
      droppedByNode.set(item.node, (droppedByNode.get(item.node) ?? 0) + 1);
      if (report) report.droppedImages += 1;
    }
  }
  for (const [node, count] of droppedByNode) {
    node.note = composeNote(node.note, imagePlaceholderLines(count));
  }
}

function xmindJsonTopicToNode(
  topic: XmindTopicJson,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  forceRoot = false,
  report?: XmindImportReport,
  pendingImages?: PendingNodeImage[],
): MindMapNode {
  claimImportedNode(stats, depth, '.xmind');
  // 导入报告：概要在本应用模型中不支持，计数上报；
  // 图片引用先收集，拓扑构建完成后统一尝试从 zip 内联（失败才计丢弃+备注占位）
  if (report) {
    if (Array.isArray(topic.summaries)) report.droppedSummaries += topic.summaries.length;
    else if (Array.isArray(topic.children?.summary)) {
      report.droppedSummaries += topic.children.summary.length;
    }
  }
  const plainNote = topic.notes?.plain?.content?.trim();
  const htmlNote = stripHtml(topic.notes?.html?.content);
  const assignedId = allocateXmindNodeId(topic.id, usedIds, forceRoot);
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
  const extras = collectXmindExtras(markerIds, labels);
  const node: MindMapNode = {
    id: assignedId,
    text: extras.textPrefix + (topic.title?.trim() || i18n.t('mindmap:import.unnamedTopic')),
    note: composeNote(plainNote || htmlNote, extras.noteSuffixLines),
    ...(completed !== undefined ? { completed } : {}),
    children: (topic.children?.attached || []).map((child) =>
      xmindJsonTopicToNode(child, depth + 1, stats, usedIds, idMap, false, report, pendingImages)),
  };
  if (topic.image && typeof topic.image === 'object') {
    pendingImages?.push({
      node,
      src: typeof topic.image.src === 'string' ? topic.image.src : undefined,
      width: toFiniteNumber(topic.image.width),
      height: toFiniteNumber(topic.image.height),
    });
  }
  return node;
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

/** 按 localName 匹配属性（.xmind XML 属性常带命名空间前缀：xhtml:src / svg:width） */
function attrByLocalName(element: Element, localName: string): string | undefined {
  for (const attr of Array.from(element.attributes)) {
    if (attr.localName === localName) return attr.value;
  }
  return undefined;
}

function xmindXmlTopicToNode(
  topic: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  forceRoot = false,
  report?: XmindImportReport,
  pendingImages?: PendingNodeImage[],
): MindMapNode {
  claimImportedNode(stats, depth, '.xmind');
  // 导入报告：<summaries><summary> 计数；<xhtml:img>（localName=img）先收集引用，
  // 拓扑构建完成后统一尝试从 zip 内联（失败才计丢弃+备注占位）
  const imageElements = directChildrenByLocalName(topic, 'img');
  if (report) {
    const summariesContainer = directChildrenByLocalName(topic, 'summaries')[0];
    if (summariesContainer) {
      report.droppedSummaries += directChildrenByLocalName(summariesContainer, 'summary').length;
    }
  }
  const title = directChildrenByLocalName(topic, 'title')[0]?.textContent?.trim();
  const notes = directChildrenByLocalName(topic, 'notes')[0];
  const note = notes
    ? firstDescendantByLocalName(notes, 'plain')?.textContent?.trim()
      || firstDescendantByLocalName(notes, 'html')?.textContent?.trim()
      || undefined
    : undefined;
  // XML marker：<marker-refs><marker-ref marker-id="task-done"/></marker-refs>
  const markerRefs = directChildrenByLocalName(topic, 'marker-refs')[0];
  const markerIds = markerRefs
    ? directChildrenByLocalName(markerRefs, 'marker-ref')
      .map((ref) => ref.getAttribute('marker-id'))
      .filter((id): id is string => !!id)
    : [];
  const completed = taskMarkerToCompleted(markerIds);
  // XML labels：<labels><label>…</label></labels>
  const labelsContainer = directChildrenByLocalName(topic, 'labels')[0];
  const labels = labelsContainer
    ? directChildrenByLocalName(labelsContainer, 'label')
      .map((label) => label.textContent?.trim())
      .filter((label): label is string => !!label)
    : [];
  const extras = collectXmindExtras(markerIds, labels);
  const childrenContainer = directChildrenByLocalName(topic, 'children')[0];
  const topicsGroups = childrenContainer
    ? directChildrenByLocalName(childrenContainer, 'topics').filter(
      (group) => !group.getAttribute('type') || group.getAttribute('type') === 'attached',
    )
    : [];
  const childTopics = topicsGroups.flatMap((group) => directChildrenByLocalName(group, 'topic'));
  const originalId = topic.getAttribute('id') || undefined;
  const assignedId = allocateXmindNodeId(originalId, usedIds, forceRoot);
  if (originalId && !idMap.has(originalId)) {
    idMap.set(originalId, assignedId);
  }
  const node: MindMapNode = {
    id: assignedId,
    text: extras.textPrefix + (title || i18n.t('mindmap:import.unnamedTopic')),
    note: composeNote(note, extras.noteSuffixLines),
    ...(completed !== undefined ? { completed } : {}),
    children: childTopics.map((child) =>
      xmindXmlTopicToNode(child, depth + 1, stats, usedIds, idMap, false, report, pendingImages)),
  };
  for (const img of imageElements) {
    pendingImages?.push({
      node,
      src: attrByLocalName(img, 'src'),
      width: toFiniteNumber(attrByLocalName(img, 'width')),
      height: toFiniteNumber(attrByLocalName(img, 'height')),
    });
  }
  return node;
}

/**
 * 把 .xmind 关联线端点重映射到导入后的节点 id，丢弃端点缺失/自指的连线。
 */
function remapXmindRelationships(
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

function createXmindDocument(
  root: MindMapNode,
  associations?: MindMapAssociation[],
  sheets?: MindMapSheetMeta[],
): MindMapDocument {
  return {
    version: '1.0',
    root,
    meta: {
      createdAt: new Date().toISOString(),
      ...(sheets && sheets.length > 0 ? { sheets } : {}),
    },
    ...(associations && associations.length > 0 ? { associations } : {}),
  };
}

/**
 * 多 sheet 文件保持「合成虚拟根」策略（运行时仍是单树模型），
 * 但在根备注中说明来源，并把 sheet → 一级子节点的对应关系记录到
 * meta.sheets（多 sheet 数据模型第一步，未来多画布 UI 可直接升格）。
 */
function createMultiSheetRoot(
  children: MindMapNode[],
  sheetTitles: string[],
): { root: MindMapNode; sheets: MindMapSheetMeta[] } {
  const normalizedTitles = sheetTitles.map(
    (title) => title.trim() || i18n.t('mindmap:import.unnamedTopic'),
  );
  const root: MindMapNode = {
    id: 'root',
    text: i18n.t('mindmap:import.importedMap'),
    note: i18n.t('mindmap:import.multiSheetNote', {
      count: children.length,
      titles: normalizedTitles.join(', '),
    }),
    children,
  };
  const sheets: MindMapSheetMeta[] = children.map((child, index) => ({
    id: `sheet_${nanoid(8)}`,
    title: normalizedTitles[index] ?? i18n.t('mindmap:import.unnamedTopic'),
    rootNodeId: child.id,
  }));
  return { root, sheets };
}

interface XmindStreamHelper {
  on(event: 'data', callback: (chunk: Uint8Array) => void): XmindStreamHelper;
  on(event: 'end', callback: () => void): XmindStreamHelper;
  on(event: 'error', callback: (error: Error) => void): XmindStreamHelper;
  pause(): XmindStreamHelper;
  resume(): XmindStreamHelper;
}

/** JSZip 内部记录的 advertised uncompressed size（zip 头部声明值，可被伪造，仅作前置拒绝） */
function zipEntryAdvertisedSize(entry: JSZip.JSZipObject): number | undefined {
  const size = (entry as unknown as {
    _data?: { uncompressedSize?: number };
  })._data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

/**
 * 流式读取 zip entry：先按 advertised size 前置拒绝（省内存快路径），
 * 再在解压过程中做累计字节数硬中断（pause + reject，不等待整个 entry 解压完成）。
 * advertised size 可被伪造，流式累计才是真正的防线。
 */
async function readZipEntryWithLimit(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  limitErrorMessage: string,
): Promise<Uint8Array> {
  const advertisedSize = zipEntryAdvertisedSize(entry);
  if (advertisedSize !== undefined && advertisedSize > maxBytes) {
    throw new Error(limitErrorMessage);
  }

  const stream = (entry as unknown as {
    internalStream(type: 'uint8array'): XmindStreamHelper;
  }).internalStream('uint8array');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    stream
      .on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          settled = true;
          stream.pause();
          reject(new Error(limitErrorMessage));
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
}

async function readXmindContent(entry: JSZip.JSZipObject): Promise<string> {
  const bytes = await readZipEntryWithLimit(
    entry,
    MAX_XMIND_CONTENT_BYTES,
    `.xmind content exceeds maximum size (${MAX_XMIND_CONTENT_BYTES} bytes)`,
  );
  return new TextDecoder().decode(bytes);
}

/**
 * Import .xmind content.json and content.xml as the existing tree model.
 * 可选 report 参数收集被丢弃的图片/概要计数（导入报告，向后兼容）。
 */
export async function importFromXmindZip(
  data: Uint8Array | ArrayBuffer,
  report?: XmindImportReport,
): Promise<MindMapDocument> {
  if (data.byteLength > MAX_XMIND_ARCHIVE_BYTES) {
    throw new Error(`.xmind archive exceeds maximum size (${MAX_XMIND_ARCHIVE_BYTES} bytes)`);
  }
  const zip = await JSZip.loadAsync(data);
  const jsonEntry = zip.file(XMIND_CONTENT_JSON);
  if (jsonEntry) {
    const raw = JSON.parse(await readXmindContent(jsonEntry)) as unknown;
    const candidates = Array.isArray(raw) ? raw : [raw];
    const sheets = candidates.filter((candidate): candidate is {
      title?: string;
      rootTopic: XmindTopicJson;
      relationships?: XmindRelationshipJson[];
    } => {
      if (!candidate || typeof candidate !== 'object' || !('rootTopic' in candidate)) return false;
      const rootTopic = (candidate as { rootTopic?: unknown }).rootTopic;
      return !!rootTopic && typeof rootTopic === 'object';
    });
    if (sheets.length === 0) throw new Error('Invalid .xmind archive: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
    const pendingImages: PendingNodeImage[] = [];
    // sheet 级关联线（拓扑转换完成后统一按 idMap 重映射）
    const rawRelationships = sheets.flatMap((sheet) =>
      (Array.isArray(sheet.relationships) ? sheet.relationships : []).map((rel) => ({
        end1: rel?.end1Id,
        end2: rel?.end2Id,
        label: rel?.title,
      })));
    if (sheets.length === 1) {
      const root = xmindJsonTopicToNode(
        sheets[0].rootTopic, 0, stats, usedIds, idMap, true, report, pendingImages,
      );
      await resolvePendingImages(zip, pendingImages, report);
      return createXmindDocument(root, remapXmindRelationships(rawRelationships, idMap));
    }
    claimImportedNode(stats, 0, '.xmind');
    usedIds.add('root');
    const children = sheets.map((sheet) =>
      xmindJsonTopicToNode(sheet.rootTopic, 1, stats, usedIds, idMap, false, report, pendingImages));
    await resolvePendingImages(zip, pendingImages, report);
    const sheetTitles = sheets.map((sheet) => sheet.title || sheet.rootTopic.title || '');
    const merged = createMultiSheetRoot(children, sheetTitles);
    return createXmindDocument(
      merged.root,
      remapXmindRelationships(rawRelationships, idMap),
      merged.sheets,
    );
  }

  const xmlEntry = zip.file(XMIND_CONTENT_XML);
  if (xmlEntry) {
    const xml = new DOMParser().parseFromString(await readXmindContent(xmlEntry), 'text/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError) throw new Error(`Invalid .xmind XML: ${parserError.textContent}`);
    const sheetElements = Array.from(xml.getElementsByTagName('*'))
      .filter((element) => element.localName === 'sheet');
    const rootTopics = sheetElements
      .map((sheet) => directChildrenByLocalName(sheet, 'topic')[0])
      .filter((topic): topic is Element => !!topic);
    if (rootTopics.length === 0) throw new Error('Invalid .xmind archive: missing root topic');
    const stats = createImportStats();
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
    const pendingImages: PendingNodeImage[] = [];
    // XML relationships：<relationships><relationship end1=".." end2=".."><title>..</title></relationship>
    const rawRelationships = sheetElements
      .flatMap((sheet) => directChildrenByLocalName(sheet, 'relationships'))
      .flatMap((container) => directChildrenByLocalName(container, 'relationship'))
      .map((rel) => ({
        end1: rel.getAttribute('end1') ?? undefined,
        end2: rel.getAttribute('end2') ?? undefined,
        label: directChildrenByLocalName(rel, 'title')[0]?.textContent ?? undefined,
      }));
    if (rootTopics.length === 1) {
      const root = xmindXmlTopicToNode(
        rootTopics[0], 0, stats, usedIds, idMap, true, report, pendingImages,
      );
      await resolvePendingImages(zip, pendingImages, report);
      return createXmindDocument(root, remapXmindRelationships(rawRelationships, idMap));
    }
    claimImportedNode(stats, 0, '.xmind');
    usedIds.add('root');
    const children = rootTopics.map((topic) =>
      xmindXmlTopicToNode(topic, 1, stats, usedIds, idMap, false, report, pendingImages));
    await resolvePendingImages(zip, pendingImages, report);
    // sheet 标题优先取 <sheet><title>，缺失时回退到该 sheet 根主题标题
    const sheetTitles = sheetElements
      .filter((sheet) => directChildrenByLocalName(sheet, 'topic').length > 0)
      .map((sheet) =>
        directChildrenByLocalName(sheet, 'title')[0]?.textContent?.trim()
        || directChildrenByLocalName(
          directChildrenByLocalName(sheet, 'topic')[0], 'title',
        )[0]?.textContent?.trim()
        || '');
    const merged = createMultiSheetRoot(children, sheetTitles);
    return createXmindDocument(
      merged.root,
      remapXmindRelationships(rawRelationships, idMap),
      merged.sheets,
    );
  }

  throw new Error('Invalid .xmind archive: content.json or content.xml not found');
}

// ============================================================================
// .mmap（MindManager）导入
// ============================================================================

function mmapTopicToNode(
  topic: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, '.mmap');
  // MindManager 结构：<Topic><Text PlainText="…"/><SubTopics><Topic/>…</SubTopics></Topic>
  const text = directChildrenByLocalName(topic, 'Text')[0]
    ?.getAttribute('PlainText')
    ?.trim();
  const children = directChildrenByLocalName(topic, 'SubTopics')
    .flatMap((container) => directChildrenByLocalName(container, 'Topic'))
    .map((child) => mmapTopicToNode(child, depth + 1, stats, usedIds));
  return {
    id: allocateXmindNodeId(topic.getAttribute('OId') ?? undefined, usedIds, forceRoot),
    text: text || i18n.t('mindmap:import.unnamedTopic'),
    children,
  };
}

/**
 * 从 .mmap（MindManager，zip 内 Document.xml）导入。
 * 结构解析与后端 chat 附件导入（builtin_resource_executor::parse_mmap_to_mindmap）
 * 对齐：OneTopic → Topic 为根，Text@PlainText 为标题，SubTopics/Topic 递归。
 * 样式、图标、备注等 MindManager 专有数据不支持（静默丢弃）。
 */
export async function importFromMmapZip(data: Uint8Array | ArrayBuffer): Promise<MindMapDocument> {
  if (data.byteLength > MAX_XMIND_ARCHIVE_BYTES) {
    throw new Error(`.mmap archive exceeds maximum size (${MAX_XMIND_ARCHIVE_BYTES} bytes)`);
  }
  const zip = await JSZip.loadAsync(data);
  const entry = zip.file('Document.xml');
  if (!entry) {
    throw new Error('Invalid .mmap archive: Document.xml not found');
  }
  const xml = new DOMParser().parseFromString(await readXmindContent(entry), 'text/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) throw new Error(`Invalid .mmap Document.xml: ${parserError.textContent}`);

  const oneTopic = Array.from(xml.getElementsByTagName('*')).find(
    (element) => element.localName.toLowerCase() === 'onetopic',
  );
  if (!oneTopic) throw new Error('Invalid .mmap archive: missing OneTopic element');
  const rootTopic = directChildrenByLocalName(oneTopic, 'Topic')[0];
  if (!rootTopic) throw new Error('Invalid .mmap archive: OneTopic has no Topic');

  const stats = createImportStats();
  const usedIds = new Set<string>();
  const root = mmapTopicToNode(rootTopic, 0, stats, usedIds, true);
  return {
    version: '1.0',
    root,
    meta: { createdAt: new Date().toISOString() },
  };
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
 * - _complete="true|false"（本应用导出的完成态属性）
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
  // 常见大纲工具的注释属性为 _note；note 作为兼容兜底
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
 * - 纯缩进大纲（无项目符号）；
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
// .mm 导入
// ============================================================================

/**
 * 提取 .mm 节点的 richcontent 文本。
 * - TYPE="NODE"：富文本正文（替代 TEXT 属性），折叠为单行；
 * - TYPE="NOTE"：备注，保留行结构（逐行 trim 后以 \n 连接）。
 */
function mmRichContentText(
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

function mmNodeToNode(
  element: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  arrows: Array<{ end1?: string; end2?: string; label?: string }>,
  forceRoot = false,
): MindMapNode {
  claimImportedNode(stats, depth, '.mm');
  const attrText = element.getAttribute('TEXT') ?? element.getAttribute('text');
  const text =
    attrText?.trim()
    || mmRichContentText(element, 'NODE')
    || i18n.t('mindmap:import.unnamedTopic');
  const note = mmRichContentText(element, 'NOTE');

  const originalId = element.getAttribute('ID') || element.getAttribute('id') || undefined;
  const assignedId = allocateXmindNodeId(originalId, usedIds, forceRoot);
  // 源 ID → 实际节点 ID；无源 ID 时登记 assignedId 自映射，供 arrowlink 端点重映射
  const mapKey = originalId ?? assignedId;
  if (!idMap.has(mapKey)) idMap.set(mapKey, assignedId);

  // .mm 完成态图标：button_ok → 已完成，button_cancel → 未完成任务
  const icons = directChildrenByLocalName(element, 'icon')
    .map((icon) => icon.getAttribute('BUILTIN'))
    .filter((id): id is string => !!id);
  const completed = icons.includes('button_ok')
    ? true
    : icons.includes('button_cancel')
      ? false
      : undefined;

  // <arrowlink DESTINATION="…"/>：.mm 自由连线 → 关联线
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
      mmNodeToNode(child, depth + 1, stats, usedIds, idMap, arrows)),
  };
}

/**
 * 从 `.mm`（XML）导入：标题 + 备注层级、
 * button_ok/button_cancel 图标 → 完成态、arrowlink → 关联线。
 * 不支持（静默丢弃）：云朵（cloud）、节点样式/颜色/字体、内嵌图片、
 * 属性（attribute）、hook 插件数据。
 */
export function importFromMmOutline(xmlContent: string): MindMapDocument {
  const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`Invalid .mm XML: ${parserError.textContent}`);
  }

  const mapElement = doc.documentElement?.localName?.toLowerCase() === 'map'
    ? doc.documentElement
    : null;
  if (!mapElement) {
    throw new Error('Invalid .mm: missing map element');
  }

  const rootElements = directChildrenByLocalName(mapElement, 'node');
  if (rootElements.length === 0) {
    throw new Error('Invalid .mm: no node elements found');
  }

  const stats = createImportStats();
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  const arrows: Array<{ end1?: string; end2?: string; label?: string }> = [];

  let root: MindMapNode;
  if (rootElements.length === 1) {
    root = mmNodeToNode(rootElements[0], 0, stats, usedIds, idMap, arrows, true);
  } else {
    claimImportedNode(stats, 0, '.mm');
    usedIds.add('root');
    root = {
      id: 'root',
      text: i18n.t('mindmap:import.importedMap'),
      children: rootElements.map((element) =>
        mmNodeToNode(element, 1, stats, usedIds, idMap, arrows)),
    };
  }

  const associations = remapXmindRelationships(arrows, idMap);
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

  // 图片清洗预算整次导入共享一份（与 xmind 导入的 resolvePendingImages 同一原则）
  const imageBudget = createImageSanitizeBudget();

  // 确保所有节点都有 ID（带深度限制），并对 images 做运行时清洗：
  // 对象展开会保留任意字段，image.src 未经校验就会直接交给 <img> 渲染——
  // 这里按白名单重建（data URL MIME/体积 + https allowlist），不合法项删除。
  function ensureIds(node: MindMapNode, depth: number = 0): MindMapNode {
    // 深度限制检查
    const result: MindMapNode =
      depth > MAX_IMPORT_DEPTH
        ? {
            ...node,
            id: node.id || nanoid(10),
            children: [],
          }
        : {
            ...node,
            id: node.id || nanoid(10),
            children: (node.children || []).map(child => ensureIds(child, depth + 1)),
          };
    if ('images' in result) {
      const images = sanitizeNodeImages((node as { images?: unknown }).images, imageBudget);
      if (images) result.images = images;
      else delete result.images;
    }
    return result;
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

export type ImportFormat =
  | 'opml' | 'markdown' | 'json' | 'mm' | 'xmind' | 'mmap'
  /** 已确认是 XML 但既非 OPML 也非 .mm（importMindMap 报明确错误，不再误报 Invalid OPML） */
  | 'unknown-xml'
  | 'auto';

/** zip 包（.xmind / .mmap）魔数：PK\x03\x04 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * 自动检测格式（基于文本内容）。
 * - zip 魔数被解码为文本时也能识别为 xmind（但二进制内容需走 importFromFile /
 *   importFromXmindZip 的字节路径，本函数只做提示性识别）；
 * - XML 按根元素区分 opml / mm；其他 XML 根元素返回 'unknown-xml'——
 *   不再回退 opml 导致「Invalid OPML: missing body element」这类误导性报错。
 */
export function detectFormat(content: string): Exclude<ImportFormat, 'auto'> {
  const trimmed = content.trim();

  if (trimmed.startsWith('PK\u0003\u0004')) {
    return 'xmind';
  }

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    // 只嗅探开头片段，避免对超大文件做整体正则
    const head = trimmed.slice(0, 4096);
    if (/<opml[\s>/]/i.test(head)) return 'opml';
    if (/<map[\s>/]/i.test(head)) return 'mm';
    // 提取首个真实元素名（跳过 XML 声明 / DOCTYPE / 注释）：
    // 能解析出元素说明确实是 XML/HTML 文档，但不是我们认识的导图格式
    const withoutProlog = head.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>/g, '').trimStart();
    if (/^<[A-Za-z_][\w:.-]*/.test(withoutProlog)) return 'unknown-xml';
    if (trimmed.startsWith('<?xml')) return 'unknown-xml';
  }

  if (trimmed.startsWith('{')) {
    return 'json';
  }

  return 'markdown';
}

/**
 * 统一导入接口（文本内容）。
 * .xmind / .mmap 是 zip 二进制格式，无法从字符串导入——
 * 请使用 importFromFile 或 importFromXmindZip / importFromMmapZip。
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
    case 'mm':
      return importFromMmOutline(content);
    case 'xmind':
      throw new Error('.xmind import requires binary data; use importFromFile or importFromXmindZip');
    case 'mmap':
      throw new Error('.mmap import requires binary data; use importFromFile or importFromMmapZip');
    case 'unknown-xml':
      // 明确报「不认识的 XML 根元素」，而不是把任意 XML 塞给 OPML 解析器误报 Invalid OPML
      throw new Error(
        'Unrecognized XML mind map format: expected an OPML (<opml>) or FreeMind (<map>) document',
      );
    default:
      throw new Error(`Unsupported import format: ${actualFormat}`);
  }
}

/**
 * 从文件导入。
 * ★ B11 修复：扩展名路由补齐 .xmind / .mmap（二进制 zip）与 .mm（XML）；
 * 无扩展名时按 zip 魔数嗅探（zip 内容按文本解码会损坏，必须走字节路径），
 * 先按 .xmind 解析、失败再按 .mmap 解析——与后端 chat 附件导入顺序一致。
 */
export async function importFromFile(file: File): Promise<MindMapDocument> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'xmind') {
    return importFromXmindZip(await file.arrayBuffer());
  }

  if (extension === 'mmap') {
    return importFromMmapZip(await file.arrayBuffer());
  }

  if (extension !== 'opml' && extension !== 'json' && extension !== 'md'
    && extension !== 'markdown' && extension !== 'mm' && extension !== 'txt') {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (looksLikeZip(head)) {
      const bytes = await file.arrayBuffer();
      try {
        return await importFromXmindZip(bytes);
      } catch (xmindError) {
        try {
          return await importFromMmapZip(bytes);
        } catch (mmapError) {
          throw new Error(
            `Unrecognized zip mind map file. .xmind: ${
              xmindError instanceof Error ? xmindError.message : String(xmindError)
            }; .mmap: ${mmapError instanceof Error ? mmapError.message : String(mmapError)}`,
          );
        }
      }
    }
  }

  const content = await file.text();

  let format: ImportFormat = 'auto';
  if (extension === 'opml') {
    format = 'opml';
  } else if (extension === 'json') {
    format = 'json';
  } else if (extension === 'md' || extension === 'markdown' || extension === 'txt') {
    // .txt：纯缩进大纲，与 Markdown 共用 markdownListToNodes 解析（支持无项目符号的缩进层级）
    format = 'markdown';
  } else if (extension === 'mm') {
    format = 'mm';
  }

  return importMindMap(content, format);
}
