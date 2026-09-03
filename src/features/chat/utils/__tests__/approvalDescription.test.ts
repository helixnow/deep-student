import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '@/locales/en-US/chatV2.json';
import zh from '@/locales/zh-CN/chatV2.json';
import { getLocalizedApprovalDescription } from '../approvalDescription';

function translator(locale: typeof en): TFunction {
  return ((key: string, options?: Record<string, unknown>) => {
    const raw = key.split('.').reduce<unknown>(
      (value, segment) => (
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[segment]
          : undefined
      ),
      locale,
    );
    if (typeof raw !== 'string') {
      return String(options?.defaultValue ?? key);
    }
    return raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      String(options?.[name] ?? ''));
  }) as unknown as TFunction;
}

describe('localized approval descriptions', () => {
  it('keeps English and Chinese approval description keys in parity', () => {
    expect(Object.keys(en.approval.descriptions).sort()).toEqual(
      Object.keys(zh.approval.descriptions).sort(),
    );
  });

  it('does not expose the Chinese backend fallback in an English UI', () => {
    const description = getLocalizedApprovalDescription(
      'builtin-skill_set_enabled',
      { skill_id: 'pdf-tools', enabled: false },
      '将停用技能: pdf-tools',
      translator(en),
    );

    expect(description).toContain('disable skill');
    expect(description).toContain('pdf-tools');
    expect(description).not.toContain('停用');
  });

  it('uses the same structured tool arguments for Chinese copy', () => {
    const description = getLocalizedApprovalDescription(
      'builtin-local_shell_execute',
      { command: 'git status' },
      'legacy fallback',
      translator(zh as typeof en),
    );

    expect(description).toBe('将执行命令：git status');
  });

  it('supports the legacy builtin colon prefix', () => {
    expect(getLocalizedApprovalDescription(
      'builtin:note_set',
      { noteId: 'n1' },
      'legacy fallback',
      translator(en),
    )).toContain('note n1');
  });

  it('retains the backend description when a locale key is unavailable', () => {
    const fallbackOnly = ((_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? '')) as unknown as TFunction;

    expect(getLocalizedApprovalDescription(
      'note_set',
      { noteId: 'n1' },
      'legacy backend description',
      fallbackOnly,
    )).toBe('legacy backend description');
  });

  it('describes model_profile_add without leaking the api key', () => {
    const withUrl = getLocalizedApprovalDescription(
      'builtin-model_profile_add',
      { model: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1', api_key: '<redacted>' },
      'fallback',
      translator(zh as typeof en),
    );
    expect(withUrl).toContain('deepseek-chat');
    expect(withUrl).toContain('api.deepseek.com');
    expect(withUrl).not.toContain('sk-');

    const existingVendor = getLocalizedApprovalDescription(
      'builtin-model_profile_add',
      { model: 'gpt-4o', vendor_id: 'builtin-openai' },
      'fallback',
      translator(en),
    );
    expect(existingVendor).toContain('gpt-4o');
    expect(existingVendor).toContain('existing vendor');
  });
});
