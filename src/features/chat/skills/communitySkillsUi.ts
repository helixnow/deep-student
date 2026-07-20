/**
 * SkillMarket / SkillTap UI 状态机与展示辅助。
 *
 * 搜索结果必须区分 empty / rate-limit / network-error / success，
 * 不得把「无匹配」复用 error 通道（避免 role=alert 误报）。
 *
 * outdated（上游版本漂移）与 trust（本地信任）是正交概念，展示不得互相暗示。
 */

import type { SkillMarketSkillCard, SkillUpdateCheckResult } from './api';

/** SkillMarket 列表区 UI 状态（不含 loading 过程中的瞬时态时可由调用方叠加） */
export type SkillMarketListUiStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'empty'
  | 'rate_limited'
  | 'network_error';

export type SkillMarketSearchFailureKind = 'rate_limited' | 'network_error';

/**
 * 将 invoke / 网络异常归类为限流或网络错误（其余一律按网络错误展示）。
 * 保持 hermetic：只看错误字符串，不发起网络请求。
 */
export function classifySkillMarketSearchError(err: unknown): SkillMarketSearchFailureKind {
  const msg = String(err ?? '');
  if (msg.includes('RATE_LIMITED') || /rate\s*limit/i.test(msg)) {
    return 'rate_limited';
  }
  return 'network_error';
}

/** 成功响应 → success 或 empty（空列表不是错误）。 */
export function resolveSkillMarketSearchSuccess(
  items: readonly SkillMarketSkillCard[],
): 'success' | 'empty' {
  return items.length === 0 ? 'empty' : 'success';
}

/**
 * 可应用的上游更新：必须 checkable、有更新、且无 error。
 * error 行（含 RATE_LIMITED）不得被当成 outdated。
 */
export function selectAvailableSkillUpdates(
  results: readonly SkillUpdateCheckResult[],
): SkillUpdateCheckResult[] {
  return results.filter((r) => r.checkable && r.updateAvailable && !r.error);
}

/**
 * 更新漂移文案：skill_market 用完整 version；url/tap 用 sha256 短前缀。
 * 避免把 version 字段误展示成「截断哈希」。
 */
export function formatSkillUpdateDrift(item: SkillUpdateCheckResult): string {
  if (item.sourceKind === 'skill_market') {
    const current = (item.currentVersion ?? '').trim() || '?';
    const remote = (item.remoteVersion ?? '').trim() || '?';
    return `${current} → ${remote}`;
  }
  const current = item.currentSha256 ? item.currentSha256.slice(0, 12) : '?';
  const remote = item.remoteSha256 ? item.remoteSha256.slice(0, 12) : '?';
  return `${current} → ${remote}`;
}

/** outdated 与 trust 正交：有更新 ≠ 未信任，未信任 ≠ 有更新。 */
export function isOutdatedUpdateRow(item: SkillUpdateCheckResult): boolean {
  return Boolean(item.checkable && item.updateAvailable && !item.error);
}
