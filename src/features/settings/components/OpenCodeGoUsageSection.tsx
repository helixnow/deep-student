/**
 * OpenCodeGoUsageSection - OpenCode Go 订阅用量（5 小时 / 周 / 月窗口）
 * 仅对 OpenCode Go 供应商渲染（调用方用 isOpenCodeGoVendor 判断）。
 * 连接区展开时自动查询一次；后续仅手动刷新。另外常驻说明「仅用于 Agent 对话」。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Info, Spinner, WarningCircle } from '@phosphor-icons/react';
import type { VendorConfig } from '@/types';
import { DsButton } from '@/components/ui/DsButton';
import {
  fetchOpenCodeGoUsage,
  type OpenCodeGoUsage,
} from '@/utils/opencodeGo';

type UsageUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: OpenCodeGoUsage }
  | { status: 'error'; detail: string };

interface OpenCodeGoUsageSectionProps {
  vendor: VendorConfig;
  /** 供应商详情是否处于活动状态：活动时自动查询一次 */
  active: boolean;
  /** 注入式查询，便于测试；默认调用后端命令 */
  fetcher?: (vendorId: string) => Promise<OpenCodeGoUsage>;
}

const WINDOW_KEYS: Record<string, string> = {
  five_hour: 'settings:vendor_panel.opencode_go.window_five_hour',
  weekly: 'settings:vendor_panel.opencode_go.window_weekly',
  monthly: 'settings:vendor_panel.opencode_go.window_monthly',
};

const formatReset = (resetsAtMs: number | null | undefined): string | null => {
  if (!resetsAtMs || !Number.isFinite(resetsAtMs)) return null;
  const date = new Date(resetsAtMs);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const OpenCodeGoUsageSection: React.FC<OpenCodeGoUsageSectionProps> = ({
  vendor,
  active,
  fetcher = fetchOpenCodeGoUsage,
}) => {
  const { t } = useTranslation(['settings']);
  const [state, setState] = useState<UsageUiState>({ status: 'idle' });
  const autoQueriedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const query = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await fetcher(vendor.id);
      if (!mountedRef.current) return;
      setState({ status: 'success', data });
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setState({ status: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }, [vendor.id, fetcher]);

  useEffect(() => {
    if (!active || autoQueriedRef.current) return;
    if (state.status !== 'idle') return;
    autoQueriedRef.current = true;
    void query();
  }, [active, query, state.status]);

  return (
    <div className="space-y-1.5" data-testid="opencode-go-usage">
      <div className="flex items-start gap-1.5 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('settings:vendor_panel.opencode_go.agent_only_notice')}</span>
      </div>
      {state.status !== 'idle' && (
        <div className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/50 bg-muted/30 py-0.5 pl-1.5 pr-0.5 text-xs text-muted-foreground">
          {state.status === 'loading' && (
            <Spinner className="h-3.5 w-3.5 animate-spin" aria-label={t('settings:vendor_panel.opencode_go.usage_loading')} />
          )}
          {state.status === 'success' &&
            state.data.windows.map((window) => {
              const reset = formatReset(window.resetsAtMs);
              return (
                <span key={window.window} className="inline-flex items-center gap-1 tabular-nums" data-testid={`opencode-go-usage-${window.window}`}>
                  <span>{t(WINDOW_KEYS[window.window] ?? window.window, { defaultValue: window.window })}</span>
                  <span className="font-medium text-primary">{Math.round(window.usedPercent)}%</span>
                  {reset && (
                    <span className="text-muted-foreground/70">
                      {t('settings:vendor_panel.opencode_go.resets_at', { time: reset })}
                    </span>
                  )}
                </span>
              );
            })}
          {state.status === 'error' && (
            <span className="inline-flex min-w-0 items-center gap-1 text-destructive" title={state.detail}>
              <WarningCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{state.detail || t('settings:vendor_panel.opencode_go.usage_failed')}</span>
            </span>
          )}
          <DsButton
            size="sm"
            variant="ghost"
            iconOnly
            className="h-5 w-5 shrink-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            onClick={() => void query()}
            disabled={state.status === 'loading'}
            title={t('settings:vendor_panel.opencode_go.usage_refresh')}
            aria-label={t('settings:vendor_panel.opencode_go.usage_refresh')}
          >
            <ArrowClockwise className={state.status === 'loading' ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
          </DsButton>
        </div>
      )}
    </div>
  );
};
