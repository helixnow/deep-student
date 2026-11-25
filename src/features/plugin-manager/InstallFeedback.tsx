// RUST-FIX(RF-W35-offline-package-feedback): Rust 版插件页只有固定字段的启停/登录，没有离线包安装结果与回滚提示。
import { useTranslation } from 'react-i18next';
import { CheckCircle, ArrowCounterClockwise, XCircle } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';

import { describeManagerError, resolveManagerErrorCode } from './reasons';
import type { PluginPackageResult } from './types';

export interface InstallFeedbackProps {
  result: PluginPackageResult;
  safeMode?: boolean;
  onDismiss?: () => void;
  className?: string;
}

const tone = {
  installed: 'border-success/30 bg-success/10 text-success',
  'rolled-back': 'border-warning/30 bg-warning/10 text-warning',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
} as const;

/** 离线 `.dsplugin` 安装反馈：成功、已回滚、被拒绝三种结果分开表述，回滚状态原样展示。 */
export function InstallFeedback({ result, safeMode = false, onDismiss, className }: InstallFeedbackProps) {
  const { t } = useTranslation('plugin_manager');
  const Icon = result.status === 'installed' ? CheckCircle : result.status === 'rolled-back' ? ArrowCounterClockwise : XCircle;

  const isRejected = result.status === 'rejected';

  return (
    <div
      role={isRejected ? 'alert' : 'status'}
      aria-live={isRejected ? 'assertive' : 'polite'}
      data-testid="plugin-install-feedback"
      data-status={result.status}
      data-safe-mode={safeMode ? 'true' : undefined}
      className={cn(
        'rounded-lg border p-3 text-sm',
        result.status === 'installed' && safeMode ? tone['rolled-back'] : tone[result.status],
        className,
      )}
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
              {safeMode ? (
                <p data-testid="plugin-install-safe-mode-quarantined" className="text-xs font-medium leading-relaxed text-foreground/90">
                  {t('install.installed.safeModeQuarantined')}
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-muted-foreground">{t('install.installed.diskOnly')}</p>
              )}
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
          {result.status === 'rejected' ? (() => {
            const effectiveCode = resolveManagerErrorCode(result.code, result.detail);
            const friendly = describeManagerError(t, result.code, result.detail);
            return (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t('install.rejected.title')}</span>
                  <span
                    data-testid="plugin-install-diagnostic-category"
                    data-category={friendly.category}
                    className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-medium text-destructive"
                  >
                    {t(`install.rejected.categories.${friendly.category}`)}
                  </span>
                </div>
                <p data-testid="plugin-install-diagnostic-explanation" className="text-xs leading-relaxed text-foreground/90">
                  {friendly.explanation}
                </p>
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
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none hover:text-foreground">
                    {effectiveCode === 'PLUGIN_INSTALL_FAILED'
                      ? t('install.rejected.technicalGeneric')
                      : t('install.rejected.technical', { code: effectiveCode })}
                  </summary>
                  <p className="mt-1 break-words font-mono text-[11px] opacity-85">{friendly.technical}</p>
                </details>
              </>
            );
          })() : null}
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
