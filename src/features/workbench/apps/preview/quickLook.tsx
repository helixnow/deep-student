/**
 * quickLook — preview 壳提供的可复用快速预览浮层 API（macOS 空格 Quick Look 同构）
 *
 * 设计目标：files 等宿主不必自渲染预览窗，也不必与 preview 壳产生编译期耦合——
 * 通过 window CustomEvent 解耦：
 *
 *   requestQuickLook(resourceId)   // 打开（同一资源再次请求＝关闭，空格语义）
 *   closeQuickLook()               // 显式关闭
 *
 * 浮层宿主 <QuickLookHost /> 由 WorkbenchDesktop 常驻挂载（未打开时零成本），
 * 内容复用 UnifiedAppPanel（与文件预览窗同一套路由：PDF/EPUB/图片/音视频/文本）。
 *
 * 交互契约：Esc / 空格 / 点击背景关闭；role=dialog + aria-modal 使原生
 * browser 子 WebView 自动让位（见 BrowserAppWindow 的 MODAL_SURFACE_BLOCKER_SELECTOR）。
 */
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent, useAppEvent } from '@/events';
import type { WbPreviewQuickLookDetail } from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { normalizeResourceInstanceKey } from '../content/resourceIdentity';
import './QuickLookOverlay.css';

const UnifiedAppPanel = React.lazy(() => import('@/features/learning-hub/apps/UnifiedAppPanel'));

export const QUICK_LOOK_EVENT = APP_EVENTS.WB_PREVIEW_QUICK_LOOK;

export type QuickLookEventDetail = WbPreviewQuickLookDetail;

/** 打开（或按开关语义关闭）快速预览浮层 */
export function requestQuickLook(
  resourceId: string,
  options?: { toggle?: boolean },
): void {
  dispatchAppEvent(QUICK_LOOK_EVENT, { resourceId, toggle: options?.toggle ?? true });
}

/** 显式关闭快速预览浮层 */
export function closeQuickLook(): void {
  dispatchAppEvent(QUICK_LOOK_EVENT, { resourceId: null });
}

/** 事件目标是否自带键盘语义（输入框/按钮等，空格不应触发关闭） */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest('input, textarea, select, button, [contenteditable="true"], [role="slider"]'),
  );
}

/**
 * Quick Look 浮层宿主。常驻挂载（WorkbenchDesktop）；未打开时不渲染任何 DOM。
 */
export const QuickLookHost: React.FC = () => {
  const { t } = useTranslation('workbench');
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useAppEvent(
    QUICK_LOOK_EVENT,
    (detail) => {
      if (!detail) return;
      const next = normalizeResourceInstanceKey(detail.resourceId);
      setResourceId((prev) => {
        if (!next) return null;
        // 空格语义：对已打开的资源再次请求＝关闭
        if (detail.toggle !== false && prev === next) return null;
        return next;
      });
    },
    [],
  );

  const close = useCallback(() => setResourceId(null), []);

  // 资源切换时重置标题，避免上一个资源的名字闪现
  useEffect(() => {
    setTitle('');
  }, [resourceId]);

  // 打开时把焦点收进面板（键盘可达）
  useEffect(() => {
    if (!resourceId) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [resourceId]);

  // Esc / 空格关闭。capture：先于窗口层/子应用快捷键消费，模态语义
  useEventRegistry(
    resourceId
      ? [
          {
            target: 'window',
            type: 'keydown',
            listener: (event) => {
              const keyEvent = event as KeyboardEvent;
              if (keyEvent.defaultPrevented) return;
              if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) return;
              if (
                keyEvent.key === 'Escape'
                || (keyEvent.key === ' ' && !isTypingTarget(keyEvent.target))
              ) {
                keyEvent.preventDefault();
                keyEvent.stopPropagation();
                close();
              }
            },
            options: true,
          },
        ]
      : [],
    [close, resourceId],
  );

  // Android 返回键 / 系统回退关闭
  useEffect(() => {
    if (!resourceId) return;
    return registerBackHandler(() => {
      close();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [close, resourceId]);

  if (!resourceId) return null;

  return createPortal(
    <div
      className="wb-quick-look-root"
      data-open="true"
      data-wb-quick-look
      data-browser-surface-occluder
      role="dialog"
      aria-modal="true"
      aria-label={title || t('filePreview.quickLook')}
    >
      <div
        className="wb-quick-look-backdrop"
        aria-hidden="true"
        onPointerDown={close}
      />
      <div ref={panelRef} className="wb-quick-look-panel" tabIndex={-1}>
        <div className="wb-quick-look-titlebar">
          <span className="wb-quick-look-title">{title || t('filePreview.quickLook')}</span>
          <span className="wb-quick-look-hint">{t('filePreview.quickLookHint')}</span>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={close}
            aria-label={t('filePreview.quickLookClose')}
            title={t('filePreview.quickLookClose')}
          >
            <X size={16} />
          </DsButton>
        </div>
        <div className="wb-quick-look-body">
          <Suspense
            fallback={<div className="wb-quick-look-loading">{t('window.loading')}</div>}
          >
            <UnifiedAppPanel
              type="file"
              resourceId={resourceId}
              dstuPath={`/${resourceId}`}
              preferNodeType
              readOnly
              isActive
              onTitleChange={setTitle}
              onClose={close}
              className="h-full"
            />
          </Suspense>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default QuickLookHost;
