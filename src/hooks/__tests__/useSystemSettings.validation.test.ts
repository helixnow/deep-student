/**
 * useSystemSettings.validateSettings i18n 合同测试
 *
 * 校验失败文案必须来自 forms:system_validation.* 命名空间（随当前语言解析），
 * 而不是源码里的中文硬编码。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// mock 掉真实 i18n 初始化；t(key) 原样返回 key，便于断言 hook 引用了 forms 命名空间
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

import { useSystemSettings } from '../useSystemSettings';
import zhForms from '@/locales/zh-CN/forms.json';
import enForms from '@/locales/en-US/forms.json';

const VALIDATION_KEYS = {
  maxChatHistory: 'forms:system_validation.max_chat_history',
  theme: 'forms:system_validation.theme',
  language: 'forms:system_validation.language',
  markdownRendererMode: 'forms:system_validation.markdown_renderer_mode',
} as const;

const renderValidateSettings = () => {
  const { result, unmount } = renderHook(() => useSystemSettings());
  return { validateSettings: result.current.validateSettings, unmount };
};

describe('useSystemSettings.validateSettings i18n', () => {
  it('returns the forms i18n key (not hardcoded Chinese) for out-of-range maxChatHistory', () => {
    const { validateSettings, unmount } = renderValidateSettings();

    expect(validateSettings({ maxChatHistory: 5 })).toEqual([VALIDATION_KEYS.maxChatHistory]);
    expect(validateSettings({ maxChatHistory: 2000 })).toEqual([VALIDATION_KEYS.maxChatHistory]);
    // 边界值合法
    expect(validateSettings({ maxChatHistory: 10 })).toEqual([]);
    expect(validateSettings({ maxChatHistory: 1000 })).toEqual([]);

    unmount();
  });

  it('returns the forms i18n key for an unsupported theme', () => {
    const { validateSettings, unmount } = renderValidateSettings();

    expect(validateSettings({ theme: 'neon' })).toEqual([VALIDATION_KEYS.theme]);
    for (const theme of ['light', 'dark', 'auto']) {
      expect(validateSettings({ theme })).toEqual([]);
    }

    unmount();
  });

  it('returns the forms i18n keys for unsupported language / markdown renderer mode', () => {
    const { validateSettings, unmount } = renderValidateSettings();

    expect(validateSettings({ language: 'fr-FR' })).toEqual([VALIDATION_KEYS.language]);
    expect(
      validateSettings({ markdownRendererMode: 'fancy' as unknown as 'legacy' }),
    ).toEqual([VALIDATION_KEYS.markdownRendererMode]);

    unmount();
  });

  it('accumulates all errors and never emits source-hardcoded text', () => {
    const { validateSettings, unmount } = renderValidateSettings();

    const errors = validateSettings({
      maxChatHistory: 0,
      theme: 'sepia',
      language: 'ja-JP',
      markdownRendererMode: 'fancy' as unknown as 'enhanced',
    });

    expect(errors).toEqual([
      VALIDATION_KEYS.maxChatHistory,
      VALIDATION_KEYS.theme,
      VALIDATION_KEYS.language,
      VALIDATION_KEYS.markdownRendererMode,
    ]);
    // key-echo mock 下若源码仍硬编码中文会在这里泄漏
    expect(errors.join('')).not.toMatch(/必须/);

    unmount();
  });

  it('has zh-CN and en-US translations for every validation key', () => {
    const zh = (zhForms as Record<string, Record<string, string>>).system_validation;
    const en = (enForms as Record<string, Record<string, string>>).system_validation;

    for (const fullKey of Object.values(VALIDATION_KEYS)) {
      const leaf = fullKey.replace('forms:system_validation.', '');
      expect(zh?.[leaf], `zh-CN forms.json missing system_validation.${leaf}`).toBeTruthy();
      expect(en?.[leaf], `en-US forms.json missing system_validation.${leaf}`).toBeTruthy();
      expect(zh[leaf]).not.toBe(en[leaf]);
    }

    // 语义抽查：范围与枚举值保持不变（10–1000 / light|dark|auto / zh-CN|en-US / legacy|enhanced）
    expect(zh.max_chat_history).toMatch(/10-1000/);
    expect(en.max_chat_history).toMatch(/10 and 1000/);
    expect(en.theme).toMatch(/light, dark, or auto/);
    expect(en.language).toMatch(/zh-CN or en-US/);
    expect(en.markdown_renderer_mode).toMatch(/legacy or enhanced/);
  });
});
