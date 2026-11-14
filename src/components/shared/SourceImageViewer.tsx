import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import i18n from '@/i18n';
import { cn } from '@/utils/cn';

export const MAX_CONCURRENT_SOURCE_IMAGE_LOADS = 2;

export interface SourceImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedSourceImageRef {
  href: string;
  resourceId: string;
  courseId: string;
  imageId: string;
  key: string;
  page?: number;
  unit?: number;
  region?: SourceImageRegion;
  versionDigest?: string;
  label: string;
}

export type SourceImageErrorKind =
  | 'missing'
  | 'file_deleted'
  | 'digest_mismatch'
  | 'decode_error'
  | 'invalid_ref';

export interface SourceImageLoadPayload {
  blob?: Blob;
  src?: string;
  alt?: string;
  page?: number;
  unit?: number;
  versionDigest?: string;
  status?: 'ok' | 'missing' | 'file_deleted' | 'digest_mismatch';
  errorMessage?: string;
}

export function isValidSourceImageRegion(region: unknown): region is SourceImageRegion {
  if (!region || typeof region !== 'object') return false;
  const { x, y, width, height } = region as SourceImageRegion;
  if (![x, y, width, height].every(Number.isSafeInteger)) return false;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return false;
  if (x + width > 1000 || y + height > 1000) return false;
  return true;
}

export function formatSourceImageLocationLabel(params: {
  page?: number;
  unit?: number;
  region?: SourceImageRegion;
  imageId: string;
}): string {
  const { page, unit, region, imageId } = params;
  if (typeof page === 'number' && page >= 1) {
    if (region) {
      const usesPerMille =
        region.x > 100 ||
        region.y > 100 ||
        region.width > 100 ||
        region.height > 100 ||
        region.x + region.width > 100 ||
        region.y + region.height > 100;
      const scale = usesPerMille ? 10 : 1;
      const startPct = Math.max(0, Math.min(100, Math.round(region.y / scale)));
      const endPct = Math.max(
        startPct,
        Math.min(100, Math.round((region.y + region.height) / scale))
      );
      return i18n.t('learningHub:sourceImageViewer.pageRegionLabel', {
        defaultValue: '第 {{page}} 页 · 区域 {{startPct}}%–{{endPct}}%',
        page,
        startPct,
        endPct,
      });
    }
    return i18n.t('learningHub:sourceImageViewer.pageLabel', {
      defaultValue: '第 {{page}} 页',
      page,
    });
  }
  if (typeof unit === 'number' && unit >= 1) {
    return i18n.t('learningHub:sourceImageViewer.unitLabel', {
      defaultValue: '第 {{unit}} 段',
      unit,
    });
  }
  return i18n.t('learningHub:sourceImageViewer.imageLabel', {
    defaultValue: '原图 {{imageId}}',
    imageId,
  });
}

export function buildSourceImageHref(resourceId: string, imageId: string): string {
  return `#source-image/${encodeURIComponent(resourceId)}/${imageId}`;
}

/**
 * 解析 #source-image/{resourceId}/{imageId} 与
 * #source-image/{resourceId}/page-{page}-region-{x}-{y}-{width}-{height}
 */
export function parseSourceImageHref(value: unknown): ParsedSourceImageRef | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('#source-image/')) return undefined;

  const rest = trimmed.slice('#source-image/'.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return undefined;

  const [rawResourceId, rawImageId] = parts;
  if (!rawResourceId || !rawImageId) return undefined;

  let resourceId: string;
  try {
    resourceId = decodeURIComponent(rawResourceId).trim();
  } catch {
    return undefined;
  }
  if (!resourceId) return undefined;

  if (rawImageId.startsWith('page-')) {
    const pageMatch = /^page-([1-9]\d*)(?:-region-(\d+)-(\d+)-(\d+)-(\d+))?$/.exec(rawImageId);
    if (!pageMatch) return undefined;
    const page = Number(pageMatch[1]);
    if (!Number.isSafeInteger(page) || page < 1) return undefined;

    let region: SourceImageRegion | undefined;
    if (pageMatch[2] !== undefined) {
      const candidate: SourceImageRegion = {
        x: Number(pageMatch[2]),
        y: Number(pageMatch[3]),
        width: Number(pageMatch[4]),
        height: Number(pageMatch[5]),
      };
      if (!isValidSourceImageRegion(candidate)) return undefined;
      region = candidate;
    }

    const label = formatSourceImageLocationLabel({ page, region, imageId: rawImageId });
    return {
      href: trimmed,
      resourceId,
      courseId: resourceId,
      imageId: rawImageId,
      key: rawImageId,
      page,
      unit: page,
      ...(region ? { region } : {}),
      label,
    };
  }

  if (rawImageId.startsWith('image-')) {
    const imageMatch = /^image-([1-9]\d*)(?:-([a-f0-9]{8,64}))?$/i.exec(rawImageId);
    if (!imageMatch) return undefined;
    const unit = Number(imageMatch[1]);
    if (!Number.isSafeInteger(unit) || unit < 1) return undefined;
    const versionDigest = imageMatch[2]?.toLowerCase();
    const label = formatSourceImageLocationLabel({ unit, imageId: rawImageId });
    return {
      href: trimmed,
      resourceId,
      courseId: resourceId,
      imageId: rawImageId,
      key: rawImageId,
      unit,
      ...(versionDigest ? { versionDigest } : {}),
      label,
    };
  }

  if (rawImageId.startsWith('frame-')) {
    const frameMatch = /^frame-(0|[1-9]\d*)$/.exec(rawImageId);
    if (!frameMatch) return undefined;
    const ms = Number(frameMatch[1]);
    if (!Number.isSafeInteger(ms) || ms < 0) return undefined;
    return {
      href: trimmed,
      resourceId,
      courseId: resourceId,
      imageId: rawImageId,
      key: rawImageId,
      label: formatSourceImageLocationLabel({ imageId: rawImageId }),
    };
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(rawImageId)) {
    return undefined;
  }

  return {
    href: trimmed,
    resourceId,
    courseId: resourceId,
    imageId: rawImageId,
    key: rawImageId,
    label: formatSourceImageLocationLabel({ imageId: rawImageId }),
  };
}

export const parseMaterialImageHref = parseSourceImageHref;

export interface SourceImageSchedulerStats {
  activeCount: number;
  queuedCount: number;
  inFlightKeys: string[];
}

export class SourceImageLoadScheduler {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<SourceImageLoadPayload>>();

  constructor(maxConcurrent = MAX_CONCURRENT_SOURCE_IMAGE_LOADS) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  load(
    canonicalKey: string,
    loader: () => Promise<SourceImageLoadPayload>
  ): Promise<SourceImageLoadPayload> {
    const existing = this.inFlight.get(canonicalKey);
    if (existing) {
      return existing;
    }

    const promise = new Promise<SourceImageLoadPayload>((resolve, reject) => {
      const startTask = () => {
        this.activeCount += 1;
        let taskResult: Promise<SourceImageLoadPayload>;
        try {
          taskResult = Promise.resolve(loader());
        } catch (err) {
          taskResult = Promise.reject(err);
        }
        void taskResult.then(resolve, reject).finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.inFlight.delete(canonicalKey);
          const next = this.queue.shift();
          if (next) {
            next();
          }
        });
      };

      if (this.activeCount < this.maxConcurrent) {
        startTask();
      } else {
        this.queue.push(startTask);
      }
    });

    this.inFlight.set(canonicalKey, promise);
    return promise;
  }

  getStats(): SourceImageSchedulerStats {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queue.length,
      inFlightKeys: Array.from(this.inFlight.keys()),
    };
  }

  reset(): void {
    this.activeCount = 0;
    this.queue.length = 0;
    this.inFlight.clear();
  }
}

export function createSourceImageLoadScheduler(
  maxConcurrent = MAX_CONCURRENT_SOURCE_IMAGE_LOADS
): SourceImageLoadScheduler {
  return new SourceImageLoadScheduler(maxConcurrent);
}

export const defaultSourceImageScheduler = createSourceImageLoadScheduler(
  MAX_CONCURRENT_SOURCE_IMAGE_LOADS
);

export interface SourceImageViewerProps {
  href: string;
  alt?: string;
  expectedDigest?: string;
  loader?: (ref: ParsedSourceImageRef) => Promise<SourceImageLoadPayload>;
  scheduler?: SourceImageLoadScheduler;
  onReturnToSource?: (ref: ParsedSourceImageRef) => void;
  onOpenSource?: (ref: ParsedSourceImageRef) => void;
  controlBarPosition?: 'top' | 'bottom' | 'both';
  className?: string;
}

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;

function resolveErrorMessage(kind: SourceImageErrorKind, customMessage?: string): string {
  if (customMessage && customMessage.trim()) return customMessage.trim();
  switch (kind) {
    case 'file_deleted':
      return i18n.t('learningHub:sourceImageViewer.errorFileDeleted', {
        defaultValue: '本地材料文件已删除或无法访问',
      });
    case 'digest_mismatch':
      return i18n.t('learningHub:sourceImageViewer.errorDigestMismatch', {
        defaultValue: '材料内容已更新，原图版本摘要不匹配',
      });
    case 'decode_error':
      return i18n.t('learningHub:sourceImageViewer.errorDecode', {
        defaultValue: '原图解码失败，请重试加载或打开原文核对',
      });
    case 'invalid_ref':
      return i18n.t('learningHub:sourceImageViewer.errorInvalidRef', {
        defaultValue: '原图引用格式无效',
      });
    case 'missing':
    default:
      return i18n.t('learningHub:sourceImageViewer.errorMissing', {
        defaultValue: '未找到对应的材料原图',
      });
  }
}

export const SourceImageViewer: React.FC<SourceImageViewerProps> = ({
  href,
  alt,
  expectedDigest,
  loader,
  scheduler = defaultSourceImageScheduler,
  onReturnToSource,
  onOpenSource,
  controlBarPosition = 'top',
  className,
}) => {
  const { t } = useTranslation('learningHub');
  const parsedRef = useMemo(() => parseSourceImageHref(href), [href]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [inViewport, setInViewport] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [fitWidth, setFitWidth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [errorState, setErrorState] = useState<{
    kind: SourceImageErrorKind;
    message: string;
  } | null>(null);

  // IntersectionObserver：进入视口后才触发原图加载
  useEffect(() => {
    setInViewport(false);
    const node = containerRef.current;
    if (!node) return;

    if (typeof IntersectionObserver !== 'function') {
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            setInViewport(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '120px' }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [href]);

  // 加载原图并在卸载或切换时释放 Blob URL
  useEffect(() => {
    if (!parsedRef) {
      setErrorState({
        kind: 'invalid_ref',
        message: resolveErrorMessage('invalid_ref'),
      });
      setResolvedSrc(null);
      setLoading(false);
      return;
    }

    if (!inViewport) {
      return;
    }

    let cancelled = false;
    let createdBlobUrl: string | null = null;

    setLoading(true);
    setErrorState(null);
    setResolvedSrc(null);

    const canonicalKey = `${parsedRef.resourceId}::${parsedRef.imageId}`;
    const loadTask = () => {
      if (!loader) {
        return Promise.resolve<SourceImageLoadPayload>({
          status: 'missing',
          errorMessage: t('learningHub:sourceImageViewer.noLoaderConfigured', {
            defaultValue: '未配置原图加载器',
          }),
        });
      }
      return loader(parsedRef);
    };

    void scheduler
      .load(canonicalKey, loadTask)
      .then((payload) => {
        if (cancelled) return;

        const requiredDigest = expectedDigest ?? parsedRef.versionDigest;
        if (
          payload.status === 'digest_mismatch' ||
          (requiredDigest &&
            payload.versionDigest &&
            payload.versionDigest.toLowerCase() !== requiredDigest.toLowerCase())
        ) {
          setErrorState({
            kind: 'digest_mismatch',
            message: resolveErrorMessage('digest_mismatch', payload.errorMessage),
          });
          setLoading(false);
          return;
        }

        if (payload.status === 'file_deleted') {
          setErrorState({
            kind: 'file_deleted',
            message: resolveErrorMessage('file_deleted', payload.errorMessage),
          });
          setLoading(false);
          return;
        }

        if (payload.status === 'missing' || (!payload.blob && !payload.src)) {
          setErrorState({
            kind: 'missing',
            message: resolveErrorMessage('missing', payload.errorMessage),
          });
          setLoading(false);
          return;
        }

        if (payload.blob) {
          createdBlobUrl = URL.createObjectURL(payload.blob);
          setResolvedSrc(createdBlobUrl);
        } else if (payload.src) {
          setResolvedSrc(payload.src);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err ?? '');
        const kind: SourceImageErrorKind = /deleted|删除|不存在/.test(msg)
          ? 'file_deleted'
          : /digest|摘要|版本/.test(msg)
            ? 'digest_mismatch'
            : 'missing';
        setErrorState({
          kind,
          message: resolveErrorMessage(kind, msg),
        });
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdBlobUrl) {
        URL.revokeObjectURL(createdBlobUrl);
      }
    };
  }, [expectedDigest, inViewport, loader, parsedRef, reloadCount, scheduler]);

  const handleZoomOut = useCallback(() => {
    setFitWidth(false);
    setZoomPercent((prev) => Math.max(ZOOM_MIN, prev - ZOOM_STEP));
  }, []);

  const handleZoomIn = useCallback(() => {
    setFitWidth(false);
    setZoomPercent((prev) => Math.min(ZOOM_MAX, prev + ZOOM_STEP));
  }, []);

  const handleFitWidth = useCallback(() => {
    setFitWidth(true);
    setZoomPercent(100);
  }, []);

  const handleRetry = useCallback(() => {
    setReloadCount((prev) => prev + 1);
  }, []);

  const handleJumpToSource = useCallback(() => {
    if (!parsedRef) return;
    if (onReturnToSource) {
      onReturnToSource(parsedRef);
      return;
    }
    onOpenSource?.(parsedRef);
  }, [onOpenSource, onReturnToSource, parsedRef]);

  const locationLabel =
    parsedRef?.label ??
    t('learningHub:sourceImageViewer.invalidRefLabel', { defaultValue: '无效引用' });
  const showTopBar = controlBarPosition === 'top' || controlBarPosition === 'both';
  const showBottomBar = controlBarPosition === 'bottom' || controlBarPosition === 'both';

  const regionOverlayStyle = useMemo(() => {
    const region = parsedRef?.region;
    if (!region) return null;
    const usesPerMille =
      region.x > 100 ||
      region.y > 100 ||
      region.width > 100 ||
      region.height > 100 ||
      region.x + region.width > 100 ||
      region.y + region.height > 100;
    const scale = usesPerMille ? 10 : 1;
    return {
      left: `${region.x / scale}%`,
      top: `${region.y / scale}%`,
      width: `${region.width / scale}%`,
      height: `${region.height / scale}%`,
    };
  }, [parsedRef?.region]);

  const renderControlBar = (position: 'top' | 'bottom') => (
    <div
      data-testid={`source-image-control-bar-${position}`}
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 bg-card px-3 py-1.5 text-xs',
        position === 'top' ? 'border-b border-border/35' : 'border-t border-border/35'
      )}
    >
      <div className="flex items-center gap-2 text-foreground">
        <span
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            errorState
              ? 'bg-destructive'
              : resolvedSrc
                ? 'bg-success'
                : 'bg-muted-foreground/60'
          )}
        />
        <span
          data-testid="source-image-location-label"
          className="font-mono tabular-nums text-xs text-foreground"
        >
          {locationLabel}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={t('learningHub:sourceImageViewer.zoomOut', '缩小')}
          onClick={handleZoomOut}
          disabled={zoomPercent <= ZOOM_MIN || Boolean(errorState)}
          className="border border-border/35 px-2 py-0.5 text-xs text-foreground"
        >
          {t('learningHub:sourceImageViewer.zoomOut', '缩小')}
        </DsButton>
        <span
          data-testid="source-image-zoom-value"
          className="min-w-[3.25rem] text-center font-mono tabular-nums text-xs text-muted-foreground"
        >
          {zoomPercent}%
        </span>
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={t('learningHub:sourceImageViewer.zoomIn', '放大')}
          onClick={handleZoomIn}
          disabled={zoomPercent >= ZOOM_MAX || Boolean(errorState)}
          className="border border-border/35 px-2 py-0.5 text-xs text-foreground"
        >
          {t('learningHub:sourceImageViewer.zoomIn', '放大')}
        </DsButton>
        <DsButton
          variant="ghost"
          size="sm"
          aria-label={t('learningHub:sourceImageViewer.fitWidth', '适应宽度')}
          aria-pressed={fitWidth}
          onClick={handleFitWidth}
          disabled={Boolean(errorState)}
          className="border border-border/35 px-2 py-0.5 text-xs text-foreground"
        >
          {t('learningHub:sourceImageViewer.fitWidth', '适应宽度')}
        </DsButton>
        {(onReturnToSource || onOpenSource) && parsedRef && (
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="source-image-return-btn"
            onClick={handleJumpToSource}
            className="border border-border/35 px-2 py-0.5 text-xs text-foreground"
          >
            {t('learningHub:sourceImageViewer.returnToSource', '回到原文')}
          </DsButton>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      data-testid="source-image-viewer"
      data-href={href}
      className={cn(
        'overflow-hidden rounded-md border border-border/35 bg-card text-card-foreground',
        className
      )}
    >
      {showTopBar && renderControlBar('top')}

      <div className="relative overflow-auto p-3">
        {!inViewport && !errorState && (
          <div
            data-testid="source-image-lazy-placeholder"
            className="flex items-center gap-2 py-6 text-xs text-muted-foreground"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
            <span>{t('learningHub:sourceImageViewer.lazyPlaceholder', '等待进入视口后加载原图')}</span>
          </div>
        )}

        {inViewport && loading && !errorState && (
          <div
            data-testid="source-image-loading"
            className="flex items-center gap-2 py-6 text-xs text-muted-foreground"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />
            <span>{t('learningHub:sourceImageViewer.loading', '正在读取材料原图')}</span>
          </div>
        )}

        {errorState && (
          <div
            data-testid="source-image-error-card"
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded border border-border/35 bg-muted/30 px-3 py-2.5 text-xs"
          >
            <div className="flex items-center gap-2 text-foreground">
              <span className="w-1.5 h-1.5 flex-shrink-0 rounded-full bg-destructive" />
              <span>{errorState.message}</span>
            </div>
            <div className="flex items-center gap-2">
              {parsedRef && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  data-testid="source-image-retry-btn"
                  onClick={handleRetry}
                  className="border border-border/35 bg-background px-2.5 py-1 text-xs text-foreground"
                >
                  {t('learningHub:sourceImageViewer.retryLoad', '重试加载')}
                </DsButton>
              )}
              {parsedRef && (onOpenSource || onReturnToSource) && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  data-testid="source-image-open-source-btn"
                  onClick={handleJumpToSource}
                  className="border border-border/35 bg-background px-2.5 py-1 text-xs text-foreground"
                >
                  {t('learningHub:sourceImageViewer.openSource', '打开原文')}
                </DsButton>
              )}
            </div>
          </div>
        )}

        {resolvedSrc && !errorState && (
          <div className="overflow-auto">
            <div
              className="relative inline-block"
              style={{
                width: fitWidth ? '100%' : `${zoomPercent}%`,
                maxWidth: fitWidth ? '100%' : 'none',
              }}
            >
              <img
                data-testid="source-image-element"
                src={resolvedSrc}
                alt={alt || locationLabel}
                decoding="async"
                referrerPolicy="no-referrer"
                className="block h-auto w-full"
                onError={() =>
                  setErrorState({
                    kind: 'decode_error',
                    message: resolveErrorMessage('decode_error'),
                  })
                }
              />
              {regionOverlayStyle && (
                <div
                  data-testid="source-image-region-bbox"
                  role="img"
                  aria-label={t('learningHub:sourceImageViewer.regionHighlight', {
                    defaultValue: '原图定位区域',
                  })}
                  className="pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/15 ring-1 ring-background/50"
                  style={regionOverlayStyle}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {showBottomBar && renderControlBar('bottom')}
    </div>
  );
};

export default SourceImageViewer;
