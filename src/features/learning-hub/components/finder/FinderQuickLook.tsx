/**
 * FinderQuickLook — 空格快速预览浮层（对标 macOS Finder Quick Look）
 *
 * 轻量实现：可视预览（图片原图 / PDF 首页）或大图标 + 名称 + 类型 / 大小 /
 * 修改时间 / 位置 + 内容摘要（如有），不加载完整渲染管线
 * （Office / 多页 PDF 等仍走「打开」进完整预览）。
 *
 * 交互：
 * - 空格 / Esc 关闭（capture 层拦截，避免触发列表的清选/滚动）
 * - 点击遮罩关闭
 * - 「打开」按钮走宿主 onOpen（消费 LearningHubSidebarProps.onOpenPreview）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, X } from '@phosphor-icons/react';
import {
  loadQuickLookVisual,
  resolveQuickLookVisual,
  type QuickLookVisualResult,
} from './quickLookPreview';
import { cn } from '@/lib/utils';
import { coarseHitClassFor36 } from '@/components/ui/coarseHit';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { Z_INDEX } from '@/config/zIndex';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import type { ResourceIconProps } from '../../icons';
import {
  IllustratedEssayIcon,
  IllustratedExamIcon,
  IllustratedFolderIcon,
  IllustratedGenericFileIcon,
  IllustratedImageIcon,
  IllustratedMindmapIcon,
  IllustratedNoteIcon,
  IllustratedTextbookIcon,
  IllustratedTranslationIcon,
} from '../../icons';

const TYPE_ICONS: Record<DstuNodeType, React.FC<ResourceIconProps>> = {
  folder: IllustratedFolderIcon,
  note: IllustratedNoteIcon,
  textbook: IllustratedTextbookIcon,
  exam: IllustratedExamIcon,
  translation: IllustratedTranslationIcon,
  essay: IllustratedEssayIcon,
  image: IllustratedImageIcon,
  file: IllustratedGenericFileIcon,
  retrieval: IllustratedGenericFileIcon,
  mindmap: IllustratedMindmapIcon,
};

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '--';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export interface FinderQuickLookProps {
  item: DstuNode;
  onClose: () => void;
  /** 「打开」按钮：由宿主接 onOpenPreview / handleOpen */
  onOpen?: (item: DstuNode) => void;
}

export function FinderQuickLook({ item, onClose, onOpen }: FinderQuickLookProps) {
  const { t, i18n } = useTranslation(['learningHub', 'common']);
  const cardRef = useRef<HTMLDivElement>(null);

  // 空格 / Esc 关闭：capture 层拦截，避免同一按键再触发列表清选或页面滚动
  useEventRegistry(
    [
      {
        target: 'window',
        type: 'keydown',
        options: true,
        listener: (event: Event) => {
          const keyEvent = event as KeyboardEvent;
          if (keyEvent.key !== 'Escape' && keyEvent.key !== ' ') return;
          const target = keyEvent.target as HTMLElement | null;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
          }
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          onClose();
        },
      },
    ],
    [onClose],
  );

  // 📱 Android 返回键：浮层打开时先关浮层（契约第 4 条）。自绘 portal 无
  // data-state="open"，androidBackCoordinator 的 Radix 兜底匹配不到，必须
  // 显式注册（对照 LearningHubContextMenu）。组件仅在打开时挂载，无需 open 门控。
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [onClose]);

  const Icon = TYPE_ICONS[item.type] || IllustratedGenericFileIcon;
  const typeLabel = item.type === 'folder'
    ? t('learningHub:finder.quickLook.folder')
    : t(`learningHub:resourceType.${item.type === 'retrieval' ? 'file' : item.type}`);

  // ★ 可视预览：图片原图 / PDF 首页。加载中显示 shimmer，失败回退类型图标。
  const visualKind = resolveQuickLookVisual(item);
  const [visual, setVisual] = useState<QuickLookVisualResult | null>(null);
  const [visualLoading, setVisualLoading] = useState(Boolean(visualKind));
  const [visualFailed, setVisualFailed] = useState(false);

  useEffect(() => {
    setVisual(null);
    setVisualFailed(false);
    if (!visualKind) {
      setVisualLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setVisualLoading(true);

    void loadQuickLookVisual(item).then((result) => {
      if (cancelled) {
        // 过期结果：ObjectURL 立即释放，避免 Blob 泄漏
        if (result?.isObjectUrl) URL.revokeObjectURL(result.url);
        return;
      }
      if (result?.isObjectUrl) objectUrl = result.url;
      setVisual(result);
      setVisualLoading(false);
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // item 引用会随列表刷新变化；仅在内容真正变化时重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.updatedAt, visualKind]);

  const showVisual = Boolean(visualKind) && !visualFailed && (visualLoading || visual !== null);

  const contentPreview = useMemo(() => {
    const raw = item.metadata?.contentPreview;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }, [item.metadata]);

  const metaRows: Array<{ label: string; value: string }> = [
    {
      label: t('learningHub:finder.quickLook.sizeLabel'),
      value: item.type === 'folder'
        ? t('learningHub:finder.childCount', { count: item.childCount ?? 0 })
        : formatSize(item.size),
    },
    {
      label: t('learningHub:finder.quickLook.updatedLabel'),
      value: item.updatedAt ? new Date(item.updatedAt).toLocaleString(i18n.language || undefined) : '--',
    },
    {
      label: t('learningHub:finder.quickLook.pathLabel'),
      value: item.path || `/${item.id}`,
    },
  ];

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/30 p-4"
      style={{ zIndex: Z_INDEX.modal }}
      data-finder-quick-look
      role="dialog"
      aria-modal="true"
      aria-label={t('learningHub:finder.quickLook.title')}
      onMouseDown={(e) => {
        // 点遮罩关闭；点卡片内部不关
        if (!cardRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={cardRef}
        data-wb-blur-surface
        className={cn(
          'flex w-[min(420px,calc(100vw-2rem))] max-h-[min(70vh,560px)] flex-col overflow-hidden',
          'rounded-2xl border border-border/60 bg-background/95 shadow-card-lg backdrop-blur-xl'
        )}
      >
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.name}>
            {item.name || item.id}
          </span>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            // 📱 触屏：视觉保持 40px 防标题栏撑高（实体 44px TouchTarget 会撑高
            // 这条 py-2 标题栏），伪元素扩区走 coarseHit.ts 共享出口的 -inset-1 档
            // （coarseHitClassFor36 字面量），40px + 两侧各 4px = 48px ≥44px 命中区
            className={cn(
              '!h-6 !w-6 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10',
              coarseHitClassFor36
            )}
            onClick={onClose}
            aria-label={t('common:close')}
          >
            <X size={14} />
          </DsButton>
        </div>

        {/* 主体 */}
        <div className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto px-5 py-5">
          {showVisual ? (
            visualLoading ? (
              /* 加载骨架：与预览图同占位，避免布局跳动 */
              <div
                className="h-44 w-full max-w-[320px] shrink-0 animate-pulse rounded-lg bg-muted/60"
                data-testid="quick-look-visual-loading"
                aria-hidden
              />
            ) : (
              <div className="flex w-full shrink-0 flex-col items-center gap-1.5">
                <img
                  src={visual!.url}
                  alt={item.name}
                  data-testid="quick-look-visual"
                  data-visual-kind={visual!.kind}
                  className="max-h-[260px] w-auto max-w-full rounded-lg border border-border/40 bg-muted/20 object-contain shadow-sm"
                  draggable={false}
                  onError={() => setVisualFailed(true)}
                />
                {visual!.kind === 'pdf' && (
                  <span className="text-2xs text-muted-foreground/70">
                    {t('learningHub:finder.quickLook.pdfFirstPage')}
                  </span>
                )}
              </div>
            )
          ) : (
            <Icon size={96} />
          )}
          <span className="text-xs text-muted-foreground">{typeLabel}</span>

          {contentPreview && (
            <p className="w-full whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/80 line-clamp-6">
              {contentPreview}
            </p>
          )}

          <dl className="w-full space-y-1 text-xs">
            {metaRows.map((row) => (
              <div key={row.label} className="flex items-baseline gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground/70">{row.label}</dt>
                <dd className="min-w-0 flex-1 truncate text-foreground/80" title={row.value}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* 底部：打开 + 关闭提示 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/40 px-3 py-2">
          <span className="text-2xs text-muted-foreground/60">
            {t('learningHub:finder.quickLook.closeHint')}
          </span>
          {onOpen && (
            <DsButton
              variant="default"
              size="sm"
              onClick={() => onOpen(item)}
            >
              <ArrowSquareOut size={14} className="mr-1.5" />
              {t('learningHub:finder.quickLook.open')}
            </DsButton>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
