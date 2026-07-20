import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  CircleNotch,
  Clock,
  MinusCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

type PillTone = 'success' | 'destructive' | 'primary' | 'muted' | 'mutedStrike';

const STATUS_TONE: Record<string, PillTone> = {
  success: 'success',
  heartbeat_ok: 'success',
  error: 'destructive',
  timeout: 'destructive',
  spawn_error: 'destructive',
  running: 'primary',
  retrying: 'primary',
  queued: 'muted',
  cancelled: 'mutedStrike',
  skipped: 'mutedStrike',
};

const TONE_CLASS: Record<PillTone, string> = {
  success: 'text-success bg-success/10',
  destructive: 'text-destructive bg-destructive/10',
  primary: 'text-primary bg-primary/10',
  muted: 'text-muted-foreground bg-muted/60',
  mutedStrike: 'text-muted-foreground bg-muted/40 line-through decoration-muted-foreground/60',
};

function StatusIcon({ status, iconSize }: { status: string; iconSize: number }) {
  switch (status) {
    case 'success':
    case 'heartbeat_ok':
      return <CheckCircle size={iconSize} weight="fill" aria-hidden />;
    case 'error':
    case 'timeout':
    case 'spawn_error':
      return <WarningCircle size={iconSize} weight="fill" aria-hidden />;
    case 'running':
    case 'retrying':
      return <CircleNotch size={iconSize} className="animate-spin motion-reduce:animate-none" aria-hidden />;
    case 'queued':
      return <Clock size={iconSize} aria-hidden />;
    case 'cancelled':
    case 'skipped':
      return <MinusCircle size={iconSize} aria-hidden />;
    default:
      return <Clock size={iconSize} aria-hidden />;
  }
}

export interface AutomationStatusPillProps {
  /** AutomationRun.status（queued|running|retrying|success|error|timeout|heartbeat_ok|spawn_error|cancelled|skipped） */
  status: string;
  size?: 'sm' | 'md';
}

/**
 * 定时任务运行状态徽标：小圆角 pill，色系随状态语义。
 * 文案走 i18n `todo:automation.status.{status}`，未知状态回退到 `automation.status.unknown`。
 */
export function AutomationStatusPill({ status, size = 'md' }: AutomationStatusPillProps): JSX.Element {
  const { t } = useTranslation(['todo']);
  const tone = STATUS_TONE[status] ?? 'muted';
  const iconSize = size === 'sm' ? 11 : 13;
  const label = t(`todo:automation.status.${status}`, {
    defaultValue: t('todo:automation.status.unknown', { defaultValue: status }),
  });

  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full font-medium tabular-nums',
        'transition-colors duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]',
        size === 'sm' ? 'px-1.5 py-px text-xs leading-4' : 'px-2 py-0.5 text-xs leading-5',
        TONE_CLASS[tone],
      )}
    >
      <StatusIcon status={status} iconSize={iconSize} />
      {label}
    </span>
  );
}

export default AutomationStatusPill;
