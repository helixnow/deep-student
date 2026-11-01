/**
 * OpenCodeGoPlanQuotaSection - OpenCode Go 套餐档位与各模型额度
 *
 * 用户选择自己的套餐（Go / Go Plus / Go Teams），列出各模型的月额度与官方预估请求数，
 * 帮助挑选性价比高的模型。数据为随版本发布的静态表（官方无公开接口），注明核对日期与来源。
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { cn } from '@/lib/utils';
import {
  formatRequestCount,
  getOpenCodeGoModelQuota,
  OPENCODE_GO_PLAN_MODELS,
  OPENCODE_GO_PLANS,
  OPENCODE_GO_PLANS_SOURCE,
  OPENCODE_GO_PLANS_VERIFIED_AT,
  useOpenCodeGoPlan,
  type OpenCodeGoPlanId,
} from '@/utils/opencodeGoPlans';

interface OpenCodeGoPlanQuotaSectionProps {
  /** 该供应商下已配置的模型 ID（`model` 字段），用于标记「已添加」并默认只列出它们 */
  configuredModelIds: string[];
}

export const OpenCodeGoPlanQuotaSection: React.FC<OpenCodeGoPlanQuotaSectionProps> = ({ configuredModelIds }) => {
  const { t, i18n } = useTranslation(['settings']);
  const [plan, setPlan] = useOpenCodeGoPlan();
  const [showAll, setShowAll] = useState(false);

  const configured = useMemo(
    () => new Set(configuredModelIds.map((id) => id.trim().toLowerCase())),
    [configuredModelIds],
  );

  const rows = useMemo(() => {
    const all = OPENCODE_GO_PLAN_MODELS.map((model) => getOpenCodeGoModelQuota(model.id, plan)!)
      .filter(Boolean)
      .sort((a, b) => {
        // 免费型号排最后；其余按预估请求数（同等额度下能用多少次）从多到少
        if (a.free !== b.free) return a.free ? 1 : -1;
        return (b.estimatedRequests?.month ?? 0) - (a.estimatedRequests?.month ?? 0);
      });
    const visible = showAll ? all : all.filter((row) => configured.has(row.model.id.toLowerCase()));
    return { all, visible: visible.length > 0 ? visible : all };
  }, [plan, showAll, configured]);

  const locale = i18n?.language;

  return (
    <div className="space-y-2" data-testid="opencode-go-plan-quota">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('settings:vendor_panel.opencode_go.plan_label')}
        </span>
        <SegmentedControl<OpenCodeGoPlanId>
          ariaLabel={t('settings:vendor_panel.opencode_go.plan_label')}
          size="compact"
          value={plan}
          onValueChange={(value) => void setPlan(value)}
          options={OPENCODE_GO_PLANS.map((option) => ({
            value: option.id,
            label: option.name,
            title: t('settings:vendor_panel.opencode_go.plan_price', {
              price: option.price_usd_per_month,
              unit: option.per_member
                ? t('settings:vendor_panel.opencode_go.plan_unit_member')
                : t('settings:vendor_panel.opencode_go.plan_unit_month'),
            }),
          }))}
        />
      </div>

      <p className="text-xs text-muted-foreground">{t('settings:vendor_panel.opencode_go.quota_explain')}</p>

      <div className="overflow-x-auto rounded-md border border-border/50">
        <table className="w-full min-w-[420px] text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">{t('settings:vendor_panel.opencode_go.col_model')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('settings:vendor_panel.opencode_go.col_monthly_limit')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('settings:vendor_panel.opencode_go.col_requests_5h')}</th>
              <th className="px-2 py-1.5 text-right font-medium">{t('settings:vendor_panel.opencode_go.col_requests_month')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.visible.map((row) => {
              const isConfigured = configured.has(row.model.id.toLowerCase());
              return (
                <tr key={row.model.id} className="border-t border-border/40" data-testid={`opencode-go-quota-${row.model.id}`}>
                  <td className="px-2 py-1.5">
                    <span className={cn('font-medium', isConfigured ? 'text-foreground' : 'text-muted-foreground')}>
                      {row.model.name}
                    </span>
                    {row.model.training_permitted && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-warning" title={t('settings:vendor_panel.opencode_go.training_warning')}>
                        <WarningCircle className="h-3 w-3" aria-hidden="true" />
                        <span>{t('settings:vendor_panel.opencode_go.training_tag')}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {row.free ? t('settings:vendor_panel.opencode_go.free') : `$${row.monthlyLimitUsd}`}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {row.estimatedRequests ? formatRequestCount(row.estimatedRequests.five_hour, locale) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {row.estimatedRequests ? formatRequestCount(row.estimatedRequests.month, locale) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span>
          {t('settings:vendor_panel.opencode_go.data_source', { date: OPENCODE_GO_PLANS_VERIFIED_AT, source: OPENCODE_GO_PLANS_SOURCE })}
        </span>
        {rows.all.length !== rows.visible.length || showAll ? (
          <DsButton size="sm" variant="ghost" className="h-auto px-1 py-0 text-2xs text-primary hover:underline" onClick={() => setShowAll((value) => !value)}>
            {showAll
              ? t('settings:vendor_panel.opencode_go.show_configured')
              : t('settings:vendor_panel.opencode_go.show_all', { count: rows.all.length })}
          </DsButton>
        ) : null}
      </div>
    </div>
  );
};
