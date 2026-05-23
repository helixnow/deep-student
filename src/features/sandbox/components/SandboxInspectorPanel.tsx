import React from 'react';
import { X } from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import type { SandboxSession, SandboxViewportPreset } from '../types';

interface SandboxInspectorPanelProps {
  session: SandboxSession;
  viewportPreset: SandboxViewportPreset;
  lineCount: number;
  charCount: number;
  onClose: () => void;
  onSetViewportPreset: (preset: SandboxViewportPreset) => void;
  compact?: boolean;
  className?: string;
}

export function SandboxInspectorPanel({
  session,
  viewportPreset,
  lineCount,
  charCount,
  onClose,
  onSetViewportPreset,
  compact = false,
  className,
}: SandboxInspectorPanelProps) {
  const sourceTypeLabel = session.sourceType === 'chat-code-block' ? '代码块' : session.sourceType;
  const modeLabel = session.mode === 'safe-preview' ? '安全' : '运行';

  return (
    <aside
      className={[
        'flex min-w-0 flex-col bg-[color:var(--shell-inspector-panel)]',
        compact ? 'h-auto border-t border-border' : 'h-full border-l border-border',
        className,
      ].filter(Boolean).join(' ')}
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">检查器</h2>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onClose}
            title="收起"
            aria-label="收起"
            className="!h-7 !w-7 !p-0"
          >
            <X size={14} />
          </NotionButton>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4 text-sm text-muted-foreground">
        <div className="space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">来源</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground">
                {sourceTypeLabel}
              </span>
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                {modeLabel}
              </span>
            </div>
            <p className="mt-2 break-all text-xs text-muted-foreground">{session.sourceMessageId}</p>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">视图</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => onSetViewportPreset('desktop')}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  viewportPreset === 'desktop'
                  ? 'border-foreground/30 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent'
                }`}
                aria-label="桌面"
                title="桌面"
              >
                桌
              </button>
              <button
                type="button"
                onClick={() => onSetViewportPreset('tablet')}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  viewportPreset === 'tablet'
                  ? 'border-foreground/30 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent'
                }`}
                aria-label="平板"
                title="平板"
              >
                平
              </button>
              <button
                type="button"
                onClick={() => onSetViewportPreset('mobile')}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  viewportPreset === 'mobile'
                  ? 'border-foreground/30 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent'
                }`}
                aria-label="手机"
                title="手机"
              >
                手
              </button>
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">统计</p>
            <dl className="mt-2 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-4">
                <dt>语言</dt>
                <dd className="text-foreground">{session.language}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt>行数</dt>
                <dd className="text-foreground">{lineCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt>字符</dt>
                <dd className="text-foreground">{charCount}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
            受限 iframe，脚本已禁用。
          </div>
        </div>
      </div>
    </aside>
  );
}

export default SandboxInspectorPanel;
