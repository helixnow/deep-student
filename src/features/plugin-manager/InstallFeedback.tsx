// RUST-FIX(RF-W35-offline-package-feedback): Rust 版插件页只有固定字段的启停/登录，没有离线包安装结果与回滚提示。
import { useTranslation } from 'react-i18next';
import { CheckCircle, ArrowCounterClockwise, XCircle } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';

import type { PluginPackageResult } from './types';

export interface InstallFeedbackProps {
  result: PluginPackageResult;
  onDismiss?: () => void;
  className?: string;
}

const tone = {
  installed: 'border-success/30 bg-success/10 text-success',
  'rolled-back': 'border-warning/30 bg-warning/10 text-warning',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

/** 离线 `.dsplugin` 安装反馈：成功、已回滚、被拒绝三种结果分开表述，回滚状态原样展示。 */
export function InstallFeedback({ result, onDismiss, className }: InstallFeedbackProps) {
  const { t } = useTranslation('plugin_manager');
  const Icon = result.status === 'installed' ? CheckCircle : result.status === 'rolled-back' ? ArrowCounterClockwise : XCircle;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="plugin-install-feedback"
      data-status={result.status}
      className={cn('rounded-lg border p-3 text-sm', tone[result.status], className)}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1 break-words">
          {result.status === 'installed' ? (
            <>
              <div className="font-medium">{t('install.installed.title', { id: result.id, version: result.version })}</div>
              <div className="text-muted-foreground">
                {result.previousVersion
                  ? t('install.installed.upgrade', { previous: result.previousVersion })
                  : t('install.installed.fresh')}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('install.installed.diskOnly')}</p>
            </>
          ) : null}
          {result.status === 'rolled-back' ? (
            <>
              <div className="font-medium">{t('install.rolledBack.title')}</div>
              <div className="text-muted-foreground">
                {result.previousVersion
                  ? t('install.rolledBack.toPrevious', { previous: result.previousVersion })
                  : t('install.rolledBack.noPrevious')}
              </div>
              <div className="break-words text-xs">{t('install.rolledBack.reason', { reason: result.reason })}</div>
            </>
          ) : null}
          {result.status === 'rejected' ? (
            <>
              <div className="font-medium">{t('install.rejected.title', { code: result.code })}</div>
              <div className="break-words text-xs">{t('install.rejected.detail', { detail: result.detail })}</div>
              <div
                data-testid="plugin-install-rollback"
                data-rollback={result.rollback}
                className={cn(
                  'text-xs',
                   result.rollback === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {t(`install.rollback.${result.rollback}`)}
              </div>
            </>
          ) : null}
        </div>
        {onDismiss ? (
          <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onDismiss} aria-label={t('actions.dismiss')}>
            {t('actions.dismiss')}
          </DsButton>
        ) : null}
      </div>
    </div>
  );
}
