import { afterEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';
import { localizeBrowserGateMessage } from '../browserApi';
import { evaluateBrowserSettingsGates } from '../gates';

describe('browser user-facing messages follow the UI language', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('renders zh-CN copy unchanged', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(evaluateBrowserSettingsGates('false', 'true').closeMessage).toBe(
      '内置浏览器不可用：请先启用学习桌面',
    );
    expect(localizeBrowserGateMessage('GATES_CLOSED: something')).toBe('内置浏览器不可用：功能未启用');
  });

  it('renders English copy in en-US', async () => {
    await i18n.changeLanguage('en-US');
    const gate = evaluateBrowserSettingsGates('true', 'false').closeMessage ?? '';
    expect(gate).toMatch(/^Built-in browser unavailable/);
    expect(gate).not.toMatch(/[一-鿿]/);
    expect(localizeBrowserGateMessage('feature flag ui.workbench_browser is off')).not.toMatch(
      /[一-鿿]/,
    );
  });
});
