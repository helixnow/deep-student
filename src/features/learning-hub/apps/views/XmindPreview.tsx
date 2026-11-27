/**
 * XMind（.xmind）只读多画布预览组件
 *
 * 同时兼容现代 XMind ZEN（content.json）与经典 XMind 8（content.xml），
 * 支持多画布切换、层级折叠/展开、备注/标签/优先级与完成态展示；
 * 对损坏或截断的 .xmind 压缩包展示统一错误态。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Flag,
  Note,
  TreeStructure,
  ArrowsOutSimple,
  ArrowsInSimple,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { cn } from '@/utils/cn';
import {
  normalizeBase64,
  decodeBase64ToArrayBuffer,
  waitForNextFrame,
} from './previewUtils';
import { findCompleteZipEndOffset } from './officeZipContainer';
import { PreviewStatus } from './PreviewStatus';

const MAX_XMIND_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_XMIND_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_XMIND_DEPTH = 60;
const MAX_XMIND_NODES = 10_000;

interface XmindPreviewNode {
  id: string;
  title: string;
  note?: string;
  labels: string[];
  priority?: number;
  completed?: boolean;
  children: XmindPreviewNode[];
}

interface XmindPreviewSheet {
  id: string;
  title: string;
  root: XmindPreviewNode;
  nodeCount: number;
}

interface XmindJsonTopic {
  id?: string;
  title?: string;
  notes?: { plain?: { content?: string } } | string;
  labels?: unknown;
  markers?: Array<{ markerId?: string }>;
  children?: { attached?: XmindJsonTopic[] };
}

function parseMarkerFlags(markerIds: string[]): { priority?: number; completed?: boolean } {
  let priority: number | undefined;
  let completed: boolean | undefined;
  for (const id of markerIds) {
    const pMatch = /^priority-(\d+)$/i.exec(id);
    if (pMatch) {
      const n = Number(pMatch[1]);
      if (n >= 1 && n <= 6) priority = n;
    } else if (/^task-done$/i.test(id)) {
      completed = true;
    }
  }
  return { priority, completed };
}

function directChildrenByLocalName(parent: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i];
    if (child.localName === localName) out.push(child);
  }
  return out;
}

function parseJsonTopic(
  topic: XmindJsonTopic,
  depth: number,
  counter: { count: number },
  untitledLabel: string,
  pathKey: string,
): XmindPreviewNode {
  if (depth > MAX_XMIND_DEPTH) {
    throw new Error('XMIND_DEPTH_EXCEEDED');
  }
  counter.count += 1;
  if (counter.count > MAX_XMIND_NODES) {
    throw new Error('XMIND_NODE_LIMIT_EXCEEDED');
  }

  const rawNote = typeof topic.notes === 'string'
    ? topic.notes
    : topic.notes?.plain?.content;
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim() : undefined;
  const labels = Array.isArray(topic.labels)
    ? topic.labels.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const markerIds = Array.isArray(topic.markers)
    ? topic.markers.map((m) => m?.markerId ?? '').filter(Boolean)
    : [];
  const { priority, completed } = parseMarkerFlags(markerIds);
  const attached = Array.isArray(topic.children?.attached) ? topic.children.attached : [];

  return {
    id: topic.id?.trim() || pathKey,
    title: topic.title?.trim() || untitledLabel,
    note,
    labels,
    priority,
    completed,
    children: attached.map((child, idx) =>
      parseJsonTopic(child, depth + 1, counter, untitledLabel, `${pathKey}.${idx}`),
    ),
  };
}

function parseXmlTopic(
  topicEl: Element,
  depth: number,
  counter: { count: number },
  untitledLabel: string,
  pathKey: string,
): XmindPreviewNode {
  if (depth > MAX_XMIND_DEPTH) {
    throw new Error('XMIND_DEPTH_EXCEEDED');
  }
  counter.count += 1;
  if (counter.count > MAX_XMIND_NODES) {
    throw new Error('XMIND_NODE_LIMIT_EXCEEDED');
  }

  const title = directChildrenByLocalName(topicEl, 'title')[0]?.textContent?.trim() || untitledLabel;
  const notesEl = directChildrenByLocalName(topicEl, 'notes')[0];
  const rawNote = notesEl
    ? directChildrenByLocalName(notesEl, 'plain')[0]?.textContent ?? notesEl.textContent ?? ''
    : '';
  const note = rawNote.trim() || undefined;
  const labels = directChildrenByLocalName(topicEl, 'labels')
    .flatMap((el) => directChildrenByLocalName(el, 'label'))
    .map((el) => (el.textContent ?? '').trim())
    .filter(Boolean);
  const markerIds = directChildrenByLocalName(topicEl, 'marker-refs')
    .flatMap((el) => directChildrenByLocalName(el, 'marker-ref'))
    .map((el) => el.getAttribute('marker-id') ?? '')
    .filter(Boolean);
  const { priority, completed } = parseMarkerFlags(markerIds);

  const attached = directChildrenByLocalName(topicEl, 'children')
    .flatMap((container) => directChildrenByLocalName(container, 'topics'))
    .filter((topicsEl) => (topicsEl.getAttribute('type') || 'attached') === 'attached')
    .flatMap((topicsEl) => directChildrenByLocalName(topicsEl, 'topic'));

  return {
    id: topicEl.getAttribute('id')?.trim() || pathKey,
    title,
    note,
    labels,
    priority,
    completed,
    children: attached.map((child, idx) =>
      parseXmlTopic(child, depth + 1, counter, untitledLabel, `${pathKey}.${idx}`),
    ),
  };
}

async function parseXmindBase64(
  base64Content: string,
  untitledLabel: string,
  sheetFallbackPrefix: string,
): Promise<XmindPreviewSheet[]> {
  const normalized = normalizeBase64(base64Content);
  if (!normalized) {
    throw new Error('EMPTY_CONTENT');
  }

  const buffer = decodeBase64ToArrayBuffer(normalized);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > MAX_XMIND_PREVIEW_BYTES) {
    throw new Error('XMIND_TOO_LARGE');
  }

  const endOffset = findCompleteZipEndOffset(bytes);
  if (endOffset === null) {
    throw new Error('INVALID_ARCHIVE');
  }
  const cleanBytes = endOffset < bytes.byteLength ? bytes.subarray(0, endOffset) : bytes;

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(cleanBytes);

  const jsonEntry = zip.file('content.json');
  if (jsonEntry) {
    const rawText = await jsonEntry.async('string');
    if (rawText.length > MAX_XMIND_CONTENT_BYTES) {
      throw new Error('XMIND_TOO_LARGE');
    }
    const parsed = JSON.parse(rawText) as unknown;
    const rawSheets = Array.isArray(parsed) ? parsed : [parsed];
    const sheets: XmindPreviewSheet[] = [];

    rawSheets.forEach((item, idx) => {
      if (!item || typeof item !== 'object' || !('rootTopic' in item)) return;
      const rec = item as { id?: string; title?: string; rootTopic?: XmindJsonTopic };
      if (!rec.rootTopic || typeof rec.rootTopic !== 'object') return;
      const counter = { count: 0 };
      const root = parseJsonTopic(rec.rootTopic, 0, counter, untitledLabel, `s${idx}_r`);
      sheets.push({
        id: rec.id?.trim() || `sheet_${idx + 1}`,
        title: rec.title?.trim() || root.title || `${sheetFallbackPrefix} ${idx + 1}`,
        root,
        nodeCount: counter.count,
      });
    });

    if (sheets.length === 0) {
      throw new Error('MISSING_ROOT_TOPIC');
    }
    return sheets;
  }

  const xmlEntry = zip.file('content.xml');
  if (xmlEntry && typeof DOMParser !== 'undefined') {
    const rawXml = await xmlEntry.async('string');
    if (rawXml.length > MAX_XMIND_CONTENT_BYTES) {
      throw new Error('XMIND_TOO_LARGE');
    }
    const doc = new DOMParser().parseFromString(rawXml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('INVALID_XML');
    }
    const sheetEls = Array.from(doc.getElementsByTagName('*')).filter((el) => el.localName === 'sheet');
    const sheets: XmindPreviewSheet[] = [];
    sheetEls.forEach((sheetEl, idx) => {
      const rootTopicEl = directChildrenByLocalName(sheetEl, 'topic')[0];
      if (!rootTopicEl) return;
      const sheetTitle = directChildrenByLocalName(sheetEl, 'title')[0]?.textContent?.trim();
      const counter = { count: 0 };
      const root = parseXmlTopic(rootTopicEl, 0, counter, untitledLabel, `s${idx}_r`);
      sheets.push({
        id: sheetEl.getAttribute('id')?.trim() || `sheet_${idx + 1}`,
        title: sheetTitle || root.title || `${sheetFallbackPrefix} ${idx + 1}`,
        root,
        nodeCount: counter.count,
      });
    });

    if (sheets.length === 0) {
      throw new Error('MISSING_ROOT_TOPIC');
    }
    return sheets;
  }

  throw new Error('INVALID_ARCHIVE');
}

function collectBranchIds(node: XmindPreviewNode, out: Set<string>): void {
  if (node.children.length > 0) {
    out.add(node.id);
    for (const child of node.children) {
      collectBranchIds(child, out);
    }
  }
}

interface XmindTreeItemProps {
  node: XmindPreviewNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

const XmindTreeItem: React.FC<XmindTreeItemProps> = ({ node, depth, collapsed, onToggle }) => {
  const { t } = useTranslation(['learningHub']);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const isRoot = depth === 0;

  return (
    <div className={cn(!isRoot && 'ml-5 border-l border-border/60 pl-3')}>
      <div
        className={cn(
          'group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50',
          isRoot && 'border-b border-border/60 pb-2.5 mb-2',
        )}
      >
        {hasChildren ? (
          <DsButton
            variant="ghost"
            size="icon"
            className="mt-0.5 shrink-0 text-muted-foreground"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? t('learningHub:xmindPreview.expandNode') : t('learningHub:xmindPreview.collapseNode')}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <CaretRight size={14} /> : <CaretDown size={14} />}
          </DsButton>
        ) : (
          <span className="mt-2 ml-2 mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/45" aria-hidden />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'min-w-0 break-words',
                isRoot
                  ? 'text-base font-semibold text-foreground'
                  : depth === 1
                    ? 'text-sm font-medium text-foreground'
                    : 'text-sm text-foreground/90',
                node.completed && 'line-through text-muted-foreground',
              )}
            >
              {node.title}
            </span>

            {node.completed && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                <CheckCircle size={12} weight="fill" />
                {t('learningHub:xmindPreview.completed')}
              </span>
            )}

            {node.priority !== undefined && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                <Flag size={12} />
                P{node.priority}
              </span>
            )}

            {node.labels.map((label) => (
              <span
                key={label}
                className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {label}
              </span>
            ))}

            {hasChildren && isCollapsed && (
              <span className="text-xs text-muted-foreground">
                ({node.children.length})
              </span>
            )}
          </div>

          {node.note && (
            <div className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <Note size={13} className="mt-0.5 shrink-0" />
              <p className="min-w-0 whitespace-pre-wrap break-words">{node.note}</p>
            </div>
          )}
        </div>
      </div>

      {hasChildren && !isCollapsed && (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <XmindTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export interface XmindPreviewProps {
  base64Content: string;
  fileName: string;
  className?: string;
}

export const XmindPreview: React.FC<XmindPreviewProps> = ({
  base64Content,
  fileName,
  className = '',
}) => {
  const { t } = useTranslation(['learningHub']);
  const [sheets, setSheets] = useState<XmindPreviewSheet[]>([]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setIsLoading(true);
      setError(null);
      setSheets([]);
      setActiveSheetIdx(0);
      setCollapsedIds(new Set());

      await waitForNextFrame();
      if (!isMounted) return;

      try {
        const parsed = await parseXmindBase64(
          base64Content,
          t('learningHub:xmindPreview.untitledTopic'),
          t('learningHub:xmindPreview.sheetFallback'),
        );
        if (!isMounted) return;
        setSheets(parsed);
        setIsLoading(false);
      } catch {
        if (!isMounted) return;
        setError(t('learningHub:xmindPreview.invalidArchive'));
        setIsLoading(false);
      }
    };

    void run();
    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 切换语言不重新解析二进制
  }, [base64Content]);

  const activeSheet = sheets[activeSheetIdx] ?? sheets[0] ?? null;

  const totalBranchCount = useMemo(() => {
    if (!activeSheet) return 0;
    const ids = new Set<string>();
    collectBranchIds(activeSheet.root, ids);
    return ids.size;
  }, [activeSheet]);

  const handleToggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setCollapsedIds(new Set());
  }, []);

  const handleCollapseAll = useCallback(() => {
    if (!activeSheet) return;
    const ids = new Set<string>();
    for (const child of activeSheet.root.children) {
      collectBranchIds(child, ids);
    }
    setCollapsedIds(ids);
  }, [activeSheet]);

  if (isLoading) {
    return (
      <div className={cn('flex h-full flex-col gap-3 p-6', className)}>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-4 w-64 ml-6" />
        <Skeleton className="h-4 w-56 ml-6" />
      </div>
    );
  }

  if (error) {
    return (
      <PreviewStatus
        tone="error"
        title={error}
        meta={fileName}
      />
    );
  }

  if (!activeSheet) {
    return (
      <PreviewStatus
        tone="empty"
        title={t('learningHub:xmindPreview.emptyWorkbook')}
        meta={fileName}
      />
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)} data-testid="xmind-preview">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <TreeStructure size={15} className="shrink-0 text-foreground/80" />
          <span className="truncate font-medium text-foreground">{fileName}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">
            {t('learningHub:xmindPreview.summaryStats', {
              sheets: sheets.length,
              nodes: activeSheet.nodeCount,
            })}
          </span>
        </div>

        {totalBranchCount > 1 && (
          <div className="flex items-center gap-1">
            <DsButton variant="ghost" size="sm" onClick={handleExpandAll}>
              <ArrowsOutSimple size={14} />
              <span>{t('learningHub:xmindPreview.expandAll')}</span>
            </DsButton>
            <DsButton variant="ghost" size="sm" onClick={handleCollapseAll}>
              <ArrowsInSimple size={14} />
              <span>{t('learningHub:xmindPreview.collapseAll')}</span>
            </DsButton>
          </div>
        )}
      </div>

      {sheets.length > 1 && (
        <div
          role="tablist"
          aria-label={t('learningHub:xmindPreview.sheetTabs')}
          className="flex items-center gap-1 overflow-x-auto border-b border-border/60 px-4 py-1.5"
        >
          {sheets.map((sheet, idx) => {
            const isSelected = idx === activeSheetIdx;
            return (
              <DsButton
                key={sheet.id}
                role="tab"
                aria-selected={isSelected}
                data-active={isSelected ? 'true' : undefined}
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActiveSheetIdx(idx);
                  setCollapsedIds(new Set());
                }}
                className={cn(
                  'shrink-0',
                  isSelected
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground',
                )}
              >
                <span className="max-w-48 truncate">{sheet.title}</span>
              </DsButton>
            );
          })}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl px-5 py-4">
          <XmindTreeItem
            node={activeSheet.root}
            depth={0}
            collapsed={collapsedIds}
            onToggle={handleToggle}
          />
        </div>
      </ScrollArea>
    </div>
  );
};

export default XmindPreview;
