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
