import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import zhCN from '@/locales/zh-CN/graph_conflict.json';
import enUS from '@/locales/en-US/graph_conflict.json';

const source = readFileSync(
  new URL('../createFromWikilink.ts', import.meta.url),
  'utf8',
);

describe('createFromWikilink i18n contract', () => {
  it('provides wikilink.create_failed in both locales', () => {
    expect(zhCN.wikilink.create_failed).toBe('创建笔记「{{title}}」失败');
    expect(enUS.wikilink.create_failed).toContain('{{title}}');
  });

  it('keeps the pre-existing graph_conflict keys intact', () => {
    for (const key of ['title', 'conflict', 'resolve', 'ignore']) {
      expect(zhCN).toHaveProperty(key);
      expect(enUS).toHaveProperty(key);
    }
  });

  it('uses the i18n key instead of a hardcoded template string', () => {
    expect(source).toContain("i18n.t('graph_conflict:wikilink.create_failed'");
    expect(source).toContain("import i18n from '@/i18n';");
    expect(source).not.toContain('`创建笔记「${trimmed}」失败`');
  });
});
