/**
 * ACR userPatch 摘要 — R2-06
 * 暂停/中止回执附带用户改动概述（Devin 协议）；各 driver 可注册 diff 回调，缺省文案见 DEFAULT_USER_PATCH。
 * 见 docs/dev/acr/DESIGN.md §4.1 / ROUND2.md R2-06。
 */
import i18n from '@/i18n';
import type { AcrReceipt } from './types';

/** 缺省：无法采集具体 diff 时的 LLM 可读摘要 */
export const DEFAULT_USER_PATCH = '用户进行了手动编辑';

export type UserPatchSummarizer = () => string | null | undefined;

const summarizers = new Map<string, UserPatchSummarizer>();

/** 各 driver 在 register 时挂载；返回空则回落缺省文案 */
export function registerUserPatchSummarizer(
  typeId: string,
  fn: UserPatchSummarizer,
): void {
  summarizers.set(typeId, fn);
}

export function clearUserPatchSummarizersForTests(): void {
  summarizers.clear();
}

/** 生成 userPatch；回调抛错或空串 → 缺省文案 */
export function summarizeUserPatch(typeId: string): string {
  const fn = summarizers.get(typeId);
  if (fn) {
    try {
      const text = fn();
      if (typeof text === 'string' && text.trim()) return text.trim();
    } catch {
      /* 回落缺省 */
    }
  }
  return i18n.t('dstu:agent.user_patch.default', {
    defaultValue: DEFAULT_USER_PATCH,
  });
}

/**
 * 用户中止 / 仲裁 abort 路径：确保 partial|cancelled 带回执带 userPatch。
 * 已有非空 userPatch 时不覆盖。
 */
export function withUserPatch(receipt: AcrReceipt, typeId: string): AcrReceipt {
  if (receipt.status !== 'partial' && receipt.status !== 'cancelled') {
    return receipt;
  }
  if (receipt.userPatch && receipt.userPatch.trim()) {
    return receipt;
  }
  return { ...receipt, userPatch: summarizeUserPatch(typeId) };
}
