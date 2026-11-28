/**
 * 内置浏览器 chrome 窗（BROWSER · B2b）
 *
 * Browser chrome + native page slot. Rust hosts the actual page as either a
 * child WebView (macOS/Windows) or a detached WebviewWindow fallback.
 * 状态消费 `@/features/browser`（B2a sessionStore / useBrowserSession）。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  EyeSlash,
  FileText,
  Globe,
  LockSimple,
  LockOpen,
  Plus,
  Prohibit,
  Robot,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/utils/cn';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useBrowserSession } from '@/features/browser/hooks/useBrowserSession';
import { browserApi, localizeBrowserGateMessage } from '@/features/browser/browserApi';
import { BROWSER_CONTENT_USER_INPUT_EVENT } from '@/features/browser/controlModeSync';
import {
  browserSurfaceBoundsFromRect,
  browserSurfaceOcclusionsFromRects,
  shouldShowBrowserSurface,
  shouldSuspendBrowserSurfaceForShellMotion,
} from '@/features/browser/nativeSurface';
import type {
  BrowserControlMode,
  BrowserRemoteInputEvent,
  BrowserScreencastFrame,
  BrowserSurfaceHostMode,
  BrowserSurfaceOcclusion,
  BrowserTabInfo,
} from '@/features/browser/types';
import type { AppWindowProps } from '../../core/types';
import { hubListenKeyed } from '../../core/eventHub';
import { useWorkbenchOverlay } from '../../core/shortcuts';
import { useWindowStore, useWindowTransientPhase } from '../../core/windowStore';
import {
  addNativeSurfaceLayoutListener,
  type NativeSurfaceLayoutEventDetail,
} from '../../core/nativeSurfaceEvents';
import { useAppsPanelOpen } from '../../components/appsPanelStore';
import { useWbSysSize } from '../system/useWbSysSize';
import {
  BROWSER_FOCUS_ADDRESS_EVENT,
  type BrowserFocusAddressEventDetail,
} from './browserChromeEvents';
import './BrowserAppWindow.css';
import { resolveBrowserLaunchability } from '@/features/browser/gates';

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const NavControls: React.FC<{
  canGoBack: boolean;
  canGoForward: boolean;
  canReload: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}> = ({
  canGoBack,
  canGoForward,
  canReload,
  loading,
  onBack,
  onForward,
  onReload,
  onStop,
}) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-nav" role="group" aria-label={t('browser.nav')}>
      {/* loading 期不锁后退/前进：点击会先停止当前加载再导航（对齐常规浏览器） */}
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        disabled={!canGoBack}
        onClick={onBack}
        aria-label={t('browser.back')}
        title={t('browser.back')}
      >
        <ArrowLeft size={16} weight="bold" aria-hidden />
      </DsButton>
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        disabled={!canGoForward}
        onClick={onForward}
        aria-label={t('browser.forward')}
        title={t('browser.forward')}
      >
        <ArrowRight size={16} weight="bold" aria-hidden />
      </DsButton>
      {loading ? (
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onStop}
          aria-label={t('browser.stop')}
          title={t('browser.stop')}
        >
          <X size={16} weight="bold" aria-hidden />
        </DsButton>
      ) : canReload ? (
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onReload}
          aria-label={t('browser.reload')}
          title={t('browser.reload')}
        >
          <ArrowClockwise size={16} weight="bold" aria-hidden />
        </DsButton>
      ) : null}
    </div>
  );
};

const AddressBar: React.FC<{
  draft: string;
  loading: boolean;
  disabled?: boolean;
  security: 'secure' | 'insecure' | 'neutral';
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
}> = ({ draft, loading, disabled = false, security, inputRef, onDraftChange, onSubmit }) => {
  const { t } = useTranslation('workbench');
  const securityLabel =
    security === 'secure'
      ? t('browser.secureConnection')
      : security === 'insecure'
        ? t('browser.insecureConnection')
        : t('browser.connectionUnknown');

  return (
    <form
      className="wb-browser-address"
      data-loading={loading ? 'true' : 'false'}
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const next = draft.trim();
        if (next) onSubmit(next);
      }}
    >
      <span
        className={`wb-browser-lock${security === 'insecure' ? ' is-insecure' : ''}`}
        role="img"
        aria-label={securityLabel}
        title={securityLabel}
      >
        {security === 'secure' ? (
          <LockSimple size={14} weight="fill" />
        ) : security === 'insecure' ? (
          <LockOpen size={14} weight="bold" />
        ) : (
          <Globe size={14} weight="bold" />
        )}
      </span>
      <input
        ref={inputRef}
        className="wb-browser-address-input ds-search-input"
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={t('browser.addressPlaceholder')}
        aria-label={t('browser.addressPlaceholder')}
        /* 长 URL 被省略号截断时，悬停仍可读到完整地址 */
        title={draft || undefined}
        spellCheck={false}
        autoComplete="off"
        inputMode="url"
        onFocus={(event) => event.currentTarget.select()}
        data-wb-browser-address
      />
      {loading ? (
        <span
          className="wb-browser-spinner"
          role="status"
          aria-label={t('window.loading')}
        />
      ) : null}
      {/* 底缘加载跑马：native 页面无自带 chrome，可见加载反馈全靠壳层（transform/opacity） */}
      <span className="wb-browser-address-progress" aria-hidden>
        <span className="wb-browser-address-progress-runner" />
      </span>
    </form>
  );
};

const ToolbarControlStatus: React.FC<{
  controlMode: BrowserControlMode;
  onTakeOver: () => void;
}> = ({ controlMode, onTakeOver }) => {
  const { t } = useTranslation('workbench');
  if (controlMode !== 'agent') {
    return (
      <span className="sr-only" role="status" data-control-mode="user">
        {t('browser.userControl')}
      </span>
    );
  }

  return (
    <div
      className="wb-browser-control is-agent"
      role="status"
      data-control-mode="agent"
    >
      <span className="wb-browser-control-label">
        <Robot size={14} weight="fill" aria-hidden />
        <span className="min-w-0 truncate">{t('browser.agentActive')}</span>
      </span>
      <DsButton
        variant="ghost"
        size="sm"
        className="wb-browser-takeover"
        onClick={onTakeOver}
      >
        {t('browser.takeOver')}
      </DsButton>
    </div>
  );
};

const DetachedPageHint: React.FC<{ onShowContent: () => void }> = ({ onShowContent }) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-detached" data-wb-browser-detached>
      <p className="wb-browser-hint-text">
        {t('browser.detachedHint')}
      </p>
      <DsButton
        variant="ghost"
        size="sm"
        className="wb-browser-hint-action"
        onClick={onShowContent}
      >
        <ArrowSquareOut size={14} weight="bold" aria-hidden />
        {t('browser.showContent')}
      </DsButton>
    </div>
  );
};

const HeadlessPageHint: React.FC<{ onShowContent: () => void }> = ({ onShowContent }) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-state-view" data-wb-browser-headless>
      <EyeSlash size={28} weight="duotone" aria-hidden className="wb-browser-empty-icon" />
      <p className="wb-browser-state-text">
        {t('browser.headlessHint')}
      </p>
      <DsButton
        variant="ghost"
        size="sm"
        className="wb-browser-hint-action"
        onClick={onShowContent}
      >
        <ArrowSquareOut size={14} weight="bold" aria-hidden />
        {t('browser.promoteForeground')}
      </DsButton>
    </div>
  );
};

const UnsupportedPageHint: React.FC = () => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-state-view" data-wb-browser-unsupported>
      <Prohibit size={28} weight="duotone" aria-hidden className="wb-browser-empty-icon" />
      <p className="wb-browser-state-text">
        {t('browser.unsupportedHint')}
      </p>
    </div>
  );
};

const TabStrip: React.FC<{
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  inTitlebar?: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}> = ({ tabs, activeTabId, inTitlebar = false, onSelectTab, onCloseTab, onNewTab }) => {
  const { t } = useTranslation('workbench');
  if (tabs.length <= 1) return null;

  return (
    <div
      className={cn('wb-browser-tab-strip', inTitlebar && 'is-titlebar')}
      role="tablist"
      aria-label={t('browser.tabs.list')}
      data-wb-browser-tab-strip
    >
      <div className="wb-browser-tab-list">
        {tabs.map((tab) => {
          const isActiveTab = activeTabId ? tab.tabId === activeTabId : tab.active;
          const label = tab.title.trim() || tab.url.trim() || t('browser.tabs.untitled');
          return (
            <div
              key={tab.tabId}
              className={cn('wb-browser-tab', isActiveTab && 'is-active')}
              data-active={isActiveTab ? 'true' : 'false'}
              onPointerDown={inTitlebar ? (e) => e.stopPropagation() : undefined}
              onDoubleClick={inTitlebar ? (e) => e.stopPropagation() : undefined}
            >
              <DsButton
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={isActiveTab}
                title={label}
                className="wb-browser-tab-trigger"
                onClick={() => onSelectTab(tab.tabId)}
              >
                <span className="min-w-0 truncate">{label}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('browser.closeTab')}
                title={t('browser.closeTab')}
                className="wb-browser-tab-close"
                onClick={() => onCloseTab(tab.tabId)}
              >
                <X size={12} weight="bold" aria-hidden />
              </DsButton>
            </div>
          );
        })}
      </div>
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('browser.newTab')}
        title={t('browser.newTab')}
        className="wb-browser-tab-add"
        onPointerDown={inTitlebar ? (e) => e.stopPropagation() : undefined}
        onDoubleClick={inTitlebar ? (e) => e.stopPropagation() : undefined}
        onClick={onNewTab}
      >
        <Plus size={14} weight="bold" aria-hidden />
      </DsButton>
    </div>
  );
};

function pointerButtonName(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

function eventModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  const mods: string[] = [];
  if (event.altKey) mods.push('Alt');
  if (event.ctrlKey) mods.push('Control');
  if (event.metaKey) mods.push('Meta');
  if (event.shiftKey) mods.push('Shift');
  return mods;
}

const REMOTE_POINTER_MOVE_THROTTLE_MS = 60;

const RemoteScreencastViewport: React.FC<{
  frame: BrowserScreencastFrame | null;
  onRemoteInput: (event: BrowserRemoteInputEvent) => void;
}> = ({ frame, onRemoteInput }) => {
  const { t } = useTranslation('workbench');
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const imeInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const lastMoveAtRef = useRef(0);
  const lastCompositionRef = useRef<{ text: string; at: number } | null>(null);

  const mapPointerCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (!frame || !imgRef.current) return null;
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
      if (frame.width <= 0 || frame.height <= 0) return null;
      const rect = imgRef.current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
      if (!Number.isFinite(scale) || scale <= 0) return null;
      const renderedW = frame.width * scale;
      const renderedH = frame.height * scale;
      const offsetX = rect.left + (rect.width - renderedW) / 2;
      const offsetY = rect.top + (rect.height - renderedH) / 2;
      if (
        clientX < offsetX ||
        clientX > offsetX + renderedW ||
        clientY < offsetY ||
        clientY > offsetY + renderedH
      ) {
        return null;
      }
      const x = Math.round(((clientX - offsetX) / renderedW) * frame.width);
      const y = Math.round(((clientY - offsetY) / renderedH) * frame.height);
      return {
        x: Math.max(0, Math.min(frame.width, x)),
        y: Math.max(0, Math.min(frame.height, y)),
      };
    },
    [frame],
  );

  const handleViewportFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && imeInputRef.current) {
        imeInputRef.current.focus({ preventScroll: true });
      }
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (imeInputRef.current) {
        imeInputRef.current.focus({ preventScroll: true });
      } else {
        event.currentTarget.focus();
      }
      const coords = mapPointerCoords(event.clientX, event.clientY);
      if (!coords) return;
      onRemoteInput({
        type: 'mousePressed',
        x: coords.x,
        y: coords.y,
        button: pointerButtonName(event.button),
        clickCount: Math.max(1, event.detail || 1),
        modifiers: eventModifiers(event),
      });
    },
    [mapPointerCoords, onRemoteInput],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const now = Date.now();
      if (now - lastMoveAtRef.current < REMOTE_POINTER_MOVE_THROTTLE_MS) return;
      const coords = mapPointerCoords(event.clientX, event.clientY);
      if (!coords) return;
      lastMoveAtRef.current = now;
      onRemoteInput({
        type: 'mouseMoved',
        x: coords.x,
        y: coords.y,
        modifiers: eventModifiers(event),
      });
    },
    [mapPointerCoords, onRemoteInput],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const coords = mapPointerCoords(event.clientX, event.clientY);
      if (!coords) return;
      onRemoteInput({
        type: 'mouseReleased',
        x: coords.x,
        y: coords.y,
        button: pointerButtonName(event.button),
        clickCount: Math.max(1, event.detail || 1),
        modifiers: eventModifiers(event),
      });
    },
    [mapPointerCoords, onRemoteInput],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onNativeWheel = (event: WheelEvent) => {
      const coords = mapPointerCoords(event.clientX, event.clientY);
      if (!coords) return;
      event.preventDefault();
      onRemoteInput({
        type: 'mouseWheel',
        x: coords.x,
        y: coords.y,
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        modifiers: eventModifiers(event),
      });
    };
    viewport.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', onNativeWheel);
    };
  }, [mapPointerCoords, onRemoteInput]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLDivElement>) => {
      isComposingRef.current = false;
      const input = imeInputRef.current;
      const text = event.data || input?.value || '';
      if (input) input.value = '';
      if (!text) return;
      lastCompositionRef.current = { text, at: Date.now() };
      onRemoteInput({ type: 'insertText', text });
    },
    [onRemoteInput],
  );

  const handleImeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nativeEvent = event.nativeEvent as InputEvent;
      if (isComposingRef.current || nativeEvent.isComposing) return;
      const text = event.currentTarget.value;
      event.currentTarget.value = '';
      if (!text) return;
      const recent = lastCompositionRef.current;
      if (recent && recent.text === text && Date.now() - recent.at < 50) {
        lastCompositionRef.current = null;
        return;
      }
      onRemoteInput({ type: 'insertText', text });
    },
    [onRemoteInput],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        isComposingRef.current ||
        event.nativeEvent.isComposing ||
        event.key === 'Process' ||
        event.keyCode === 229 ||
        event.key === 'Unidentified'
      ) {
        return;
      }
      const modifiers = eventModifiers(event);
      const isPrintable =
        event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      event.preventDefault();
      if (isPrintable) {
        onRemoteInput({ type: 'insertText', text: event.key });
        return;
      }
      onRemoteInput({ type: 'keyDown', key: event.key, modifiers });
    },
    [onRemoteInput],
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        isComposingRef.current ||
        event.nativeEvent.isComposing ||
        event.key === 'Process' ||
        event.keyCode === 229 ||
        event.key === 'Unidentified'
      ) {
        return;
      }
      const isPrintable =
        event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (isPrintable) return;
      event.preventDefault();
      onRemoteInput({ type: 'keyUp', key: event.key, modifiers: eventModifiers(event) });
    },
    [onRemoteInput],
  );

  return (
    <div
      ref={viewportRef}
      className="wb-browser-remote-viewport"
      role="application"
      tabIndex={0}
      aria-label={t('browser.remoteViewportHint')}
      data-wb-browser-remote-viewport
      onFocus={handleViewportFocus}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      <input
        ref={imeInputRef}
        type="text"
        className="wb-browser-ime-input"
        aria-label={t('browser.remoteViewportHint')}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        tabIndex={-1}
        onChange={handleImeChange}
      />
      {frame ? (
        <img
          ref={imgRef}
          className="wb-browser-remote-image"
          src={`data:${frame.mimeType};base64,${frame.data}`}
          alt={t('browser.remoteViewportHint')}
          draggable={false}
        />
      ) : (
        <div className="wb-browser-remote-placeholder" role="status">
          <Globe size={24} weight="duotone" aria-hidden className="wb-browser-empty-icon" />
          <span className="wb-browser-empty-title">{t('browser.remoteConnecting')}</span>
        </div>
      )}
    </div>
  );
};

let surfaceSequence = Date.now() * 1000;

function nextSurfaceSequence(): number {
  surfaceSequence += 1;
  return surfaceSequence;
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

function isWorkbenchShellMotionActive(slot: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return shouldSuspendBrowserSurfaceForShellMotion({
    globalDragging: root.hasAttribute('data-wb-dragging'),
    globalSettling: root.hasAttribute('data-wb-settling'),
    ownWindowDragging: Boolean(slot?.closest('.wb-window.wb-shell-dragging')),
  });
}

function isOwnWorkbenchWindowDragging(slot: HTMLElement | null): boolean {
  return Boolean(slot?.closest('.wb-window.wb-shell-dragging'));
}

function elementIsRendered(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    (!Number.isFinite(opacity) || opacity > 0.01)
  );
}

function stackingIndex(element: HTMLElement): number {
  const value = Number.parseFloat(window.getComputedStyle(element).zIndex);
  return Number.isFinite(value) ? value : 0;
}

const DOM_SURFACE_VISUAL_OCCLUDER_SELECTOR = [
  '[data-browser-surface-occluder]',
  '[data-overlay-container="true"]',
  '[role="menu"]',
  '[data-testid="wb-dock-context-menu"]',
  '[data-testid="wb-dock-window-list"]',
  '[data-wb-tile-menu]',
  '[data-testid="workbench-dev-panel"]',
  '[data-wb-menubar]',
  '.wb-apps-root',
  '.wb-wpm-overlay',
  '[data-wb-expose-root]',
  '[data-wb-switcher-root]',
  '[data-wb-desk-menu]',
  '.wb-switcher-bar',
  '[data-testid="wb-snap-preview"]',
  '.wb-dock-mag',
  '.wb-dock-tip',
].join(',');

const DOM_SURFACE_INPUT_SHIELD_SELECTOR = [
  '[data-browser-surface-input-shield]',
  '[data-overlay-container="true"]',
  '.wb-apps-root',
  '.wb-wpm-overlay',
  '[data-wb-expose-root]',
  '[role="menu"]',
  '[data-testid="wb-dock-context-menu"]',
  '[data-testid="wb-dock-window-list"]',
  '[data-wb-tile-menu]',
  '[data-wb-desk-menu-backdrop]',
  '[data-testid="wb-menubar-flyout-backdrop"]',
].join(',');

// A modal's backdrop needs the entire browser slot, not only the dialog
// panel. The native child cannot be dimmed by a DOM backdrop, so yield the
// full slot while any app-modal dialog is active.
const MODAL_SURFACE_BLOCKER_SELECTOR = [
  '[data-overlay-container="true"]',
  '.wb-apps-root',
  '.wb-wpm-overlay',
  '[data-wb-expose-root]',
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
].join(',');

interface BrowserSurfaceOcclusionLayers {
  occlusions: BrowserSurfaceOcclusion[];
  inputOcclusions: BrowserSurfaceOcclusion[];
  blocksBrowserInput: boolean;
}

function hasVisibleElement(selector: string): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).some((element) => {
    if (!elementIsRendered(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * Native child WebViews do not participate in the DOM stacking context. Mirror
 * every DOM surface above the browser page slot into the clip host. Menus have
 * a separate full-page input shield so their DOM outside-click handlers still
 * close them while the page remains visible outside the menu itself.
 */
function browserSurfaceOcclusions(
  slot: HTMLElement,
  slotRect: DOMRectReadOnly,
): BrowserSurfaceOcclusionLayers {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (hasVisibleElement(MODAL_SURFACE_BLOCKER_SELECTOR)) {
    const fullSlot = browserSurfaceOcclusionsFromRects(slotRect, viewport, [slotRect]);
    return {
      occlusions: fullSlot,
      inputOcclusions: fullSlot,
      blocksBrowserInput: true,
    };
  }

  const ownWindow = slot.closest<HTMLElement>('[data-wb-window]');
  const ownZIndex = ownWindow ? stackingIndex(ownWindow) : 0;
  const candidates: DOMRectReadOnly[] = [];

  for (const windowElement of document.querySelectorAll<HTMLElement>('[data-wb-window]')) {
    if (windowElement === ownWindow || !elementIsRendered(windowElement)) continue;
    if (stackingIndex(windowElement) <= ownZIndex) continue;
    candidates.push(windowElement.getBoundingClientRect());
  }

  const dock = document.querySelector<HTMLElement>('[data-testid="wb-dock"]');
  if (dock && elementIsRendered(dock)) {
    candidates.push(dock.getBoundingClientRect());
  }
  // Keep the auto-hide activation strip reachable even while the Dock itself
  // is hidden behind the native browser child surface.
  const dockHotzone = document.querySelector<HTMLElement>('[data-testid="wb-dock-hotzone"]');
  if (dockHotzone && elementIsRendered(dockHotzone)) {
    candidates.push(dockHotzone.getBoundingClientRect());
  }

  for (const element of document.querySelectorAll<HTMLElement>(
    DOM_SURFACE_VISUAL_OCCLUDER_SELECTOR,
  )) {
    if (!elementIsRendered(element)) continue;
    candidates.push(element.getBoundingClientRect());
  }

  const occlusions = browserSurfaceOcclusionsFromRects(
    slotRect,
    viewport,
    candidates,
  );
  const blocksBrowserInput = hasVisibleElement(DOM_SURFACE_INPUT_SHIELD_SELECTOR);
  const inputOcclusions = blocksBrowserInput
    ? browserSurfaceOcclusionsFromRects(slotRect, viewport, [slotRect])
    : occlusions;

  return { occlusions, inputOcclusions, blocksBrowserInput };
}

function browserConnectionSecurity(
  currentUrl: string,
  hasSession: boolean,
): 'secure' | 'insecure' | 'neutral' {
  if (!hasSession || !currentUrl) return 'neutral';
  try {
    const protocol = new URL(currentUrl).protocol.toLowerCase();
    if (protocol === 'https:') return 'secure';
    if (protocol === 'http:') return 'insecure';
  } catch {
    // Runtime navigation policy remains authoritative for malformed URLs.
  }
  return 'neutral';
}

interface NativeBrowserSurfaceOptions {
  windowId: string;
  slotRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string | null;
  isVisible: boolean;
  overlayOpen: boolean;
}

interface NativeBrowserSurfaceHandle {
  hostMode: BrowserSurfaceHostMode | null;
  recordHostMode: (mode: BrowserSurfaceHostMode) => void;
  refreshHostMode: () => Promise<BrowserSurfaceHostMode | null>;
}

function useNativeBrowserSurface({
  windowId,
  slotRef,
  sessionId,
  isVisible,
  overlayOpen,
}: NativeBrowserSurfaceOptions): NativeBrowserSurfaceHandle {
  const [suspended, setSuspended] = useState(false);
  const [shellMotion, setShellMotion] = useState(() => ({
    suspended: isWorkbenchShellMotionActive(slotRef.current),
    ownWindowDragging: isOwnWorkbenchWindowDragging(slotRef.current),
  }));
  const [hostMode, setHostMode] = useState<BrowserSurfaceHostMode | null>(null);
  const hostModeRef = useRef<BrowserSurfaceHostMode | null>(null);
  hostModeRef.current = hostMode;
  const mountedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const scheduleMeasureRef = useRef<() => void>(() => {});
  const lastBoundsKeyRef = useRef('');
  const latestBoundsKeyRef = useRef('');
  const boundsInFlightRef = useRef(false);
  const boundsPendingRef = useRef(false);
  const lastVisibilityRef = useRef<{ sessionId: string; visible: boolean } | null>(null);
  const visibilityQueueRef = useRef<Promise<void>>(Promise.resolve());
  const reportedErrorRef = useRef(false);
  const previousSessionRef = useRef<string | null>(null);
  const layoutSuspensionsRef = useRef(new Set<string>());
  const inputShieldActiveRef = useRef(false);

  const desiredVisible = shouldShowBrowserSurface({
    isVisible,
    hasSession: Boolean(sessionId),
    overlayOpen,
    suspended: suspended || shellMotion.suspended,
  });
  const stateRef = useRef({ sessionId, desiredVisible });
  stateRef.current = { sessionId, desiredVisible };

  const recordMode = useCallback((mode: BrowserSurfaceHostMode) => {
    hostModeRef.current = mode;
    if (mountedRef.current) setHostMode(mode);
    reportedErrorRef.current = false;
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void browserApi
      .getSurfaceHostMode()
      .then((mode) => {
        if (!cancelled) recordMode(mode);
      })
      .catch(() => {
        // Older backends without get_surface_host_mode fall back to bounds/visibility reply.
      });
    return () => {
      cancelled = true;
    };
  }, [recordMode]);

  const reportSurfaceError = useCallback((operation: string, error: unknown) => {
    if (reportedErrorRef.current) return;
    reportedErrorRef.current = true;
    console.warn(`[BrowserSurface] ${operation} failed:`, error);
  }, []);

  const requestVisibility = useCallback(
    (targetSessionId: string, visible: boolean, focus = false) => {
      if (hostModeRef.current === 'remote') return;
      const last = lastVisibilityRef.current;
      if (!focus && last?.sessionId === targetSessionId && last.visible === visible) return;
      lastVisibilityRef.current = { sessionId: targetSessionId, visible };

      visibilityQueueRef.current = visibilityQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const mode = await browserApi.setSurfaceVisibility(
              targetSessionId,
              visible,
              focus,
            );
            recordMode(mode);
          } catch (error) {
            const current = lastVisibilityRef.current;
            if (
              current?.sessionId === targetSessionId &&
              current.visible === visible
            ) {
              lastVisibilityRef.current = null;
            }
            reportSurfaceError('visibility update', error);
          }
        });
    },
    [recordMode, reportSurfaceError],
  );

  const measureAndReveal = useCallback(() => {
    if (hostModeRef.current === 'remote') return;
    const current = stateRef.current;
    if (!current.sessionId || !current.desiredVisible) return;
    const slot = slotRef.current;
    if (!slot) return;

    const slotRect = slot.getBoundingClientRect();
    const baseBounds = browserSurfaceBoundsFromRect(
      slotRect,
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    );
    if (!baseBounds) {
      latestBoundsKeyRef.current = '';
      boundsPendingRef.current = false;
      requestVisibility(current.sessionId, false);
      return;
    }
    const { blocksBrowserInput, ...surfaceLayers } = browserSurfaceOcclusions(slot, slotRect);
    if (blocksBrowserInput !== inputShieldActiveRef.current) {
      inputShieldActiveRef.current = blocksBrowserInput;
      if (blocksBrowserInput) {
        void browserApi.releaseSurfaceFocus(current.sessionId).catch((error: unknown) => {
          reportSurfaceError('keyboard focus handoff', error);
        });
      }
    }
    const bounds = {
      ...baseBounds,
      ...surfaceLayers,
    };

    const occlusionKey = bounds.occlusions
      .map(({ x, y, width, height }) => `${x},${y},${width},${height}`)
      .join(';');
    const inputOcclusionKey = bounds.inputOcclusions
      .map(({ x, y, width, height }) => `${x},${y},${width},${height}`)
      .join(';');
    const boundsKey = `${current.sessionId}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${bounds.viewportWidth}:${bounds.viewportHeight}:${occlusionKey}:${inputOcclusionKey}`;
    latestBoundsKeyRef.current = boundsKey;
    if (boundsInFlightRef.current) {
      boundsPendingRef.current = true;
      return;
    }
    if (boundsKey === lastBoundsKeyRef.current) {
      requestVisibility(current.sessionId, true);
      return;
    }
    lastBoundsKeyRef.current = boundsKey;
    boundsInFlightRef.current = true;

    void browserApi.setSurfaceBounds(
      current.sessionId,
      bounds,
      nextSurfaceSequence(),
    ).then((mode) => {
      recordMode(mode);
      const latest = stateRef.current;
      if (
        latest.sessionId === current.sessionId &&
        latest.desiredVisible &&
        latestBoundsKeyRef.current === boundsKey
      ) {
        requestVisibility(current.sessionId, true);
      }
    }).catch((error: unknown) => {
      if (lastBoundsKeyRef.current === boundsKey) {
        lastBoundsKeyRef.current = '';
      }
      if (latestBoundsKeyRef.current === boundsKey) {
        latestBoundsKeyRef.current = '';
      }
      requestVisibility(current.sessionId, false);
      reportSurfaceError('bounds update', error);
    }).finally(() => {
      boundsInFlightRef.current = false;
      if (!boundsPendingRef.current) return;
      boundsPendingRef.current = false;
      scheduleMeasureRef.current();
    });
  }, [recordMode, reportSurfaceError, requestVisibility, slotRef]);

  useLayoutEffect(() => {
    if (!isTauriRuntime()) return;
    const slot = slotRef.current;
    if (!slot) return;

    const scheduleMeasure = () => {
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        measureAndReveal();
      });
    };
    scheduleMeasureRef.current = scheduleMeasure;

    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleMeasure)
      : null;
    observer?.observe(slot);
    const dock = document.querySelector<HTMLElement>('[data-testid="wb-dock"]');
    if (dock) observer?.observe(dock);
    const dockObserver = dock && typeof MutationObserver === 'function'
      ? new MutationObserver(scheduleMeasure)
      : null;
    if (dock && dockObserver) {
      dockObserver.observe(dock, {
        attributes: true,
        attributeFilter: ['class', 'data-autohide', 'data-hidden'],
      });
    }
    const isSurfaceOccluder = (node: Node | null): boolean => {
      if (!(node instanceof Element)) return false;
      return node.matches(DOM_SURFACE_VISUAL_OCCLUDER_SELECTOR)
        || node.closest(DOM_SURFACE_VISUAL_OCCLUDER_SELECTOR) != null;
    };
    const occluderObserver = typeof MutationObserver === 'function'
      ? new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && isSurfaceOccluder(mutation.target)) {
            scheduleMeasure();
            return;
          }
          if (mutation.type !== 'childList') continue;
          if (isSurfaceOccluder(mutation.target)) {
            scheduleMeasure();
            return;
          }
          for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (isSurfaceOccluder(node)) {
              scheduleMeasure();
              return;
            }
          }
        }
      })
      : null;
    occluderObserver?.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state'],
    });
    let dockTransitionRaf: number | null = null;
    let dockTransitionCount = 0;
    const measureDockDuringTransition = () => {
      scheduleMeasure();
      if (dockTransitionCount > 0) {
        dockTransitionRaf = requestAnimationFrame(measureDockDuringTransition);
      } else {
        dockTransitionRaf = null;
      }
    };
    const isDockTransition = (event: TransitionEvent) =>
      Boolean(
        dock &&
          event.target instanceof Element &&
          dock.contains(event.target) &&
          (event.propertyName === 'transform' || event.propertyName === 'opacity'),
      );
    const onDockTransitionRun = (event: TransitionEvent) => {
      if (!isDockTransition(event)) return;
      dockTransitionCount += 1;
      if (dockTransitionRaf == null) {
        dockTransitionRaf = requestAnimationFrame(measureDockDuringTransition);
      }
    };
    const onDockTransitionDone = (event: TransitionEvent) => {
      if (!isDockTransition(event)) return;
      dockTransitionCount = Math.max(0, dockTransitionCount - 1);
      scheduleMeasure();
    };
    dock?.addEventListener('transitionrun', onDockTransitionRun);
    dock?.addEventListener('transitionend', onDockTransitionDone);
    dock?.addEventListener('transitioncancel', onDockTransitionDone);
    const onDockPointerChange = () => scheduleMeasure();
    dock?.addEventListener('pointerenter', onDockPointerChange);
    dock?.addEventListener('pointerleave', onDockPointerChange);
    dock?.addEventListener('focusin', onDockPointerChange);
    dock?.addEventListener('focusout', onDockPointerChange);
    let snapTransitionRaf: number | null = null;
    let snapTransitionCount = 0;
    const measureSnapDuringTransition = () => {
      scheduleMeasure();
      if (snapTransitionCount > 0) {
        snapTransitionRaf = requestAnimationFrame(measureSnapDuringTransition);
      } else {
        snapTransitionRaf = null;
      }
    };
    const isSnapTransition = (event: TransitionEvent) =>
      event.target instanceof Element &&
      Boolean(event.target.closest('[data-testid="wb-snap-preview"]'));
    const onSnapTransitionRun = (event: TransitionEvent) => {
      if (!isSnapTransition(event)) return;
      snapTransitionCount += 1;
      if (snapTransitionRaf == null) {
        snapTransitionRaf = requestAnimationFrame(measureSnapDuringTransition);
      }
    };
    const onSnapTransitionDone = (event: TransitionEvent) => {
      if (!isSnapTransition(event)) return;
      snapTransitionCount = Math.max(0, snapTransitionCount - 1);
      scheduleMeasure();
    };
    document.addEventListener('transitionrun', onSnapTransitionRun, true);
    document.addEventListener('transitionend', onSnapTransitionDone, true);
    document.addEventListener('transitioncancel', onSnapTransitionDone, true);
    const onOccluderTransition = (event: TransitionEvent | AnimationEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(DOM_SURFACE_VISUAL_OCCLUDER_SELECTOR)) return;
      scheduleMeasure();
    };
    document.addEventListener('transitionrun', onOccluderTransition, true);
    document.addEventListener('transitionend', onOccluderTransition, true);
    document.addEventListener('transitioncancel', onOccluderTransition, true);
    document.addEventListener('animationstart', onOccluderTransition, true);
    document.addEventListener('animationend', onOccluderTransition, true);
    document.addEventListener('animationcancel', onOccluderTransition, true);
    window.addEventListener('resize', scheduleMeasure);
    scheduleMeasure();

    return () => {
      observer?.disconnect();
      dockObserver?.disconnect();
      occluderObserver?.disconnect();
      dock?.removeEventListener('transitionrun', onDockTransitionRun);
      dock?.removeEventListener('transitionend', onDockTransitionDone);
      dock?.removeEventListener('transitioncancel', onDockTransitionDone);
      dock?.removeEventListener('pointerenter', onDockPointerChange);
      dock?.removeEventListener('pointerleave', onDockPointerChange);
      dock?.removeEventListener('focusin', onDockPointerChange);
      dock?.removeEventListener('focusout', onDockPointerChange);
      if (dockTransitionRaf != null) cancelAnimationFrame(dockTransitionRaf);
      document.removeEventListener('transitionrun', onSnapTransitionRun, true);
      document.removeEventListener('transitionend', onSnapTransitionDone, true);
      document.removeEventListener('transitioncancel', onSnapTransitionDone, true);
      document.removeEventListener('transitionrun', onOccluderTransition, true);
      document.removeEventListener('transitionend', onOccluderTransition, true);
      document.removeEventListener('transitioncancel', onOccluderTransition, true);
      document.removeEventListener('animationstart', onOccluderTransition, true);
      document.removeEventListener('animationend', onOccluderTransition, true);
      document.removeEventListener('animationcancel', onOccluderTransition, true);
      if (snapTransitionRaf != null) cancelAnimationFrame(snapTransitionRaf);
      window.removeEventListener('resize', scheduleMeasure);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      scheduleMeasureRef.current = () => {};
    };
  }, [measureAndReveal, slotRef]);

  useLayoutEffect(() => {
    if (!isTauriRuntime()) return;
    const previousSession = previousSessionRef.current;
    if (previousSession && previousSession !== sessionId) {
      requestVisibility(previousSession, false);
      lastBoundsKeyRef.current = '';
      latestBoundsKeyRef.current = '';
      boundsPendingRef.current = false;
      inputShieldActiveRef.current = false;
    }
    previousSessionRef.current = sessionId;

    if (!sessionId) return;
    if (!desiredVisible) {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      latestBoundsKeyRef.current = '';
      boundsPendingRef.current = false;
      requestVisibility(sessionId, false);
      return;
    }
    scheduleMeasureRef.current();
  }, [desiredVisible, requestVisibility, sessionId]);

  useEffect(() => {
    if (!isTauriRuntime() || typeof MutationObserver !== 'function') return;
    const root = document.documentElement;
    const syncMotionState = () => {
      setShellMotion({
        suspended: isWorkbenchShellMotionActive(slotRef.current),
        ownWindowDragging: isOwnWorkbenchWindowDragging(slotRef.current),
      });
    };
    const observer = new MutationObserver(syncMotionState);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-wb-dragging', 'data-wb-settling'],
    });
    syncMotionState();
    return () => observer.disconnect();
  }, [slotRef]);

  useEffect(() => {
    if (!isTauriRuntime() || typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(() => scheduleMeasureRef.current());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'data-hidden',
        'data-open',
        'data-state',
        'data-wb-snap-visible',
        'aria-hidden',
        'aria-modal',
      ],
    });
    scheduleMeasureRef.current();
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !sessionId) return;
    return hubListenKeyed<{ kind?: unknown }>(
      BROWSER_CONTENT_USER_INPUT_EVENT,
      sessionId,
      ({ kind }) => {
        if (kind !== 'pointerdown' && kind !== 'keydown' && kind !== 'compositionstart') return;
        const state = useWindowStore.getState();
        const browserWindow = state.windows[windowId];
        if (!browserWindow || browserWindow.minimized) return;
        if (state.focusStack.at(-1) !== windowId) state.focusWindow(windowId);
      },
    );
  }, [sessionId, windowId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const onLayout = (detail: NativeSurfaceLayoutEventDetail) => {
      const scope = detail.scope ?? 'window';
      const appliesToSurface = scope === 'all' || detail.windowId === windowId;
      if (!appliesToSurface && detail.phase !== 'sync') {
        scheduleMeasureRef.current();
        return;
      }
      const suspensionKey = `${scope}:${detail.windowId}`;
      if (detail.phase === 'suspend') {
        layoutSuspensionsRef.current.add(suspensionKey);
        stateRef.current = { ...stateRef.current, desiredVisible: false };
        latestBoundsKeyRef.current = '';
        boundsPendingRef.current = false;
        setSuspended(true);
        const currentSessionId = stateRef.current.sessionId;
        if (currentSessionId) requestVisibility(currentSessionId, false);
        return;
      }
      if (detail.phase === 'resume') {
        layoutSuspensionsRef.current.delete(suspensionKey);
        setSuspended(layoutSuspensionsRef.current.size > 0);
      }
      scheduleMeasureRef.current();
    };
    // 注册式监听：维护消费者计数，使无 browser 窗时拖拽每帧的 sync 直接短路
    return addNativeSurfaceLayoutListener(onLayout);
  }, [requestVisibility, windowId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const currentSessionId = stateRef.current.sessionId;
      stateRef.current = { ...stateRef.current, desiredVisible: false };
      if (currentSessionId && isTauriRuntime()) {
        requestVisibility(currentSessionId, false);
      }
    };
  }, [requestVisibility]);

  const refreshHostMode = useCallback(async (): Promise<BrowserSurfaceHostMode | null> => {
    if (!isTauriRuntime()) return null;
    try {
      const mode = await browserApi.getSurfaceHostMode();
      recordMode(mode);
      return mode;
    } catch {
      return hostModeRef.current;
    }
  }, [recordMode]);

  return { hostMode, recordHostMode: recordMode, refreshHostMode };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const BrowserAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  launchPayload,
  onTitleChange,
  isActive,
  isVisible,
}) => {
  const { t } = useTranslation('workbench');
  // 窗口内容区尺寸分级（data-wb-sys-size），供 CSS 收紧窄窗 chrome 留白
  const { ref: sizeRef } = useWbSysSize();
  const session = useBrowserSession({ launchPayload, hydrateOnMount: true });
  const closeSession = session.closeSession;
  const hydrateFromRust = session.hydrateFromRust;
  const [gatesDisabled, setGatesDisabled] = useState(false);
  const [gatesDisabledMessage, setGatesDisabledMessage] = useState<string | null>(null);
  const launchabilityMountedRef = useRef(true);
  const launchabilitySeqRef = useRef(0);
  const prevGatesDisabledRef = useRef<boolean | null>(null);

  const refreshLaunchability = useCallback(() => {
    const seq = ++launchabilitySeqRef.current;
    void resolveBrowserLaunchability()
      .then((snap) => {
        if (!launchabilityMountedRef.current || seq !== launchabilitySeqRef.current) return;
        const nextDisabled = !snap.open;
        const becameEnabled = prevGatesDisabledRef.current === true && !nextDisabled;
        prevGatesDisabledRef.current = nextDisabled;
        setGatesDisabled(nextDisabled);
        setGatesDisabledMessage(snap.closeMessage);
        if (becameEnabled) {
          void hydrateFromRust().catch(() => {
            // Store records lastError.
          });
        }
      })
      .catch(() => {
        // Keep current gate state if launchability check fails transiently.
      });
  }, [hydrateFromRust]);

  useEffect(() => {
    launchabilityMountedRef.current = true;
    refreshLaunchability();
    return () => {
      launchabilityMountedRef.current = false;
    };
  }, [refreshLaunchability]);

  useEventRegistry(
    [
      {
        target: 'window',
        type: 'workbench:settings-changed',
        listener: refreshLaunchability,
      },
      {
        target: 'window',
        type: 'workbench:mode-changed',
        listener: refreshLaunchability,
      },
    ],
    [refreshLaunchability],
  );
  const addressRef = useRef<HTMLInputElement | null>(null);
  const pageSlotRef = useRef<HTMLDivElement | null>(null);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const escapedWindowId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(windowId) : windowId;
    const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${escapedWindowId}"]`);
    const queryRoot: ParentNode = shell ?? document;
    let observer: MutationObserver | null = null;
    const findTarget = (): HTMLElement | null => {
      const target = Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      setTitlebarTarget((current) => (current === target ? current : target));
      if (target) observer?.disconnect();
      return target;
    };
    if (!findTarget()) {
      observer = new MutationObserver(findTarget);
      observer.observe(shell ?? document.body, { childList: true, subtree: true });
    }
    return () => observer?.disconnect();
  }, [windowId]);
  const workbenchOverlayOpen = useWorkbenchOverlay(
    (state) => state.exposeOpen || state.cheatsheetOpen,
  );
  const appsPanelOpen = useAppsPanelOpen();
  const transientPhase = useWindowTransientPhase(windowId);
  const { hostMode, recordHostMode, refreshHostMode } = useNativeBrowserSurface({
    windowId,
    slotRef: pageSlotRef,
    sessionId: session.sessionId,
    isVisible: isVisible && session.contentVisible,
    overlayOpen: workbenchOverlayOpen || appsPanelOpen || transientPhase != null,
  });

  useEffect(() => {
    return () => {
      queueMicrotask(() => {
        if (useWindowStore.getState().windows[windowId]) return;
        void closeSession().catch((error) => {
          console.warn('[BrowserSurface] close cleanup failed:', error);
        });
      });
    };
  }, [closeSession, windowId]);

  useEffect(() => {
    const pageTitle = session.title?.trim();
    onTitleChange(pageTitle || t('workbench:apps.browser'));
  }, [onTitleChange, t, session.title]);

  useEffect(() => {
    const onFocusAddress = (event: Event) => {
      const detail = (event as CustomEvent<BrowserFocusAddressEventDetail>).detail;
      if (!detail || detail.windowId !== windowId) return;
      addressRef.current?.focus();
      addressRef.current?.select();
      detail.acknowledge(document.activeElement === addressRef.current);
    };
    window.addEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
    return () => window.removeEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
  }, [windowId]);

  useEffect(() => {
    if (!launchPayload || typeof launchPayload !== 'object') return;
    if ((launchPayload as { focusAddress?: unknown }).focusAddress === true) {
      const emit = () => {
        addressRef.current?.focus();
        addressRef.current?.select();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(emit);
      window.setTimeout(emit, 120);
    }
  }, [launchPayload]);

  const handleNavigate = useCallback(
    (url: string) => {
      if (gatesDisabled) {
        // Never invoke Tauri while gated — reject_closed_gate hides the native child window.
        return;
      }
      // loading 期允许直接改道：先停止在途导航，再发起新导航（Chrome 语义）
      if (session.loading) session.stopLoading();
      void session.navigate(url).catch(() => {
        // Store 已记录 lastError；用户路径无需制造 unhandled rejection。
      });
    },
    [session, gatesDisabled],
  );

  const handleBack = useCallback(() => {
    if (session.loading) session.stopLoading();
    void session.back().catch(() => {});
  }, [session]);

  const handleForward = useCallback(() => {
    if (session.loading) session.stopLoading();
    void session.forward().catch(() => {});
  }, [session]);

  const handleReload = useCallback(() => {
    if (gatesDisabled || !session.sessionId) return;
    void session.reload().catch(() => {});
  }, [gatesDisabled, session]);

  const handleStop = useCallback(() => {
    session.stopLoading();
  }, [session]);

  const [extracting, setExtracting] = useState(false);

  const handleExtractContent = useCallback(() => {
    if (gatesDisabled || !session.sessionId || extracting) return;
    setExtracting(true);
    void browserApi
      .extractContent(session.sessionId)
      .then(async (result) => {
        const copied = await copyTextToClipboard(result.markdown);
        if (!copied) {
          throw new Error('Clipboard copy failed');
        }
        showGlobalNotification('success', t('browser.extractSuccess'));
      })
      .catch((err: unknown) => {
        showGlobalNotification(
          'error',
          t('browser.extractFailed', { error: getErrorMessage(err) }),
        );
      })
      .finally(() => {
        setExtracting(false);
      });
  }, [extracting, gatesDisabled, session.sessionId, t]);

  const handleTakeOver = useCallback(() => {
    void session.takeOver().catch(() => {
      // Store 已记录 lastError。
    });
  }, [session]);

  const handleShowContent = useCallback(() => {
    void session.showContent();
  }, [session]);

  const handlePromoteToInteractive = useCallback(() => {
    void session
      .promoteToInteractive()
      .then((mode) => {
        if (mode) recordHostMode(mode);
        return refreshHostMode();
      })
      .catch(() => {
        // Store records lastError.
      });
  }, [recordHostMode, refreshHostMode, session]);

  const handleSelectTab = useCallback(
    (tabId: string) => {
      void session.switchTab(tabId).catch(() => {
        // Store records lastError.
      });
    },
    [session],
  );

  const handleCloseTab = useCallback(
    (tabId: string) => {
      void session.closeTab(tabId).catch(() => {
        // Store records lastError.
      });
    },
    [session],
  );

  const handleNewTab = useCallback(() => {
    void session.createTab().catch(() => {
      // Store records lastError.
    });
  }, [session]);

  const handleRemoteInput = useCallback(
    (event: BrowserRemoteInputEvent) => {
      void session.sendRemoteInput(event).catch(() => {
        // Remote input errors are non-fatal; session state remains authoritative.
      });
    },
    [session],
  );

  const refreshTabs = session.refreshTabs;
  useEffect(() => {
    if (!session.sessionId) return;
    void refreshTabs();
  }, [refreshTabs, session.sessionId, session.currentUrl, session.title]);

  return (
    <>
      {titlebarTarget ? createPortal(
        <TabStrip
          tabs={session.tabs}
          activeTabId={session.activeTabId}
          inTitlebar
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />,
        titlebarTarget,
      ) : null}
      <div
        ref={sizeRef}
        className="wb-browser-root"
        data-wb-browser-app
        data-wb-browser-chrome
        data-active={isActive ? 'true' : 'false'}
        data-loading={session.loading ? 'true' : 'false'}
      >
        {!titlebarTarget ? (
          <TabStrip
            tabs={session.tabs}
            activeTabId={session.activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
            onNewTab={handleNewTab}
          />
        ) : null}
      <div className="wb-browser-toolbar">
        <NavControls
          canGoBack={!gatesDisabled && session.canGoBack}
          canGoForward={!gatesDisabled && session.canGoForward}
          canReload={!gatesDisabled && Boolean(session.sessionId)}
          loading={session.loading}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onStop={handleStop}
        />
        <AddressBar
          draft={session.addressDraft}
          loading={session.loading}
          disabled={gatesDisabled}
          security={browserConnectionSecurity(session.currentUrl, Boolean(session.sessionId))}
          inputRef={addressRef}
          onDraftChange={gatesDisabled ? () => {} : session.setAddressDraft}
          onSubmit={handleNavigate}
        />
        <div className="wb-browser-toolbar-actions">
          {!gatesDisabled && session.sessionId ? (
            <>
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                disabled={extracting}
                onClick={handleExtractContent}
                aria-label={t('browser.extractContent')}
                title={t('browser.extractContent')}
              >
                <FileText size={16} weight="bold" aria-hidden />
              </DsButton>
              {session.tabs.length <= 1 ? (
                <DsButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  onClick={handleNewTab}
                  aria-label={t('browser.newTab')}
                  title={t('browser.newTab')}
                >
                  <Plus size={16} weight="bold" aria-hidden />
                </DsButton>
              ) : null}
            </>
          ) : null}
          <ToolbarControlStatus controlMode={session.controlMode} onTakeOver={handleTakeOver} />
        </div>
      </div>
      {!gatesDisabled && session.lastError ? (
        <p className="wb-browser-error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden />
          <span className="wb-browser-error-text">
            {localizeBrowserGateMessage(session.lastError ?? '')}
          </span>
        </p>
      ) : null}
      <div
        className="wb-browser-page-frame"
        data-wb-browser-page-frame
        data-host-mode={hostMode ?? 'pending'}
        aria-busy={session.loading || undefined}
      >
        <div ref={pageSlotRef} className="wb-browser-page-slot" data-wb-browser-page-slot>
          {session.sessionId && hostMode === 'remote' ? (
            <RemoteScreencastViewport
              frame={session.screencastFrame}
              onRemoteInput={handleRemoteInput}
            />
          ) : null}
        </div>
        {!session.sessionId ? (
          <div className="wb-browser-empty" data-wb-browser-empty data-wb-browser-disabled={gatesDisabled ? 'true' : undefined}>
            <Globe size={30} weight="duotone" aria-hidden className="wb-browser-empty-icon" />
            <span className="wb-browser-empty-title">
              {gatesDisabled
                ? (gatesDisabledMessage ?? t('browser.needBrowserEnabled'))
                : t('browser.emptyHint')}
            </span>
            {gatesDisabled ? (
              <span className="wb-browser-empty-sub">
                {t('browser.gatedHint')}
              </span>
            ) : null}
          </div>
        ) : null}
        {session.sessionId && hostMode === 'detached' ? (
          <DetachedPageHint onShowContent={handleShowContent} />
        ) : null}
        {session.sessionId && hostMode === 'headless' ? (
          <HeadlessPageHint onShowContent={handlePromoteToInteractive} />
        ) : null}
        {session.sessionId && hostMode === 'unsupported' ? (
          <UnsupportedPageHint />
        ) : null}
      </div>
    </div>
    </>
  );
};

export default BrowserAppWindow;
