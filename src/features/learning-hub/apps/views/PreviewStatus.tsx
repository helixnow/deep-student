/**
 * PreviewStatus — Learning Hub 预览区统一空态 / 加载 / 错误占位
 *
 * 替换各 ContentView 内联的 spinner / WarningCircle / FileText 混用失败隐喻。
 *
 * - 加载态支持 delayMs 延迟显示（与 UnifiedAppPanel 的 150ms 策略一致）：
 *   短加载不闪烁 spinner，超时后淡入。
 * - 非加载态带轻微 rise-in 入场动画；图标置于柔和的圆形底座上。
 */

import React from 'react';
import {
  WarningCircle,
  ImageBroken,
  FileText,
  CircleNotch,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
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
  /**
   * 仅 tone="loading" 生效：延迟该毫秒数后再显示加载指示，
   * 快速加载（< delayMs）不会闪现 spinner。延迟期间容器仍占满高度，布局不跳动。
   */
  delayMs?: number;
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
        className="h-7 w-7 animate-spin text-primary"
        aria-hidden="true"
      />
    );
  }

  if (icon === 'none') return null;

  let glyph: React.ReactNode;
  let glyphClass: string;
  let plateClass: string;

  if (icon === 'brokenImage') {
    glyph = <ImageBroken size={26} aria-hidden="true" />;
    glyphClass = 'text-muted-foreground';
    plateClass = 'bg-muted/70';
  } else if (icon === 'file') {
    glyph = <FileText size={26} aria-hidden="true" />;
    glyphClass = 'text-muted-foreground';
    plateClass = 'bg-muted/70';
  } else if (tone === 'warning') {
    glyph = <WarningCircle size={26} aria-hidden="true" />;
    glyphClass = 'text-warning';
    plateClass = 'bg-warning/10';
  } else {
    glyph = <WarningCircle size={26} aria-hidden="true" />;
    glyphClass = 'text-destructive';
    plateClass = 'bg-destructive/10';
  }

  return (
    <div
      className={cn(
        'flex h-14 w-14 items-center justify-center rounded-full',
        plateClass,
        glyphClass,
      )}
    >
      {glyph}
    </div>
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
  delayMs,
}) => {
  const resolvedIcon = icon ?? defaultIconForTone(tone);
  const role = tone === 'loading' ? 'status' : tone === 'error' ? 'alert' : 'note';

  const useDelay = tone === 'loading' && typeof delayMs === 'number' && delayMs > 0;
  const [delayElapsed, setDelayElapsed] = React.useState(!useDelay);

  React.useEffect(() => {
    if (!useDelay) {
      setDelayElapsed(true);
      return;
    }
    setDelayElapsed(false);
    const timer = window.setTimeout(() => setDelayElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [useDelay, delayMs]);

  // 延迟期内保持等高空容器，避免 spinner 出现/消失引起布局跳动
  if (!delayElapsed) {
    return (
      <div
        className={cn('h-full', className)}
        role="status"
        aria-label={title}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center h-full gap-3 px-4 py-6 text-center',
        tone === 'loading' ? 'ui-fade-in' : 'ui-rise-in',
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
          <p className="text-xs text-muted-foreground/80 break-all">
            {meta}
          </p>
        )}
      </div>
      {children}
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
          {actions.map((action) => (
            <DsButton
              key={action.id}
              variant={action.variant ?? (action.id === 'retry' ? 'ghost' : 'default')}
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled || action.loading}
              className="gap-1.5 [@media(pointer:coarse)]:!min-h-11"
            >
              {action.loading && (
                <CircleNotch className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {action.label}
            </DsButton>
          ))}
        </div>
      )}
    </div>
  );
};

export default PreviewStatus;
