/**
 * 思维导图应用窗口（P8 + O17）
 *
 * 直接复用 @/features/mindmap 的 MindMapContentView（只读消费）。
 *
 * isActive 映射说明：
 * - MindMapContentView 的 isActive prop 承担"标签页活跃"语义：
 *   活跃时接管全局键盘/剪贴板、加载文档、同步标题；非活跃时 saveDraftSync
 *   并暂停画布交互（经 MindMapActiveContext 下发）。
 * - 这里映射为窗口的 isActive（focused）：与标签页语义等价——同一时刻
 *   只有焦点窗口接管键盘与 store，避免多窗口争抢全局快捷键。
 *   isVisible=false 时窗口壳（WindowBody）已对内容做 visibility:hidden，
 *   画布渲染成本归零，无需额外处理。
 *
 * O17：复用 content 侧 ContentSkeleton（mindmap 变体）+ ContentEmptyState +
 * useContentLoadPhase / useResizeSettle / useDragRenderPause；不改 legacy MindMapContentView。
 *
 * ANTI-REGRESSION：拖拽降频只走 useDragRenderPause（CSS 冻结动画），禁止因
 * renderThrottleMs>0 把 isActive 置 false——MindMapContentView 失活会同步
 * saveDraftSync，拖拽热路径写草稿比动画更伤帧。
 *
 * 每个 MindMapContentView 持有独立 store；windowId 作为实例路由键，保证同资源
 * 出现在多个宿主时 activation 也只命中目标窗口。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Upload } from '@phosphor-icons/react';
import { nanoid } from 'nanoid';
import { MindMapContentView } from '@/features/mindmap/MindMapContentView';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { createEmpty, dstu } from '@/dstu';
import { extractDisplayFileName, fileManager } from '@/utils/fileManager';
import { TauriAPI } from '@/utils/tauriApi';
import { isAndroidMobileShell, isWebUiShell } from '@/utils/platform';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import { ContentEmptyState } from '../content/ContentEmptyState';
import { ContentSkeleton } from '../content/ContentSkeleton';
import { useContentLoadPhase } from '../content/useContentLoadPhase';
import { useResizeSettle } from '../content/useResizeSettle';
import '../content/ContentAppWindow.css';

const EMPTY_IMPORT_EXTENSIONS = ['xmind', 'mmap', 'opml', 'md', 'markdown', 'json', 'mm', 'txt'] as const;
const EMPTY_IMPORT_ACCEPT = EMPTY_IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(',');
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 10_000;
const MAX_DEPTH = 100;

interface SimpleMindMapNode {
  id: string;
  text: string;
  note?: string;
  children: SimpleMindMapNode[];
}

interface SimpleMindMapDoc {
  version: '1.0';
  root: SimpleMindMapNode;
  meta: {
    createdAt: string;
    sheets?: Array<{ id: string; title: string; rootNodeId: string }>;
  };
}

function hasNativeTauriDialog(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as Record<string, unknown>;
  return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI_IPC__)
    && !isWebUiShell()
    && !isAndroidMobileShell();
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function directChildrenByTag(parent: Element, name: string): Element[] {
  const lower = name.toLowerCase();
  return Array.from(parent.children).filter((c) => c.localName.toLowerCase() === lower);
}

function allocNodeId(preferred: string | undefined, used: Set<string>, forceRoot = false): string {
  if (forceRoot) {
    used.add('root');
    return 'root';
  }
  const clean = preferred?.trim();
  if (clean && clean !== 'root' && !used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let id = nanoid(10);
  while (used.has(id) || id === 'root') id = nanoid(10);
  used.add(id);
  return id;
}

function checkNodeBudget(stats: { count: number }, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error('Mind map depth exceeds maximum limit');
  stats.count += 1;
  if (stats.count > MAX_NODES) throw new Error('Mind map node count exceeds maximum limit');
}

function hasZipEocd(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - (22 + 65_535));
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      const commentLen = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLen === bytes.length) return true;
    }
  }
  return false;
}

async function parseXmindBytes(
  bytes: Uint8Array,
  fallbackTitle: string,
  unnamedLabel: string,
): Promise<SimpleMindMapDoc> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES || !hasZipEocd(bytes)) {
    throw new Error('Invalid or truncated .xmind archive');
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);

  const jsonEntry = zip.file('content.json');
  if (jsonEntry) {
    const parsed = JSON.parse(await jsonEntry.async('string')) as unknown;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    type TopicJson = {
      id?: string;
      title?: string;
      notes?: { plain?: { content?: string } } | string;
      children?: { attached?: TopicJson[] };
    };
    const sheets = candidates.filter((c): c is { title?: string; rootTopic: TopicJson } =>
      Boolean(c && typeof c === 'object' && 'rootTopic' in c && typeof (c as { rootTopic?: unknown }).rootTopic === 'object' && (c as { rootTopic?: unknown }).rootTopic !== null));
    if (sheets.length === 0) throw new Error('Invalid .xmind archive: missing root topic');

    const stats = { count: 0 };
    const used = new Set<string>();
    const walk = (topic: TopicJson, depth: number, forceRoot = false): SimpleMindMapNode => {
      checkNodeBudget(stats, depth);
      const rawNote = typeof topic.notes === 'string' ? topic.notes : topic.notes?.plain?.content;
      const note = rawNote?.trim() || undefined;
      return {
        id: allocNodeId(topic.id, used, forceRoot),
        text: topic.title?.trim() || unnamedLabel,
        ...(note ? { note } : {}),
        children: (Array.isArray(topic.children?.attached) ? topic.children.attached : [])
          .map((child) => walk(child, depth + 1, false)),
      };
    };

    if (sheets.length === 1) {
      return { version: '1.0', root: walk(sheets[0].rootTopic, 0, true), meta: { createdAt: new Date().toISOString() } };
    }
    used.add('root');
    const children = sheets.map((s) => walk(s.rootTopic, 1, false));
    return {
      version: '1.0',
      root: { id: 'root', text: fallbackTitle || unnamedLabel, children },
      meta: {
        createdAt: new Date().toISOString(),
        sheets: children.map((child, i) => ({
          id: `sheet_${i + 1}`,
          title: sheets[i].title?.trim() || child.text,
          rootNodeId: child.id,
        })),
      },
    };
  }

  const xmlEntry = zip.file('content.xml');
  if (xmlEntry) {
    const xml = new DOMParser().parseFromString(await xmlEntry.async('string'), 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('Invalid .xmind XML');
    const sheetEls = Array.from(xml.getElementsByTagName('*')).filter((el) => el.localName.toLowerCase() === 'sheet');
    const rootTopics = sheetEls
      .map((s) => directChildrenByTag(s, 'topic')[0])
      .filter((t): t is Element => Boolean(t));
    if (rootTopics.length === 0) throw new Error('Invalid .xmind archive: missing root topic');
    const stats = { count: 0 };
    const used = new Set<string>();
    const walk = (topic: Element, depth: number, forceRoot = false): SimpleMindMapNode => {
      checkNodeBudget(stats, depth);
      const title = directChildrenByTag(topic, 'title')[0]?.textContent?.trim();
      const notesEl = directChildrenByTag(topic, 'notes')[0];
      const note = (notesEl ? directChildrenByTag(notesEl, 'plain')[0]?.textContent ?? notesEl.textContent : undefined)?.trim() || undefined;
      const attached = directChildrenByTag(topic, 'children')
        .flatMap((c) => directChildrenByTag(c, 'topics'))
        .filter((ts) => (ts.getAttribute('type') || 'attached') === 'attached')
        .flatMap((ts) => directChildrenByTag(ts, 'topic'));
      return {
        id: allocNodeId(topic.getAttribute('id') ?? undefined, used, forceRoot),
        text: title || unnamedLabel,
        ...(note ? { note } : {}),
        children: attached.map((child) => walk(child, depth + 1, false)),
      };
    };
    if (rootTopics.length === 1) {
      return { version: '1.0', root: walk(rootTopics[0], 0, true), meta: { createdAt: new Date().toISOString() } };
    }
    used.add('root');
    const children = rootTopics.map((t) => walk(t, 1, false));
    return {
      version: '1.0',
      root: { id: 'root', text: fallbackTitle || unnamedLabel, children },
      meta: {
        createdAt: new Date().toISOString(),
        sheets: children.map((child, i) => ({
          id: `sheet_${i + 1}`,
          title: directChildrenByTag(sheetEls[i], 'title')[0]?.textContent?.trim() || child.text,
          rootNodeId: child.id,
        })),
      },
    };
  }
  throw new Error('Invalid .xmind archive: content.json or content.xml not found');
}

async function parseMmapBytes(bytes: Uint8Array, unnamedLabel: string): Promise<SimpleMindMapDoc> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES || !hasZipEocd(bytes)) {
    throw new Error('Invalid or truncated .mmap archive');
  }
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('Document.xml');
  if (!entry) throw new Error('Invalid .mmap archive: Document.xml not found');
  const xml = new DOMParser().parseFromString(await entry.async('string'), 'text/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid .mmap Document.xml');
  const oneTopic = Array.from(xml.getElementsByTagName('*')).find((el) => el.localName.toLowerCase() === 'onetopic');
  const rootTopic = oneTopic ? directChildrenByTag(oneTopic, 'Topic')[0] : undefined;
  if (!rootTopic) throw new Error('Invalid .mmap archive: missing root topic');
  const stats = { count: 0 };
  const used = new Set<string>();
  const walk = (topic: Element, depth: number, forceRoot = false): SimpleMindMapNode => {
    checkNodeBudget(stats, depth);
    const text = directChildrenByTag(topic, 'Text')[0]?.getAttribute('PlainText')?.trim();
    const children = directChildrenByTag(topic, 'SubTopics')
      .flatMap((c) => directChildrenByTag(c, 'Topic'))
      .map((child) => walk(child, depth + 1, false));
    return {
      id: allocNodeId(topic.getAttribute('OId') ?? undefined, used, forceRoot),
      text: text || unnamedLabel,
      children,
    };
  };
  return { version: '1.0', root: walk(rootTopic, 0, true), meta: { createdAt: new Date().toISOString() } };
}

function parseTextMindMap(
  content: string,
  ext: string,
  fallbackTitle: string,
  unnamedLabel: string,
): SimpleMindMapDoc {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Empty mind map content');

  if (ext === 'json' || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { version?: string; root?: SimpleMindMapNode; meta?: { createdAt?: string } };
    if (!parsed || typeof parsed !== 'object' || !parsed.root || typeof parsed.root !== 'object') {
      throw new Error('Invalid JSON mind map');
    }
    return {
      version: '1.0',
      root: parsed.root,
      meta: { createdAt: typeof parsed.meta?.createdAt === 'string' ? parsed.meta.createdAt : new Date().toISOString() },
    };
  }

  if (ext === 'opml' || /<opml[\s>/]/i.test(trimmed.slice(0, 2048))) {
    const xml = new DOMParser().parseFromString(trimmed, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('Invalid OPML');
    const body = xml.querySelector('body');
    const outlines = body ? directChildrenByTag(body, 'outline') : [];
    if (outlines.length === 0) throw new Error('Invalid OPML: no outline elements found');
    const stats = { count: 0 };
    const used = new Set<string>();
    const walk = (el: Element, depth: number, forceRoot = false): SimpleMindMapNode => {
      checkNodeBudget(stats, depth);
      const text = (el.getAttribute('text') || el.getAttribute('title') || '').trim();
      const note = (el.getAttribute('_note') || el.getAttribute('note') || '').trim() || undefined;
      return {
        id: allocNodeId(undefined, used, forceRoot),
        text: text || unnamedLabel,
        ...(note ? { note } : {}),
        children: directChildrenByTag(el, 'outline').map((c) => walk(c, depth + 1, false)),
      };
    };
    const root = outlines.length === 1
      ? walk(outlines[0], 0, true)
      : {
          id: 'root',
          text: xml.querySelector('head > title')?.textContent?.trim() || fallbackTitle || unnamedLabel,
          children: outlines.map((o) => walk(o, 1, false)),
        };
    return { version: '1.0', root, meta: { createdAt: new Date().toISOString() } };
  }

  if (ext === 'mm' || /<map[\s>/]/i.test(trimmed.slice(0, 2048))) {
    const xml = new DOMParser().parseFromString(trimmed, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('Invalid .mm XML');
    const mapEl = xml.documentElement?.localName?.toLowerCase() === 'map' ? xml.documentElement : null;
    const rootEls = mapEl ? directChildrenByTag(mapEl, 'node') : [];
    if (rootEls.length === 0) throw new Error('Invalid .mm: no node elements found');
    const stats = { count: 0 };
    const used = new Set<string>();
    const walk = (el: Element, depth: number, forceRoot = false): SimpleMindMapNode => {
      checkNodeBudget(stats, depth);
      const text = (el.getAttribute('TEXT') ?? el.getAttribute('text') ?? '').trim();
      return {
        id: allocNodeId(el.getAttribute('ID') ?? el.getAttribute('id') ?? undefined, used, forceRoot),
        text: text || unnamedLabel,
        children: directChildrenByTag(el, 'node').map((c) => walk(c, depth + 1, false)),
      };
    };
    const root = rootEls.length === 1
      ? walk(rootEls[0], 0, true)
      : {
          id: 'root',
          text: fallbackTitle || unnamedLabel,
          children: rootEls.map((el) => walk(el, 1, false)),
        };
    return { version: '1.0', root, meta: { createdAt: new Date().toISOString() } };
  }

  // Markdown / plain text fallback outline
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+|^[-*+]\s+|^\d+[.)]\s+/, '').trim())
    .filter(Boolean);
  const [first, ...rest] = lines;
  return {
    version: '1.0',
    root: {
      id: 'root',
      text: first || fallbackTitle || unnamedLabel,
      children: rest.slice(0, MAX_NODES - 1).map((line) => ({
        id: nanoid(10),
        text: line,
        children: [],
      })),
    },
    meta: { createdAt: new Date().toISOString() },
  };
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error('Failed to read file bytes'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file bytes'));
    reader.readAsArrayBuffer(file);
  });
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new TextDecoder('utf-8').decode(await readFileBytes(file));
}

const MindmapAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  isActive,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation(['workbench', 'learningHub', 'mindmap']);
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  const [createdResourceId, setCreatedResourceId] = useState<string | null>(null);
  const [isActionBusy, setIsActionBusy] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const effectiveResourceId = instanceKey || createdResourceId;
  const hasResource = Boolean(effectiveResourceId);
  const { phase, markReady } = useContentLoadPhase({
    hostRef,
    enabled: hasResource,
  });

  useResizeSettle(hostRef, contentRef, hasResource);
  useDragRenderPause(hostRef, renderThrottleMs);

  // B-9：独立窗口的窗口级保存指示——dirty/saving 时窗口标题追加 ●，
  // 与 Notes 标签条圆点语义对齐（AppWindowProps 无专用保存通道，经标题透出）。
  const lastTitleRef = useRef('');
  const saveStateRef = useRef<'saved' | 'saving' | 'dirty'>('saved');

  const emitTitle = useCallback(() => {
    const title = lastTitleRef.current;
    const showMarker = saveStateRef.current !== 'saved';
    onTitleChange(showMarker && title ? `● ${title}` : title);
  }, [onTitleChange]);

  const handleTitleChange = useCallback(
    (title: string) => {
      lastTitleRef.current = title;
      emitTitle();
    },
    [emitTitle],
  );

  const handleSaveStateChange = useCallback(
    (state: 'saved' | 'saving' | 'dirty') => {
      const wasMarked = saveStateRef.current !== 'saved';
      saveStateRef.current = state;
      const isMarked = state !== 'saved';
      if (wasMarked !== isMarked) emitTitle();
    },
    [emitTitle],
  );

  const handleContentReady = useCallback(() => markReady(), [markReady]);
  const handleLoadError = useCallback(() => markReady(), [markReady]);

  const persistAndOpenImportedDoc = useCallback(
    async (doc: SimpleMindMapDoc, fallbackTitle: string) => {
      const title = doc.root.text.trim() || fallbackTitle || t('mindmap:import.importedMap');
      const result = await dstu.create('/', {
        type: 'mindmap',
        name: title,
        content: JSON.stringify(doc),
        metadata: { defaultView: 'mindmap' },
      });
      if (!isMountedRef.current) return;
      if (!result.ok) {
        showGlobalNotification('error', result.error.toUserMessage());
        return;
      }
      setCreatedResourceId(result.value.id);
      handleTitleChange(result.value.name);
      showGlobalNotification('success', t('mindmap:import.success'));
    },
    [handleTitleChange, t],
  );

  const handleCreateMindMap = useCallback(async () => {
    if (isActionBusy) return;
    setIsActionBusy(true);
    try {
      const result = await createEmpty({ type: 'mindmap' });
      if (!isMountedRef.current) return;
      if (result.ok) {
        setCreatedResourceId(result.value.id);
        handleTitleChange(result.value.name);
        showGlobalNotification('success', t('learningHub:finder.create.mindmapSuccess'));
      } else {
        showGlobalNotification('error', result.error.toUserMessage());
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        showGlobalNotification(
          'error',
          err instanceof Error ? err.message : t('learningHub:finder.create.failed'),
        );
      }
    } finally {
      if (isMountedRef.current) setIsActionBusy(false);
    }
  }, [handleTitleChange, isActionBusy, t]);

  const handleImportFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || isActionBusy) return;
      setIsActionBusy(true);
      try {
        const ext = getExtension(file.name);
        const fallbackTitle = stripExtension(file.name);
        const unnamedLabel = t('mindmap:import.unnamedTopic');
        let doc: SimpleMindMapDoc;
        if (ext === 'xmind') {
          doc = await parseXmindBytes(await readFileBytes(file), fallbackTitle, unnamedLabel);
        } else if (ext === 'mmap') {
          doc = await parseMmapBytes(await readFileBytes(file), unnamedLabel);
        } else {
          doc = parseTextMindMap(await readFileText(file), ext, fallbackTitle, unnamedLabel);
        }
        await persistAndOpenImportedDoc(doc, fallbackTitle);
      } catch (err: unknown) {
        if (isMountedRef.current) {
          showGlobalNotification(
            'error',
            err instanceof Error && err.message.trim() ? err.message : t('mindmap:import.failed'),
          );
        }
      } finally {
        if (isMountedRef.current) setIsActionBusy(false);
      }
    },
    [isActionBusy, persistAndOpenImportedDoc, t],
  );

  const handleImportClick = useCallback(() => {
    if (isActionBusy) return;
    if (!hasNativeTauriDialog()) {
      const input = importInputRef.current;
      if (input) {
        input.value = '';
        input.click();
      }
      return;
    }
    setIsActionBusy(true);
    void (async () => {
      try {
        const filePath = await fileManager.pickSingleFile({
          title: t('mindmap:import.dialogTitle'),
          filters: [
            { name: t('mindmap:import.filterName'), extensions: [...EMPTY_IMPORT_EXTENSIONS] },
          ],
        });
        if (!filePath || !isMountedRef.current) return;
        const name = extractDisplayFileName(filePath);
        const ext = getExtension(name);
        const fallbackTitle = stripExtension(name);
        const unnamedLabel = t('mindmap:import.unnamedTopic');
        let doc: SimpleMindMapDoc;
        if (ext === 'xmind' || ext === 'mmap') {
          const rawBytes = await TauriAPI.readFileAsBytes(filePath);
          const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
          doc = ext === 'xmind'
            ? await parseXmindBytes(bytes, fallbackTitle, unnamedLabel)
            : await parseMmapBytes(bytes, unnamedLabel);
        } else {
          doc = parseTextMindMap(await fileManager.readTextFile(filePath), ext, fallbackTitle, unnamedLabel);
        }
        await persistAndOpenImportedDoc(doc, fallbackTitle);
      } catch (err: unknown) {
        if (isMountedRef.current) {
          showGlobalNotification(
            'error',
            err instanceof Error && err.message.trim() ? err.message : t('mindmap:import.failed'),
          );
        }
      } finally {
        if (isMountedRef.current) setIsActionBusy(false);
      }
    })();
  }, [isActionBusy, persistAndOpenImportedDoc, t]);

  if (!effectiveResourceId) {
    return (
      <div
        ref={hostRef}
        className="wb-content-host flex flex-col items-center justify-center gap-4 p-4"
        data-wb-content-host
        data-wb-mindmap-host
      >
        <ContentEmptyState
          className="!h-auto !p-0"
          title={t('workbench:content.missingResource')}
          description={t('workbench:mindmap.missingResourceHint')}
        />
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <DsButton
            variant="default"
            size="sm"
            disabled={isActionBusy}
            data-testid="mm-empty-create-btn"
            onClick={() => void handleCreateMindMap()}
          >
            <Plus size={15} />
            <span>{t('learningHub:finder.toolbar.newMindMap')}</span>
          </DsButton>
          <DsButton
            variant="outline"
            size="sm"
            disabled={isActionBusy}
            data-testid="mm-empty-import-btn"
            onClick={handleImportClick}
          >
            <Upload size={15} />
            <span>{t('mindmap:import.dialogTitle')}</span>
          </DsButton>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept={EMPTY_IMPORT_ACCEPT}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          data-testid="mm-empty-import-input"
          onChange={(e) => void handleImportFileChange(e)}
        />
      </div>
    );
  }

  const showSkeleton = phase === 'loading' || phase === 'fading';

  return (
    <div
      ref={hostRef}
      className="wb-content-host"
      data-wb-content-host
      data-wb-mindmap-host
      // 骨架屏期间向辅助技术标记加载中
      aria-busy={showSkeleton || undefined}
    >
      <div ref={contentRef} className="wb-content-viewport">
        <MindMapContentView
          resourceId={effectiveResourceId}
          storeInstanceId={windowId}
          isActive={isActive}
          onTitleChange={handleTitleChange}
          onSaveStateChange={handleSaveStateChange}
          onReady={handleContentReady}
          onLoadError={handleLoadError}
          className="h-full"
        />
      </div>
      {showSkeleton && (
        <ContentSkeleton
          variant="mindmap"
          phase={phase === 'fading' ? 'fading' : 'loading'}
          label={t('workbench:mindmap.loading')}
        />
      )}
    </div>
  );
};

export default MindmapAppWindow;
