/**
 * PDF 页边反向链接胶囊（Mineral）：本页被哪些导图节点 / 闪卡 / 笔记引用。
 *
 * - 胶囊：6px 青瓷点 + `2 导图 · 1 闪卡`（等宽数字，省略 0 计数）
 * - 点开为轻量锚定浮层，1px 分隔线列出每条引用；点击条目经 `anchors.reveal`
 *   回到引用方（未打开时自动分栏打开）
 * - 胶囊自身阻断指针冒泡，避免点击触发页面双击缩放 / 划词等阅读器手势
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cards, NotePencil, TreeStructure } from '@phosphor-icons/react';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { cn } from '@/utils/cn';
import type { AnchorEdgeRecord, AnchorEdgeSourceKind } from '@/ui-kernel/contracts/interop';
import { backlinkCountParts, type AnchorBacklinkSummary } from '../interop/pdfInteropBridge';

// ============================================================================
// Props 定义
// ============================================================================

export interface PdfPageMarginBacklinksProps {
  summary: AnchorBacklinkSummary;
  /** 1-based 页码（无障碍标签与测试定位） */
  page: number;
  /** 页面右上角已有学习选择按钮时下移，避免重叠 */
  offsetForPageControls?: boolean;
  className?: string;
}

const SOURCE_ICON: Record<AnchorEdgeSourceKind, React.ElementType> = {
  mindmap: TreeStructure,
  flashcard: Cards,
  note: NotePencil,
  qbank: NotePencil,
};

const stopPointer = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

// ============================================================================
// 组件实现
// ============================================================================

export const PdfPageMarginBacklinks: React.FC<PdfPageMarginBacklinksProps> = ({
  summary,
  page,
  offsetForPageControls = false,
  className,
}) => {
  const { t } = useTranslation('pdf');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const parts = backlinkCountParts(summary);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const handleReveal = useCallback((edge: AnchorEdgeRecord) => {
    setOpen(false);
    void getAppKernel().anchors.reveal(edge.sourceAnchorUri, { splitIfClosed: true, pulse: true });
  }, []);

  if (summary.total <= 0 || parts.length === 0) return null;

  const countLabel = parts.map((part) => t(`pdf:interop.backlink_${part.kind}`, { count: part.count })).join(' · ');

  return (
    <div
      ref={rootRef}
      className={cn(
        'ds-pdf__margin-backlinks absolute right-2 z-[11]',
        offsetForPageControls ? 'top-12' : 'top-2',
        className,
      )}
      data-testid="pdf-margin-backlinks"
      data-page={page}
      onPointerDown={stopPointer}
      onMouseDown={stopPointer}
      onMouseUp={stopPointer}
      onDoubleClick={stopPointer}
      onClick={stopPointer}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-card/90 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('pdf:interop.backlinks_popover_title')} ${countLabel}`}
        title={t('pdf:interop.backlinks_popover_title')}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <span className="font-mono tabular-nums" data-testid="pdf-margin-backlinks-count">
          {countLabel}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('pdf:interop.backlinks_popover_title')}
          className="absolute right-0 top-full mt-1 min-w-[180px] max-w-[260px] rounded-lg border border-border/35 bg-card p-1.5 text-xs text-foreground shadow-sm"
        >
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1 pt-0.5 text-[11px] text-muted-foreground">
            <span>{t('pdf:interop.backlinks_popover_title')}</span>
            <span className="font-mono tabular-nums">P.{page}</span>
          </div>
          <div className="h-px bg-border/35" aria-hidden="true" />
          <ul className="pt-1">
            {summary.edges.map((edge, index) => {
              const Icon = SOURCE_ICON[edge.sourceKind] ?? NotePencil;
              const label =
                edge.sourceLabel ||
                t(`pdf:interop.backlink_${edge.sourceKind === 'qbank' ? 'note' : edge.sourceKind}`, { count: 1 });
              return (
                <li key={edge.edgeId}>
                  {index > 0 && <div className="mx-1.5 h-px bg-border/35" aria-hidden="true" />}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-foreground/[0.04]"
                    data-testid="pdf-margin-backlink-item"
                    onClick={() => handleReveal(edge)}
                  >
                    <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

export default PdfPageMarginBacklinks;
