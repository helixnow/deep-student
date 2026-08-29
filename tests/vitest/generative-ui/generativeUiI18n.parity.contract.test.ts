/**
 * generativeUi 中英 key 对齐合同
 *
 * 规则：zh-CN / en-US 叶子 key 集合必须相等；
 * blocks.markdown / chart / steps / table、a11y.*、demo.recipes.* 必须存在且非空。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zh from '@/locales/zh-CN/generativeUi.json';
import en from '@/locales/en-US/generativeUi.json';
import { INTENT_RECIPES } from '@/features/generative-ui/demo/intentRecipes';

function collectKeyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectKeyPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths.sort();
}

function collectLeafValues(
  obj: Record<string, unknown>,
  prefix = '',
): Array<[string, unknown]> {
  const leaves: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      leaves.push(...collectLeafValues(value as Record<string, unknown>, path));
    } else {
      leaves.push([path, value]);
    }
  }
  return leaves;
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/\{\{\s*[\w.]+\s*\}\}/g)].map((m) => m[0]).sort();
}

function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function collectSourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(absolutePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function collectLiteralLocaleKeys(): string[] {
  const srcRoot = path.join(process.cwd(), 'src');
  const generativeUiRoot = path.join(srcRoot, 'features/generative-ui');
  const keys = new Set<string>();

  for (const file of collectSourceFiles(generativeUiRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
      const key = match[1];
      if (key && !key.includes(':')) keys.add(key);
    }
  }

  for (const file of collectSourceFiles(srcRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/['"]generativeUi:([A-Za-z0-9_.-]+)['"]/g)) {
      if (match[1]) keys.add(match[1]);
    }
  }

  return [...keys].sort();
}

const REQUIRED_BLOCK_KEYS = [
  'blocks.markdown.empty',
  'blocks.markdown.error',
  'blocks.chart.empty',
  'blocks.chart.a11y_label',
  'blocks.steps.status_pending',
  'blocks.steps.status_active',
  'blocks.steps.status_done',
  'blocks.steps.status_error',
  'blocks.steps.status_skipped',
  'blocks.table.empty',
] as const;

const REQUIRED_A11Y_KEYS = [
  'a11y.region_label',
  'a11y.action_bar_label',
  'a11y.list_label',
  'a11y.text_label',
  'a11y.progress_label',
  'a11y.key_value_label',
  'a11y.flashcard_front',
  'a11y.flashcard_back',
  'a11y.mindmap_label',
  'a11y.research_report_label',
  'a11y.review_day',
  'a11y.step_pending',
  'a11y.step_active',
  'a11y.step_done',
  'a11y.step_error',
  'a11y.step_skipped',
  'a11y.markdown_label',
  'a11y.chart_label',
  'a11y.chart_empty',
  'a11y.steps_label',
  'a11y.table_label',
  'a11y.table_caption',
  'a11y.block_error',
  'a11y.retry',
] as const;

const REQUIRED_DEMO_RECIPE_KEYS = [
  'demo.recipes.learning_dashboard.title',
  'demo.recipes.learning_dashboard.description',
  'demo.recipes.research_briefing.title',
  'demo.recipes.research_briefing.description',
  'demo.recipes.translation_chart.title',
  'demo.recipes.translation_chart.description',
  'demo.recipes.mistake_table.title',
  'demo.recipes.mistake_table.description',
  'demo.recipes.empty_markdown.title',
  'demo.recipes.empty_markdown.description',
  'demo.recipes.v11_grid_two_col.title',
  'demo.recipes.v11_grid_two_col.description',
] as const;

describe('generativeUi i18n parity contract (zh-CN / en-US)', () => {
  const zhKeys = collectKeyPaths(zh as Record<string, unknown>);
  const enKeys = collectKeyPaths(en as Record<string, unknown>);
  const zhKeySet = new Set(zhKeys);
  const enKeySet = new Set(enKeys);

  it('has an empty key-set diff between zh-CN and en-US', () => {
    const missingInEn = zhKeys.filter((k) => !enKeySet.has(k));
    const missingInZh = enKeys.filter((k) => !zhKeySet.has(k));

    expect(missingInEn, `keys missing in en-US: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInZh, `keys missing in zh-CN: ${missingInZh.join(', ')}`).toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });

  it('every leaf value is a non-empty string in both locales', () => {
    for (const [localeName, locale] of [
      ['zh-CN', zh],
      ['en-US', en],
    ] as const) {
      for (const [path, value] of collectLeafValues(locale as Record<string, unknown>)) {
        expect(typeof value, `${localeName} ${path} must be a string`).toBe('string');
        expect((value as string).trim().length, `${localeName} ${path} must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('requires blocks.markdown / chart / steps / table groups', () => {
    for (const locale of [zh, en] as const) {
      const blocks = (locale as { blocks?: Record<string, unknown> }).blocks;
      expect(blocks, 'blocks namespace must exist').toBeTruthy();
      expect(blocks).toHaveProperty('markdown');
      expect(blocks).toHaveProperty('chart');
      expect(blocks).toHaveProperty('steps');
      expect(blocks).toHaveProperty('table');
    }

    for (const key of REQUIRED_BLOCK_KEYS) {
      expect(zhKeySet.has(key), `zh-CN missing required block key: ${key}`).toBe(true);
      expect(enKeySet.has(key), `en-US missing required block key: ${key}`).toBe(true);
    }
  });

  it('requires a11y.* keys used by renderer and block landmarks', () => {
    const zhA11y = zhKeys.filter((k) => k.startsWith('a11y.'));
    const enA11y = enKeys.filter((k) => k.startsWith('a11y.'));

    expect(zhA11y.length, 'a11y.* must exist in zh-CN').toBeGreaterThan(0);
    expect(enA11y).toEqual(zhA11y);

    for (const key of REQUIRED_A11Y_KEYS) {
      expect(zhKeySet.has(key), `zh-CN missing required a11y key: ${key}`).toBe(true);
      expect(enKeySet.has(key), `en-US missing required a11y key: ${key}`).toBe(true);
    }
  });

  it('requires demo.recipes.* title/description for Style Lab recipe buttons', () => {
    const zhDemo = zhKeys.filter((k) => k.startsWith('demo.recipes.'));
    const enDemo = enKeys.filter((k) => k.startsWith('demo.recipes.'));

    expect(zhDemo.length, 'demo.recipes.* must exist in zh-CN').toBeGreaterThan(0);
    expect(enDemo).toEqual(zhDemo);

    for (const key of REQUIRED_DEMO_RECIPE_KEYS) {
      expect(zhKeySet.has(key), `zh-CN missing required demo recipe key: ${key}`).toBe(true);
      expect(enKeySet.has(key), `en-US missing required demo recipe key: ${key}`).toBe(true);
    }

    for (const recipe of INTENT_RECIPES) {
      expect(recipe.i18nKey.startsWith('demo.recipes.')).toBe(true);
      for (const field of ['title', 'description'] as const) {
        const key = `${recipe.i18nKey}.${field}`;
        expect(zhKeySet.has(key), `zh-CN missing ${key} for recipe ${recipe.id}`).toBe(true);
        expect(enKeySet.has(key), `en-US missing ${key} for recipe ${recipe.id}`).toBe(true);
      }
    }
  });

  it('keeps interpolation placeholders aligned across locales', () => {
    for (const key of zhKeys) {
      const zhValue = readPath(zh as Record<string, unknown>, key);
      const enValue = readPath(en as Record<string, unknown>, key);
      if (typeof zhValue !== 'string' || typeof enValue !== 'string') continue;
      expect(
        interpolationTokens(enValue),
        `placeholder mismatch for ${key}`,
      ).toEqual(interpolationTokens(zhValue));
    }
  });

  it('registers the namespace and covers every literal production callsite', () => {
    const i18nSource = fs.readFileSync(path.join(process.cwd(), 'src/i18n.ts'), 'utf8');
    const allNamespaces = i18nSource.match(/const\s+ALL_NS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    expect(allNamespaces).toMatch(/['"]generativeUi['"]/);

    for (const key of collectLiteralLocaleKeys()) {
      expect(readPath(zh as Record<string, unknown>, key), `zh-CN missing used key: ${key}`)
        .toEqual(expect.any(String));
      expect(readPath(en as Record<string, unknown>, key), `en-US missing used key: ${key}`)
        .toEqual(expect.any(String));
    }
  });
});
