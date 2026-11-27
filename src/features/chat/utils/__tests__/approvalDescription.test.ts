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

  it('formats browser_click with coordinates when ref is absent instead of showing ?', () => {
    const coordOnlyZh = getLocalizedApprovalDescription(
      'builtin-browser_click',
      { x: 120, y: 340 },
      'fallback',
      translator(zh as typeof en),
    );
    expect(coordOnlyZh).toContain('120');
    expect(coordOnlyZh).toContain('340');
    expect(coordOnlyZh).not.toContain('?');

    const coordWithElementEn = getLocalizedApprovalDescription(
      'builtin-browser_click',
      { x: 42.5, y: 88, element: 'Chart canvas' },
      'fallback',
      translator(en),
    );
    expect(coordWithElementEn).toContain('Chart canvas');
    expect(coordWithElementEn).toContain('42.5');
    expect(coordWithElementEn).toContain('88');
    expect(coordWithElementEn).not.toContain('?');

    const refClickEn = getLocalizedApprovalDescription(
      'builtin-browser_click',
      { ref: 'e12', element: 'Submit' },
      'fallback',
      translator(en),
    );
    expect(refClickEn).toContain('Submit');
    expect(refClickEn).toContain('ref=e12');
  });

  it('formats all new browser interaction, extraction, tabs, observe, screenshot, and downloads tools', () => {
    const tZh = translator(zh as typeof en);
    const tEn = translator(en);

    // browser_hover (ref + coords)
    expect(getLocalizedApprovalDescription(
      'builtin-browser_hover',
      { ref: 'e4', element: 'Menu' },
      'fallback',
      tEn,
    )).toBe('Will hover over webpage element: Menu (ref=e4)');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_hover',
      { x: 200, y: 150 },
      'fallback',
      tZh,
    )).toBe('将悬停在网页坐标 (200, 150)');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_hover',
      { x: 200, y: 150, element: 'Tooltip trigger' },
      'fallback',
      tEn,
    )).toBe('Will hover over webpage element: Tooltip trigger (coords 200, 150)');

    // browser_press_key
    expect(getLocalizedApprovalDescription(
      'builtin-browser_press_key',
      { key: 'Enter' },
      'fallback',
      tEn,
    )).toBe('Will press key on webpage: Enter');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_press_key',
      { key: 'k', modifiers: ['Meta', 'Shift'] },
      'fallback',
      tZh,
    )).toBe('将在网页中按下组合键：Meta+Shift+k');

    // browser_select_option
    expect(getLocalizedApprovalDescription(
      'builtin-browser_select_option',
      { ref: 'e9', element: 'Country', values: ['CN', 'US'] },
      'fallback',
      tEn,
    )).toBe('Will select option(s) in Country (ref=e9): CN, US');

    // browser_wait_for
    expect(getLocalizedApprovalDescription(
      'builtin-browser_wait_for',
      { text: 'Results ready' },
      'fallback',
      tEn,
    )).toContain('Results ready');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_wait_for',
      { selector: '#main-table' },
      'fallback',
      tZh,
    )).toContain('#main-table');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_wait_for',
      { load_state: 'networkidle' },
      'fallback',
      tEn,
    )).toContain('networkidle');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_wait_for',
      {},
      'fallback',
      tZh,
    )).toBe('将等待网页条件就绪');

    // browser_extract_content
    expect(getLocalizedApprovalDescription(
      'builtin-browser_extract_content',
      {},
      'fallback',
      tEn,
    )).toContain('extract readable content');

    // browser_tabs
    expect(getLocalizedApprovalDescription(
      'builtin-browser_tabs',
      { action: 'new', url: 'https://example.com' },
      'fallback',
      tEn,
    )).toContain('https://example.com');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_tabs',
      { action: 'switch', tab_id: 'tab-2' },
      'fallback',
      tZh,
    )).toContain('tab-2');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_tabs',
      { action: 'close', tab_id: 'tab-3' },
      'fallback',
      tEn,
    )).toContain('tab-3');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_tabs',
      { action: 'list' },
      'fallback',
      tZh,
    )).toBe('将列出当前浏览器标签页');

    // browser_observe
    expect(getLocalizedApprovalDescription(
      'builtin-browser_observe',
      { kind: 'console' },
      'fallback',
      tEn,
    )).toContain('console logs');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_observe',
      { kind: 'network' },
      'fallback',
      tZh,
    )).toContain('网络请求日志');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_observe',
      { kind: 'both' },
      'fallback',
      tEn,
    )).toContain('console and network logs');

    // browser_screenshot & browser_downloads
    expect(getLocalizedApprovalDescription(
      'builtin-browser_screenshot',
      {},
      'fallback',
      tEn,
    )).toContain('screenshot');
    expect(getLocalizedApprovalDescription(
      'builtin-browser_downloads',
      {},
      'fallback',
      tZh,
    )).toContain('下载记录');
  });
});
