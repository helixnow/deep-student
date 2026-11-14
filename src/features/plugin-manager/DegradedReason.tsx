import { useTranslation } from 'react-i18next';
import { ShieldWarning, WarningCircle } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import { degradeCodeLabel, parsePluginReason } from './reasons';
import type { PluginUiDegradedInfo } from './ui-status';

export interface DegradedReasonProps {
  /** Host 报告的原始降级原因，形如 `<CODE>: <detail>` 或既有自由文本。 */
  reason?: string;
  /**
   * W17 `hostStatus.degraded()` 的结构化结果；提供时优先使用（含 `CONSENT_REQUIRED` 与
   * `consentRequired` 语义），不再本地二次解析。
   */
  info?: PluginUiDegradedInfo;
  className?: string;
}

/**
 * 降级原因：错误码走本地化文案，后半段原文始终保留，便于排查。
 * 没有错误码的既有原因（缺服务、apply 抛错）只显示原文，不冒充结构化错误。
 */
export function DegradedReason({ reason, info, className }: DegradedReasonProps) {
  const { t } = useTranslation('plugin_manager');
  const parsed = info ?? parsePluginReason(reason ?? '');
  const code = parsed.code;
  const label = degradeCodeLabel(t, code);
  const consentRequired = info?.consentRequired === true;
  const Icon = consentRequired ? ShieldWarning : WarningCircle;

  return (
    <div
      data-testid="plugin-degraded"
      data-code={code ?? 'unclassified'}
      data-consent-required={consentRequired ? 'true' : undefined}
      className={cn('flex items-start gap-1.5 text-xs leading-relaxed', consentRequired ? 'text-warning' : 'text-destructive', className)}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">
          {t('degraded.title')}
          {label ? `：${label}` : ''}
        </div>
        <div className="break-words text-muted-foreground">
          {code ? (
            <>
              <span className="sr-only">{t('degraded.detail')}</span>
              {parsed.detail || t('degraded.noCode')}
            </>
          ) : (
            parsed.detail
          )}
        </div>
      </div>
    </div>
  );
}
