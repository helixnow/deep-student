import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderSimplePlus, SidebarSimple, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { HtmlSandboxPreview } from '@/components/previews/HtmlSandboxPreview';
import { InteractiveHtmlCanvas } from '@/components/previews/InteractiveHtmlCanvas';
import { stripSandboxRunRuntimeGuard } from '@/components/previews/chatHtmlPreviewDocument';
import {
  getArtifactRenderer,
  subscribeArtifactRendererRegistry,
} from '@/components/previews/artifactRendererRegistry';
import {
  hasLiveWidgetModelState,
  hasMeaningfulModelContent,
} from '@/components/previews/pinnedArtifactContextBridge';
import { subscribeWidgetLocalState } from '@/components/previews/widgetLocalState';
import { usePinnedArtifactStore } from '@/stores/pinnedArtifactStore';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

import {
  createStarterHtmlCanvasInput,
  launchSandboxWorkbench,
} from '../launchSandboxWorkbench';
import {
  readPersistedSandboxDraft,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
  type SandboxSessionRevisionState,
} from '../store/useSandboxWorkbenchStore';
import { SandboxStatusRail } from './SandboxStatusRail';
import { SandboxToolbar } from './SandboxToolbar';
import type { SandboxOwnerKey } from '../types';
import './SandboxWorkbenchSurface.css';

export interface SandboxWorkbenchSurfaceProps {
  embedded?: boolean;
  className?: string;
  onClose?: () => void;
  ownerKey?: SandboxOwnerKey;
  /**
   * 隐藏自绘的 SandboxToolbar。
   * 独立视图形态下移动端已有统一顶栏（UnifiedMobileHeader），
   * 再渲染 SandboxToolbar 会形成第二条顶栏；由 SandboxWorkbenchPage 在小屏时传入。
   */
  hideToolbar?: boolean;
}

const viewportClasses: Record<'desktop' | 'tablet' | 'mobile', string> = {
  desktop: 'max-w-none',
  tablet: 'max-w-[900px]',
  mobile: 'max-w-[390px]',
};

export function SandboxWorkbenchSurface({
  embedded = false,
  className,
  onClose,
  ownerKey,
  hideToolbar = false,
}: SandboxWorkbenchSurfaceProps) {
  const { t, i18n } = useTranslation('workbench');
  const { isSmallScreen } = useBreakpoint();
  const activeSession = useSandboxWorkbenchStore((state) =>
    ownerKey ? selectSandboxWorkbenchOwnerState(state, ownerKey).activeSession : state.activeSession,
  );
  const isOpen = useSandboxWorkbenchStore((state) =>
    ownerKey ? selectSandboxWorkbenchOwnerState(state, ownerKey).isOpen : state.isOpen,
  );
  const inspectorOpen = useSandboxWorkbenchStore((state) =>
    ownerKey ? selectSandboxWorkbenchOwnerState(state, ownerKey).inspectorOpen : state.inspectorOpen,
  );
  const viewportPreset = useSandboxWorkbenchStore((state) =>
    ownerKey
      ? selectSandboxWorkbenchOwnerState(state, ownerKey).viewportPreset
      : state.viewportPreset,
  );
  const activeOwnerKey = useSandboxWorkbenchStore((state) => state.activeOwnerKey);
  const effectiveOwnerKey = ownerKey?.trim() || activeOwnerKey;
  const sessionRevisionsByOwner = useSandboxWorkbenchStore(
    (state) => state.sessionRevisionsByOwner,
  );
  const closeSession = useSandboxWorkbenchStore((state) => state.closeSession);
  const openWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const closeWorkbench = useSandboxWorkbenchStore((state) => state.closeWorkbench);
  const commitSessionRevision = useSandboxWorkbenchStore((state) => state.commitSessionRevision);
  const selectSessionRevision = useSandboxWorkbenchStore((state) => state.selectSessionRevision);
  const resetSessionDraft = useSandboxWorkbenchStore((state) => state.resetSessionDraft);
  const restoreSessionSnapshot = useSandboxWorkbenchStore((state) => state.restoreSessionSnapshot);
  const restorePersistedDraft = useSandboxWorkbenchStore((state) => state.restorePersistedDraft);
  const setInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);
  const setViewportPreset = useSandboxWorkbenchStore((state) => state.setViewportPreset);

  const isEnglish = (i18n.resolvedLanguage || i18n.language || '').startsWith('en');

  const [runtimeError, setRuntimeError] = useState<{
    message: string;
    lineno: number;
    colno: number;
  } | null>(null);
  const [canvasSyncKey, setCanvasSyncKey] = useState(0);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [preResetSnapshot, setPreResetSnapshot] = useState<{
    revState: SandboxSessionRevisionState;
    content: string;
  } | null>(null);
  const didAttemptAutoRestoreRef = useRef(false);

  useEffect(() => {
    setResetConfirmOpen(false);
    setPreResetSnapshot(null);
  }, [activeSession?.id]);

  useEffect(() => {
    if (didAttemptAutoRestoreRef.current) return;
    didAttemptAutoRestoreRef.current = true;
    if (activeSession || embedded) return;
    const draft = readPersistedSandboxDraft();
    if (draft && !draft.dismissed) {
      restorePersistedDraft(ownerKey);
    }
  }, [activeSession, embedded, ownerKey, restorePersistedDraft]);

  const pinnedRecord = usePinnedArtifactStore((state) => {
    if (activeSession?.artifactId && state.recordsById[activeSession.artifactId]) {
      return state.recordsById[activeSession.artifactId];
    }
    const byOwner = state.activeArtifactByOwnerKey[effectiveOwnerKey];
    if (byOwner && state.recordsById[byOwner]) {
      return state.recordsById[byOwner];
    }
    if (activeSession?.sessionId) {
      const bySession = state.activeArtifactBySessionId[activeSession.sessionId];
      if (bySession && state.recordsById[bySession]) {
        return state.recordsById[bySession];
      }
    }
    return null;
  });

  const selectArtifactVersion = usePinnedArtifactStore((state) => state.selectArtifactVersion);
  const applyPatchToArtifact = usePinnedArtifactStore((state) => state.applyPatchToArtifact);
  const saveArtifactToStudySpace = usePinnedArtifactStore(
    (state) => state.saveArtifactToStudySpace,
  );

  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    return subscribeArtifactRendererRegistry(() => {
      setRegistryTick((v) => v + 1);
    });
  }, []);

  const sessionRevisionState = sessionRevisionsByOwner[effectiveOwnerKey];

  const revisions = useMemo(() => {
    if (pinnedRecord && pinnedRecord.revisions.length > 0) {
      return pinnedRecord.revisions;
    }
    if (sessionRevisionState && sessionRevisionState.revisions.length > 0) {
      return sessionRevisionState.revisions;
    }
    if (activeSession) {
      return [
        {
          version: 1,
          content: activeSession.content,
          createdAt: activeSession.createdAt,
        },
      ];
    }
    return [];
  }, [pinnedRecord, sessionRevisionState, activeSession]);

  const activeVersion = pinnedRecord?.activeVersion ?? sessionRevisionState?.activeVersion ?? 1;
  const activeRevision = useMemo(
    () =>
      revisions.find((rev) => rev.version === activeVersion) ??
      revisions[revisions.length - 1] ??
      null,
    [revisions, activeVersion],
  );

  const effectiveContent = stripSandboxRunRuntimeGuard(
    activeRevision?.content ?? activeSession?.content ?? '',
  );
  const initialDraftContent = sessionRevisionState?.initialContent ?? revisions[0]?.content ?? effectiveContent;
  const canResetDraft =
    !pinnedRecord &&
    (revisions.length > 1 ||
      effectiveContent !== initialDraftContent ||
      runtimeError !== null);
  const effectiveKind = pinnedRecord?.kind ?? activeSession?.artifactKind;
  const useInteractiveHtmlCanvas =
    effectiveKind === 'html' ||
    Boolean(
      activeSession &&
        activeSession.language.toLowerCase().startsWith('html') &&
        activeSession.mode === 'sandbox-run',
    );
  const scriptsEnabled = useInteractiveHtmlCanvas || activeSession?.mode === 'sandbox-run';
  const effectiveWidgetId =
    pinnedRecord?.widgetId ??
    activeSession?.widgetId ??
    pinnedRecord?.artifactId ??
    activeSession?.id ??
    '';
  const effectiveTitle = pinnedRecord?.title || activeSession?.title || t('sandbox.title');

  const [hasSyncedWidgetState, setHasSyncedWidgetState] = useState<boolean>(() =>
    effectiveWidgetId
      ? hasLiveWidgetModelState({ widgetId: effectiveWidgetId, source: effectiveContent })
      : false,
  );

  useEffect(() => {
    if (!effectiveWidgetId) {
      setHasSyncedWidgetState(false);
      return undefined;
    }
    setHasSyncedWidgetState(
      hasLiveWidgetModelState({ widgetId: effectiveWidgetId, source: effectiveContent }),
    );
    return subscribeWidgetLocalState(
      { widgetId: effectiveWidgetId, source: effectiveContent },
      (snapshot) => {
        setHasSyncedWidgetState(hasMeaningfulModelContent(snapshot?.modelContent));
      },
    );
  }, [effectiveWidgetId, effectiveContent]);

  const [savingToSpace, setSavingToSpace] = useState(false);

  const handleSaveToSpace = useCallback(async () => {
    if (!activeSession || savingToSpace) return;
    setSavingToSpace(true);
    try {
      const result = await saveArtifactToStudySpace({
        artifactId: pinnedRecord?.artifactId ?? activeSession.artifactId,
        title: effectiveTitle,
        kind: effectiveKind ?? 'html',
        language: pinnedRecord?.language ?? activeSession.language,
        content: effectiveContent,
        sessionId: pinnedRecord?.sessionId ?? activeSession.sessionId,
        groupId: pinnedRecord?.groupId ?? activeSession.groupId,
      });
      try {
        showGlobalNotification(
          'success',
          result.pinnedToGroup ? t('sandbox.savedToSpace') : t('sandbox.savedAsNote'),
        );
      } catch {
        // ignore notification errors in headless environments
      }
    } catch (error) {
      const message = getErrorMessage(error);
      try {
        showGlobalNotification('error', t('sandbox.saveFailed', { message }));
      } catch {
        // ignore notification errors in headless environments
      }
    } finally {
      setSavingToSpace(false);
    }
  }, [
    activeSession,
    effectiveContent,
    effectiveKind,
    effectiveTitle,
    pinnedRecord,
    saveArtifactToStudySpace,
    savingToSpace,
    t,
  ]);

  const handleClose = useCallback(() => {
    onClose?.();
    closeWorkbench(ownerKey);
  }, [closeWorkbench, onClose, ownerKey]);

  const handleClear = useCallback(() => {
    closeSession(ownerKey);
  }, [closeSession, ownerKey]);

  const handleToggleInspector = useCallback(() => {
    setInspectorOpen(!inspectorOpen, ownerKey);
  }, [inspectorOpen, ownerKey, setInspectorOpen]);

  const rootRef = useRef<HTMLElement | null>(null);
  const hasActiveSession = activeSession !== null;
  useEffect(() => {
    if (!isSmallScreen || !inspectorOpen || !hasActiveSession) return;
    return registerBackHandler(() => {
      const el = rootRef.current;
      if (!el || !el.isConnected) return false;
      if (el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      setInspectorOpen(false, ownerKey);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, inspectorOpen, hasActiveSession, ownerKey, setInspectorOpen]);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const prevViewportRef = useRef<string | null>(null);
  const prevSessionStampRef = useRef<{ id: string; updatedAt: number } | null>(null);

  useEffect(() => {
    setRuntimeError(null);
  }, [activeSession?.id, activeVersion]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const payload = event.data as
        | { source?: unknown; type?: unknown; message?: unknown; lineno?: unknown; colno?: unknown }
        | null
        | undefined;
      if (!payload || payload.source !== 'ds-sandbox-runtime' || payload.type !== 'runtime-error') {
        return;
      }
      const frame = canvasRef.current?.querySelector('iframe.interactive-html-canvas-frame');
      if (
        frame instanceof HTMLIFrameElement &&
        frame.contentWindow &&
        event.source &&
        event.source !== frame.contentWindow
      ) {
        return;
      }
      setRuntimeError({
        message: typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : (isEnglish ? 'Unknown script runtime error' : '未知脚本运行错误'),
        lineno: typeof payload.lineno === 'number' && Number.isFinite(payload.lineno)
          ? payload.lineno
          : 0,
        colno: typeof payload.colno === 'number' && Number.isFinite(payload.colno)
          ? payload.colno
          : 0,
      });
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isEnglish]);

  useEffect(() => {
    const prev = prevViewportRef.current;
    prevViewportRef.current = viewportPreset;
    const el = canvasRef.current;
    if (!el || prev === null || prev === viewportPreset) return;
    el.removeAttribute('data-sandbox-viewport-pulse');
    void el.offsetWidth;
    el.setAttribute('data-sandbox-viewport-pulse', '');
    const timer = window.setTimeout(
      () => el.removeAttribute('data-sandbox-viewport-pulse'),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [viewportPreset]);

  useEffect(() => {
    const prev = prevSessionStampRef.current;
    prevSessionStampRef.current = activeSession
      ? { id: activeSession.id, updatedAt: activeSession.updatedAt }
      : null;
    const el = canvasRef.current;
    if (
      !el ||
      !activeSession ||
      !prev ||
      prev.id !== activeSession.id ||
      prev.updatedAt === activeSession.updatedAt
    ) {
      return;
    }
    el.removeAttribute('data-sandbox-refresh-flash');
    void el.offsetWidth;
    el.setAttribute('data-sandbox-refresh-flash', '');
    const timer = window.setTimeout(
      () => el.removeAttribute('data-sandbox-refresh-flash'),
      700,
    );
    return () => window.clearTimeout(timer);
  }, [activeSession]);

  const subtitle = activeSession
    ? `${activeSession.language.toUpperCase()} · ${
        effectiveKind ? t('sandbox.pinnedCanvas') : t('sandbox.safePreview')
      }`
    : t('sandbox.emptyHint');

  const lineCount = useMemo(() => {
    if (!effectiveContent) return 0;
    return effectiveContent.split(/\r\n|\r|\n/).length;
  }, [effectiveContent]);

  const charCount = effectiveContent.length;

  const customRenderer = useMemo(() => {
    void registryTick;
    if (effectiveKind === 'openui' || effectiveKind === 'generative-ui') {
      return getArtifactRenderer(effectiveKind);
    }
    return null;
  }, [effectiveKind, registryTick]);

  const sessionForInspector = useMemo(
    () =>
      activeSession
        ? {
            ...activeSession,
            title: effectiveTitle,
            content: effectiveContent,
          }
        : null,
    [activeSession, effectiveContent, effectiveTitle],
  );

  if (!activeSession) {
    if (embedded) {
      return null;
    }

    const restorableDraft = readPersistedSandboxDraft();

    return (
      <section
        className={cn(
          'flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]',
          className,
        )}
      >
        {!hideToolbar && (
          <SandboxToolbar
            title={t('sandbox.title')}
            subtitle={subtitle}
            inspectorOpen={inspectorOpen}
            onToggleInspector={handleToggleInspector}
            onClose={handleClose}
          />
        )}
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl space-y-4 rounded-3xl border border-dashed border-border/35 bg-card/60 p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('sandbox.emptyHint')}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <DsButton
                type="button"
                variant="primary"
                size="sm"
                data-testid="sandbox-create-starter-button"
                onClick={() =>
                  launchSandboxWorkbench(
                    createStarterHtmlCanvasInput(i18n.resolvedLanguage || i18n.language),
                    ownerKey,
                  )
                }
              >
                {t('sandbox.createStarterCanvas', {
                  defaultValue: isEnglish
                    ? 'New HTML Canvas'
                    : '新建 HTML 画布',
                })}
              </DsButton>
              {restorableDraft && (
                <DsButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="sandbox-restore-draft-button"
                  onClick={() => {
                    restorePersistedDraft(ownerKey);
                  }}
                >
                  {t('sandbox.restoreLastDraft', {
                    defaultValue: isEnglish ? 'Restore last draft' : '恢复上次草稿',
                  })}
                </DsButton>
              )}
            </div>
            {isSmallScreen && (
              <p className="mt-2 text-xs text-muted-foreground/70">{t('sandbox.mobileHint')}</p>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (!isOpen && !embedded) {
    return (
      <section
        className={cn(
          'flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]',
          className,
        )}
      >
        {!hideToolbar && (
          <SandboxToolbar
            title={effectiveTitle}
            meta={t('sandbox.closed')}
            inspectorOpen={inspectorOpen}
            onToggleInspector={handleToggleInspector}
            onClose={handleClose}
          />
        )}
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="flex flex-col items-center gap-4">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => openWorkbench(ownerKey)}
              aria-label={t('sandbox.open')}
              title={t('sandbox.open')}
              data-wb-blur-surface
              className="!h-12 !w-12 rounded-2xl border border-border/35 bg-background/90 text-muted-foreground shadow-[var(--shadow-shell-soft)] backdrop-blur-md hover:bg-background hover:text-foreground"
            >
              <SidebarSimple size={18} />
            </DsButton>
            <button
              type="button"
              onClick={handleClear}
              className="rounded-full border border-border/35 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 [@media(pointer:coarse)]:!min-h-11"
            >
              {t('sandbox.clearSession')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const toolbarSubtitle = `${activeSession.language.toUpperCase()} · ${
    effectiveKind || useInteractiveHtmlCanvas
      ? t('sandbox.pinnedCanvas')
      : t('sandbox.safePreview')
  }`;

  const previewShell = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="relative z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border/35 bg-[color:var(--shell-workspace-panel)] px-4 py-2.5"
        data-testid="sandbox-artifact-header"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            data-testid="sandbox-artifact-status-dot"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              hasSyncedWidgetState ? 'bg-[hsl(var(--success))]' : 'bg-primary',
            )}
            aria-hidden="true"
          />
          <span
            className="max-w-[220px] truncate text-xs font-medium text-foreground"
            data-testid="sandbox-artifact-title"
          >
            {effectiveTitle}
          </span>
          {useInteractiveHtmlCanvas && (
            <span
              data-testid="sandbox-runtime-status-badge"
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums',
                runtimeError
                  ? 'border-destructive/45 bg-destructive/10 text-destructive'
                  : 'border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] text-foreground',
              )}
            >
              {runtimeError
                ? (isEnglish ? 'Script error' : '脚本错误')
                : (isEnglish ? `Running · v${activeVersion}` : `已运行 · v${activeVersion}`)}
            </span>
          )}
          {hasSyncedWidgetState && (
            <span
              className="rounded-full border border-border/35 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
              data-testid="sandbox-state-synced-badge"
            >
              {t('sandbox.stateSynced')}
            </span>
          )}
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={t('sandbox.versionHistory')}
            data-testid="sandbox-version-pills"
          >
            {revisions.map((rev) => {
              const isCurrent = rev.version === activeVersion;
              return (
                <button
                  key={rev.version}
                  type="button"
                  data-testid={`sandbox-version-pill-v${rev.version}`}
                  aria-pressed={isCurrent}
                  onClick={() => {
                    setRuntimeError(null);
                    if (pinnedRecord) {
                      selectArtifactVersion(pinnedRecord.artifactId, rev.version);
                    } else {
                      selectSessionRevision(rev.version, ownerKey);
                    }
                  }}
                  className={cn(
                    'rounded-full border px-2 py-0.5 font-mono text-xs tabular-nums transition-colors',
                    isCurrent
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border/35 bg-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  v{rev.version}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {useInteractiveHtmlCanvas && !pinnedRecord && (
            <button
              type="button"
              disabled={!canResetDraft}
              onClick={() => {
                setResetConfirmOpen((prev) => !prev);
              }}
              aria-expanded={resetConfirmOpen}
              data-testid="sandbox-reset-button"
              className="inline-flex items-center gap-1 rounded-full border border-border/35 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-45 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:px-3.5"
            >
              <span>{isEnglish ? 'Reset' : '重置'}</span>
            </button>
          )}
          {useInteractiveHtmlCanvas && !pinnedRecord && preResetSnapshot && !resetConfirmOpen && (
            <button
              type="button"
              onClick={() => {
                setRuntimeError(null);
                restoreSessionSnapshot(preResetSnapshot, ownerKey);
                setPreResetSnapshot(null);
                setCanvasSyncKey((v) => v + 1);
              }}
              data-testid="sandbox-undo-reset-button"
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:px-3.5"
            >
              <span>{isEnglish ? 'Reset to v1 · Undo' : '已重置为 v1 · 撤销重置'}</span>
            </button>
          )}
          <button
            type="button"
            disabled={savingToSpace}
            onClick={() => void handleSaveToSpace()}
            data-testid="sandbox-save-to-space-button"
            className="inline-flex items-center gap-1 rounded-full border border-border/35 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:px-3.5"
          >
            <FolderSimplePlus size={13} className="shrink-0" />
            <span>{savingToSpace ? t('sandbox.savingToSpace') : t('sandbox.saveToSpace')}</span>
          </button>

          {(['desktop', 'tablet', 'mobile'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setViewportPreset(preset, ownerKey)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:px-4',
                viewportPreset === preset
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border/35 bg-transparent text-muted-foreground hover:text-foreground',
              )}
              aria-label={
                preset === 'desktop'
                  ? t('sandbox.desktop')
                  : preset === 'tablet'
                    ? t('sandbox.tablet')
                    : t('sandbox.mobile')
              }
              title={
                preset === 'desktop'
                  ? t('sandbox.desktop')
                  : preset === 'tablet'
                    ? t('sandbox.tablet')
                    : t('sandbox.mobile')
              }
            >
              {preset === 'desktop'
                ? t('sandbox.desktopShort', '桌')
                : preset === 'tablet'
                  ? t('sandbox.tabletShort', '平')
                  : t('sandbox.mobileShort', '手')}
            </button>
          ))}
        </div>
      </div>

      {useInteractiveHtmlCanvas && !pinnedRecord && resetConfirmOpen && (
        <div
          data-testid="sandbox-reset-confirm-bar"
          role="alertdialog"
          aria-label={isEnglish ? 'Confirm reset' : '确认重置'}
          className="relative z-20 flex flex-wrap items-center justify-between gap-2 border-b border-warning/35 bg-warning/10 px-4 py-2 text-xs text-foreground"
        >
          <span>
            {isEnglish
              ? 'Reset to initial v1? Existing versions will be collapsed and can be undone.'
              : '确定重置回初始版本 v1 吗？当前历史版本将被收起，可随时撤销。'}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const snapshotRevState: SandboxSessionRevisionState = sessionRevisionState
                  ? {
                      initialContent: sessionRevisionState.initialContent,
                      activeVersion: sessionRevisionState.activeVersion,
                      revisions: sessionRevisionState.revisions.map((item) => ({ ...item })),
                    }
                  : {
                      initialContent: initialDraftContent,
                      activeVersion,
                      revisions: revisions.map((item) => ({ ...item })),
                    };
                setPreResetSnapshot({
                  revState: snapshotRevState,
                  content: effectiveContent,
                });
                setRuntimeError(null);
                resetSessionDraft(ownerKey);
                setResetConfirmOpen(false);
                setCanvasSyncKey((v) => v + 1);
              }}
              data-testid="sandbox-reset-confirm-button"
              className="rounded-md border border-warning/50 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-warning/15 [@media(pointer:coarse)]:!min-h-11"
            >
              {isEnglish ? 'Confirm Reset' : '确认重置'}
            </button>
            <button
              type="button"
              onClick={() => setResetConfirmOpen(false)}
              data-testid="sandbox-reset-cancel-button"
              className="rounded-md border border-border/35 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted [@media(pointer:coarse)]:!min-h-11"
            >
              {isEnglish ? 'Cancel' : '取消'}
            </button>
          </div>
        </div>
      )}

      {useInteractiveHtmlCanvas && (
        <div
          data-testid="sandbox-runtime-console"
          role={runtimeError ? 'alert' : undefined}
          className={cn(
            'relative z-20 flex shrink-0 items-center justify-between gap-2 border-b px-4 py-1.5 text-xs',
            runtimeError
              ? 'border-destructive/35 bg-destructive/10 text-destructive'
              : 'border-border/25 bg-muted/20 text-muted-foreground',
          )}
        >
          <span
            data-testid={runtimeError ? 'sandbox-runtime-error-message' : 'sandbox-runtime-ok-message'}
            className="min-w-0 truncate font-mono"
          >
            {runtimeError
              ? `${isEnglish ? 'Runtime error' : '脚本运行错误'}${
                  runtimeError.lineno > 0
                    ? isEnglish
                      ? ` (line ${runtimeError.lineno}${runtimeError.colno > 0 ? `:${runtimeError.colno}` : ''})`
                      : `（第 ${runtimeError.lineno} 行${runtimeError.colno > 0 ? `:${runtimeError.colno}` : ''}）`
                    : ''
                }: ${runtimeError.message}`
              : (isEnglish
                  ? `Sandbox runtime · v${activeVersion} · Ready`
                  : `运行控制台 · v${activeVersion} · 运行正常`)}
          </span>
          {runtimeError && (
            <button
              type="button"
              onClick={() => setRuntimeError(null)}
              data-testid="sandbox-runtime-clear-error"
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-destructive/15"
            >
              {isEnglish ? 'Clear' : '清除'}
            </button>
          )}
        </div>
      )}

      <CustomScrollArea
        className="min-h-0 flex-1"
        viewportClassName="bg-[radial-gradient(circle_at_top,_hsl(var(--card)/0.55),_transparent_58%)] p-4"
        orientation="both"
      >
        <div
          ref={canvasRef}
          data-testid="sandbox-runtime-canvas"
          className={cn(
            'relative z-[1] mx-auto min-h-[360px] overflow-hidden rounded-2xl border border-border/35 bg-background shadow-[var(--shadow-shell-soft)] md:min-h-[520px] [&_[data-expanded="true"]]:!relative [&_[data-expanded="true"]]:!inset-auto [&_[data-expanded="true"]]:!z-[1] [&_[data-expanded="true"]]:!h-auto [&_[data-expanded="true"]]:!min-h-[480px] [&_[data-expanded="true"]]:!w-full',
            !useInteractiveHtmlCanvas &&
              effectiveKind !== 'openui' &&
              effectiveKind !== 'generative-ui' &&
              'h-full',
            viewportClasses[viewportPreset],
          )}
        >
          {useInteractiveHtmlCanvas ? (
            <InteractiveHtmlCanvas
              key={`${activeSession.id}:${canvasSyncKey}`}
              html={effectiveContent}
              widgetId={effectiveWidgetId || undefined}
              workTitle={effectiveTitle}
              title={effectiveTitle}
              expanded
              externalVersion={activeVersion}
              onHtmlChange={(nextHtml) => {
                setRuntimeError(null);
                setResetConfirmOpen(false);
                setPreResetSnapshot(null);
                const cleanHtml = stripSandboxRunRuntimeGuard(nextHtml);
                if (pinnedRecord) {
                  applyPatchToArtifact(pinnedRecord.artifactId, { content: cleanHtml });
                } else {
                  commitSessionRevision(cleanHtml, ownerKey);
                }
                if (cleanHtml !== nextHtml) {
                  setCanvasSyncKey((v) => v + 1);
                }
              }}
            />
          ) : effectiveKind === 'openui' || effectiveKind === 'generative-ui' ? (
            customRenderer ? (
              <div className="p-4" data-testid={`sandbox-custom-artifact-${effectiveKind}`}>
                {React.createElement(customRenderer, {
                  content: effectiveContent,
                  widgetId: effectiveWidgetId || undefined,
                  title: effectiveTitle,
                })}
              </div>
            ) : (
              <div className="p-4 text-xs text-muted-foreground" data-testid="sandbox-renderer-fallback">
                <p className="mb-2">{t('sandbox.rendererUnavailable')}</p>
                <pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-foreground">
                  {effectiveContent}
                </pre>
              </div>
            )
          ) : (
            <HtmlSandboxPreview
              mode="chat-safe"
              htmlContent={effectiveContent}
              height="100%"
              title={effectiveTitle}
              className="h-full w-full"
            />
          )}
        </div>
      </CustomScrollArea>
    </div>
  );

  const inspectorSession = sessionForInspector ?? activeSession;
  const inspectorSourceTypeLabel = inspectorSession.sourceType === 'chat-code-block'
    ? t('sandbox.codeBlock')
    : inspectorSession.sourceType;
  const inspectorModeLabel = inspectorSession.mode === 'safe-preview'
    ? t('sandbox.safePreview')
    : t('sandbox.running');

  const inspectorShell = (
    <aside
      data-testid="sandbox-inspector-panel"
      className={[
        'flex min-w-0 flex-col bg-[color:var(--shell-inspector-panel)]',
        isSmallScreen
          ? 'h-auto max-h-[45dvh] border-t border-border'
          : 'h-full border-l border-border',
      ].join(' ')}
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t('sandbox.inspector')}</h2>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setInspectorOpen(false, ownerKey)}
            title={t('sandbox.collapse')}
            aria-label={t('sandbox.collapse')}
            className="!h-7 !w-7 !p-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:-my-2"
          >
            <X size={14} />
          </DsButton>
        </div>
      </div>
      <CustomScrollArea
        className="min-h-0 flex-1"
        viewportClassName="px-4 py-4 text-sm text-muted-foreground"
      >
        <div className="space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.source')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground">
                {inspectorSourceTypeLabel}
              </span>
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                {inspectorModeLabel}
              </span>
            </div>
            <p className="mt-2 break-all text-xs text-muted-foreground">{inspectorSession.sourceMessageId}</p>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.view')}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              {(['desktop', 'tablet', 'mobile'] as const).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setViewportPreset(preset, ownerKey)}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors [@media(pointer:coarse)]:!min-h-11 ${
                    viewportPreset === preset
                      ? 'border-foreground/30 bg-foreground/5 text-foreground'
                      : 'border-border bg-transparent'
                  }`}
                  aria-label={t(`sandbox.${preset}`)}
                  title={t(`sandbox.${preset}`)}
                >
                  {preset === 'desktop'
                    ? t('sandbox.desktopShort', '桌')
                    : preset === 'tablet'
                      ? t('sandbox.tabletShort', '平')
                      : t('sandbox.mobileShort', '手')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.stats')}</p>
            <dl className="mt-2 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-4">
                <dt>{t('sandbox.language')}</dt>
                <dd className="text-foreground">{inspectorSession.language}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt>{t('sandbox.lines')}</dt>
                <dd className="text-foreground">{lineCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt>{t('sandbox.characters')}</dt>
                <dd className="text-foreground">{charCount}</dd>
              </div>
            </dl>
          </div>

          <div
            data-testid="sandbox-inspector-security-notice"
            className="rounded-xl border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground"
          >
            {scriptsEnabled
              ? (isEnglish
                  ? 'Script execution enabled (allow-scripts · no same-origin permission).'
                  : '脚本执行已启用（allow-scripts · 无同源权限）。')
              : t('sandbox.iframeNotice')}
          </div>
        </div>
      </CustomScrollArea>
    </aside>
  );

  return (
    <section
      ref={rootRef}
      className={cn(
        'flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]',
        className,
      )}
    >
      {!hideToolbar && (
        <div className="relative z-20 shrink-0">
          <SandboxToolbar
            title={effectiveTitle}
            subtitle={toolbarSubtitle}
            inspectorOpen={inspectorOpen}
            onToggleInspector={handleToggleInspector}
            onClose={handleClose}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {isSmallScreen ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">{previewShell}</div>
            {inspectorOpen ? inspectorShell : null}
          </div>
        ) : (
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={inspectorOpen ? 74 : 82} minSize={58} className="h-full">
              {previewShell}
            </Panel>

            {inspectorOpen ? (
              <>
                <PanelResizeHandle
                  hitAreaMargins={{ coarse: 19, fine: 5 }}
                  className="w-px bg-border/35 transition-colors hover:bg-primary/30 active:bg-primary/50"
                />
                <Panel defaultSize={26} minSize={20} maxSize={36}>
                  {inspectorShell}
                </Panel>
              </>
            ) : (
              <Panel defaultSize={18} minSize={14} maxSize={22}>
                <SandboxStatusRail onOpenInspector={handleToggleInspector} />
              </Panel>
            )}
          </PanelGroup>
        )}
      </div>
    </section>
  );
}

export default SandboxWorkbenchSurface;
