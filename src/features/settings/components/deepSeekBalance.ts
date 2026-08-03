/**
 * deepSeekBalance - DeepSeek 官方账户余额查询（纯逻辑，无 React 依赖）
 *
 * 官方余额接口：GET https://api.deepseek.com/user/balance，Bearer 认证。
 * 返回 balance_infos[0].total_balance / currency。
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { VendorConfig } from '@/types';
import { resolveApiKey } from './vendorModelService';

export const DEEPSEEK_OFFICIAL_HOST = 'api.deepseek.com';
export const DEEPSEEK_BALANCE_URL = `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`;

export interface DeepSeekBalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: DeepSeekBalanceInfo[];
}

export interface DeepSeekBalanceResult {
  balance: string;
  currency: string;
  fetchedAt: number;
}

/**
 * 仅 DeepSeek 官方供应商启用余额查询：
 * providerType=deepseek，且 baseUrl 指向官方域名（内置供应商放行）。
 */
export function isOfficialDeepSeekVendor(vendor: VendorConfig): boolean {
  if ((vendor.providerType ?? '').toLowerCase() !== 'deepseek') return false;
  if (vendor.isBuiltin || vendor.id.startsWith('builtin-')) return true;
  try {
    const host = new URL(vendor.baseUrl.trim()).hostname.toLowerCase();
    return host === DEEPSEEK_OFFICIAL_HOST || host.endsWith(`.${DEEPSEEK_OFFICIAL_HOST}`);
  } catch {
    return false;
  }
}

/** 官方余额接口不使用供应商的 OpenAI-compatible `/v1` 基础地址。 */
export function buildDeepSeekBalanceUrl(): string {
  return DEEPSEEK_BALANCE_URL;
}

/**
 * 查询余额。fetcher 可注入以便测试；默认走 Tauri HTTP 插件（绕过 CORS）。
 */
export async function queryDeepSeekBalance(
  vendor: VendorConfig,
  fetcher: typeof fetch = tauriFetch as unknown as typeof fetch,
): Promise<DeepSeekBalanceResult> {
  const key = await resolveApiKey(vendor);
  if (!key) {
    throw new Error('no_api_key');
  }

  const response = await fetcher(buildDeepSeekBalanceUrl(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('unauthorized');
  }
  if (!response.ok) {
    throw new Error('fetch_failed');
  }

  const data = (await response.json()) as DeepSeekBalanceResponse;
  const info = data.balance_infos?.[0];
  if (!info) {
    throw new Error('no_balance_info');
  }

  return {
    balance: info.total_balance,
    currency: info.currency,
    fetchedAt: Date.now(),
  };
}

export type BalanceAgeKey = 'just_now' | 'minutes_ago' | 'hours_ago' | 'days_ago';

/** 将最近一次查询时间格式化为 i18n 相对时间键（组件层负责翻译）。 */
export function formatBalanceFetchedAt(
  fetchedAt: number,
  now: number = Date.now(),
): { key: BalanceAgeKey; count: number } {
  const elapsedMs = Math.max(0, now - fetchedAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return { key: 'just_now', count: 0 };
  if (minutes < 60) return { key: 'minutes_ago', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'hours_ago', count: hours };
  return { key: 'days_ago', count: Math.floor(hours / 24) };
}
