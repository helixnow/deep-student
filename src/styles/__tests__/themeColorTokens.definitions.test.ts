import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(process.cwd(), 'src');
const themeColors = readFileSync(join(srcRoot, 'styles/theme-colors.css'), 'utf-8');
const tailwindConfig = readFileSync(resolve(process.cwd(), 'tailwind.config.js'), 'utf-8');

const collectFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectFiles(path, out);
    else out.push(path);
  }
  return out;
};

const allSrcFiles = collectFiles(srcRoot);

/** 每一个在 src 的样式层里被声明过的自定义属性（含 tsx/ts 里以 style 对象写死的）。 */
const definedTokens = (() => {
  const names = new Set<string>();
  for (const file of allSrcFiles) {
    if (file.endsWith('.css')) {
      for (const match of readFileSync(file, 'utf-8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
        names.add(match[1]);
      }
    } else if (/\.tsx?$/.test(file)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]\s*:/g)) {
        names.add(match[1]);
      }
    }
  }
  return names;
})();

const blockOf = (selector: string) => {
  const start = themeColors.indexOf(`${selector} {`);
  expect(start, `${selector} block should exist in theme-colors.css`).toBeGreaterThan(-1);
  return themeColors.slice(start, themeColors.indexOf('\n}', start));
};

const lightRoot = blockOf(':where(:root)');
const darkRoot = blockOf(':root.dark');

const declarationOf = (block: string, token: string) =>
  block.match(new RegExp(`${token}:([^;]+);`))?.[1]?.trim();

/** hsl(var(--shadow-base) / 0.34) → 0.34 中最大的一个（复合阴影取最强的一层）。 */
const maxShadowAlpha = (declaration: string | undefined) =>
  Math.max(
    ...[...(declaration ?? '').matchAll(/var\(--shadow-base\)\s*\/\s*([\d.]+)/g)].map((m) => Number(m[1])),
    0,
  );

describe('theme color token definitions', () => {
  it('defines the tokens that shipped as consumers-without-definitions', () => {
    // 这些 var() 早于定义就被消费了：解析失败时属性直接丢弃，
    // 表现为「面板没有背景」「选中态没有描边」而不是报错，很难被发现。
    for (const token of [
      '--surface-panel',
      '--accent-primary',
      '--button-secondary-surface',
      '--brand-secondary',
      '--brand-accent',
    ]) {
      expect(lightRoot, `${token} must be defined in the light token layer`).toContain(`${token}:`);
    }
  });

  it('keeps --surface-panel an opaque panel surface next to --surface-panel-strong', () => {
    const panel = declarationOf(lightRoot, '--surface-panel');
    expect(panel).toBeTruthy();
    expect(panel).not.toContain('transparent');
    expect(lightRoot).toContain('--surface-panel-strong:');
  });

  it('exposes real colors for the tailwind brand.secondary / brand.accent mapping', () => {
    // tailwind 直接吐 var(--brand-secondary)，不会再包 hsl()，所以必须是完整颜色值。
    expect(tailwindConfig).toContain("secondary: 'var(--brand-secondary)'");
    expect(tailwindConfig).toContain("accent: 'var(--brand-accent)'");
    for (const token of ['--brand-secondary', '--brand-accent']) {
      expect(declarationOf(lightRoot, token)).toMatch(/hsl\(|color-mix\(/);
      expect(declarationOf(darkRoot, token), `${token} needs a dark value too`).toMatch(/hsl\(|color-mix\(/);
    }
  });

  it('flips shell and content shadows so dark overlays keep depth', () => {
    // 亮色档在 0.04–0.10；暗色档必须抬到 workbench 暗色区间（0.34–0.56）。
    for (const token of [
      '--shadow-shell-soft',
      '--shadow-shell-panel',
      '--shadow-shell-floating',
      '--shadow-shell-pressed',
      '--shadow-content-subtle',
      '--shadow-content-soft',
      '--shadow-content-elevated',
    ]) {
      const light = maxShadowAlpha(declarationOf(lightRoot, token));
      const dark = maxShadowAlpha(declarationOf(darkRoot, token));
      expect(dark, `${token} must be redefined for dark mode`).toBeGreaterThanOrEqual(0.3);
      expect(dark, `${token} must be stronger in dark than in light`).toBeGreaterThan(light);
    }
  });

  it('keeps the mobile sheet scrim and shadow readable in dark mode', () => {
    // --shadow-base 换成浅色会把遮罩和底栏投影一起洗掉。
    expect(declarationOf(darkRoot, '--shadow-base')).toBe('0 0% 0%');
    expect(maxShadowAlpha(declarationOf(darkRoot, '--mobile-sheet-shadow'))).toBeGreaterThanOrEqual(0.4);
    expect(maxShadowAlpha(declarationOf(darkRoot, '--mobile-sheet-scrim'))).toBeGreaterThanOrEqual(0.4);
  });

  it('gives resource icon illustrations a dark branch', () => {
    for (const token of ['--resource-icon-bg-mix', '--resource-icon-ink-mix', '--resource-icon-paper']) {
      expect(lightRoot).toContain(`${token}:`);
      expect(darkRoot, `${token} needs a dark override`).toContain(`${token}:`);
    }
  });

  it('leaves no undefined token behind in the recovery and system-status surfaces', () => {
    const consumers = ['features/data-recovery', 'components/system-status'];
    const missing: string[] = [];

    for (const consumer of consumers) {
      for (const file of collectFiles(join(srcRoot, consumer))) {
        if (!/\.(tsx?|css)$/.test(file)) continue;
        for (const match of readFileSync(file, 'utf-8').matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
          if (!definedTokens.has(match[1])) missing.push(`${match[1]} (${file.slice(srcRoot.length + 1)})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
