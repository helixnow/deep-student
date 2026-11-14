/**
 * DeepSeekBalanceSection - DeepSeek 官方账户余额查询
 * 仅对 providerType=deepseek 且 baseUrl 指向官方域名的供应商渲染
 * （调用方负责用 isOfficialDeepSeekVendor 判断）。
 * 连接区展开时和回到应用时自动查询。
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner, WarningCircle } from '@phosphor-icons/react';
import type { VendorConfig } from '@/types';
import {
  formatBalanceFetchedAt,
  queryDeepSeekBalance,
  type DeepSeekBalanceResult,
} from './deepSeekBalance';

type BalanceUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: DeepSeekBalanceResult }
  | { status: 'error'; errorKey: string };

const errorKeyOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'no_api_key') return 'settings:vendor_panel.balance_no_key';
  if (message === 'unauthorized') return 'settings:vendor_panel.balance_unauthorized';
  return 'settings:vendor_panel.balance_fetch_failed';
};

interface DeepSeekBalanceSectionProps {
  vendor: VendorConfig;
  /** 供应商详情是否处于活动状态：活动时自动查询一次 */
  active: boolean;
  /** 注入式 fetch，便于测试；默认走 Tauri HTTP 插件 */
  fetcher?: typeof fetch;
}

export const DeepSeekBalanceSection: React.FC<DeepSeekBalanceSectionProps> = ({
  vendor,
  active,
  fetcher,
}) => {
  const { t } = useTranslation(['settings']);
  const [state, setState] = useState<BalanceUiState>({ status: 'idle' });
  const autoQueriedRef = useRef(false);
  const vendorIdRef = useRef(vendor.id);
  const mountedRef = useRef(true);

  // 切换供应商时重置（含成功态：不展示上一个供应商的余额）
  useEffect(() => {
    if (vendorIdRef.current !== vendor.id) {
      vendorIdRef.current = vendor.id;
      autoQueriedRef.current = false;
      setState({ status: 'idle' });
    }
  }, [vendor.id]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const query = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await queryDeepSeekBalance(vendor, fetcher);
      if (!mountedRef.current) return;
      setState({ status: 'success', data });
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setState({ status: 'error', errorKey: errorKeyOf(error) });
    }
  }, [vendor, fetcher]);

  // 首次展开时查询，回到应用时重新查询。
  useEffect(() => {
    if (!active || autoQueriedRef.current) return;
    if (state.status !== 'idle') return;
    autoQueriedRef.current = true;
    void query();
  }, [active, query, state.status]);

  useRefreshOnReturn(query, active && state.status !== 'loading');

  if (state.status === 'idle') {
    return null;
  }

  const ageLabel = (fetchedAt: number): string => {
    const { key, count } = formatBalanceFetchedAt(fetchedAt);
    return t(`settings:vendor_panel.balance_${key}`, { count });
  };

  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/50 bg-muted/30 py-0.5 pl-1.5 pr-0.5 text-xs text-muted-foreground">
      {state.status === 'loading' && <Spinner className="h-3.5 w-3.5 animate-spin" aria-label={t('settings:vendor_panel.balance_loading')} />}
      {state.status === 'success' && (
        <span className="inline-flex min-w-0 items-center gap-1 tabular-nums" data-testid="deepseek-balance-value">
          <span>
            <span>{t('settings:vendor_panel.balance_remaining')}</span>{' '}
            <span className="font-medium text-primary">{state.data.currency === 'CNY' ? '¥' : `${state.data.currency} `}{state.data.balance}</span>
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span>{ageLabel(state.data.fetchedAt)}</span>
        </span>
      )}
      {state.status === 'error' && (
        <span className="inline-flex min-w-0 items-center gap-1 text-destructive">
          <WarningCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t(state.errorKey)}</span>
        </span>
      )}
    </span>
  );
};
