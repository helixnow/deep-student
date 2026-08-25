import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buttonBaseClassName,
  buttonIconSizeClassNames,
  buttonSizeClassNames,
  shellNavBaseClassName,
} from '@/components/ui/buttonPrimitiveContract';

/**
 * 字号缩放闭环契约。
 *
 * 设置 → 外观 → 界面字号写的是 --font-size-scale（fontConfig.ts），所有
 * --font-size-* token 都是 calc(Npx * var(--font-size-scale))。Tailwind 的
 * 任意值字号（text-[13px] 这类）是编译期常量，完全不参与缩放——按钮标签曾
 * 是最显眼的漏网层。本测试锁住共享按钮/基元这一层的闭环，并确认新增违规有
 * lint 拦截。
 */
describe('font size scale closure contract', () => {
  const readSource = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf-8');

  const ARBITRARY_FONT_SIZE = /(?<![a-zA-Z0-9])text-\[(?:length:)?\d*\.?\d+(?:px|rem|em|pt)\]/;

  it('scales every font-size token off --font-size-scale', () => {
    const shadcnVars = readSource('src/styles/shadcn-variables.css');
    const sizeTokens = [...shadcnVars.matchAll(/(--font-size-(?!scale)[a-z0-9-]+):\s*([^;]+);/g)];
    expect(sizeTokens.length).toBeGreaterThan(5);
    for (const [, token, value] of sizeTokens) {
      expect(value, `${token} must be derived from --font-size-scale`).toContain('var(--font-size-scale)');
    }
    expect(shadcnVars).toContain('--font-size-ui: calc(13px * var(--font-size-scale));');
    expect(readSource('src/config/fontConfig.ts')).toContain("setProperty('--font-size-scale'");
  });

  it('maps the Tailwind text-ui utility onto the scalable ui token', () => {
    expect(readSource('tailwind.config.js')).toMatch(/'ui':\s*'var\(--font-size-ui\)'/);
  });

  it('routes the menu shell font size through the ui token', () => {
    // AppMenu / ModelPicker 桌面档经 --menu-shell-font-size 消费字号，
    // 写死 13px 会让所有弹出菜单脱离界面字号缩放。
    expect(readSource('src/styles/theme-colors.css')).toContain(
      '--menu-shell-font-size: var(--font-size-ui);',
    );
  });

  it('keeps src/styles free of bare hardcoded px font sizes', () => {
    const collectCss = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectCss(full, acc);
        else if (entry.name.endsWith('.css')) acc.push(full);
      }
      return acc;
    };

    // notes-typography.css 属于 notes 功能域（由 notes 线维护），不在本契约范围。
    const EXEMPT = new Set(['notes-typography.css']);

    const offenders: string[] = [];
    for (const file of collectCss(resolve(process.cwd(), 'src/styles'))) {
      if (EXEMPT.has(file.split('/').pop() ?? '')) continue;
      const source = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
      // 裸 px 字号不参与 --font-size-scale；max(Npx, var(--font-size-*)) 地板
      // 写法（floor 只兜下限、放大照常跟随）不在此列。
      for (const match of source.matchAll(/font-size:\s*[0-9.]+(?:px|pt)\s*(?:!important)?\s*;/g)) {
        offenders.push(`${file.replace(`${process.cwd()}/`, '')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the mobile drawer readability floors while following the scale', () => {
    const responsive = readSource('src/styles/responsive-utilities.css');
    // 分组标题地板 14px；导航行与搜索框地板 16px（iOS WKWebView 聚焦
    // <16px 输入框会自动放大页面），放大档跟随 --font-size-scale。
    expect(responsive).toContain('font-size: max(14px, var(--font-size-base)) !important;');
    expect(
      responsive.match(/font-size: max\(16px, var\(--font-size-lg\)\) !important;/g),
    ).toHaveLength(2);
  });

  it('keeps the hand-written .text-ui rule from shadowing the Tailwind utility', () => {
    const typography = readSource('src/styles/typography.css');
    // typography.css 晚于 tailwind.css 引入：不加 :where() 归零特异性的话，
    // 这条规则会盖掉 text-ui 工具类（12px vs 13px），并顺带压掉同元素上的
    // font-* / tracking-* 工具类。
    expect(typography).toMatch(/:where\(\.text-ui\)\s*\{/);
    expect(typography).not.toMatch(/^\.text-ui\s*\{/m);
    const rule = typography.match(/:where\(\.text-ui\)\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('font-size: var(--font-size-ui);');
  });

  it('routes shared button recipes through token font sizes', () => {
    expect(buttonBaseClassName).toContain('text-ui');
    expect(shellNavBaseClassName).toContain('text-ui');
    expect(buttonSizeClassNames.default).toContain('text-ui');
    expect(buttonSizeClassNames.md).toContain('text-ui');
    expect(buttonSizeClassNames.sm).toContain('text-xs');
    expect(buttonSizeClassNames.lg).toContain('text-sm');

    const recipes = { buttonBaseClassName, shellNavBaseClassName, ...buttonSizeClassNames };
    for (const [name, recipe] of Object.entries(recipes)) {
      expect(recipe, `${name} must not hardcode a font size`).not.toMatch(ARBITRARY_FONT_SIZE);
    }
  });

  it('keeps touch targets at the 44px baseline regardless of font scale', () => {
    // 字号放大不能把触控目标压小：高度走固定几何 token，桌面才在 lg 断点压缩。
    for (const [size, recipe] of Object.entries(buttonSizeClassNames)) {
      expect(recipe, `size=${size} must keep the coarse-pointer touch target`).toContain(
        'h-[var(--touch-target-size)]',
      );
    }
    for (const [size, recipe] of Object.entries(buttonIconSizeClassNames)) {
      expect(recipe, `iconOnly size=${size} must keep the coarse-pointer touch target`).toContain(
        'h-[var(--touch-target-size)] w-[var(--touch-target-size)]',
      );
    }
    const shadcnVars = readSource('src/styles/shadcn-variables.css');
    expect(shadcnVars).toContain('--control-height-touch: 44px;');
    expect(shadcnVars).toContain('--touch-target-size: var(--control-height-touch);');
  });

  it('leaves no hardcoded font size in the shared UI primitives', () => {
    const collect = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collect(full, acc);
        else if (/\.tsx?$/.test(entry.name)) acc.push(full);
      }
      return acc;
    };

    const offenders: string[] = [];
    for (const file of collect(resolve(process.cwd(), 'src/components/ui'))) {
      const source = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const match = source.match(ARBITRARY_FONT_SIZE);
      if (match) offenders.push(`${file.replace(`${process.cwd()}/`, '')}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('wires the lint guard that blocks new hardcoded font sizes', () => {
    const eslintConfig = readSource('eslint.config.js');
    expect(eslintConfig).toContain("import noArbitraryFontSize from './eslint-rules/no-arbitrary-font-size.js'");
    expect(eslintConfig).toContain("'no-arbitrary-font-size': noArbitraryFontSize");
    expect(eslintConfig).toContain("'ds-components/no-arbitrary-font-size': 'warn'");
    // 共享基元目录已清零，必须是 error 而不是 warn
    expect(eslintConfig).toMatch(
      /files:\s*\['src\/components\/ui\/\*\*\/\*\.\{ts,tsx\}'\][\s\S]{0,320}?'ds-components\/no-arbitrary-font-size':\s*'error'/,
    );
  });
});
