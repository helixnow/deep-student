import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Modern sidebar color contract
 *
 * 架构决定（2026-05 shell 去色迁移）：
 * sidebar/shell 层的所有表面和交互 token 必须通过 shadcn 基础灰度派生
 * （hsl(var(--background)) / hsl(var(--muted)) / hsl(var(--accent)) 等），
 * 禁止硬编码十六进制或暖米色 hue。切换主题（亮/暗、palette）时只改
 * shadcn-variables.css 的基础灰度即可全局联动。
 */
describe('modern sidebar color contract', () => {
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const typographySource = readFileSync(resolve(process.cwd(), 'src/styles/typography.css'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  const shadcnSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');

  it('aligns desktop navigation row states with the shared interaction tokens', () => {
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row:hover,[\s\S]*background:\s*var\(--interactive-hover\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row--active\s*\{[\s\S]*background:\s*var\(--interactive-selected\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row:hover,[\s\S]*background:\s*var\(--interactive-hover\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row--active\s*\{[\s\S]*background:\s*var\(--interactive-selected\) !important;/);
  });

  it('maps sidebar study-ui helper vars directly onto shared shell tokens', () => {
    expect(typographySource).toMatch(/--sidebar-study-surface:\s*var\(--sidebar\);/);
    expect(typographySource).toMatch(/--sidebar-study-hover:\s*var\(--interactive-hover\);/);
    expect(typographySource).toMatch(/--sidebar-study-selected:\s*var\(--interactive-selected\);/);
    expect(typographySource).toMatch(/--sidebar-study-border:\s*var\(--sidebar-border\);/);
    expect(typographySource).not.toContain('--sidebar-study-surface: color-mix');
    expect(typographySource).not.toContain('--sidebar-study-hover: color-mix');
    expect(typographySource).not.toContain('--sidebar-study-selected: color-mix');
  });

  it('shadcn base greyscale stays purely neutral (hue 0, no beige tint)', () => {
    // 亮色：所有基础灰度必须 hue == 0 或 saturation == 0%
    // 禁止 hue 60° 的暖米色（study-ui 迁移残留）
    expect(shadcnSource).not.toMatch(/:root\s*\{[\s\S]*--titlebar-background:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\s*\{[\s\S]*--card:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\s*\{[\s\S]*--muted:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\s*\{[\s\S]*--accent:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\s*\{[\s\S]*--border:\s*60\s/);
    // 暗色同样不得带色相
    expect(shadcnSource).not.toMatch(/:root\.dark\s*\{[\s\S]*--titlebar-background:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\.dark\s*\{[\s\S]*--card:\s*60\s/);
    expect(shadcnSource).not.toMatch(/:root\.dark\s*\{[\s\S]*--muted:\s*60\s/);
  });

  it('routes shell/sidebar surface tokens through shadcn base variables (no hardcoded hex)', () => {
    // 方向 C（扁平单色）：所有 shell 表面一律 --background，
    // 侧边栏是唯一非白的区域（nav-background）。
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-backdrop:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-panel:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-panel-strong:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-titlebar:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-surface:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-float:\s*hsl\(var\(--background\)\);/);
    // 侧边栏保留淡灰区分
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--sidebar:\s*hsl\(var\(--nav-background\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--sidebar-accent:\s*hsl\(var\(--accent\)\);/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--interactive-hover:\s*hsl\(var\(--accent\)\);/);

    // 暗色走同样的派生链（扁平，shell 表面 = --background）
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-backdrop:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-panel:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-titlebar:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-surface:\s*hsl\(var\(--background\)\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--sidebar:\s*hsl\(var\(--nav-background\)\);/);
  });

  it('forbids reintroducing the beige study-ui hex palette in theme-colors.css', () => {
    // 旧的硬编码暖米色值一旦出现就是回退，直接断掉
    const legacyBeigeHex = ['#ECECE7', '#EBEAE5', '#DDDCD4', '#EFEFEA', '#F3F3F3', '#F8F8F4', '#FCFCFA', '#EDEDE7'];
    for (const hex of legacyBeigeHex) {
      expect(themeSource).not.toContain(hex);
    }
  });
});
