/**
 * Original-source viewer for question provenance.
 *
 * Source refs carry `source_id`, a real 1-based `page` (or null for native
 * text/transcript sources), and an optional normalized bbox. This component:
 * - resolves the page through `qbank_get_source_page` (exam-scoped);
 * - loads the rasterized full-page image through the existing VFS blob API;
 * - draws the bbox over the full page rather than cropping a thumbnail;
 * - never substitutes page 1 when a ref has no page, and reports legacy refs
 *   explicitly instead of silently hiding them.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  ArrowRight,
  CaretLeft,
  CaretRight,
  CircleNotch,
  FileText,
  Image as ImageIcon,
  WarningCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog } from '@/components/ui/DsDialog';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';

export type SourceBBox = [number, number, number, number];

/** Structural subset shared by question and material source refs. */
export interface QuestionSourceRef {
  source_id: string;
  page?: number | null;
  bbox?: SourceBBox | number[] | null;
}

/** Backend `qbank_get_source_page` payload (snake_case by design). */
export interface SourcePageResult {
  source_id: string;
  page?: number | null;
  blob_hash?: string | null;
  width?: number | null;
  height?: number | null;
  text?: string | null;
  source_name?: string | null;
  source_format?: string | null;
  original_path?: string | null;
  page_count?: number | null;
  available_pages?: number[] | null;
}

export type ViewerRefRole = 'question' | 'answer';

export interface ViewerSourceRef {
  source_id: string;
  page: number | null;
  bbox: SourceBBox | null;
  role: ViewerRefRole;
  ordinal: number;
}

type InvokeLike = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const defaultInvoke = invoke as unknown as InvokeLike;

function normalizePage(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const page = Math.trunc(value);
  return page >= 1 ? page : null;
}

/** Reject invalid/out-of-page bboxes instead of clamping them onto the image. */
export function normalizeSourceBBox(value: unknown): SourceBBox | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const numbers = value.slice(0, 4).map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const [left, top, right, bottom] = numbers;
  if (left < 0 || top < 0 || right > 1 || bottom > 1) return null;
  if (right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

function normalizeRef(ref: QuestionSourceRef | null | undefined, role: ViewerRefRole, ordinal: number): ViewerSourceRef {
  return {
    source_id: typeof ref?.source_id === 'string' ? ref.source_id.trim() : '',
    page: normalizePage(ref?.page),
    bbox: normalizeSourceBBox(ref?.bbox),
    role,
    ordinal,
  };
}

/**
 * Question refs come first, then answer refs. Both roles are kept separate so
 * the UI can say whether a page locates the stem or the answer.
 */
export function buildViewerSourceRefs(
  sourceRefs?: readonly QuestionSourceRef[] | null,
  answerSourceRefs?: readonly QuestionSourceRef[] | null,
): ViewerSourceRef[] {
  return [
    ...(sourceRefs ?? []).map((ref, index) => normalizeRef(ref, 'question', index)),
    ...(answerSourceRefs ?? []).map((ref, index) => normalizeRef(ref, 'answer', index)),
  ];
}

function refKey(ref: ViewerSourceRef): string {
  return `${ref.role}:${ref.ordinal}:${ref.source_id}:${ref.page ?? 'none'}`;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return String(error ?? '');
}

export async function fetchQuestionSourcePage(
  examId: string,
  sourceId: string,
  page: number | null,
  invokeFn: InvokeLike = defaultInvoke,
): Promise<SourcePageResult> {
  return (await invokeFn('qbank_get_source_page', {
    examId,
    sourceId,
    page,
  })) as SourcePageResult;
}

interface BlobBase64Result {
  base64?: string;
  mimeType?: string;
  mime_type?: string;
}

/** Resolve a page blob through the existing VFS image API. */
export async function loadSourceBlobDataUrl(
  blobHash: string,
  invokeFn: InvokeLike = defaultInvoke,
): Promise<string> {
  const result = (await invokeFn('vfs_get_blob_base64', { blobHash })) as BlobBase64Result;
  if (!result?.base64) {
    throw new Error('Empty blob content');
  }
  const mime = result.mimeType || result.mime_type || 'image/jpeg';
  return `data:${mime};base64,${result.base64}`;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type ErrorKind = 'legacy' | 'missing-exam' | 'load';

export interface QuestionSourceViewerProps {
  isOpen: boolean;
  onClose: () => void;
  examId?: string | null;
  sourceRefs?: readonly QuestionSourceRef[] | null;
  answerSourceRefs?: readonly QuestionSourceRef[] | null;
  initialRefIndex?: number;
  className?: string;
}

const RefList: React.FC<{
  refs: ViewerSourceRef[];
  activeIndex: number;
  layout: 'desktop' | 'mobile';
  onSelect: (index: number) => void;
}> = ({ refs, activeIndex, layout, onSelect }) => {
  const { t } = useTranslation('exam_sheet');
  return (
    <div
      data-testid="source-viewer-refs"
      className={cn(
        'flex gap-1.5',
        layout === 'mobile' ? 'w-full overflow-x-auto px-3 py-2' : 'flex-col',
      )}
    >
      {refs.map((ref, index) => {
        const active = index === activeIndex;
        const roleLabel =
          ref.role === 'answer'
            ? t('questionBank.sourceViewer.answerRef', { defaultValue: '答案来源' })
            : t('questionBank.sourceViewer.questionRef', { defaultValue: '题干来源' });
        const pageLabel =
          ref.page != null
            ? t('questionBank.sourceViewer.pageNumber', { defaultValue: '第 {{page}} 页', page: ref.page })
            : t('questionBank.sourceViewer.noPageShort', { defaultValue: '无页码' });
        return (
          <DsButton
            key={`${refKey(ref)}:${index}`}
            variant="ghost"
            size="sm"
            onClick={() => onSelect(index)}
            aria-pressed={active}
            data-testid={`source-ref-${index}`}
            className={cn(
              'ui-state-colors !h-auto min-h-0 shrink-0 !justify-start !whitespace-normal !rounded-md !border !px-2 !py-1.5 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              layout === 'mobile' ? 'min-w-[152px]' : 'w-full',
              active
                ? 'border-primary/50 bg-primary/[0.10] text-foreground'
                : 'border-border/40 bg-muted/20 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-1 text-caption font-medium">
              <span
                className={cn(
                  'rounded px-1 py-px text-2xs uppercase tracking-wide',
                  ref.role === 'answer' ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary',
                )}
              >
                {roleLabel}
              </span>
              <span className="tabular-nums">{pageLabel}</span>
              {ref.bbox && (
                <span
                  className="rounded bg-warning/15 px-1 py-px text-2xs text-warning"
                  title={t('questionBank.sourceViewer.hasBBox', { defaultValue: '含定位框' })}
                >
                  bbox
                </span>
              )}
            </span>
            <span className="mt-0.5 block max-w-[220px] truncate font-mono text-2xs opacity-70">
              {ref.source_id || t('questionBank.sourceViewer.unknownSource', { defaultValue: '未知来源' })}
            </span>
          </DsButton>
        );
      })}
    </div>
  );
};

const SourceMeta: React.FC<{
  data: SourcePageResult | null;
  activeRef: ViewerSourceRef | null;
  viewPage: number | null;
  onSelectPage: (page: number) => void;
}> = ({ data, activeRef, viewPage, onSelectPage }) => {
  const { t } = useTranslation('exam_sheet');
  const pages = data?.available_pages ?? [];
  const pageIsInSource = viewPage != null && pages.includes(viewPage);
  const pageLabel =
    viewPage != null
      ? t('questionBank.sourceViewer.pageNumber', { defaultValue: '第 {{page}} 页', page: viewPage })
      : t('questionBank.sourceViewer.noPageShort', { defaultValue: '无页码' });

  return (
    <div className="space-y-2">
      <div>
        <div className="text-caption font-medium text-foreground">
          {data?.source_name || activeRef?.source_id || t('questionBank.sourceViewer.unknownSource', { defaultValue: '未知来源' })}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          <span className="tabular-nums">{pageLabel}</span>
          {data?.source_format && <span className="uppercase">{data.source_format}</span>}
          {data?.page_count != null && (
            <span>
              {t('questionBank.sourceViewer.pageCount', {
                defaultValue: '共 {{count}} 页',
                count: data.page_count,
              })}
            </span>
          )}
        </div>
      </div>

      {data?.original_path && (
        <div className="text-2xs leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground/70">
            {t('questionBank.sourceViewer.originalPath', { defaultValue: '原始文件：' })}
          </span>
          <span className="break-all font-mono">{data.original_path}</span>
        </div>
      )}

      {pages.length > 0 && (
        <div>
          <div className="mb-1 text-2xs text-muted-foreground">
            {t('questionBank.sourceViewer.availablePages', { defaultValue: '可用页' })}
          </div>
          <div className="flex flex-wrap gap-1">
            {pages.map((page) => (
              <DsButton
                key={page}
                variant="ghost"
                size="sm"
                onClick={() => onSelectPage(page)}
                aria-pressed={page === viewPage}
                className={cn(
                  'ui-state-colors !h-auto min-h-0 !rounded !border !px-1.5 !py-0.5 text-2xs tabular-nums',
                  page === viewPage
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/40 bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {page}
              </DsButton>
            ))}
          </div>
          {!pageIsInSource && viewPage != null && (
            <p className="mt-1 text-2xs text-warning">
              {t('questionBank.sourceViewer.pageMissing', {
                defaultValue: '来源中没有第 {{page}} 页，未生成替代页面。',
                page: viewPage,
              })}
            </p>
          )}
        </div>
      )}

      {pages.length === 0 && data?.page_count != null && viewPage != null && (
        <p className="text-2xs text-warning">
          {t('questionBank.sourceViewer.noRasterizedPage', {
            defaultValue: '未提供页面图像，仅显示原始文件信息。',
          })}
        </p>
      )}

      {data?.text && (
        <div>
          <div className="mb-1 text-2xs text-muted-foreground">
            {viewPage == null
              ? t('questionBank.sourceViewer.nativeText', { defaultValue: '原生文本' })
              : t('questionBank.sourceViewer.pageText', { defaultValue: '页面文字层' })}
          </div>
          <div className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-muted/20 p-2 text-caption leading-relaxed text-muted-foreground">
            {data.text}
          </div>
        </div>
      )}
    </div>
  );
};

export const QuestionSourceViewer: React.FC<QuestionSourceViewerProps> = ({
  isOpen,
  onClose,
  examId,
  sourceRefs,
  answerSourceRefs,
  initialRefIndex = 0,
  className,
}) => {
  const { t } = useTranslation('exam_sheet');
  const isMobile = useIsMobile();

  const refs = useMemo(
    () => buildViewerSourceRefs(sourceRefs, answerSourceRefs),
    [sourceRefs, answerSourceRefs],
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const [viewPage, setViewPage] = useState<number | null>(null);
  const [data, setData] = useState<SourcePageResult | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>('legacy');
  const requestTokenRef = useRef(0);
  const wasOpenRef = useRef(false);

  const activeRef = refs[activeIndex] ?? null;
  const activeRefKey = activeRef ? refKey(activeRef) : '';
  const activeSourceId = activeRef?.source_id ?? '';
  const hasActiveRef = activeRef != null;

  // Opening (or changing the supplied ref set) starts at the requested ref.
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const lastIndex = Math.max(0, refs.length - 1);
    setActiveIndex(Math.min(Math.max(initialRefIndex, 0), lastIndex));
  }, [isOpen, initialRefIndex, refs.length]);

  // A ref change selects its real page. `null` stays null (no page 1 fallback).
  useEffect(() => {
    if (!isOpen) return;
    setViewPage(activeRef?.page ?? null);
  }, [isOpen, activeRefKey, activeRef?.page]);

  // Reset immediately when switching refs so stale page images cannot flash.
  useEffect(() => {
    if (!isOpen) return;
    requestTokenRef.current += 1;
    setData(null);
    setImageUrl(null);
    setError(null);
  }, [isOpen, activeRefKey]);

  useEffect(() => {
    if (!isOpen) return;
    if (!hasActiveRef) {
      setLoadState('idle');
      return;
    }
    if (!activeSourceId) {
      setLoadState('error');
      setErrorKind('legacy');
      setError('');
      return;
    }
    if (!examId) {
      setLoadState('error');
      setErrorKind('missing-exam');
      setError('');
      return;
    }

    const token = ++requestTokenRef.current;
    setData(null);
    setImageUrl(null);
    setLoadState('loading');
    setError(null);
    void (async () => {
      try {
        const pageResult = await fetchQuestionSourcePage(examId, activeSourceId, viewPage);
        if (token !== requestTokenRef.current) return;
        setData(pageResult);
        if (pageResult.blob_hash) {
          const url = await loadSourceBlobDataUrl(pageResult.blob_hash);
          if (token !== requestTokenRef.current) return;
          setImageUrl(url);
        }
        setLoadState('ready');
      } catch (caught: unknown) {
        if (token !== requestTokenRef.current) return;
        setData(null);
        setImageUrl(null);
        setErrorKind('legacy');
        setError(readErrorMessage(caught));
        setLoadState('error');
      }
    })();
  }, [isOpen, examId, activeSourceId, hasActiveRef, viewPage]);

  const moveRef = useCallback((delta: number) => {
    setActiveIndex((current) => {
      const next = current + delta;
      return Math.min(Math.max(next, 0), Math.max(0, refs.length - 1));
    });
  }, [refs.length]);

  const handleViewerKeyDown = useCallback((event: Event) => {
    const keyboard = event as KeyboardEvent;
    const target = keyboard.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (keyboard.key === 'ArrowLeft') {
      keyboard.preventDefault();
      moveRef(-1);
    } else if (keyboard.key === 'ArrowRight') {
      keyboard.preventDefault();
      moveRef(1);
    }
  }, [moveRef]);

  useEventRegistry(
    isOpen
      ? [{ target: 'document', type: 'keydown', listener: handleViewerKeyDown }]
      : [],
    [isOpen, handleViewerKeyDown],
  );

  const availablePages = data?.available_pages ?? [];
  const pageIndex = viewPage != null ? availablePages.indexOf(viewPage) : -1;
  const canGoPreviousPage = pageIndex > 0;
  const canGoNextPage = pageIndex >= 0 && pageIndex < availablePages.length - 1;
  const canGoPreviousRef = activeIndex > 0;
  const canGoNextRef = activeIndex < refs.length - 1;

  const pageLabel =
    viewPage != null
      ? t('questionBank.sourceViewer.pageNumber', { defaultValue: '第 {{page}} 页', page: viewPage })
      : t('questionBank.sourceViewer.noPageShort', { defaultValue: '无页码' });
  const sourceTitle =
    data?.source_name || activeRef?.source_id || t('questionBank.sourceViewer.unknownSource', { defaultValue: '未知来源' });

  const bbox = activeRef?.bbox;
  const showBBox =
    Boolean(bbox) &&
    imageUrl != null &&
    activeRef?.page != null &&
    viewPage === activeRef.page;
  const bboxStyle = showBBox && bbox
    ? {
        left: `${bbox[0] * 100}%`,
        top: `${bbox[1] * 100}%`,
        width: `${(bbox[2] - bbox[0]) * 100}%`,
        height: `${(bbox[3] - bbox[1]) * 100}%`,
      }
    : undefined;

  const roleLabel = activeRef?.role === 'answer'
    ? t('questionBank.sourceViewer.answerRef', { defaultValue: '答案来源' })
    : t('questionBank.sourceViewer.questionRef', { defaultValue: '题干来源' });

  const legacyDetail = t('questionBank.sourceViewer.legacyRefDetail', {
    defaultValue: '来源 {{sourceId}} · {{page}}',
    sourceId: activeRef?.source_id || t('questionBank.sourceViewer.unknownSource', { defaultValue: '未知来源' }),
    page: pageLabel,
  });

  const renderEmptyPane = () => {
    if (loadState === 'loading') {
      return (
        <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          <CircleNotch size={22} className="animate-spin" />
          <span>{t('questionBank.sourceViewer.loading', { defaultValue: '正在读取原题页面…' })}</span>
        </div>
      );
    }
    if (loadState === 'error') {
      const title = errorKind === 'missing-exam'
        ? t('questionBank.sourceViewer.missingExam', { defaultValue: '缺少题目集上下文，无法读取原题来源' })
        : t('questionBank.sourceViewer.legacyUnavailable', {
            defaultValue: '旧版来源引用不可用（缺少可解析的来源记录）',
          });
      return (
        <div role="alert" data-testid="source-viewer-error" className="max-w-md space-y-2 px-4 text-center">
          <WarningCircle size={24} className="mx-auto text-warning" />
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="break-all font-mono text-caption text-muted-foreground">{legacyDetail}</p>
          {error && <p className="break-words text-2xs text-muted-foreground/80">{error}</p>}
        </div>
      );
    }
    if (loadState === 'ready' && viewPage == null) {
      return (
        <div className="max-w-md space-y-2 px-4 text-center" data-testid="source-viewer-no-page">
          <FileText size={24} className="mx-auto text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t('questionBank.sourceViewer.noPageTitle', { defaultValue: '该来源没有页码' })}
          </p>
          <p className="text-xs text-muted-foreground">
            {data?.source_name
              ? t('questionBank.sourceViewer.noPageWithSource', {
                  defaultValue: '原始来源：{{name}}。未生成替代页面。',
                  name: data.source_name,
                })
              : t('questionBank.sourceViewer.noPageHint', { defaultValue: '未生成替代页面。' })}
          </p>
        </div>
      );
    }
    if (loadState === 'ready') {
      if (availablePages.length === 0) {
        return (
          <div className="max-w-md space-y-2 px-4 text-center" data-testid="source-viewer-page-image-unavailable">
            <FileText size={24} className="mx-auto text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {t('questionBank.sourceViewer.pageImageUnavailableTitle', {
                defaultValue: '该页没有可用的页面图像',
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {data?.source_name
                ? t('questionBank.sourceViewer.pageImageUnavailableWithSource', {
                    defaultValue: '原始文件：{{name}}。未生成替代页面。',
                    name: data.source_name,
                  })
                : t('questionBank.sourceViewer.pageImageUnavailableHint', {
                    defaultValue: '已显示原始文件信息；未生成替代页面。',
                  })}
            </p>
          </div>
        );
      }
      return (
        <div className="max-w-md space-y-2 px-4 text-center" data-testid="source-viewer-page-missing">
          <ImageIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t('questionBank.sourceViewer.pageMissingTitle', {
              defaultValue: '来源中没有第 {{page}} 页',
              page: viewPage,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('questionBank.sourceViewer.pageMissingHint', { defaultValue: '未用其他页面替代。' })}
          </p>
        </div>
      );
    }
    return (
      <div className="px-4 text-center text-xs text-muted-foreground">
        {refs.length === 0
          ? t('questionBank.sourceViewer.noRefs', { defaultValue: '该题目没有来源定位' })
          : t('questionBank.sourceViewer.selectRef', { defaultValue: '选择一个来源定位以查看原题页面' })}
      </div>
    );
  };

  return (
    <DsDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      maxWidth="max-w-6xl"
      aria-label={t('questionBank.sourceViewer.title', { defaultValue: '原题来源' })}
      className={cn('h-[min(85vh,720px)]', className)}
    >
      <div
        data-testid="question-source-viewer"
        data-source-viewer-layout={isMobile ? 'mobile' : 'desktop'}
        className="flex h-full min-h-0 flex-col"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border/40 px-4 py-3 pr-14">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {t('questionBank.sourceViewer.title', { defaultValue: '原题来源' })}
            </h2>
            <p className="mt-0.5 truncate text-caption text-muted-foreground">
              {roleLabel} · {sourceTitle} · <span className="tabular-nums">{pageLabel}</span>
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-muted/40 px-2 py-1 text-2xs tabular-nums text-muted-foreground">
            {refs.length > 0
              ? t('questionBank.sourceViewer.refPosition', {
                  defaultValue: '{{current}} / {{total}}',
                  current: Math.min(activeIndex + 1, refs.length),
                  total: refs.length,
                })
              : t('questionBank.sourceViewer.noRefsShort', { defaultValue: '无来源' })}
          </span>
        </header>

        {isMobile && refs.length > 0 && (
          <div className="shrink-0 overflow-hidden border-b border-border/30 bg-muted/10">
            <RefList refs={refs} activeIndex={activeIndex} layout="mobile" onSelect={setActiveIndex} />
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-3">
            {imageUrl ? (
              <div
                className="relative m-auto inline-block max-w-full"
                data-testid="source-page-canvas"
                data-page-width={data?.width ?? undefined}
                data-page-height={data?.height ?? undefined}
              >
                <img
                  src={imageUrl}
                  alt={t('questionBank.sourceViewer.pageImageAlt', {
                    defaultValue: '{{source}} {{page}} 原题页面',
                    source: sourceTitle,
                    page: pageLabel,
                  })}
                  draggable={false}
                  className="block max-h-[52dvh] w-auto max-w-full select-none object-contain md:max-h-[calc(85vh-235px)]"
                />
                {bboxStyle && (
                  <div
                    data-testid="source-page-bbox"
                    role="img"
                    aria-label={t('questionBank.sourceViewer.bboxLabel', { defaultValue: '题目定位区域' })}
                    className="pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/15 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]"
                    style={bboxStyle}
                  />
                )}
              </div>
            ) : (
              renderEmptyPane()
            )}
          </div>

          {!isMobile && (
            <aside className="flex w-72 shrink-0 flex-col border-l border-border/40 bg-background">
              {refs.length > 0 && (
                <div className="max-h-[42%] shrink-0 overflow-y-auto border-b border-border/30 p-2">
                  <RefList refs={refs} activeIndex={activeIndex} layout="desktop" onSelect={setActiveIndex} />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <SourceMeta
                  data={data}
                  activeRef={activeRef}
                  viewPage={viewPage}
                  onSelectPage={setViewPage}
                />
              </div>
            </aside>
          )}
        </div>

        {isMobile && (data || loadState === 'error') && (
          <div className="max-h-40 shrink-0 overflow-y-auto border-t border-border/30 bg-background px-3 py-2">
            <SourceMeta
              data={data}
              activeRef={activeRef}
              viewPage={viewPage}
              onSelectPage={setViewPage}
            />
          </div>
        )}

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/40 bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1">
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              disabled={!canGoPreviousPage}
              onClick={() => setViewPage(availablePages[pageIndex - 1])}
              aria-label={t('questionBank.sourceViewer.previousPage', { defaultValue: '上一页' })}
              className="!h-7 !w-7"
            >
              <CaretLeft size={14} />
            </DsButton>
            <span className="min-w-14 text-center text-caption tabular-nums text-muted-foreground">
              {pageLabel}
            </span>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              disabled={!canGoNextPage}
              onClick={() => setViewPage(availablePages[pageIndex + 1])}
              aria-label={t('questionBank.sourceViewer.nextPage', { defaultValue: '下一页' })}
              className="!h-7 !w-7"
            >
              <CaretRight size={14} />
            </DsButton>
          </div>

          {refs.length > 0 && (
            <div className="ml-auto flex items-center gap-1">
              <DsButton
                variant="ghost"
                size="sm"
                disabled={!canGoPreviousRef}
                onClick={() => moveRef(-1)}
                aria-label={t('questionBank.sourceViewer.previousRef', { defaultValue: '上一条来源' })}
                className="!h-7 !px-2 text-caption"
              >
                <ArrowLeft size={13} className="mr-1" />
                {t('questionBank.sourceViewer.previousRefShort', { defaultValue: '上一处' })}
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                disabled={!canGoNextRef}
                onClick={() => moveRef(1)}
                aria-label={t('questionBank.sourceViewer.nextRef', { defaultValue: '下一条来源' })}
                className="!h-7 !px-2 text-caption"
              >
                {t('questionBank.sourceViewer.nextRefShort', { defaultValue: '下一处' })}
                <ArrowRight size={13} className="ml-1" />
              </DsButton>
            </div>
          )}
        </footer>
      </div>
    </DsDialog>
  );
};

export default QuestionSourceViewer;
