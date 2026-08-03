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
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  Globe,
  HandPalm,
  LockSimple,
  LockOpen,
  Robot,
  WarningCircle,
} from '@phosphor-icons/react';
import { useBrowserSession } from '@/features/browser/hooks/useBrowserSession';
import { browserApi } from '@/features/browser/browserApi';
import { BROWSER_CONTENT_USER_INPUT_EVENT } from '@/features/browser/controlModeSync';
import {
  browserSurfaceBoundsFromRect,
  browserSurfaceOcclusionsFromRects,
  shouldShowBrowserSurface,
  shouldSuspendBrowserSurfaceForShellMotion,
} from '@/features/browser/nativeSurface';
import type {
  BrowserControlMode,
  BrowserSurfaceHostMode,
  BrowserSurfaceOcclusion,
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

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const NavControls: React.FC<{
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}> = ({ canGoBack, canGoForward, loading, onBack, onForward, onReload }) => {
  const { t } = useTranslation('workbench');
  return (
    <div className="wb-browser-nav" role="group" aria-label={t('browser.nav')}>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={!canGoBack || loading}
        onClick={onBack}
        aria-label={t('browser.back')}
        title={t('browser.back')}
      >
        <ArrowLeft size={16} weight="bold" />
      </button>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={!canGoForward || loading}
        onClick={onForward}
        aria-label={t('browser.forward')}
        title={t('browser.forward')}
      >
        <ArrowRight size={16} weight="bold" />
      </button>
      <button
        type="button"
        className="wb-browser-icon-btn"
        disabled={loading}
        onClick={onReload}
        aria-label={t('browser.reload')}
        title={t('browser.reload')}
      >
        <ArrowClockwise size={16} weight="bold" />
      </button>
    </div>
  );
};

const AddressBar: React.FC<{
  draft: string;
  loading: boolean;
  security: 'secure' | 'insecure' | 'neutral';
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
}> = ({ draft, loading, security, inputRef, onDraftChange, onSubmit }) => {
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

const AgentBar: React.FC<{
  controlMode: BrowserControlMode;
  onTakeOver: () => void;
}> = ({ controlMode, onTakeOver }) => {
  const { t } = useTranslation('workbench');
  const agentActive = controlMode === 'agent';

  return (
    <div
      className={`wb-browser-agent${agentActive ? ' is-agent' : ' is-user'}`}
      role="status"
      data-control-mode={controlMode}
    >
      <span className="wb-browser-agent-label">
        {agentActive ? (
          <>
            <Robot size={14} weight="fill" aria-hidden />
            {t('browser.agentActive')}
          </>
        ) : (
          <>
            <HandPalm size={14} weight="fill" aria-hidden />
            {t('browser.userControl')}
          </>
        )}
      </span>
      {agentActive ? (
        <button type="button" className="wb-browser-takeover" onClick={onTakeOver}>
          {t('browser.takeOver')}
        </button>
      ) : null}
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
      <button type="button" className="wb-browser-hint-action" onClick={onShowContent}>
        <ArrowSquareOut size={14} weight="bold" aria-hidden />
        {t('browser.showContent')}
      </button>
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

function useNativeBrowserSurface({
  windowId,
  slotRef,
  sessionId,
  isVisible,
  overlayOpen,
}: NativeBrowserSurfaceOptions): BrowserSurfaceHostMode | null {
  const [suspended, setSuspended] = useState(false);
  const [shellMotion, setShellMotion] = useState(() => ({
    suspended: isWorkbenchShellMotionActive(slotRef.current),
    ownWindowDragging: isOwnWorkbenchWindowDragging(slotRef.current),
  }));
  const [hostMode, setHostMode] = useState<BrowserSurfaceHostMode | null>(null);
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
    if (mountedRef.current) setHostMode(mode);
    reportedErrorRef.current = false;
  }, []);

  const reportSurfaceError = useCallback((operation: string, error: unknown) => {
    if (reportedErrorRef.current) return;
    reportedErrorRef.current = true;
    console.warn(`[BrowserSurface] ${operation} failed:`, error);
  }, []);

  const requestVisibility = useCallback(
    (targetSessionId: string, visible: boolean, focus = false) => {
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

  return hostMode;
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
  const addressRef = useRef<HTMLInputElement | null>(null);
  const pageSlotRef = useRef<HTMLDivElement | null>(null);
  const workbenchOverlayOpen = useWorkbenchOverlay(
    (state) => state.exposeOpen || state.cheatsheetOpen,
  );
  const appsPanelOpen = useAppsPanelOpen();
  const transientPhase = useWindowTransientPhase(windowId);
  const hostMode = useNativeBrowserSurface({
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
      void session.navigate(url).catch(() => {
        // Store 已记录 lastError；用户路径无需制造 unhandled rejection。
      });
    },
    [session],
  );

  const handleTakeOver = useCallback(() => {
    void session.takeOver().catch(() => {
      // Store 已记录 lastError。
    });
  }, [session]);

  const handleShowContent = useCallback(() => {
    void session.showContent();
  }, [session]);

  return (
    <div
      ref={sizeRef}
      className="wb-browser-root"
      data-wb-browser-app
      data-wb-browser-chrome
      data-active={isActive ? 'true' : 'false'}
      data-loading={session.loading ? 'true' : 'false'}
    >
      <div className="wb-browser-toolbar">
        <NavControls
          canGoBack={session.canGoBack}
          canGoForward={session.canGoForward}
          loading={session.loading}
          onBack={() => void session.back().catch(() => {})}
          onForward={() => void session.forward().catch(() => {})}
          onReload={() => void session.reload().catch(() => {})}
        />
        <AddressBar
          draft={session.addressDraft}
          loading={session.loading}
          security={browserConnectionSecurity(session.currentUrl, Boolean(session.sessionId))}
          inputRef={addressRef}
          onDraftChange={session.setAddressDraft}
          onSubmit={handleNavigate}
        />
      </div>
      <AgentBar controlMode={session.controlMode} onTakeOver={handleTakeOver} />
      {session.lastError ? (
        <p className="wb-browser-error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden />
          <span className="wb-browser-error-text">{session.lastError}</span>
        </p>
      ) : null}
      <div
        className="wb-browser-page-frame"
        data-wb-browser-page-frame
        data-host-mode={hostMode ?? 'pending'}
        aria-busy={session.loading || undefined}
      >
        <div ref={pageSlotRef} className="wb-browser-page-slot" data-wb-browser-page-slot />
        {!session.sessionId ? (
          <div className="wb-browser-empty" data-wb-browser-empty>
            <Globe size={30} weight="duotone" aria-hidden className="wb-browser-empty-icon" />
            <span className="wb-browser-empty-title">
              {t('browser.emptyHint')}
            </span>
          </div>
        ) : null}
        {session.sessionId && hostMode === 'detached' ? (
          <DetachedPageHint onShowContent={handleShowContent} />
        ) : null}
      </div>
    </div>
  );
};

export default BrowserAppWindow;
