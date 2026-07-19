/**
 * PreviewStatus — Learning Hub 预览区统一空态 / 加载 / 错误占位
 *
 * 替换各 ContentView 内联的 spinner / WarningCircle / FileText 混用失败隐喻。
 */

import React from 'react';
import {
  WarningCircle,
  ImageBroken,
  FileText,
  CircleNotch,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';

export type PreviewStatusTone = 'error' | 'warning' | 'empty' | 'loading';

export type PreviewStatusIcon = 'warning' | 'brokenImage' | 'file' | 'none';

export interface PreviewStatusAction {
  id: string;
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'default' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
}

export interface PreviewStatusProps {
  tone: PreviewStatusTone;
  title: string;
  description?: string;
  meta?: string;
  icon?: PreviewStatusIcon;
  actions?: PreviewStatusAction[];
  className?: string;
  children?: React.ReactNode;
}

function defaultIconForTone(tone: PreviewStatusTone): PreviewStatusIcon {
  switch (tone) {
    case 'loading':
      return 'none';
    case 'empty':
      return 'file';
    case 'warning':
    case 'error':
    default:
      return 'warning';
  }
}

function StatusIcon({
  icon,
  tone,
}: {
  icon: PreviewStatusIcon;
  tone: PreviewStatusTone;
}) {
  if (tone === 'loading') {
    return (
      <CircleNotch
        className="h-8 w-8 animate-spin text-primary"
        aria-hidden="true"
      />
    );
  }

  if (icon === 'none') return null;

  if (icon === 'brokenImage') {
    return (
      <ImageBroken
        size={40}
        className="text-muted-foreground"
        aria-hidden="true"
      />
    );
  }

  if (icon === 'file') {
    return (
      <FileText
        className="w-16 h-16 text-muted-foreground opacity-50"
        aria-hidden="true"
      />
    );
  }

  // warning
  const toneClass =
    tone === 'warning'
      ? 'text-amber-500'
      : 'text-destructive';

  return (
    <WarningCircle
      size={tone === 'warning' ? 32 : 40}
      className={toneClass}
      aria-hidden="true"
    />
  );
}

export const PreviewStatus: React.FC<PreviewStatusProps> = ({
  tone,
  title,
  description,
  meta,
  icon,
  actions,
  className,
  children,
}) => {
  const resolvedIcon = icon ?? defaultIconForTone(tone);
  const role = tone === 'loading' ? 'status' : tone === 'error' ? 'alert' : 'note';

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full gap-3 px-4 py-6 text-center',
        className,
      )}
      role={role}
      aria-label={tone === 'loading' ? title : undefined}
    >
      <StatusIcon icon={resolvedIcon} tone={tone} />
      <div className="space-y-1 max-w-md">
        <p
          className={cn(
            'text-sm font-medium',
            tone === 'error' && 'text-destructive',
            tone === 'loading' && 'text-muted-foreground',
            (tone === 'empty' || tone === 'warning') && 'text-foreground',
          )}
        >
          {title}
        </p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        {meta && (
          <p className="text-xs text-muted-foreground/80 break-all font-mono">
            {meta}
          </p>
        )}
      </div>
      {children}
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
          {actions.map((action) => (
            <NotionButton
              key={action.id}
              variant={action.variant ?? (action.id === 'retry' ? 'ghost' : 'default')}
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled || action.loading}
              className="gap-1.5"
            >
              {action.loading && (
                <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {action.label}
            </NotionButton>
          ))}
        </div>
      )}
    </div>
  );
};

export default PreviewStatus;
