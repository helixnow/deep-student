import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { SidebarSimple } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { HtmlSandboxPreview } from '@/components/previews/HtmlSandboxPreview';
import { useBreakpoint } from '@/hooks/useBreakpoint';

import {
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '../store/useSandboxWorkbenchStore';
import { SandboxInspectorPanel } from './SandboxInspectorPanel';
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
   * ★ 2026-07-08（移动端审计 D-6）：独立视图形态下移动端已有统一顶栏
   * （UnifiedMobileHeader），再渲染 SandboxToolbar 会形成第二条顶栏；
   * 由 SandboxWorkbenchPage 在小屏时传入。嵌入 chat-v2 右屏时保持默认 false。
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
  const { t } = useTranslation('workbench');
  const { isSmallScreen } = useBreakpoint();
  const activeSession = useSandboxWorkbenchStore((state) => ownerKey
    ? selectSandboxWorkbenchOwnerState(state, ownerKey).activeSession
    : state.activeSession);
  const isOpen = useSandboxWorkbenchStore((state) => ownerKey
    ? selectSandboxWorkbenchOwnerState(state, ownerKey).isOpen
    : state.isOpen);
  const inspectorOpen = useSandboxWorkbenchStore((state) => ownerKey
    ? selectSandboxWorkbenchOwnerState(state, ownerKey).inspectorOpen
    : state.inspectorOpen);
  const viewportPreset = useSandboxWorkbenchStore((state) => ownerKey
    ? selectSandboxWorkbenchOwnerState(state, ownerKey).viewportPreset
    : state.viewportPreset);
  const refreshSession = useSandboxWorkbenchStore((state) => state.refreshSession);
  const closeSession = useSandboxWorkbenchStore((state) => state.closeSession);
  const openWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const closeWorkbench = useSandboxWorkbenchStore((state) => state.closeWorkbench);
  const setInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);
  const setViewportPreset = useSandboxWorkbenchStore((state) => state.setViewportPreset);

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

  // ACR 4.0（A6 演出）：viewport 切换 / refresh 后给画布一次轻量反馈。
  // 画布 max-width 无 transition（宽度瞬时落位），用一次 scale/opacity 脉冲确认
  // 切换发生；refresh 用 ::after 覆层 flash。皆有 reduced-motion 静态路径（CSS）。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const prevViewportRef = useRef<string | null>(null);
  const prevSessionStampRef = useRef<{ id: string; updatedAt: number } | null>(null);

  useEffect(() => {
    const prev = prevViewportRef.current;
    prevViewportRef.current = viewportPreset;
    const el = canvasRef.current;
    if (!el || prev === null || prev === viewportPreset) return;
    el.removeAttribute('data-sandbox-viewport-pulse');
    // 强制重排，确保连续切换能重启动画
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
    ? `${activeSession.language.toUpperCase()} · ${t('sandbox.safePreview')}`
    : t('sandbox.emptyHint');

  const lineCount = useMemo(() => {
    if (!activeSession?.content) return 0;
    return activeSession.content.split(/\r\n|\r|\n/).length;
  }, [activeSession]);

  const charCount = activeSession?.content.length ?? 0;

  if (!activeSession) {
    if (embedded) {
      return null;
    }

    return (
      <section className={cn('flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]', className)}>
        {!hideToolbar && (
          <SandboxToolbar
            title={t('sandbox.title')}
            subtitle={subtitle}
            inspectorOpen={inspectorOpen}
            onReload={() => refreshSession(ownerKey)}
            onToggleInspector={handleToggleInspector}
            onClose={handleClose}
          />
        )}
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl rounded-3xl border border-dashed border-border bg-card/60 p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('sandbox.emptyHint')}</p>
            {isSmallScreen && (
              <p className="mt-2 text-xs text-muted-foreground/70">
                {t('sandbox.mobileHint')}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (!isOpen && !embedded) {
    return (
      <section className={cn('flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]', className)}>
        {!hideToolbar && (
          <SandboxToolbar
            title={activeSession.title}
            meta={t('sandbox.closed')}
            inspectorOpen={inspectorOpen}
            onReload={() => refreshSession(ownerKey)}
            onToggleInspector={handleToggleInspector}
            onClose={handleClose}
          />
        )}
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="flex flex-col items-center gap-4">
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => openWorkbench(ownerKey)}
              aria-label={t('sandbox.open')}
              title={t('sandbox.open')}
              data-wb-blur-surface
              className="!h-12 !w-12 rounded-2xl border border-border/80 bg-background/90 text-muted-foreground shadow-[var(--shadow-shell-soft)] backdrop-blur-md hover:bg-background hover:text-foreground"
            >
              <SidebarSimple size={18} />
            </NotionButton>
            <button
              type="button"
              onClick={handleClear}
              className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5"
            >
              {t('sandbox.clearSession')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const toolbarSubtitle = `${activeSession.language.toUpperCase()} · ${t('sandbox.safePreview')}`;

  const previewShell = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('sandbox.preview')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['desktop', 'tablet', 'mobile'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setViewportPreset(preset, ownerKey)}
              className={cn(
                // 触屏（coarse 指针）下药丸放大到 ≥40px 触控目标
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-4',
                viewportPreset === preset
                  ? 'border-foreground/25 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground'
              )}
              aria-label={preset === 'desktop' ? t('sandbox.desktop') : preset === 'tablet' ? t('sandbox.tablet') : t('sandbox.mobile')}
              title={preset === 'desktop' ? t('sandbox.desktop') : preset === 'tablet' ? t('sandbox.tablet') : t('sandbox.mobile')}
            >
              {/* 文案走 i18n（此前硬编码「桌/平/手」，英文界面不可读） */}
              {preset === 'desktop'
                ? t('sandbox.desktopShort', '桌')
                : preset === 'tablet'
                  ? t('sandbox.tabletShort', '平')
                  : t('sandbox.mobileShort', '手')}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_hsl(var(--card)/0.55),_transparent_58%)] p-4">
        <div
          ref={canvasRef}
          data-testid="sandbox-runtime-canvas"
          className={cn(
            'relative mx-auto h-full min-h-[360px] overflow-hidden rounded-[28px] border border-border/70 bg-background shadow-[var(--shadow-shell-soft)] md:min-h-[520px]',
            viewportClasses[viewportPreset]
          )}
        >
          <HtmlSandboxPreview
            mode="chat-safe"
            htmlContent={activeSession.content}
            height="100%"
            title={activeSession.title}
            className="h-full w-full"
          />
        </div>
      </div>
    </div>
  );

  const inspectorShell = (
    <SandboxInspectorPanel
      session={activeSession}
      viewportPreset={viewportPreset}
      lineCount={lineCount}
      charCount={charCount}
      onClose={() => setInspectorOpen(false, ownerKey)}
      onSetViewportPreset={(preset) => setViewportPreset(preset, ownerKey)}
      compact={isSmallScreen}
    />
  );

  return (
    <section className={cn('flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]', className)}>
      {!hideToolbar && (
        <SandboxToolbar
          title={activeSession.title}
          subtitle={toolbarSubtitle}
          inspectorOpen={inspectorOpen}
          onReload={() => refreshSession(ownerKey)}
          onToggleInspector={handleToggleInspector}
          onClose={handleClose}
        />
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {isSmallScreen ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">{previewShell}</div>
            {/* ★ 2026-07-08（移动端审计 D-7）：原先无条件渲染，
                工具栏的检查器开关与面板内 X 按钮在小屏上形同虚设 */}
            {inspectorOpen ? inspectorShell : null}
          </div>
        ) : (
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={inspectorOpen ? 74 : 82} minSize={58} className="h-full">
              {previewShell}
            </Panel>

            {inspectorOpen ? (
              <>
                <PanelResizeHandle className="w-1.5 bg-border transition-colors hover:bg-primary/30 active:bg-primary/50" />
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
