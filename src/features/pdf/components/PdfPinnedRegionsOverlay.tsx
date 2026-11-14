/**
 * PDF 画中画对照浮窗（Sioyek Portal / LiquidText 风格）：
 * 将框选出的架构图、核心公式或三线表钉在阅读器角落，跨页阅读方法推导或消融实验时可随时对照，
 * 支持拖拽位置、两档尺寸切换（240px / 360px）、折叠成紧凑胶囊、一键跳回原页与送入主对话。
 */

import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsInSimple,
  ArrowsOutSimple,
  ChatCircleText,
  Crosshair,
  Minus,
  PushPinSimple,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/utils/cn';
import { captureBaseName } from '../regionCapture';

// ============================================================================
// Props 与数据类型
// ============================================================================

export interface PinnedPdfRegion {
  id: string;
  page: number;
  title: string;
  blob: Blob;
  imageUrl: string;
  x: number;
  y: number;
  expanded: boolean;
  collapsed: boolean;
}

export interface PdfPinnedRegionsOverlayProps {
  containerRef: React.RefObject<HTMLElement | null>;
  regions: readonly PinnedPdfRegion[];
  documentTitle?: string;
  onUpdateRegion: (id: string, patch: Partial<PinnedPdfRegion>) => void;
  onRemoveRegion: (id: string) => void;
  onJumpToPage: (page: number, label?: string) => void;
}

const COMPACT_CARD_WIDTH = 248;
const EXPANDED_CARD_WIDTH = 368;
const COLLAPSED_PILL_WIDTH = 176;
const EDGE_PADDING = 10;

// ============================================================================
// 组件实现
// ============================================================================

export const PdfPinnedRegionsOverlay: React.FC<PdfPinnedRegionsOverlayProps> = ({
  containerRef,
  regions,
  documentTitle,
  onUpdateRegion,
  onRemoveRegion,
  onJumpToPage,
}) => {
  const { t } = useTranslation(['pdf', 'common']);
  const dragStateRef = useRef<{
    id: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    cardWidth: number;
  } | null>(null);

  const clampPosition = useCallback(
    (x: number, y: number, cardWidth: number): { x: number; y: number } => {
      const container = containerRef.current;
      if (!container) return { x: Math.max(EDGE_PADDING, x), y: Math.max(EDGE_PADDING, y) };
      const maxX = Math.max(EDGE_PADDING, container.clientWidth - cardWidth - EDGE_PADDING);
      const maxY = Math.max(EDGE_PADDING, container.clientHeight - 92);
      return {
        x: Math.min(maxX, Math.max(EDGE_PADDING, Math.round(x))),
        y: Math.min(maxY, Math.max(EDGE_PADDING, Math.round(y))),
      };
    },
    [containerRef],
  );

  const handleHeaderPointerDown = useCallback(
    (region: PinnedPdfRegion, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 环境不支持指针捕获时忽略
      }
      const cardWidth = region.collapsed
        ? COLLAPSED_PILL_WIDTH
        : region.expanded
          ? EXPANDED_CARD_WIDTH
          : COMPACT_CARD_WIDTH;
      dragStateRef.current = {
        id: region.id,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: region.x,
        originY: region.y,
        cardWidth,
      };
    },
    [],
  );

  const handleHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const next = clampPosition(
        drag.originX + (event.clientX - drag.startClientX),
        drag.originY + (event.clientY - drag.startClientY),
        drag.cardWidth,
      );
      onUpdateRegion(drag.id, next);
    },
    [clampPosition, onUpdateRegion],
  );

  const handleHeaderPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
  }, []);

  const handleSendToChat = useCallback(
    async (region: PinnedPdfRegion) => {
      try {
        const name = captureBaseName(documentTitle, t('pdf:capture.untitled'));
        const file = new File(
          [region.blob],
          `${t('pdf:capture.file_name', { name, page: region.page })}.png`,
          { type: 'image/png' },
        );
        const { sendImageToChat } = await import('@/features/chat/context/imageToChat');
        await sendImageToChat(file, t('pdf:capture.source', { name, page: region.page }));
      } catch {
        showGlobalNotification('error', t('pdf:capture.failed'));
      }
    },
    [documentTitle, t],
  );

  if (regions.length === 0) return null;

  return (
    <div className="ds-pdf__pinned-layer" data-testid="pdf-pinned-regions-layer">
      {regions.map((region) => {
        const width = region.collapsed
          ? undefined
          : region.expanded
            ? EXPANDED_CARD_WIDTH
            : COMPACT_CARD_WIDTH;
        const pos = clampPosition(
          region.x,
          region.y,
          width ?? COLLAPSED_PILL_WIDTH,
        );

        return (
          <div
            key={region.id}
            className={cn(
              'ds-pdf__pinned-card ui-rise-in',
              region.collapsed && 'ds-pdf__pinned-card--collapsed',
            )}
            style={{
              left: pos.x,
              top: pos.y,
              width,
            }}
            data-testid="pdf-pinned-card"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div
              className="ds-pdf__pinned-header"
              onPointerDown={(e) => handleHeaderPointerDown(region, e)}
              onPointerMove={handleHeaderPointerMove}
              onPointerUp={handleHeaderPointerUp}
              onPointerCancel={handleHeaderPointerUp}
            >
              <span className="ds-pdf__pinned-dot" aria-hidden="true" />
              <span className="ds-pdf__pinned-page font-mono tabular-nums">
                P.{region.page}
              </span>
              <span className="ds-pdf__pinned-title" title={region.title}>
                {region.title}
              </span>

              <div className="ds-pdf__pinned-actions">
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="ds-pdf__pinned-btn"
                  onClick={() => onJumpToPage(region.page, region.title)}
                  title={t('pdf:pinned.jump_to_source', { page: region.page })}
                  aria-label={t('pdf:pinned.jump_to_source', { page: region.page })}
                >
                  <Crosshair size={14} />
                </DsButton>

                {!region.collapsed && (
                  <>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="ds-pdf__pinned-btn"
                      onClick={() => void handleSendToChat(region)}
                      title={t('pdf:pinned.send_to_chat')}
                      aria-label={t('pdf:pinned.send_to_chat')}
                    >
                      <ChatCircleText size={14} />
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="ds-pdf__pinned-btn"
                      onClick={() =>
                        onUpdateRegion(region.id, { expanded: !region.expanded })
                      }
                      title={
                        region.expanded
                          ? t('pdf:pinned.compact_size')
                          : t('pdf:pinned.expand_size')
                      }
                      aria-label={
                        region.expanded
                          ? t('pdf:pinned.compact_size')
                          : t('pdf:pinned.expand_size')
                      }
                    >
                      {region.expanded ? (
                        <ArrowsInSimple size={14} />
                      ) : (
                        <ArrowsOutSimple size={14} />
                      )}
                    </DsButton>
                  </>
                )}

                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="ds-pdf__pinned-btn"
                  onClick={() =>
                    onUpdateRegion(region.id, { collapsed: !region.collapsed })
                  }
                  title={
                    region.collapsed
                      ? t('pdf:pinned.expand_card')
                      : t('pdf:pinned.collapse_card')
                  }
                  aria-label={
                    region.collapsed
                      ? t('pdf:pinned.expand_card')
                      : t('pdf:pinned.collapse_card')
                  }
                >
                  {region.collapsed ? <PushPinSimple size={14} /> : <Minus size={14} />}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="ds-pdf__pinned-btn"
                  onClick={() => onRemoveRegion(region.id)}
                  title={t('pdf:a11y.close')}
                  aria-label={t('pdf:a11y.close')}
                >
                  <X size={14} />
                </DsButton>
              </div>
            </div>

            {!region.collapsed && (
              <div className="ds-pdf__pinned-body">
                <img
                  src={region.imageUrl}
                  alt={region.title}
                  className="ds-pdf__pinned-img"
                  draggable={false}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PdfPinnedRegionsOverlay;
