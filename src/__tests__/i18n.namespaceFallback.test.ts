import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

const COMMUNITY_NS = 'acme.notes';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
  await vi.waitFor(() => expect(i18n.hasResourceBundle('zh-CN', 'settings')).toBe(true), { timeout: 10_000 });
  i18n.addResourceBundle('zh-CN', COMMUNITY_NS, { greeting: '你好' }, true, true);
});

describe('i18n namespace fallback', () => {
  it('keeps the official cross-namespace fallback', () => {
    expect(i18n.t('settings:title')).toBe('系统设置');
    // sidebar-only key looked up through the default namespace (common) falls back to sidebar
    expect(i18n.t('sections.flat_analysis')).toBe('扁平分析');
    expect(i18n.getFixedT('zh-CN', 'chatV2')('sections.flat_analysis')).toBe('扁平分析');
  });

  it('resolves community keys only inside their own namespace', () => {
    expect(i18n.t(`${COMMUNITY_NS}:greeting`)).toBe('你好');
    expect(i18n.t(`${COMMUNITY_NS}:title`)).toBe('title');
    expect(i18n.t('title', { ns: COMMUNITY_NS })).toBe('title');
    expect(i18n.getFixedT('zh-CN', COMMUNITY_NS)('title')).toBe('title');
    expect(i18n.t('acme.unloaded:title')).toBe('title');
  });
});
