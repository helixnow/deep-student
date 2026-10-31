/**
 * OpenCode Go 订阅（https://opencode.ai/docs/go/）。
 *
 * 遵守 OpenCode 官方规则，OpenCode Go 只用于 Agent 对话。后端在请求准备处强制拦截
 * （`src-tauri/crates/dstu-llm/src/llm_manager/opencode_go.rs`）；前端据此把 Go 模型从非对话功能的
 * 模型选择器中隐藏，避免用户选到必然失败的模型。判定规则与后端保持一致。
 */

import { tauriInvoke } from '@/api/tauriClient';

export const OPENCODE_GO_VENDOR_ID = 'builtin-opencode-go';
export const OPENCODE_GO_PROVIDER_TYPE = 'opencode_go';

export interface OpenCodeGoConfigLike {
  vendorId?: string | null;
  providerType?: string | null;
  baseUrl?: string | null;
}

const isGoRootUrl = (baseUrl?: string | null): boolean => {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl.trim());
    if (url.hostname.toLowerCase() !== 'opencode.ai') return false;
    const path = url.pathname.replace(/\/+$/, '');
    return path.startsWith('/inference/go') || path.startsWith('/zen/go');
  } catch {
    return false;
  }
};

/** 供应商 ID、供应商类型或端点任一指向 OpenCode Go。 */
export function isOpenCodeGoConfig(config: OpenCodeGoConfigLike | null | undefined): boolean {
  if (!config) return false;
  return (
    config.vendorId === OPENCODE_GO_VENDOR_ID ||
    (config.providerType ?? '').toLowerCase() === OPENCODE_GO_PROVIDER_TYPE ||
    isGoRootUrl(config.baseUrl)
  );
}

/** 供应商本身是否为 OpenCode Go（供应商对象的 id 即 vendorId）。 */
export function isOpenCodeGoVendor(vendor: { id: string; providerType?: string | null; baseUrl?: string | null } | null | undefined): boolean {
  if (!vendor) return false;
  return isOpenCodeGoConfig({ vendorId: vendor.id, providerType: vendor.providerType, baseUrl: vendor.baseUrl });
}

/** 非 Agent 对话功能的模型候选：去掉 OpenCode Go 模型。 */
export function excludeOpenCodeGo<T extends OpenCodeGoConfigLike>(configs: readonly T[]): T[] {
  return configs.filter((config) => !isOpenCodeGoConfig(config));
}

export type OpenCodeGoUsageWindowKey = 'five_hour' | 'weekly' | 'monthly';

export interface OpenCodeGoUsageWindow {
  window: OpenCodeGoUsageWindowKey | string;
  usedPercent: number;
  resetsAtMs?: number | null;
}

export interface OpenCodeGoUsage {
  windows: OpenCodeGoUsageWindow[];
}

/** 查询订阅用量（后端调用公开的 `/zen/go/v1/usage`）。 */
export function fetchOpenCodeGoUsage(vendorId: string): Promise<OpenCodeGoUsage> {
  return tauriInvoke<OpenCodeGoUsage>('opencode_go_get_usage', { vendorId }, { silent: true });
}
