import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowsOut, CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { BACK_PRIORITY, registerBackHandler } from '@/services/androidBackRegistry';
import { registerInkWorkspaceExitGuard } from '@/services/inkWorkspaceRegistry';
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/utils/errorUtils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { inkApi } from './api';
import { flushInkEditor, hasDirtyInkEditor, persistInkEditorDrafts } from './editorSession';
import { LazyInkBoardEditor } from './LazyInkBoardEditorEntry';
import { LazyInkEditor } from './LazyInkEditorEntry';
import { INK_BOARD_SCHEMA_VERSION, INK_SCHEMA_VERSION } from './types';
import './InkWorkspace.css';

export interface InkWorkspaceProps {
  documentId: string;
  title?: string;
  isActive?: boolean;
  onClose?: () => void;
  onRetryExit?: () => void;
  className?: string;
}

type InkRoute = {
  documentId: string;
  status: 'loading' | 'paged' | 'board' | 'error';
  title?: string;
  error?: string;
};

const workspaceStack = new Set<symbol>();
const scrollLocks = new Set<symbol>();
let previousBodyOverflow = '';
const workspaceListeners = new Set<() => void>();
const subscribeWorkspace = (listener: () => void) => {
  workspaceListeners.add(listener);
  return () => { workspaceListeners.delete(listener); };
};
const getForegroundWorkspace = () => [...workspaceStack].at(-1);
const publishWorkspaces = () => workspaceListeners.forEach((listener) => listener());

function isHostVisible(element: HTMLElement | null, includeAnimating = false): boolean {
  if (!element?.isConnected) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.matches('[hidden], [inert]')
      || (current.getAttribute('aria-hidden') === 'true' && current.getAttribute('data-aria-hidden') !== 'true')) return false;
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden' || (!includeAnimating && style.opacity === '0')
      || (style.pointerEvents === 'none' && (current === element || current.hasAttribute('data-view-layer-shell'))
        && getComputedStyle(document.body).pointerEvents !== 'none')) return false;
  }
  return document.documentElement.getClientRects().length === 0 || element.getClientRects().length > 0;
}

function hasForegroundOverlay(page: HTMLElement | null): boolean {
  if (!page) return false;
  const overlays = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
  );
  return [...overlays].some((overlay) => {
    if (overlay === page || overlay.dataset.state === 'closed' || !isHostVisible(overlay, true)) return false;
    if (page.contains(overlay)) return true;
    let zIndex = 0;
    for (let current: HTMLElement | null = overlay; current; current = current.parentElement) {
      zIndex = Math.max(zIndex, Number.parseInt(getComputedStyle(current).zIndex, 10) || 0);
    }
    return zIndex > Z_INDEX.modal
      || ((zIndex === Z_INDEX.modal || zIndex === 0)
        && Boolean(page.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
}

export function InkWorkspace({ documentId, title, isActive = true, onClose, onRetryExit, className }: InkWorkspaceProps) {
  const { t } = useTranslation(['ink', 'common', 'learningHub']);
  const hostRef = useRef<HTMLDivElement>(null);
  const ownedOverlaysRef = useRef(new Set<HTMLElement>());
  const translationRef = useRef(t);
  translationRef.current = t;
  const token = useRef(Symbol('ink-workspace')).current;
  const [portalRoot] = useState(() => document.createElement('div'));
  const [hostVisible, setHostVisible] = useState(false);
  const [opened, setOpened] = useState(true);
  const [session, setSession] = useState({ documentId, title });
  const [startedDocumentId, setStartedDocumentId] = useState<string>();
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [route, setRoute] = useState<InkRoute>();
  const [leaving, setLeaving] = useState(false);
  const [exitBlocked, setExitBlocked] = useState(false);
  const mountedRef = useRef(false);
  const leavingRef = useRef(false);
  const flushPromiseRef = useRef<Promise<boolean>>();
  const requestedRef = useRef({ documentId, title });
  const sessionRef = useRef(session);
  const onCloseRef = useRef(onClose);
  const presentationRef = useRef(false);
  const requestVersionRef = useRef(0);
  if (requestedRef.current.documentId !== documentId) requestVersionRef.current += 1;
  requestedRef.current = { documentId, title };
  sessionRef.current = session;
  onCloseRef.current = onClose;

  const owner = useSyncExternalStore(subscribeWorkspace, getForegroundWorkspace, getForegroundWorkspace);
  const eligible = isActive && hostVisible;
  const presenting = opened && eligible && owner === token;
  const pageRef = useFocusTrap<HTMLElement>(presenting);
  const titleId = useId();
  const currentRoute = route?.documentId === session.documentId ? route : undefined;
  const displayTitle = (session.documentId === documentId ? title : session.title)
    || currentRoute?.title || t('toolbar.label');
  const switching = documentId !== session.documentId;
  presentationRef.current = presenting;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
    };
  }, []);

  const updateHostVisibility = useCallback(() => {
    setHostVisible(isActive && isHostVisible(hostRef.current));
  }, [isActive]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    updateHostVisibility();
    const observer = new MutationObserver(updateHostVisibility);
    for (let current: HTMLElement | null = host; current; current = current.parentElement) {
      observer.observe(current, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert', 'data-state', 'data-active'],
      });
    }
    const resizeObserver = new ResizeObserver(updateHostVisibility);
    if (host) resizeObserver.observe(host);
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, [updateHostVisibility]);
  useEventRegistry([
    { target: 'window', type: 'resize', listener: updateHostVisibility },
    { target: 'window', type: 'animationend', listener: updateHostVisibility },
  ], [updateHostVisibility]);

  useLayoutEffect(() => {
    if (!opened || !eligible) return;
    workspaceStack.add(token);
    publishWorkspaces();
    return () => {
      workspaceStack.delete(token);
      publishWorkspaces();
    };
  }, [eligible, opened, token]);

  useLayoutEffect(() => {
    if (!presenting) return;
    portalRoot.dataset.inkWorkspacePortal = session.documentId;
    document.body.appendChild(portalRoot);
    if (!scrollLocks.size) previousBodyOverflow = document.body.style.overflow;
    scrollLocks.add(token);
    document.body.style.overflow = 'hidden';
    return () => {
      portalRoot.remove();
      scrollLocks.delete(token);
      if (!scrollLocks.size) document.body.style.overflow = previousBodyOverflow;
    };
  }, [portalRoot, presenting, session.documentId, token]);

  useEffect(() => {
    if (!presenting) return;
    const existing = new Set(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'));
    const observeOverlays = () => {
      const overlays = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      for (const overlay of overlays) {
        if (overlay === pageRef.current || overlay.dataset.state === 'closed' || !overlay.isConnected) continue;
        const focusOwned = overlay.contains(document.activeElement)
          || (!existing.has(overlay) && pageRef.current?.contains(document.activeElement));
        if (portalRoot.contains(overlay) || (focusOwned
          && Boolean(portalRoot.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING))) {
          ownedOverlaysRef.current.add(overlay);
        }
      }
    };
    observeOverlays();
    const observer = new MutationObserver(observeOverlays);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pageRef, portalRoot, presenting]);

  useLayoutEffect(() => {
    if (presenting || !opened) return;
    const overlays = new Set([
      ...ownedOverlaysRef.current,
      ...portalRoot.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
    ]);
    for (const overlay of [...overlays].reverse()) {
      if (overlay === pageRef.current || overlay.dataset.state === 'closed') continue;
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    }
    ownedOverlaysRef.current.clear();
  }, [opened, pageRef, portalRoot, presenting]);

  useEffect(() => {
    if (!opened) setStartedDocumentId(undefined);
    else if (presenting) setStartedDocumentId(session.documentId);
  }, [opened, presenting, session.documentId]);

  useEffect(() => {
    if (!startedDocumentId || startedDocumentId !== session.documentId) return;
    let cancelled = false;
    const translate = translationRef.current;
    setRoute({ documentId: startedDocumentId, status: 'loading' });
    void inkApi.get({ document_id: startedDocumentId }).then((manifest) => {
      if (cancelled) return;
      if (manifest.document_id !== startedDocumentId) {
        throw new Error(translate('workspace.documentMismatch', { defaultValue: '读取到的笔记与当前文件不一致，请重试。' }));
      }
      if (manifest.schema_version !== INK_SCHEMA_VERSION && manifest.schema_version !== INK_BOARD_SCHEMA_VERSION) {
        throw new Error(translate('workspace.unsupportedSchema', {
          defaultValue: '不支持此手写笔记版本（{{version}}），请更新应用后重试。',
          version: manifest.schema_version,
        }));
      }
      setRoute({
        documentId: startedDocumentId,
        status: manifest.schema_version === INK_BOARD_SCHEMA_VERSION ? 'board' : 'paged',
        title: manifest.title,
      });
    }).catch((error: unknown) => {
      if (!cancelled) setRoute({ documentId: startedDocumentId, status: 'error', error: getErrorMessage(error) });
    });
    return () => { cancelled = true; };
  }, [probeAttempt, session.documentId, startedDocumentId]);

  const flushSession = useCallback((sourceId: string): Promise<boolean> => {
    if (!mountedRef.current || sessionRef.current.documentId !== sourceId) return Promise.resolve(false);
    if (flushPromiseRef.current) return flushPromiseRef.current;
    leavingRef.current = true;
    if (pageRef.current) pageRef.current.dataset.inkWorkspaceLeaving = 'true';
    setLeaving(true);
    setExitBlocked(false);
    const saving = (async () => {
      try {
        const result = await flushInkEditor(sourceId);
        if (!mountedRef.current || sessionRef.current.documentId !== sourceId) return false;
        if (!result.ok || hasDirtyInkEditor(sourceId)) {
          setExitBlocked(true);
          return false;
        }
        return true;
      } catch {
        if (mountedRef.current && sessionRef.current.documentId === sourceId) setExitBlocked(true);
        return false;
      } finally {
        leavingRef.current = false;
        flushPromiseRef.current = undefined;
        if (pageRef.current) pageRef.current.dataset.inkWorkspaceLeaving = 'false';
        if (mountedRef.current) setLeaving(false);
      }
    })();
    flushPromiseRef.current = saving;
    return saving;
  }, [pageRef]);

  useLayoutEffect(() => {
    if (!opened) return;
    const sourceId = session.documentId;
    return registerInkWorkspaceExitGuard(sourceId, {
      isDirty: () => hasDirtyInkEditor(sourceId),
      flush: async () => {
        const version = requestVersionRef.current;
        if (!await flushSession(sourceId)) return false;
        const requested = requestedRef.current;
        if (requested.documentId !== sourceId) {
          setSession(requested);
          setOpened(true);
          return false;
        }
        return requestVersionRef.current === version;
      },
    });
  }, [flushSession, opened, session.documentId]);

  const leave = useCallback(async (intent: 'close' | 'switch') => {
    if (intent === 'close' && (!presentationRef.current || leavingRef.current)) return;
    const sourceId = sessionRef.current.documentId;
    const version = requestVersionRef.current;
    if (!await flushSession(sourceId)) return;
    const requested = requestedRef.current;
    if (requested.documentId !== sourceId) {
      setSession(requested);
      setOpened(true);
    } else if (intent === 'close' && requestVersionRef.current === version && presentationRef.current) {
      setOpened(false);
      onCloseRef.current?.();
    }
  }, [flushSession]);

  useEffect(() => {
    if (documentId !== session.documentId) void leave('switch');
  }, [documentId, leave, session.documentId]);

  useEffect(() => () => {
    const sourceId = session.documentId;
    queueMicrotask(() => { void persistInkEditorDrafts(sourceId).catch(() => undefined); });
  }, [session.documentId]);

  useEffect(() => {
    if (!opened || presenting || leavingRef.current || startedDocumentId !== session.documentId || !hasDirtyInkEditor(session.documentId)) return;
    const sourceId = session.documentId;
    void flushSession(sourceId).then((saved) => {
      if (!saved) return persistInkEditorDrafts(sourceId);
    }).catch(() => persistInkEditorDrafts(sourceId)).catch(() => undefined);
  }, [flushSession, opened, presenting, session.documentId, startedDocumentId]);

  const overlayEscapeRef = useRef<KeyboardEvent>();
  const captureEscape = useCallback((event: KeyboardEvent) => {
    if (presentationRef.current && event.key === 'Escape' && hasForegroundOverlay(pageRef.current)) overlayEscapeRef.current = event;
  }, [pageRef]);
  const handleEscape = useCallback((event: KeyboardEvent) => {
    if (!presentationRef.current || event === overlayEscapeRef.current || event.key !== 'Escape'
      || event.defaultPrevented || isComposingKeyEvent(event)
      || !isHostVisible(hostRef.current) || hasForegroundOverlay(pageRef.current)) return;
    event.preventDefault();
    event.stopPropagation();
    void leave(switching ? 'switch' : 'close');
  }, [leave, pageRef, switching]);
  useEventRegistry(presenting ? [
    { target: 'window', type: 'keydown', listener: captureEscape, options: true },
    { target: 'window', type: 'keydown', listener: handleEscape },
  ] : [], [captureEscape, handleEscape, presenting]);
  useEffect(() => {
    if (!presenting) return;
    return registerBackHandler(() => {
      if (!presentationRef.current || !isHostVisible(hostRef.current) || hasForegroundOverlay(pageRef.current)) return false;
      void leave(switching ? 'switch' : 'close');
      return true;
    }, BACK_PRIORITY.overlay);
  }, [leave, pageRef, presenting, switching]);

  const reopen = () => {
    if (opened) {
      workspaceStack.delete(token);
      workspaceStack.add(token);
      publishWorkspaces();
      return;
    }
    setExitBlocked(false);
    setRoute(undefined);
    setProbeAttempt((attempt) => attempt + 1);
    setOpened(true);
  };

  return (
    <div ref={hostRef} className={cn('flex h-full min-h-0 flex-col items-center justify-center gap-3', className)}>
      {!presenting && <>
        <span className="max-w-full truncate px-4 text-sm text-muted-foreground">{displayTitle}</span>
        <DsButton variant="outline" onClick={reopen} disabled={!isActive || leaving}>
          <ArrowsOut size={18} aria-hidden="true" />
          {t('workspace.openFullscreen', { defaultValue: '重新打开全屏书写' })}
        </DsButton>
      </>}
      {opened && createPortal(
        <section
          ref={pageRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-ink-workspace-page={session.documentId}
          data-overlay-container="true"
          className="ink-workspace-page bg-background text-foreground"
          style={{ zIndex: Z_INDEX.modal }}
        >
          <header className="ink-workspace-header border-b border-border/50">
            <DsButton variant="ghost" size="sm" onClick={() => { void leave(switching ? 'switch' : 'close'); }} disabled={leaving}>
              {leaving ? <CircleNotch size={18} className="animate-spin" aria-hidden="true" /> : <ArrowLeft size={18} aria-hidden="true" />}
              {t('common:back')}
            </DsButton>
            <h1 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">{displayTitle}</h1>
            {leaving && <span role="status" className="text-sm text-muted-foreground">{t('status.saving')}</span>}
          </header>
          {exitBlocked && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm">
            <span className="flex-1">{t('workspace.exitBlocked', { defaultValue: '保存未完成，当前编辑页面和草稿已保留。请重试保存后再返回或切换笔记。' })}</span>
            <DsButton size="sm" variant="outline" disabled={leaving} onClick={() => { if (onRetryExit) onRetryExit(); else void leave(switching ? 'switch' : 'close'); }}>
              {t('common:retry')}
            </DsButton>
          </div>}
          <div
            className="ink-workspace-content"
            {...(leaving ? { inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement> : {})}
          >
            {currentRoute?.status === 'error' ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <p>{t('errors.loadFailed')}</p>
              <p className="max-w-xl break-words text-sm text-muted-foreground">{currentRoute.error}</p>
              <DsButton variant="outline" onClick={() => setProbeAttempt((attempt) => attempt + 1)}>{t('common:retry')}</DsButton>
            </div> : currentRoute?.status === 'board' ? (
              <LazyInkBoardEditor key={session.documentId} documentId={session.documentId} className="h-full min-h-0" />
            ) : currentRoute?.status === 'paged' ? (
              <LazyInkEditor key={session.documentId} documentId={session.documentId} className="h-full min-h-0" />
            ) : <div role="status" className="flex h-full items-center justify-center gap-2">
              <CircleNotch size={20} className="animate-spin" aria-hidden="true" />{t('status.loading')}
            </div>}
          </div>
        </section>,
        portalRoot,
      )}
    </div>
  );
}
