import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 拆分输入栏 i18n 键解析契约（0824 rel-mobile 审查）
 *
 * 背景：AttachmentPanelBody（v0.9.44 → 0824 Composer 拆分新增）曾引用
 * `common:actions.more` 作为移动端「⋯更多」按钮的 aria-label，但两份 locale
 * 里都没有这个键——en-US 读屏用户只能听到中文 fallback「更多」。
 *
 * 本契约把拆分出的 Composer* / 附件面板组件里所有**字面量、带显式命名空间**
 * 的 t() 键锁定为「zh-CN 与 en-US 必须同时可解析」。模板字符串键
 * （如 `chatV2:authority.…${preset}`）不在匹配范围内。
 */

const ROOT = process.cwd();

const SPLIT_INPUT_BAR_FILES = [
  'src/features/chat/components/input-bar/InputBarUI.tsx',
  'src/features/chat/components/input-bar/ComposerToolbar.tsx',
  'src/features/chat/components/input-bar/ComposerTextarea.tsx',
  'src/features/chat/components/input-bar/ComposerPlusMenu.tsx',
  'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
  'src/features/chat/components/input-bar/attachmentModeHelpers.ts',
];

const LOCALES = ['zh-CN', 'en-US'] as const;

/** 字面量 t('ns:path.to.key') / t('ns:key', …)；命名空间必须显式 */
const LITERAL_NAMESPACED_KEY = /\bt\(\s*'([A-Za-z0-9]+):([A-Za-z0-9_.-]+)'/g;

const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

type LocaleTree = Record<string, unknown>;

const namespaceCache = new Map<string, LocaleTree | null>();

const loadNamespace = (locale: string, ns: string): LocaleTree | null => {
  const cacheKey = `${locale}/${ns}`;
  if (!namespaceCache.has(cacheKey)) {
    try {
      namespaceCache.set(
        cacheKey,
        JSON.parse(readSource(`src/locales/${locale}/${ns}.json`)) as LocaleTree,
      );
    } catch {
      namespaceCache.set(cacheKey, null);
    }
  }
  return namespaceCache.get(cacheKey) ?? null;
};

const resolveKey = (tree: LocaleTree | null, path: string): boolean => {
  if (!tree) return false;
  let cursor: unknown = tree;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !(part in (cursor as LocaleTree))) {
      return false;
    }
    cursor = (cursor as LocaleTree)[part];
  }
  return typeof cursor === 'string' || typeof cursor === 'object';
};

describe('split input bar i18n key resolution contract', () => {
  const referencedKeys = new Map<string, Set<string>>();

  for (const file of SPLIT_INPUT_BAR_FILES) {
    const source = readSource(file);
    for (const match of source.matchAll(LITERAL_NAMESPACED_KEY)) {
      const key = `${match[1]}:${match[2]}`;
      if (!referencedKeys.has(key)) referencedKeys.set(key, new Set());
      referencedKeys.get(key)!.add(file);
    }
  }

  it('extracts a meaningful number of literal namespaced keys (anti-rot guard)', () => {
    // 拆分组件当前引用 200+ 个字面量键；解析归零说明正则或文件列表失效
    expect(referencedKeys.size).toBeGreaterThan(100);
  });

  it('resolves every literal namespaced key in both zh-CN and en-US', () => {
    const missing: string[] = [];
    for (const [key, files] of referencedKeys) {
      const [ns, path] = key.split(':');
      for (const locale of LOCALES) {
        if (!resolveKey(loadNamespace(locale, ns), path)) {
          missing.push(`${key} (${locale}) referenced by ${[...files].join(', ')}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the mobile attachment panel more/close aria-labels on resolvable keys', () => {
    const panelSource = readSource(
      'src/features/chat/components/input-bar/AttachmentPanelBody.tsx',
    );
    expect(panelSource).toContain("aria-label={t('common:actions.more'");
    expect(panelSource).toContain("aria-label={t('common:actions.close')}");
    for (const locale of LOCALES) {
      const common = loadNamespace(locale, 'common');
      expect(resolveKey(common, 'actions.more')).toBe(true);
      expect(resolveKey(common, 'actions.close')).toBe(true);
    }
  });
});
