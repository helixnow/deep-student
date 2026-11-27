import type React from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { nanoid } from 'nanoid';
import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { extractFileName, extractDisplayFileName, fileManager } from '@/utils/fileManager';
import { TauriAPI } from '@/utils/tauriApi';
import { dstu, type DstuNode } from '@/dstu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import i18n from '@/i18n';
import type { ImportProgressState, ImportStage } from '../components/ImportProgressModal';
import type { FinderPath } from '../stores/finderStore';
import { dstuNodeToResourceListItem } from '../types';
import type { LearningHubSidebarProps } from '../types';
import {
  consumePathsDropHandledFlag,
  formatFailedImportSummary,
  isDragDropBlockedView,
  partitionMarkdownNoteImports,
  resolveImportFormatOptions,
} from '../dragDropRouting';
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MODULE_GUIDANCE_EXTENSIONS,
  getFileExtension,
  type SidebarT,
  type TextbookImportProgress,
} from './sidebarConstants';
import type { MarkdownNoteImport } from './useMarkdownNoteImport';
import { canParseAsMobileTextbook, withStagedTextbookFile } from '../textbookFileImport';
import { findCompleteZipEndOffset } from '../apps/views/officeZipContainer';

type AttachImportProgress = { done: number; total: number } | null;

interface ImportQueueState {
  tail: Promise<void>;
  pendingCount: number;
  activeFingerprints: Set<string>;
  lastAutoOpenedPdfAt: number;
}

const AUTO_OPEN_PDF_COOLDOWN_MS = 10_000;

// U03 弱网连点幂等 + 串行队列：按侧栏实例（isMountedRef）隔离，跨重渲染稳定且卸载自动 GC；
// 相同文件指纹（name+size+lastModified / path）在途去重，不同文件按 FIFO 排队绝不静默丢弃。
const importQueueByInstance = new WeakMap<object, ImportQueueState>();

function getImportQueueState(instanceKey: object): ImportQueueState {
  let state = importQueueByInstance.get(instanceKey);
  if (!state) {
    state = {
      tail: Promise.resolve(),
      pendingCount: 0,
      activeFingerprints: new Set<string>(),
      lastAutoOpenedPdfAt: 0,
    };
    importQueueByInstance.set(instanceKey, state);
  }
  return state;
}

function getFileImportFingerprint(file: File): string {
  return `file::${file.name}::${file.size}::${file.lastModified}`;
}

function getPathImportFingerprint(filePath: string): string {
  return `path::${filePath}`;
}

async function enqueueImportBatch<T>(
  instanceKey: object,
  items: T[],
  getFingerprint: (item: T) => string,
  run: (queuedItems: T[], queueState: ImportQueueState) => Promise<void>,
): Promise<void> {
  const state = getImportQueueState(instanceKey);
  const queuedItems: T[] = [];
  const addedFingerprints: string[] = [];

  for (const item of items) {
    const fp = getFingerprint(item);
    if (state.activeFingerprints.has(fp)) continue;
    state.activeFingerprints.add(fp);
    addedFingerprints.push(fp);
    queuedItems.push(item);
  }

  if (queuedItems.length === 0) return;

  const prev = state.pendingCount > 0 ? state.tail : null;
  state.pendingCount += 1;
  let releaseTail!: () => void;
  state.tail = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });

  try {
    if (prev) {
      await prev;
    }
    await run(queuedItems, state);
  } finally {
    for (const fp of addedFingerprints) {
      state.activeFingerprints.delete(fp);
    }
    state.pendingCount = Math.max(0, state.pendingCount - 1);
    releaseTail();
  }
}

/** 当前侧栏实例是否存在在途或排队中的导入（供工具栏「导入资料」防连点复用） */
export function isImportActionInFlight(isMountedRef: object): boolean {
  const state = importQueueByInstance.get(isMountedRef);
  return Boolean(state && state.pendingCount > 0);
}

const UPLOAD_MIME_FALLBACKS: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonc: 'application/jsonc',
  jsonl: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  vtt: 'text/vtt',
  xmind: 'application/vnd.xmind.workbook',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
};

/**
 * 浏览器/OS 对 Office（本质为 ZIP 容器）或无注册关联的文件常上报空串、
 * application/octet-stream 或 application/zip；若扩展名有明确规范 MIME，
 * 优先使用规范 MIME，避免后端按 .bin/.zip 落盘或误判格式。
 */
const GENERIC_BROWSER_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-msdownload',
]);

export function resolveUploadMimeType(fileName: string, providedType?: string, isImage = false): string {
  const trimmed = providedType?.trim() ?? '';
  const normalized = trimmed.toLowerCase();
  const ext = getFileExtension(fileName);
  const canonicalByExt = UPLOAD_MIME_FALLBACKS[ext];
  if (canonicalByExt && (!normalized || GENERIC_BROWSER_MIME_TYPES.has(normalized))) {
    return canonicalByExt;
  }
  if (trimmed) return trimmed;
  if (isImage) return `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`;
  return 'application/octet-stream';
}

function stripFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

const MINDMAP_IMPORT_EXTENSIONS = new Set(['xmind', 'mmap', 'opml', 'mm']);
const MAX_MINDMAP_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_MINDMAP_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_MINDMAP_IMPORT_DEPTH = 100;
const MAX_MINDMAP_IMPORT_NODES = 10_000;

interface ImportedMindMapNode {
  id: string;
  text: string;
  note?: string;
  priority?: 1 | 2 | 3 | 4 | 5 | 6;
  completed?: boolean;
  style?: { bgColor?: string };
  children: ImportedMindMapNode[];
}

interface ImportedMindMapAssociation {
  id: string;
  source: string;
  target: string;
  label?: string;
}

interface ImportedMindMapSummary {
  id: string;
  parentId: string;
  startChildId: string;
  endChildId: string;
  label: string;
}

interface ImportedMindMapDocument {
  version: '1.0';
  root: ImportedMindMapNode;
  associations?: ImportedMindMapAssociation[];
  summaries?: ImportedMindMapSummary[];
  meta: {
    createdAt: string;
    sheets?: Array<{ id: string; title: string; rootNodeId: string }>;
  };
}

interface XmindTopicJson {
  id?: string;
  title?: string;
  notes?: { plain?: { content?: string } } | string;
  labels?: string[];
  markers?: Array<{ markerId?: string }>;
  style?: { properties?: Record<string, string> };
  children?: {
    attached?: XmindTopicJson[];
    summary?: XmindTopicJson[];
  };
  summaries?: Array<{ id?: string; range?: string; topicId?: string }>;
}

function normalizeZipArchiveBytes(bytes: Uint8Array): Uint8Array | null {
  const endOffset = findCompleteZipEndOffset(bytes);
  if (endOffset === null) return null;
  return endOffset < bytes.length ? bytes.subarray(0, endOffset) : bytes;
}

function allocateMindmapNodeId(
  preferred: string | undefined,
  usedIds: Set<string>,
  forceRoot = false,
): string {
  if (forceRoot) {
    usedIds.add('root');
    return 'root';
  }
  const candidate = preferred?.trim();
  if (candidate && candidate !== 'root' && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }
  let generated = nanoid(10);
  while (usedIds.has(generated) || generated === 'root') {
    generated = nanoid(10);
  }
  usedIds.add(generated);
  return generated;
}

function claimMindmapNode(stats: { nodeCount: number }, depth: number, format: string): void {
  if (depth > MAX_MINDMAP_IMPORT_DEPTH) {
    throw new Error(`${format} depth exceeds maximum limit (${MAX_MINDMAP_IMPORT_DEPTH})`);
  }
  stats.nodeCount += 1;
  if (stats.nodeCount > MAX_MINDMAP_IMPORT_NODES) {
    throw new Error(`${format} node count exceeds maximum limit (${MAX_MINDMAP_IMPORT_NODES})`);
  }
}

function directChildrenByLocalName(parent: Element, localName: string): Element[] {
  const target = localName.toLowerCase();
  return Array.from(parent.children).filter(
    (child) => child.localName.toLowerCase() === target,
  );
}

function parseMarkerSemantics(markerIds: string[]): {
  completed?: boolean;
  priority?: 1 | 2 | 3 | 4 | 5 | 6;
  otherMarkers: string[];
} {
  let completed: boolean | undefined;
  let priority: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
  const otherMarkers: string[] = [];

  for (const rawId of markerIds) {
    const id = rawId.trim();
    if (!id) continue;
    if (id === 'task-done') {
      completed = true;
      continue;
    }
    if (id.startsWith('task-')) {
      completed ??= false;
      continue;
    }
    const priorityMatch = /^priority-([1-6])$/.exec(id);
    if (priorityMatch) {
      priority ??= Number(priorityMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      continue;
    }
    otherMarkers.push(id);
  }
  return { completed, priority, otherMarkers };
}

function buildMindmapNote(baseNote: string | undefined, labels: string[], markers: string[]): string | undefined {
  const lines: string[] = [];
  const trimmedBase = baseNote?.trim();
  if (trimmedBase) lines.push(trimmedBase);
  const cleanLabels = labels.map((l) => l.trim()).filter(Boolean);
  if (cleanLabels.length > 0) {
    lines.push(i18n.t('mindmap:import.labelsNote', {
      labels: cleanLabels.join(', '),
      defaultValue: `Labels: ${cleanLabels.join(', ')}`,
    }));
  }
  if (markers.length > 0) {
    lines.push(i18n.t('mindmap:import.markersNote', {
      markers: markers.join(', '),
      defaultValue: `.xmind markers: ${markers.join(', ')}`,
    }));
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function remapMindmapAssociations(
  raw: Array<{ end1?: string; end2?: string; label?: string }>,
  idMap: Map<string, string>,
): ImportedMindMapAssociation[] {
  const seen = new Set<string>();
  const out: ImportedMindMapAssociation[] = [];
  for (const rel of raw) {
    if (!rel.end1 || !rel.end2) continue;
    const source = idMap.get(rel.end1);
    const target = idMap.get(rel.end2);
    if (!source || !target || source === target) continue;
    const pairKey = source < target ? `${source}:${target}` : `${target}:${source}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const label = rel.label?.trim().slice(0, 240);
    out.push({
      id: `assoc_${nanoid(8)}`,
      source,
      target,
      ...(label ? { label } : {}),
    });
  }
  return out;
}

function parseSummaryRange(range: string | undefined, childCount: number): [number, number] | null {
  if (!range) return null;
  const match = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(range.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= childCount || end <= start) {
    return null;
  }
  return [start, end];
}

function xmindJsonTopicToNode(
  topic: XmindTopicJson,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  summaries: ImportedMindMapSummary[],
  forceRoot = false,
): ImportedMindMapNode {
  claimMindmapNode(stats, depth, '.xmind');
  const assignedId = allocateMindmapNodeId(topic.id, usedIds, forceRoot);
  if (topic.id) idMap.set(topic.id, assignedId);

  const rawNote = typeof topic.notes === 'string'
    ? topic.notes
    : topic.notes?.plain?.content;
  const markerIds = (Array.isArray(topic.markers) ? topic.markers : [])
    .map((m) => m?.markerId ?? '')
    .filter(Boolean);
  const { completed, priority, otherMarkers } = parseMarkerSemantics(markerIds);
  const labels = Array.isArray(topic.labels)
    ? topic.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const note = buildMindmapNote(rawNote, labels, otherMarkers);
  const attached = Array.isArray(topic.children?.attached) ? topic.children.attached : [];
  const children = attached.map((child) =>
    xmindJsonTopicToNode(child, depth + 1, stats, usedIds, idMap, summaries, false));

  if (Array.isArray(topic.summaries) && Array.isArray(topic.children?.summary)) {
    const summaryTitles = new Map<string, string>();
    for (const sTopic of topic.children.summary) {
      if (sTopic?.id) summaryTitles.set(sTopic.id, sTopic.title?.trim() ?? '');
    }
    for (const sum of topic.summaries) {
      const bounds = parseSummaryRange(sum?.range, children.length);
      if (!bounds) continue;
      const startChild = children[bounds[0]];
      const endChild = children[bounds[1]];
      if (!startChild || !endChild) continue;
      summaries.push({
        id: sum.id?.trim() || `sum_${nanoid(8)}`,
        parentId: assignedId,
        startChildId: startChild.id,
        endChildId: endChild.id,
        label: (sum.topicId ? summaryTitles.get(sum.topicId) : '') || '',
      });
    }
  }

  const bgColor = topic.style?.properties?.['svg:fill']?.trim();
  const safeBgColor = bgColor && (/^#[0-9a-f]{3,8}$/i.test(bgColor) || /^rgba?\([^;{}]+\)$/i.test(bgColor))
    ? bgColor
    : undefined;

  return {
    id: assignedId,
    text: topic.title?.trim() || i18n.t('mindmap:import.unnamedTopic', { defaultValue: 'Untitled topic' }),
    ...(note ? { note } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(completed !== undefined ? { completed } : {}),
    ...(safeBgColor ? { style: { bgColor: safeBgColor } } : {}),
    children,
  };
}

function xmindXmlTopicToNode(
  topic: Element,
  depth: number,
  stats: { nodeCount: number },
  usedIds: Set<string>,
  idMap: Map<string, string>,
  forceRoot = false,
): ImportedMindMapNode {
  claimMindmapNode(stats, depth, '.xmind');
  const rawId = topic.getAttribute('id') ?? undefined;
  const assignedId = allocateMindmapNodeId(rawId, usedIds, forceRoot);
  if (rawId) idMap.set(rawId, assignedId);

  const title = directChildrenByLocalName(topic, 'title')[0]?.textContent?.trim();
  const notesEl = directChildrenByLocalName(topic, 'notes')[0];
  const plainNote = notesEl
    ? directChildrenByLocalName(notesEl, 'plain')[0]?.textContent ?? notesEl.textContent ?? undefined
    : undefined;
  const labels = directChildrenByLocalName(topic, 'labels')
    .flatMap((el) => directChildrenByLocalName(el, 'label'))
    .map((el) => el.textContent ?? '');
  const markerIds = directChildrenByLocalName(topic, 'marker-refs')
    .flatMap((el) => directChildrenByLocalName(el, 'marker-ref'))
    .map((el) => el.getAttribute('marker-id') ?? '')
    .filter(Boolean);
  const { completed, priority, otherMarkers } = parseMarkerSemantics(markerIds);
  const note = buildMindmapNote(plainNote, labels, otherMarkers);

  const attachedTopics = directChildrenByLocalName(topic, 'children')
    .flatMap((container) => directChildrenByLocalName(container, 'topics'))
    .filter((topicsEl) => (topicsEl.getAttribute('type') || 'attached') === 'attached')
    .flatMap((topicsEl) => directChildrenByLocalName(topicsEl, 'topic'));

  return {
    id: assignedId,
    text: title || i18n.t('mindmap:import.unnamedTopic', { defaultValue: 'Untitled topic' }),
    ...(note ? { note } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(completed !== undefined ? { completed } : {}),
    children: attachedTopics.map((child) =>
      xmindXmlTopicToNode(child, depth + 1, stats, usedIds, idMap, false)),
  };
}

async function parseXmindBytesToDocument(bytes: Uint8Array, fallbackTitle: string): Promise<ImportedMindMapDocument> {
  if (bytes.byteLength > MAX_MINDMAP_ARCHIVE_BYTES) {
    throw new Error(`.xmind archive exceeds maximum size (${MAX_MINDMAP_ARCHIVE_BYTES} bytes)`);
  }
  const normalizedBytes = normalizeZipArchiveBytes(bytes);
  if (!normalizedBytes) {
    throw new Error('Invalid or truncated .xmind archive');
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(normalizedBytes);

  const jsonEntry = zip.file('content.json');
  if (jsonEntry) {
    const rawText = await jsonEntry.async('string');
    if (rawText.length > MAX_MINDMAP_CONTENT_BYTES) {
      throw new Error('.xmind content exceeds maximum size');
    }
    const parsed = JSON.parse(rawText) as unknown;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const sheets = candidates.filter((c): c is {
      title?: string;
      rootTopic: XmindTopicJson;
      relationships?: Array<{ end1Id?: string; end2Id?: string; title?: string }>;
    } => Boolean(c && typeof c === 'object' && 'rootTopic' in c && (c as { rootTopic?: unknown }).rootTopic && typeof (c as { rootTopic?: unknown }).rootTopic === 'object'));
    if (sheets.length === 0) throw new Error('Invalid .xmind archive: missing root topic');

    const stats = { nodeCount: 0 };
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
    const summaries: ImportedMindMapSummary[] = [];
    const rawRelationships = sheets.flatMap((s) =>
      (Array.isArray(s.relationships) ? s.relationships : []).map((rel) => ({
        end1: rel?.end1Id,
        end2: rel?.end2Id,
        label: rel?.title,
      })));

    if (sheets.length === 1) {
      const root = xmindJsonTopicToNode(sheets[0].rootTopic, 0, stats, usedIds, idMap, summaries, true);
      const associations = remapMindmapAssociations(rawRelationships, idMap);
      return {
        version: '1.0',
        root,
        ...(associations.length > 0 ? { associations } : {}),
        ...(summaries.length > 0 ? { summaries } : {}),
        meta: { createdAt: new Date().toISOString() },
      };
    }

    claimMindmapNode(stats, 0, '.xmind');
    usedIds.add('root');
    const children = sheets.map((s) =>
      xmindJsonTopicToNode(s.rootTopic, 1, stats, usedIds, idMap, summaries, false));
    const sheetMeta = children.map((child, idx) => ({
      id: `sheet_${idx + 1}`,
      title: sheets[idx].title?.trim() || child.text,
      rootNodeId: child.id,
    }));
    const associations = remapMindmapAssociations(rawRelationships, idMap);
    return {
      version: '1.0',
      root: {
        id: 'root',
        text: fallbackTitle || i18n.t('mindmap:import.importedMap', { defaultValue: 'Imported Mind Map' }),
        children,
      },
      ...(associations.length > 0 ? { associations } : {}),
      ...(summaries.length > 0 ? { summaries } : {}),
      meta: { createdAt: new Date().toISOString(), sheets: sheetMeta },
    };
  }

  const xmlEntry = zip.file('content.xml');
  if (xmlEntry) {
    const rawXml = await xmlEntry.async('string');
    if (rawXml.length > MAX_MINDMAP_CONTENT_BYTES) {
      throw new Error('.xmind content exceeds maximum size');
    }
    const xml = new DOMParser().parseFromString(rawXml, 'text/xml');
    if (xml.querySelector('parsererror')) {
      throw new Error('Invalid .xmind XML');
    }
    const sheetElements = Array.from(xml.getElementsByTagName('*'))
      .filter((el) => el.localName.toLowerCase() === 'sheet');
    const rootTopics = sheetElements
      .map((sheet) => directChildrenByLocalName(sheet, 'topic')[0])
      .filter((topic): topic is Element => Boolean(topic));
    if (rootTopics.length === 0) throw new Error('Invalid .xmind archive: missing root topic');

    const stats = { nodeCount: 0 };
    const usedIds = new Set<string>();
    const idMap = new Map<string, string>();
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
      const associations = remapMindmapAssociations(rawRelationships, idMap);
      return {
        version: '1.0',
        root,
        ...(associations.length > 0 ? { associations } : {}),
        meta: { createdAt: new Date().toISOString() },
      };
    }

    claimMindmapNode(stats, 0, '.xmind');
    usedIds.add('root');
    const children = rootTopics.map((topic) =>
      xmindXmlTopicToNode(topic, 1, stats, usedIds, idMap, false));
    const sheetMeta = children.map((child, idx) => ({
      id: `sheet_${idx + 1}`,
      title: directChildrenByLocalName(sheetElements[idx], 'title')[0]?.textContent?.trim() || child.text,
      rootNodeId: child.id,
    }));
    const associations = remapMindmapAssociations(rawRelationships, idMap);
    return {
      version: '1.0',
      root: {
        id: 'root',
        text: fallbackTitle || i18n.t('mindmap:import.importedMap', { defaultValue: 'Imported Mind Map' }),
        children,
      },
      ...(associations.length > 0 ? { associations } : {}),
      meta: { createdAt: new Date().toISOString(), sheets: sheetMeta },
    };
  }

  throw new Error('Invalid .xmind archive: content.json or content.xml not found');
}

async function parseMmapBytesToDocument(bytes: Uint8Array): Promise<ImportedMindMapDocument> {
  if (bytes.byteLength > MAX_MINDMAP_ARCHIVE_BYTES) {
    throw new Error(`.mmap archive exceeds maximum size (${MAX_MINDMAP_ARCHIVE_BYTES} bytes)`);
  }
  const normalizedBytes = normalizeZipArchiveBytes(bytes);
  if (!normalizedBytes) {
    throw new Error('Invalid or truncated .mmap archive');
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(normalizedBytes);
  const entry = zip.file('Document.xml');
  if (!entry) throw new Error('Invalid .mmap archive: Document.xml not found');

  const rawXml = await entry.async('string');
  const xml = new DOMParser().parseFromString(rawXml, 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid .mmap Document.xml');

  const oneTopic = Array.from(xml.getElementsByTagName('*')).find(
    (el) => el.localName.toLowerCase() === 'onetopic',
  );
  const rootTopic = oneTopic ? directChildrenByLocalName(oneTopic, 'Topic')[0] : undefined;
  if (!rootTopic) throw new Error('Invalid .mmap archive: missing root topic');

  const stats = { nodeCount: 0 };
  const usedIds = new Set<string>();
  const walk = (topic: Element, depth: number, forceRoot = false): ImportedMindMapNode => {
    claimMindmapNode(stats, depth, '.mmap');
    const text = directChildrenByLocalName(topic, 'Text')[0]?.getAttribute('PlainText')?.trim();
    const children = directChildrenByLocalName(topic, 'SubTopics')
      .flatMap((c) => directChildrenByLocalName(c, 'Topic'))
      .map((child) => walk(child, depth + 1, false));
    return {
      id: allocateMindmapNodeId(topic.getAttribute('OId') ?? undefined, usedIds, forceRoot),
      text: text || i18n.t('mindmap:import.unnamedTopic', { defaultValue: 'Untitled topic' }),
      children,
    };
  };
  return {
    version: '1.0',
    root: walk(rootTopic, 0, true),
    meta: { createdAt: new Date().toISOString() },
  };
}

function parseOpmlTextToDocument(opmlContent: string, fallbackTitle: string): ImportedMindMapDocument {
  const xml = new DOMParser().parseFromString(opmlContent, 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid OPML');
  const body = xml.querySelector('body');
  if (!body) throw new Error('Invalid OPML: missing body element');
  const outlines = Array.from(body.children).filter(
    (el) => el.localName.toLowerCase() === 'outline',
  );
  if (outlines.length === 0) throw new Error('Invalid OPML: no outline elements found');

  const stats = { nodeCount: 0 };
  const usedIds = new Set<string>();
  const walk = (el: Element, depth: number, forceRoot = false): ImportedMindMapNode => {
    claimMindmapNode(stats, depth, 'OPML');
    const text = el.getAttribute('text') || el.getAttribute('title') || '';
    const note = el.getAttribute('_note') || el.getAttribute('note') || undefined;
    const completeAttr = el.getAttribute('_complete');
    const statusAttr = el.getAttribute('_status');
    const completed =
      completeAttr === 'true' || statusAttr === 'checked'
        ? true
        : completeAttr === 'false' || statusAttr === 'unchecked'
          ? false
          : undefined;
    const children = Array.from(el.children)
      .filter((c) => c.localName.toLowerCase() === 'outline')
      .map((c) => walk(c, depth + 1, false));
    return {
      id: allocateMindmapNodeId(undefined, usedIds, forceRoot),
      text: text.trim() || i18n.t('mindmap:import.unnamedTopic', { defaultValue: 'Untitled topic' }),
      ...(note ? { note } : {}),
      ...(completed !== undefined ? { completed } : {}),
      children,
    };
  };

  let root: ImportedMindMapNode;
  if (outlines.length === 1) {
    root = walk(outlines[0], 0, true);
  } else {
    usedIds.add('root');
    const headTitle = xml.querySelector('head > title')?.textContent?.trim();
    root = {
      id: 'root',
      text: headTitle || fallbackTitle || i18n.t('mindmap:import.importedMap', { defaultValue: 'Imported Mind Map' }),
      children: outlines.map((el) => walk(el, 1, false)),
    };
  }
  return { version: '1.0', root, meta: { createdAt: new Date().toISOString() } };
}

function parseMmTextToDocument(mmContent: string, fallbackTitle: string): ImportedMindMapDocument {
  const xml = new DOMParser().parseFromString(mmContent, 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid .mm XML');
  const mapEl = xml.documentElement?.localName?.toLowerCase() === 'map' ? xml.documentElement : null;
  if (!mapEl) throw new Error('Invalid .mm: missing map element');
  const rootEls = directChildrenByLocalName(mapEl, 'node');
  if (rootEls.length === 0) throw new Error('Invalid .mm: no node elements found');

  const stats = { nodeCount: 0 };
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  const arrows: Array<{ end1?: string; end2?: string; label?: string }> = [];

  const readRichContent = (el: Element, type: 'NODE' | 'NOTE'): string | undefined => {
    const rich = directChildrenByLocalName(el, 'richcontent').find(
      (rc) => (rc.getAttribute('TYPE') || rc.getAttribute('type') || '').toUpperCase() === type,
    );
    const raw = rich?.textContent?.replace(/\u00a0/g, ' ');
    if (!raw) return undefined;
    if (type === 'NODE') return raw.replace(/\s+/g, ' ').trim() || undefined;
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines.join('\n') : undefined;
  };

  const walk = (el: Element, depth: number, forceRoot = false): ImportedMindMapNode => {
    claimMindmapNode(stats, depth, '.mm');
    const rawId = el.getAttribute('ID') || el.getAttribute('id') || undefined;
    const assignedId = allocateMindmapNodeId(rawId, usedIds, forceRoot);
    const mapKey = rawId ?? assignedId;
    if (!idMap.has(mapKey)) idMap.set(mapKey, assignedId);

    const text =
      (el.getAttribute('TEXT') ?? el.getAttribute('text'))?.trim()
      || readRichContent(el, 'NODE')
      || i18n.t('mindmap:import.unnamedTopic', { defaultValue: 'Untitled topic' });
    const note = readRichContent(el, 'NOTE');
    const icons = directChildrenByLocalName(el, 'icon')
      .map((icon) => icon.getAttribute('BUILTIN') ?? '')
      .filter(Boolean);
    const completed = icons.includes('button_ok')
      ? true
      : icons.includes('button_cancel')
        ? false
        : undefined;
    for (const arrow of directChildrenByLocalName(el, 'arrowlink')) {
      const dest = arrow.getAttribute('DESTINATION') || arrow.getAttribute('destination');
      if (dest) {
        arrows.push({ end1: mapKey, end2: dest, label: arrow.getAttribute('MIDDLE_LABEL') ?? undefined });
      }
    }
    return {
      id: assignedId,
      text,
      ...(note ? { note } : {}),
      ...(completed !== undefined ? { completed } : {}),
      children: directChildrenByLocalName(el, 'node').map((c) => walk(c, depth + 1, false)),
    };
  };

  const root: ImportedMindMapNode = rootEls.length === 1
    ? walk(rootEls[0], 0, true)
    : (() => {
        usedIds.add('root');
        return {
          id: 'root',
          text: fallbackTitle || i18n.t('mindmap:import.importedMap', { defaultValue: 'Imported Mind Map' }),
          children: rootEls.map((el) => walk(el, 1, false)),
        };
      })();
  const associations = remapMindmapAssociations(arrows, idMap);
  return {
    version: '1.0',
    root,
    ...(associations.length > 0 ? { associations } : {}),
    meta: { createdAt: new Date().toISOString() },
  };
}

async function readBlobAsText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }
  const bytes = await readBlobHeadBytes(blob);
  if (bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  throw new Error('Failed to read file text');
}

async function importMindmapFromFileObject(
  file: File,
  folderId: string | null,
  t: SidebarT,
): Promise<{ ok: true; node: DstuNode } | { ok: false; reason: string }> {
  if (file.size === 0) {
    return {
      ok: false,
      reason: t('finder.dragDrop.emptyFileReason', { defaultValue: 'Empty file (0 bytes)' }),
    };
  }
  const ext = getFileExtension(file.name);
  const fallbackTitle = stripFileExtension(file.name);
  try {
    let doc: ImportedMindMapDocument;
    if (ext === 'xmind') {
      const bytes = await readBlobHeadBytes(file);
      if (!bytes) throw new Error('Failed to read .xmind bytes');
      doc = await parseXmindBytesToDocument(bytes, fallbackTitle);
    } else if (ext === 'mmap') {
      const bytes = await readBlobHeadBytes(file);
      if (!bytes) throw new Error('Failed to read .mmap bytes');
      doc = await parseMmapBytesToDocument(bytes);
    } else if (ext === 'opml') {
      doc = parseOpmlTextToDocument(await readBlobAsText(file), fallbackTitle);
    } else if (ext === 'mm') {
      doc = parseMmTextToDocument(await readBlobAsText(file), fallbackTitle);
    } else {
      return {
        ok: false,
        reason: t('finder.dragDrop.invalidMindmapReason', { defaultValue: 'Invalid or corrupted mind map file' }),
      };
    }

    const title = doc.root.text.trim() || fallbackTitle || file.name;
    const createResult = await dstu.create('/', {
      type: 'mindmap',
      name: title,
      content: JSON.stringify(doc),
      metadata: {
        ...(folderId ? { folderId } : {}),
        defaultView: 'mindmap',
      },
    });
    if (!createResult.ok) {
      return { ok: false, reason: createResult.error.toUserMessage() };
    }
    return { ok: true, node: createResult.value };
  } catch (err: unknown) {
    debugLog.warn('[LearningHub] Mind map file import failed:', file.name, err);
    return {
      ok: false,
      reason: t('finder.dragDrop.invalidMindmapReason', { defaultValue: 'Invalid or corrupted mind map file' }),
    };
  }
}

async function importMindmapFromPath(
  filePath: string,
  folderId: string | null,
  t: SidebarT,
): Promise<{ ok: true; node: DstuNode } | { ok: false; name: string; reason: string }> {
  const name = extractDisplayFileName(filePath);
  const ext = getFileExtension(name);
  const fallbackTitle = stripFileExtension(name);
  try {
    let doc: ImportedMindMapDocument;
    if (ext === 'xmind' || ext === 'mmap') {
      const rawBytes = await TauriAPI.readFileAsBytes(filePath);
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      if (bytes.byteLength === 0) {
        return {
          ok: false,
          name,
          reason: t('finder.dragDrop.emptyFileReason', { defaultValue: 'Empty file (0 bytes)' }),
        };
      }
      doc = ext === 'xmind'
        ? await parseXmindBytesToDocument(bytes, fallbackTitle)
        : await parseMmapBytesToDocument(bytes);
    } else if (ext === 'opml' || ext === 'mm') {
      const text = await fileManager.readTextFile(filePath);
      if (!text.trim()) {
        return {
          ok: false,
          name,
          reason: t('finder.dragDrop.emptyFileReason', { defaultValue: 'Empty file (0 bytes)' }),
        };
      }
      doc = ext === 'opml'
        ? parseOpmlTextToDocument(text, fallbackTitle)
        : parseMmTextToDocument(text, fallbackTitle);
    } else {
      return {
        ok: false,
        name,
        reason: t('finder.dragDrop.invalidMindmapReason', { defaultValue: 'Invalid or corrupted mind map file' }),
      };
    }

    const title = doc.root.text.trim() || fallbackTitle || name;
    const createResult = await dstu.create('/', {
      type: 'mindmap',
      name: title,
      content: JSON.stringify(doc),
      metadata: {
        ...(folderId ? { folderId } : {}),
        defaultView: 'mindmap',
      },
    });
    if (!createResult.ok) {
      return { ok: false, name, reason: createResult.error.toUserMessage() };
    }
    return { ok: true, node: createResult.value };
  } catch (err: unknown) {
    debugLog.warn('[LearningHub] Mind map path import failed:', name, err);
    return {
      ok: false,
      name,
      reason: t('finder.dragDrop.invalidMindmapReason', { defaultValue: 'Invalid or corrupted mind map file' }),
    };
  }
}

/** Match returned textbook nodes back to requested paths so skipped items never vanish silently. */
function findUnmatchedTextbookPaths(paths: string[], nodes: DstuNode[]): string[] {
  if (nodes.length === 0) return [...paths];
  const remainingNames = nodes.map((node) => node.name.trim().toLowerCase());
  const unmatched: string[] = [];
  for (const filePath of paths) {
    const fileName = extractDisplayFileName(filePath).trim().toLowerCase();
    const stem = stripFileExtension(fileName);
    const matchIndex = remainingNames.findIndex((name) => name === fileName || stripFileExtension(name) === stem);
    if (matchIndex >= 0) {
      remainingNames.splice(matchIndex, 1);
    } else {
      unmatched.push(filePath);
    }
  }
  return unmatched;
}

function canFallbackToVfsFile(ext: string): boolean {
  return ext !== 'pdf';
}

export interface ImportPathsContext {
  importProgress: Pick<ImportProgressState, 'isImporting'>;
  currentPath?: FinderPath;
  t: SidebarT;
  currentCreatableFolderId: string | null;
  importMarkdownPathNotes: MarkdownNoteImport['importMarkdownPathNotes'];
  isMountedRef: React.MutableRefObject<boolean>;
  setImportProgress: React.Dispatch<React.SetStateAction<ImportProgressState>>;
  setAttachImportProgress: React.Dispatch<React.SetStateAction<AttachImportProgress>>;
  handleRefresh: () => Promise<void>;
  openImportedMarkdownNote: MarkdownNoteImport['openImportedMarkdownNote'];
  onOpenApp: LearningHubSidebarProps['onOpenApp'];
}

/**
 * 按文件路径导入（拖拽与「导入资料…」对话框共用）
 * 按扩展名分类后分发到对应适配器
 */
export async function importPathsIntoLibrary(
  {
    importProgress: _importProgress,
    currentPath,
    t,
    currentCreatableFolderId,
    importMarkdownPathNotes,
    isMountedRef,
    setImportProgress,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
    onOpenApp,
  }: ImportPathsContext,
  paths: string[],
): Promise<void> {
  void _importProgress;
  if (paths.length === 0) return;

  debugLog.log('[LearningHub] 导入文件:', paths.length, '个文件');

  const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
    flashcards: [],
    mindmap: [],
  };
  const importablePaths: string[] = [];

  for (const p of paths) {
    const name = extractFileName(p);
    const ext = getFileExtension(name);
    if (!MINDMAP_IMPORT_EXTENSIONS.has(ext)) {
      const guidance = MODULE_GUIDANCE_EXTENSIONS[ext];
      if (guidance) {
        // ★ P3 引导：apkg/colpkg 等不进资源库，提示到对应模块导入
        guidanceNames[guidance].push(name);
        continue;
      }
    }
    importablePaths.push(p);
  }

  const format = resolveImportFormatOptions(t, i18n.language);

  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join(format.listSeparator),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join(format.listSeparator),
    }));
  }
  if (importablePaths.length === 0) {
    return;
  }

  await enqueueImportBatch(
    isMountedRef,
    importablePaths,
    getPathImportFingerprint,
    async (queuedPaths) => {
      // Markdown 本身就是笔记：任何位置拖入都导入为笔记（用笔记应用打开、可编辑），
      // 不再只在「笔记」视图才这样——在「全部文件」拖入会变成只读预览的资料
      const shouldImportMarkdownAsNotes = true;
      const preferVfsFilesView = currentPath?.typeFilter === 'file';

      // 按类型分组
      const docPaths: string[] = [];
      const imagePaths: string[] = [];
      const mindmapPaths: string[] = [];
      const otherPaths: string[] = [];

      for (const p of queuedPaths) {
        const name = extractFileName(p);
        const ext = getFileExtension(name);
        if (MINDMAP_IMPORT_EXTENSIONS.has(ext)) {
          mindmapPaths.push(p);
          continue;
        }
        const isMarkdown = ext === 'md' || ext === 'markdown';
        if (DOCUMENT_EXTENSIONS.has(ext)) {
          if (!isMarkdown && (preferVfsFilesView || !canParseAsMobileTextbook(ext))) {
            otherPaths.push(p);
          } else {
            docPaths.push(p);
          }
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          imagePaths.push(p);
        } else {
          otherPaths.push(p);
        }
      }

      debugLog.log('[LearningHub] 文件分类:', {
        documents: docPaths.length,
        images: imagePaths.length,
        mindmaps: mindmapPaths.length,
        others: otherPaths.length,
        markdownAsNotes: shouldImportMarkdownAsNotes,
      });

      const { markdownItems: markdownNotePaths, otherItems: textbookPaths } = partitionMarkdownNoteImports(
        docPaths,
        (path) => extractFileName(path),
        shouldImportMarkdownAsNotes,
      );

      let totalSuccess = 0;
      let totalFailed = 0;
      let unlisten: UnlistenFn | null = null;
      let firstImportedNode: DstuNode | null = null;
      // ★ 2026-07-20：失败文件明细（文件名 + 具体原因），toast 不再只报笼统"导入失败"
      const failedDetails: { name: string; reason?: string }[] = [];
      // 后端按内容哈希去重：拖入已有的同一份文件会返回旧条目，不能报「已导入」
      const duplicateNames: string[] = [];
      const importStartedAt = Date.now();
      let textbookProgressStarted = false;
      let attachProgressStarted = false;

      try {
    const dropTargetFolderId = currentCreatableFolderId;

    if (markdownNotePaths.length > 0) {
      const markdownResult = await importMarkdownPathNotes(markdownNotePaths, dropTargetFolderId);

      totalSuccess += markdownResult.importedNodes.length;
      totalFailed += markdownResult.failedCount;
      firstImportedNode = markdownResult.importedNodes[0] ?? firstImportedNode;
      for (const failedFile of markdownResult.failedFiles ?? []) {
        failedDetails.push({
          name: failedFile,
          reason: markdownResult.firstError || undefined,
        });
      }
      if (markdownResult.failedCount > 0 && (markdownResult.failedFiles?.length ?? 0) === 0) {
        failedDetails.push({
          name: markdownNotePaths[0] ? extractDisplayFileName(markdownNotePaths[0]) : 'markdown',
          reason: markdownResult.firstError || undefined,
        });
      }

      if (markdownResult.importedNodes.length === 0 && markdownResult.failedCount > 0) {
        debugLog.error('[LearningHub] Markdown 笔记导入失败:', markdownResult.firstError);
      }
    }

    if (mindmapPaths.length > 0) {
      const limit = pLimit(3);
      const mindmapResults = await Promise.all(
        mindmapPaths.map((filePath) =>
          limit(() => importMindmapFromPath(filePath, dropTargetFolderId, t))),
      );
      for (const r of mindmapResults) {
        if ('node' in r) {
          totalSuccess += 1;
          firstImportedNode ??= r.node;
        } else {
          totalFailed += 1;
          failedDetails.push({ name: r.name, reason: r.reason });
        }
      }
    }

    // 1. 文档类：通过 textbookDstuAdapter 导入（未接收的非 PDF 文档自动兜底进入 VFS 文件表）
    const fallbackAttachmentPaths: string[] = [];
    if (textbookPaths.length > 0) {
      const firstFileName = textbookPaths[0] ? extractDisplayFileName(textbookPaths[0]) : '';
      let lastTextbookError: string | undefined;
      textbookProgressStarted = true;
      setImportProgress({
        isImporting: true,
        fileName: firstFileName,
        stage: 'hashing',
        progress: 0,
      });

      // 监听后端进度事件
      unlisten = await listen<TextbookImportProgress>('textbook-import-progress', (event) => {
        const { file_name, stage, current_page, total_pages, progress, error: progressError } = event.payload;
        if (progressError) {
          lastTextbookError = progressError;
        }
        setImportProgress(prev => ({
          ...prev,
          fileName: file_name,
          stage: stage as ImportStage,
          currentPage: current_page,
          totalPages: total_pages,
          progress,
          error: progressError,
        }));
      });

      let docResult: Awaited<ReturnType<typeof textbookDstuAdapter.addTextbooks>>;
      try {
        docResult = await textbookDstuAdapter.addTextbooks(textbookPaths, dropTargetFolderId);
      } catch (addErr) {
        const message = addErr instanceof Error ? addErr.message : String(addErr);
        docResult = {
          ok: false,
          error: { toUserMessage: () => message },
        } as Awaited<ReturnType<typeof textbookDstuAdapter.addTextbooks>>;
      } finally {
        if (unlisten) { unlisten(); unlisten = null; }
      }

      if (docResult.ok) {
        const existing = docResult.value.filter((node) => node.createdAt < importStartedAt - 5_000);
        duplicateNames.push(...existing.map((node) => node.name));
        totalSuccess += docResult.value.length - existing.length;
        if (!firstImportedNode) {
          firstImportedNode = docResult.value[0] ?? null;
        }
        const skippedPaths = findUnmatchedTextbookPaths(textbookPaths, docResult.value);
        for (const skippedPath of skippedPaths) {
          const ext = getFileExtension(extractFileName(skippedPath));
          if (canFallbackToVfsFile(ext)) {
            fallbackAttachmentPaths.push(skippedPath);
          } else {
            totalFailed += 1;
            failedDetails.push({
              name: extractDisplayFileName(skippedPath),
              reason: lastTextbookError || t('finder.dragDrop.importFailed'),
            });
          }
        }
      } else {
        const reason = docResult.error.toUserMessage();
        debugLog.error('[LearningHub] 文档导入失败:', reason);
        for (const failedPath of textbookPaths) {
          const ext = getFileExtension(extractFileName(failedPath));
          if (canFallbackToVfsFile(ext)) {
            fallbackAttachmentPaths.push(failedPath);
          } else {
            totalFailed += 1;
            failedDetails.push({ name: extractDisplayFileName(failedPath), reason });
          }
        }
      }

      textbookProgressStarted = false;
      if (isMountedRef.current) {
        setImportProgress(prev => ({ ...prev, isImporting: false }));
      }
    }

    // 2. 图片类/其他文件（含被教材管道跳过的 Office/文本兜底）：通过 attachmentDstuAdapter 创建
    const attachmentPaths = [...imagePaths, ...otherPaths, ...fallbackAttachmentPaths];
    if (attachmentPaths.length > 0) {
      // ★ 由 Rust 直接把文件（含 Android content:// URI、含中文/空格的 Windows 路径）
      // 流式复制进暂存区，WebView 不再经手字节（旧路径 read_file_bytes → File →
      // base64 → JSON IPC，3 个并发的 200MB 文件在手机上会撑爆渲染进程）。
      const { stagePathUpload, abortStagedUpload, createByteBudgetLimiter } = await import('@/utils/stagedUpload');
      const { mimeTypeFromFileName } = await import('@/hooks/useTauriDragAndDrop');
      const limit = pLimit(3);
      // 后端创建时会把暂存文件整份读入内存：按字节预算串行化大文件
      const byteBudget = createByteBudgetLimiter(64 * 1024 * 1024);

      attachProgressStarted = true;
      setAttachImportProgress({ done: 0, total: attachmentPaths.length });

      const attachResults = await Promise.all(
        attachmentPaths.map((filePath) =>
          limit(async () => {
            const name = extractFileName(filePath);
            const ext = getFileExtension(name);
            const isImage = IMAGE_EXTENSIONS.has(ext);

            try {
              let staged: { uploadId: string; size: number };
              try {
                staged = await stagePathUpload(filePath);
              } catch (readError) {
                debugLog.error('[LearningHub] 读取文件失败:', name, readError);
                return { ok: false as const, name, reason: t('finder.dragDrop.readFileFailed') };
              }

              const mimeType = resolveUploadMimeType(name, mimeTypeFromFileName(name), isImage);

              let result;
              try {
                result = await byteBudget(staged.size, () => attachmentDstuAdapter.createFromStagedUpload(
                  { uploadId: staged.uploadId, name, mimeType, size: staged.size },
                  isImage ? 'image' : 'file',
                  dropTargetFolderId ? { folderId: dropTargetFolderId } : undefined,
                ));
              } catch (createError) {
                // 后端未消费（如 IPC 异常）时主动清理暂存文件；已消费则为幂等空操作
                void abortStagedUpload(staged.uploadId);
                throw createError;
              }
              if (!result.ok) {
                void abortStagedUpload(staged.uploadId);
                // ★ 携带后端结构化拒绝原因（如"不支持的文件类型 .xyz"）
                return { ok: false as const, name, reason: result.error.toUserMessage() };
              }
              return { ok: true as const, name, node: result.value, isMedia: MEDIA_EXTENSIONS.has(ext) };
            } catch (e) {
              debugLog.error('[LearningHub] 附件导入失败:', name, e);
              return {
                ok: false as const,
                name,
                reason: e instanceof Error ? e.message : undefined,
              };
            } finally {
              if (isMountedRef.current) {
                setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
              }
            }
          })
        )
      );

      attachProgressStarted = false;
      if (isMountedRef.current) {
        setAttachImportProgress(null);
      }

      for (const r of attachResults) {
        if (r.ok) totalSuccess++;
        else {
          totalFailed++;
          failedDetails.push({ name: r.name, reason: r.reason });
        }
      }
      // 没有文档时打开第一个导入的音视频：直接进入转写 / 字幕界面
      if (!firstImportedNode) {
        firstImportedNode = attachResults.find((r) => r.ok && 'isMedia' in r && r.isMedia)?.node ?? null;
      }
    }

    // 3. 显示结果通知（失败时附具体文件与原因，最多 3 条）
    const failedSummary = failedDetails.length > 0
      ? t('finder.dragDrop.importFailedFiles', {
          names: formatFailedImportSummary(failedDetails, format),
        })
      : undefined;
    const duplicateSummary = duplicateNames.length > 0
      ? t('finder.dragDrop.alreadyInLibrary', { names: duplicateNames.slice(0, 3).join(format.listSeparator) })
      : undefined;
    if (duplicateSummary && totalSuccess === 0 && totalFailed === 0) {
      showGlobalNotification('info', duplicateSummary);
    } else if (totalSuccess > 0 && totalFailed === 0) {
      showGlobalNotification('success',
        t('finder.dragDrop.importSuccess', { count: totalSuccess }),
        duplicateSummary,
      );
    } else if (totalSuccess > 0 && totalFailed > 0) {
      showGlobalNotification('warning',
        t('finder.dragDrop.importPartial', {
          success: totalSuccess,
          failed: totalFailed,
        }),
        failedSummary
      );
    } else if (totalFailed > 0) {
      showGlobalNotification('error',
        t('finder.dragDrop.importFailed'),
        failedSummary
      );
    }

    // 4. 刷新文件列表（全是已有文件时也打开它，让用户看到在哪）
    if (totalSuccess > 0 || duplicateNames.length > 0) {
      await handleRefresh();
      if (isMountedRef.current && firstImportedNode) {
        if (firstImportedNode.type === 'note') {
          openImportedMarkdownNote(firstImportedNode);
        } else if (onOpenApp) {
          const itemType =
            firstImportedNode.type === 'mindmap'
              ? 'mindmap'
              : firstImportedNode.type === 'file'
                ? 'file'
                : 'textbook';
          onOpenApp(dstuNodeToResourceListItem(firstImportedNode, itemType));
        }
      }
    }
      } catch (error) {
        debugLog.error('[LearningHub] 导入异常:', error);
        showGlobalNotification('error', t('finder.dragDrop.importFailed'));
      } finally {
        if (unlisten) {
          unlisten();
          unlisten = null;
        }
        if (textbookProgressStarted && isMountedRef.current) {
          setImportProgress(prev => ({ ...prev, isImporting: false }));
        }
        if (attachProgressStarted && isMountedRef.current) {
          setAttachImportProgress(null);
        }
      }
    },
  );
}

export interface ImportDroppedFilesContext {
  pathsDropHandledRef: React.MutableRefObject<boolean>;
  currentPath: FinderPath;
  t: SidebarT;
  importMarkdownFileObjects: MarkdownNoteImport['importMarkdownFileObjects'];
  currentCreatableFolderId: string | null;
  isMountedRef: React.MutableRefObject<boolean>;
  setAttachImportProgress: React.Dispatch<React.SetStateAction<AttachImportProgress>>;
  handleRefresh: () => Promise<void>;
  openImportedMarkdownNote: MarkdownNoteImport['openImportedMarkdownNote'];
  onOpenApp?: LearningHubSidebarProps['onOpenApp'];
}

async function readBlobHeadBytes(blob: Blob): Promise<Uint8Array | null> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise<Uint8Array | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(blob);
    });
  }
  return null;
}

/**
 * 导入前快速校验空文件与明显损坏/截断的 PDF（避免静默丢弃或无报错失败）。
 * 返回本地化失败原因；校验通过返回 null。
 */
export async function validateImportFileObject(
  file: File,
  ext: string,
  t: SidebarT,
): Promise<string | null> {
  if (file.size === 0) {
    return t('finder.dragDrop.emptyFileReason', { defaultValue: '文件为空（0 字节）' });
  }
  if (ext === 'pdf') {
    if (file.size < 64) {
      return t('finder.dragDrop.corruptPdfReason', { defaultValue: 'PDF 文件已损坏或内容不完整' });
    }
    try {
      const headSlice = typeof file.slice === 'function' ? file.slice(0, 1024) : file;
      const headBytes = await readBlobHeadBytes(headSlice);
      if (headBytes) {
        let header = '';
        for (let i = 0; i < headBytes.length; i += 1) {
          header += String.fromCharCode(headBytes[i]);
        }
        if (!header.includes('%PDF-')) {
          return t('finder.dragDrop.corruptPdfReason', { defaultValue: 'PDF 文件已损坏或格式无效' });
        }
      }
      // 校验尾部 4096 字节是否包含 %%EOF 或 startxref，前置拦截截断损坏的 PDF
      const tailStart = Math.max(0, file.size - 4096);
      const tailSlice = typeof file.slice === 'function' ? file.slice(tailStart, file.size) : file;
      const tailBytes = await readBlobHeadBytes(tailSlice);
      if (tailBytes && tailBytes.length > 0) {
        let tail = '';
        for (let i = 0; i < tailBytes.length; i += 1) {
          tail += String.fromCharCode(tailBytes[i]);
        }
        if (!tail.includes('%%EOF') && !tail.includes('startxref')) {
          return t('finder.dragDrop.corruptPdfReason', { defaultValue: 'PDF 文件已损坏或内容不完整' });
        }
      }
    } catch {
      // 读取片段失败时交由后端处理，不在前置校验阶段误杀
    }
  }
  return null;
}

/**
 * 处理浏览器 File 对象拖拽（非 Tauri 环境兜底）
 */
export async function importDroppedFiles(
  {
    pathsDropHandledRef,
    currentPath,
    t,
    importMarkdownFileObjects,
    currentCreatableFolderId,
    isMountedRef,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
    onOpenApp,
  }: ImportDroppedFilesContext,
  files: File[],
  fromPicker = false,
): Promise<void> {
  if (files.length === 0) return;
  if (!fromPicker && consumePathsDropHandledFlag(pathsDropHandledRef)) {
    debugLog.log('[LearningHub] 跳过 files 回调，统一走 paths 导入链路');
    return;
  }
  if (!fromPicker && isDragDropBlockedView(currentPath)) {
    showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere'));
    return;
  }

  debugLog.log('[LearningHub] 浏览器拖拽导入:', files.length, '个文件');

  // ★ P3 引导：apkg/colpkg 等不进资源库，提示到对应模块导入；.xmind/.mmap/.opml/.mm 直接导入为思维导图
  const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
    flashcards: [],
    mindmap: [],
  };
  const importableFiles = files.filter((file) => {
    const ext = getFileExtension(file.name);
    if (MINDMAP_IMPORT_EXTENSIONS.has(ext)) {
      return true;
    }
    const guidance = MODULE_GUIDANCE_EXTENSIONS[ext];
    if (guidance) {
      guidanceNames[guidance].push(file.name);
      return false;
    }
    return true;
  });
  const format = resolveImportFormatOptions(t, i18n.language);

  if (guidanceNames.flashcards.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
      names: guidanceNames.flashcards.join(format.listSeparator),
    }));
  }
  if (guidanceNames.mindmap.length > 0) {
    showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
      names: guidanceNames.mindmap.join(format.listSeparator),
    }));
  }
  if (importableFiles.length === 0) return;

  await enqueueImportBatch(
    isMountedRef,
    importableFiles,
    getFileImportFingerprint,
    async (queuedFiles, queueState) => {
      let attachProgressStarted = false;

      try {
        // Markdown 本身就是笔记：任何位置拖入都导入为笔记（用笔记应用打开、可编辑），
        // 不再只在「笔记」视图才这样——在「全部文件」拖入会变成只读预览的资料
        const shouldImportMarkdownAsNotes = true;
        const { markdownItems: markdownFiles, otherItems: nonMarkdownFiles } = partitionMarkdownNoteImports(
          queuedFiles,
          (file) => file.name,
          shouldImportMarkdownAsNotes,
        );
    const mindmapFiles: File[] = [];
    const attachmentFiles: File[] = [];
    for (const file of nonMarkdownFiles) {
      if (MINDMAP_IMPORT_EXTENSIONS.has(getFileExtension(file.name))) {
        mindmapFiles.push(file);
      } else {
        attachmentFiles.push(file);
      }
    }

    let totalSuccess = 0;
    let totalFailed = 0;
    // On mobile each staged document is fully parsed in the Host, so consume one at a time.
    const limit = pLimit(fromPicker ? 1 : 3);
    let firstImportedNode: DstuNode | null = null;
    let firstImportedMindmap: DstuNode | null = null;
    const failedDetails: { name: string; reason?: string }[] = [];

    if (markdownFiles.length > 0) {
      try {
        const markdownResult = await importMarkdownFileObjects(markdownFiles, currentCreatableFolderId);

        totalSuccess += markdownResult.importedNodes.length;
        totalFailed += markdownResult.failedCount;
        firstImportedNode = markdownResult.importedNodes[0] ?? null;
        for (const failedFile of markdownResult.failedFiles ?? []) {
          failedDetails.push({
            name: failedFile,
            reason: markdownResult.firstError || undefined,
          });
        }
        if (markdownResult.failedCount > 0 && (markdownResult.failedFiles?.length ?? 0) === 0) {
          failedDetails.push({
            name: markdownFiles[0]?.name ?? 'markdown',
            reason: markdownResult.firstError || undefined,
          });
        }
      } catch (e) {
        totalFailed += markdownFiles.length;
        const reason = e instanceof Error ? e.message : String(e);
        for (const mdFile of markdownFiles) {
          failedDetails.push({ name: mdFile.name, reason });
        }
      }
    }

    if (mindmapFiles.length > 0) {
      const mindmapResults = await Promise.all(
        mindmapFiles.map((file) =>
          limit(async () => ({
            name: file.name,
            result: await importMindmapFromFileObject(file, currentCreatableFolderId, t),
          }))),
      );
      for (const entry of mindmapResults) {
        if ('node' in entry.result) {
          totalSuccess += 1;
          firstImportedMindmap ??= entry.result.node;
        } else {
          totalFailed += 1;
          failedDetails.push({ name: entry.name, reason: entry.result.reason });
        }
      }
    }

    if (attachmentFiles.length > 0 && isMountedRef.current) {
      attachProgressStarted = true;
      setAttachImportProgress({ done: 0, total: attachmentFiles.length });
    }

    const preferVfsFilesView = currentPath.typeFilter === 'file';

    let results: Array<
      | { ok: true; name: string; node: DstuNode; isMedia: boolean }
      | { ok: false; name: string; reason?: string }
    >;
    try {
      results = await Promise.all(
        attachmentFiles.map((file) =>
          limit(async () => {
            const ext = getFileExtension(file.name);
            const isImage = IMAGE_EXTENSIONS.has(ext);
            const mimeType = resolveUploadMimeType(file.name, file.type, isImage);

            try {
              const invalidReason = await validateImportFileObject(file, ext, t);
              if (invalidReason) {
                return { ok: false as const, name: file.name, reason: invalidReason };
              }
              let textbookFailureReason: string | undefined;
              // 仅 PDF/EPUB 从「导入资料…」优先尝试教材解析；若浏览器/WebUI 环境未解析出教材条目，
              // 统一兜底写入 VFS files 表（前置已拦截 0 字节与损坏 PDF），绝不静默丢弃。
              const shouldTryTextbookImport =
                fromPicker && !preferVfsFilesView && (ext === 'pdf' || ext === 'epub') && canParseAsMobileTextbook(ext);
              if (shouldTryTextbookImport) {
                try {
                  const result = await withStagedTextbookFile(file, (source) =>
                    textbookDstuAdapter.addTextbooks([source], currentCreatableFolderId));
                  if (result.ok && result.value[0]) {
                    return { ok: true as const, name: file.name, node: result.value[0], isMedia: false };
                  }
                  textbookFailureReason = result.ok
                    ? t('finder.dragDrop.importFailed')
                    : result.error.toUserMessage();
                } catch (stageErr) {
                  textbookFailureReason = stageErr instanceof Error ? stageErr.message : String(stageErr);
                }
              }
              // ★ 2026-06-12（审阅问题 FE-M1）：传递当前文件夹 ID，并补齐扩展名对应的 MIME（避免浏览器空/通用 type 落盘失败）
              const result = await attachmentDstuAdapter.create(
                file, isImage ? 'image' : 'file',
                {
                  ...(currentCreatableFolderId ? { folderId: currentCreatableFolderId } : {}),
                  mimeType,
                },
              );
              if (!result.ok) {
                return {
                  ok: false as const,
                  name: file.name,
                  reason: result.error.toUserMessage() || textbookFailureReason,
                };
              }
              return { ok: true as const, name: file.name, node: result.value, isMedia: MEDIA_EXTENSIONS.has(ext) };
            } catch (e) {
              return {
                ok: false as const,
                name: file.name,
                reason: e instanceof Error ? e.message : undefined,
              };
            } finally {
              if (isMountedRef.current) {
                setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
              }
            }
          })
        )
      );
    } finally {
      if (attachProgressStarted) {
        attachProgressStarted = false;
        if (isMountedRef.current) {
          setAttachImportProgress(null);
        }
      }
    }

    for (const r of results) {
      if (r.ok) totalSuccess++;
      else {
        totalFailed++;
        failedDetails.push({ name: r.name, reason: 'reason' in r ? r.reason : undefined });
      }
    }

    // ★ 失败时附具体文件与原因（最多 3 条），不再只报笼统"导入失败"
    const failedSummary = failedDetails.length > 0
      ? t('finder.dragDrop.importFailedFiles', {
          names: formatFailedImportSummary(failedDetails, format),
        })
      : undefined;
    if (totalSuccess > 0 && totalFailed === 0) {
      showGlobalNotification('success',
        t('finder.dragDrop.importSuccess', { count: totalSuccess })
      );
    } else if (totalSuccess > 0) {
      showGlobalNotification('warning',
        t('finder.dragDrop.importPartial', {
          success: totalSuccess,
          failed: totalFailed,
        }),
        failedSummary
      );
    } else if (totalFailed > 0) {
      showGlobalNotification('error', t('finder.dragDrop.importFailed'), failedSummary);
    }

    if (totalSuccess > 0) {
      await handleRefresh();
      if (isMountedRef.current) {
        if (firstImportedNode) openImportedMarkdownNote(firstImportedNode);
        else if (firstImportedMindmap && onOpenApp) {
          onOpenApp(dstuNodeToResourceListItem(firstImportedMindmap, 'mindmap'));
        } else if (fromPicker && onOpenApp) {
          const firstPreview = results.find((entry) => entry.ok && (entry.node.type === 'textbook' || entry.isMedia));
          if (firstPreview?.ok) {
            const nodeMetadata = firstPreview.node.metadata as Record<string, unknown> | undefined;
            const hasProcessingError = nodeMetadata?.processingStatus === 'error';
            const isPdfPreview =
              firstPreview.node.type === 'textbook' || getFileExtension(firstPreview.name) === 'pdf';
            const successfulPdfCount = results.filter(
              (entry) =>
                entry.ok
                && (entry.node.type === 'textbook' || getFileExtension(entry.name) === 'pdf'),
            ).length;
            const now = Date.now();
            const suppressStackedPdfSpawn =
              isPdfPreview
              && (
                hasProcessingError
                || successfulPdfCount > 1
                || queueState.pendingCount > 1
                || now - queueState.lastAutoOpenedPdfAt < AUTO_OPEN_PDF_COOLDOWN_MS
              );
            if (!suppressStackedPdfSpawn) {
              if (isPdfPreview) {
                queueState.lastAutoOpenedPdfAt = now;
              }
              onOpenApp(dstuNodeToResourceListItem(firstPreview.node, firstPreview.node.type === 'textbook' ? 'textbook' : 'file'));
            }
          }
        }
      }
    }
  } finally {
    if (attachProgressStarted && isMountedRef.current) {
      setAttachImportProgress(null);
    }
  }
    },
  );
}
