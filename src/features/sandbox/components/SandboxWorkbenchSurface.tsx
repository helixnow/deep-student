import React, { useCallback, useMemo } from 'react';
import { SidebarSimple } from '@phosphor-icons/react';

import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { HtmlSandboxPreview } from '@/components/previews/HtmlSandboxPreview';
import { useBreakpoint } from '@/hooks/useBreakpoint';

import { useSandboxWorkbenchStore } from '../store/useSandboxWorkbenchStore';
import { SandboxInspectorPanel } from './SandboxInspectorPanel';
import { SandboxStatusRail } from './SandboxStatusRail';
import { SandboxToolbar } from './SandboxToolbar';

export interface SandboxWorkbenchSurfaceProps {
  embedded?: boolean;
  className?: string;
  onClose?: () => void;
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
}: SandboxWorkbenchSurfaceProps) {
  const { isSmallScreen } = useBreakpoint();
  const activeSession = useSandboxWorkbenchStore((state) => state.activeSession);
  const isOpen = useSandboxWorkbenchStore((state) => state.isOpen);
  const inspectorOpen = useSandboxWorkbenchStore((state) => state.inspectorOpen);
  const viewportPreset = useSandboxWorkbenchStore((state) => state.viewportPreset);
  const refreshSession = useSandboxWorkbenchStore((state) => state.refreshSession);
  const closeSession = useSandboxWorkbenchStore((state) => state.closeSession);
  const openWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const closeWorkbench = useSandboxWorkbenchStore((state) => state.closeWorkbench);
  const setInspectorOpen = useSandboxWorkbenchStore((state) => state.setInspectorOpen);
  const setViewportPreset = useSandboxWorkbenchStore((state) => state.setViewportPreset);

  const handleClose = useCallback(() => {
    onClose?.();
    closeWorkbench();
  }, [closeWorkbench, onClose]);

  const handleClear = useCallback(() => {
    closeSession();
  }, [closeSession]);

  const handleToggleInspector = useCallback(() => {
    setInspectorOpen(!inspectorOpen);
  }, [inspectorOpen, setInspectorOpen]);

  const subtitle = activeSession
    ? `${activeSession.language.toUpperCase()} · 安全预览`
    : '在聊天中打开代码块即可预览';

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
        <SandboxToolbar
          title="沙箱工作台"
          subtitle={subtitle}
          inspectorOpen={inspectorOpen}
          onReload={refreshSession}
          onToggleInspector={handleToggleInspector}
          onClose={handleClose}
        />
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl rounded-3xl border border-dashed border-border bg-card/60 p-8 text-center">
            <p className="text-sm text-muted-foreground">在聊天中打开代码块即可预览。</p>
          </div>
        </div>
      </section>
    );
  }

  if (!isOpen && !embedded) {
    return (
      <section className={cn('flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]', className)}>
        <SandboxToolbar
          title={activeSession.title}
          meta="已收起"
          inspectorOpen={inspectorOpen}
          onReload={refreshSession}
          onToggleInspector={handleToggleInspector}
          onClose={handleClose}
        />
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="flex flex-col items-center gap-4">
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={openWorkbench}
              aria-label="打开沙箱工作台"
              title="打开沙箱工作台"
              className="!h-12 !w-12 rounded-2xl border border-border/80 bg-background/90 text-muted-foreground shadow-[var(--shadow-shell-soft)] backdrop-blur-md hover:bg-background hover:text-foreground"
            >
              <SidebarSimple size={18} />
            </NotionButton>
            <button
              type="button"
              onClick={handleClear}
              className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5"
            >
              清空会话
            </button>
          </div>
        </div>
      </section>
    );
  }

  const toolbarSubtitle = `${activeSession.language.toUpperCase()} · 安全预览`;

  const previewShell = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            预览
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['desktop', 'tablet', 'mobile'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setViewportPreset(preset)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                viewportPreset === preset
                  ? 'border-foreground/25 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground'
              )}
              aria-label={preset === 'desktop' ? '桌面' : preset === 'tablet' ? '平板' : '手机'}
              title={preset === 'desktop' ? '桌面' : preset === 'tablet' ? '平板' : '手机'}
            >
              {preset === 'desktop' ? '桌' : preset === 'tablet' ? '平' : '手'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.55),_transparent_58%)] p-4">
        <div
          data-testid="sandbox-runtime-canvas"
          className={cn(
            'mx-auto h-full min-h-[360px] overflow-hidden rounded-[28px] border border-border/70 bg-background shadow-[var(--shadow-shell-soft)] md:min-h-[520px]',
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
      onClose={() => setInspectorOpen(false)}
      onSetViewportPreset={setViewportPreset}
      compact={isSmallScreen}
    />
  );

  return (
    <section className={cn('flex h-full min-h-0 flex-col bg-[color:var(--shell-workspace-panel)]', className)}>
      <SandboxToolbar
        title={activeSession.title}
        subtitle={toolbarSubtitle}
        inspectorOpen={inspectorOpen}
        onReload={refreshSession}
        onToggleInspector={handleToggleInspector}
        onClose={handleClose}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {isSmallScreen ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">{previewShell}</div>
            {inspectorShell}
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
