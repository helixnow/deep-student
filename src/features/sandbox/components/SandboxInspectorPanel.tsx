import React from 'react';
import { X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation('workbench');
  const sourceTypeLabel = session.sourceType === 'chat-code-block'
    ? t('sandbox.codeBlock')
    : session.sourceType;
  const modeLabel = session.mode === 'safe-preview' ? t('sandbox.safePreview') : t('sandbox.running');

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
          <h2 className="text-sm font-semibold text-foreground">{t('sandbox.inspector')}</h2>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onClose}
            title={t('sandbox.collapse')}
            aria-label={t('sandbox.collapse')}
            className="!h-7 !w-7 !p-0"
          >
            <X size={14} />
          </NotionButton>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4 text-sm text-muted-foreground">
        <div className="space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.source')}</p>
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
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.view')}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => onSetViewportPreset('desktop')}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  viewportPreset === 'desktop'
                  ? 'border-foreground/30 bg-foreground/5 text-foreground'
                  : 'border-border bg-transparent'
                }`}
                aria-label={t('sandbox.desktop')}
                title={t('sandbox.desktop')}
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
                aria-label={t('sandbox.tablet')}
                title={t('sandbox.tablet')}
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
                aria-label={t('sandbox.mobile')}
                title={t('sandbox.mobile')}
              >
                手
              </button>
            </div>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t('sandbox.stats')}</p>
            <dl className="mt-2 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-4">
                <dt>{t('sandbox.language')}</dt>
                <dd className="text-foreground">{session.language}</dd>
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

          <div className="rounded-xl border border-border bg-background/60 p-3 text-xs leading-5 text-muted-foreground">
            {t('sandbox.iframeNotice')}
          </div>
        </div>
      </div>
    </aside>
  );
}

export default SandboxInspectorPanel;
