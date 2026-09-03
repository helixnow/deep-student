import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 故障/恢复路径的底色契约。
 *
 * 这些面板是「其他东西已经坏了」时唯一还会渲染的界面，一旦它们消费的
 * surface token 没有定义，background 会在 computed-value time 失效 →
 * 整块透明，用户看到的是叠字。2026-08 审计发现 --surface-panel /
 * --accent-primary / --button-secondary-surface 三个 token 从未在 token 层
 * 定义过，本测试防止再次退化。
 */
describe('failure-path surface token contract', () => {
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  /** 消费这些 token 的故障/恢复路径与输入栏菜单 */
  const CONSUMERS = [
    'src/features/data-recovery/StartupPreflight.tsx',
    'src/features/data-recovery/ComponentRecoveryShell.tsx',
    'src/features/data-recovery/RecoveryCenter.tsx',
    'src/features/data-recovery/RecoveryShell.tsx',
    'src/components/system-status/FeatureUnavailablePanel.tsx',
    'src/features/chat/components/input-bar/ComposerPlusMenu.tsx',
  ];

  const collectCssFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collectCssFiles(full, acc);
      else if (entry.name.endsWith('.css')) acc.push(full);
    }
    return acc;
  };

  const definedCustomProperties = (() => {
    const names = new Set<string>();
    for (const file of collectCssFiles(resolve(process.cwd(), 'src'))) {
      for (const match of readFileSync(file, 'utf-8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
        names.add(match[1]);
      }
    }
    return names;
  })();

  /** 取某个选择器块的正文（只取第一段，够用来断言 token 是否在该主题下定义） */
  const blockOf = (selector: string) => {
    const start = themeSource.indexOf(`${selector} {`);
    expect(start, `theme-colors.css should contain a ${selector} block`).toBeGreaterThan(-1);
    const end = themeSource.indexOf('\n}', start);
    return themeSource.slice(start, end);
  };

  const lightBlock = blockOf(':where(:root)');
  const darkBlock = blockOf(':root.dark');

  const NEW_TOKENS = ['--surface-panel', '--accent-primary', '--button-secondary-surface'] as const;

  it('defines every custom property the failure-path panels consume', () => {
    for (const consumer of CONSUMERS) {
      const source = readFileSync(resolve(process.cwd(), consumer), 'utf-8');
      const consumed = [...source.matchAll(/var\((--[a-zA-Z0-9-]+)\s*[,)]/g)].map(match => match[1]);
      expect(consumed.length, `${consumer} should consume design tokens`).toBeGreaterThan(0);
      for (const token of consumed) {
        expect(
          definedCustomProperties.has(token),
          `${token} is consumed by ${consumer} but never defined in any src/**/*.css token layer`,
        ).toBe(true);
      }
    }
  });

  it('defines the panel/accent/secondary tokens in both the light and dark token blocks', () => {
    for (const token of NEW_TOKENS) {
      expect(lightBlock, `${token} must be defined for the light theme`).toContain(`${token}:`);
      expect(darkBlock, `${token} must be defined for the dark theme`).toContain(`${token}:`);
    }
  });

  it('keeps a non-color-mix fallback so panels never fall back to transparent', () => {
    // 兜底声明（:where(:root) / :root.dark 里的那一份）必须是实色，
    // 老 Android WebView 不认 color-mix 时仍然有底。
    for (const block of [lightBlock, darkBlock]) {
      for (const token of NEW_TOKENS) {
        const declaration = block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1] ?? '';
        expect(declaration, `${token} fallback should not depend on color-mix`).not.toContain('color-mix');
        expect(declaration.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('upgrades the panel/secondary surfaces to color-mix behind @supports', () => {
    const supportsStart = themeSource.indexOf('@supports (background: color-mix(');
    expect(supportsStart, 'theme-colors.css should guard the color-mix upgrade with @supports').toBeGreaterThan(-1);
    const supportsBlock = themeSource.slice(supportsStart, themeSource.indexOf('\n}\n', supportsStart));

    // 两个选择器都要覆写：:root.dark 的实色兜底特异性高于 :where(:root)，
    // 只升级 :where(:root) 的话暗色会停在兜底值。
    expect(supportsBlock).toContain(':where(:root)');
    expect(supportsBlock).toContain(':root.dark');
    expect(supportsBlock).toMatch(/--surface-panel:\s*color-mix\(in hsl, var\(--surface-elevated\)/);
    expect(supportsBlock.match(/--surface-panel:/g)).toHaveLength(2);
    expect(supportsBlock.match(/--button-secondary-surface:\s*var\(--button-tonal-bg\)/g)).toHaveLength(2);
  });

  it('keeps --accent-primary aligned with the shadcn primary token', () => {
    expect(lightBlock).toMatch(/--accent-primary:\s*hsl\(var\(--primary\)\);/);
    expect(darkBlock).toMatch(/--accent-primary:\s*hsl\(var\(--primary\)\);/);
  });

  it('keeps the settings navigation accents in the token layer instead of hex literals', () => {
    const navSource = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/useSettingsNavigation.tsx'),
      'utf-8',
    );
    expect(navSource).not.toMatch(/mobileAccent:\s*'#/);
    expect(navSource).toContain('var(--settings-nav-accent-amber)');

    for (const match of navSource.matchAll(/var\((--settings-nav-accent-[a-z]+)\)/g)) {
      expect(lightBlock, `${match[1]} must have a light value`).toContain(`${match[1]}:`);
      expect(darkBlock, `${match[1]} must be re-tuned for dark mode`).toContain(`${match[1]}:`);
    }

    // 高对比偏好档（与 workbench a11y-cursor.css 同族）
    expect(themeSource).toMatch(/@media \(prefers-contrast: more\)[\s\S]*--settings-nav-accent-amber:/);
  });
});
