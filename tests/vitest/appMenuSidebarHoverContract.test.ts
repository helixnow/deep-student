import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AppMenu 外壳契约
 *
 * 架构决定（一劳永逸）：AppMenu 的视觉外壳完全由 --menu-shell-* token 驱动，
 * 这些 token 在 theme-colors.css 中定义，并内部链接到：
 *   - 交互态 → --interactive-hover / --interactive-selected（与 sidebar 行为同源）
 *   - 圆角 / 阴影 / 表面 → composer shell 族（与输入框外壳同源）
 *
 * 本契约验证：
 *  1. AppMenu.css 只消费 --menu-shell-* / 共享令牌，不再硬编码 radius/shadow/border。
 *  2. theme-colors.css 中的 token 链正确接入交互 / shell 体系。
 */
describe('AppMenu shell contract', () => {
  const menuCss = readFileSync(resolve(process.cwd(), 'src/components/ui/app-menu/AppMenu.css'), 'utf-8');
  const themeCss = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  it('routes hover/active/radius/foreground through --menu-shell-* tokens', () => {
    expect(menuCss).toMatch(/--app-menu-row-hover:\s*var\(--menu-shell-row-hover\);/);
    expect(menuCss).toMatch(/--app-menu-row-active:\s*var\(--menu-shell-row-active\);/);
    expect(menuCss).toMatch(/--app-menu-row-foreground:\s*var\(--menu-shell-foreground\);/);
    expect(menuCss).toMatch(/--app-menu-row-radius:\s*var\(--menu-shell-row-radius\);/);

    expect(menuCss).toMatch(/\.app-menu-trigger:hover,[\s\S]*background-color:\s*var\(--app-menu-row-hover\);/);
    expect(menuCss).toMatch(/\.app-menu-trigger\[aria-expanded="true"\],[\s\S]*background-color:\s*var\(--app-menu-row-active\);/);
    expect(menuCss).toMatch(/\.app-menu-item:hover,[\s\S]*background-color:\s*var\(--app-menu-row-hover\);/);
    expect(menuCss).toMatch(/\.app-menu-item:active\s*\{[\s\S]*background-color:\s*var\(--app-menu-row-active\);/);
  });

  it('theme-colors.css wires --menu-shell-* into the interactive + shell token families', () => {
    // 交互态必须与 sidebar 行为同源
    expect(themeCss).toMatch(/--menu-shell-row-hover:\s*var\(--interactive-hover\);/);
    expect(themeCss).toMatch(/--menu-shell-row-active:\s*var\(--interactive-selected\);/);
    // 外壳视觉必须与 composer shell 同源
    expect(themeCss).toMatch(/--menu-shell-surface:\s*var\(--composer-panel-surface\);/);
    expect(themeCss).toMatch(/--menu-shell-border:\s*var\(--composer-panel-border\);/);
    expect(themeCss).toMatch(/--menu-shell-shadow:\s*var\(--shadow-shell-floating\);/);
    // 圆角必须使用 shell 圆角令牌（而不是硬编码数值）
    expect(themeCss).toMatch(/--menu-shell-radius:\s*var\(--radius-shell-[a-z-]+\);/);
    expect(themeCss).toMatch(/--menu-shell-row-radius:\s*var\(--radius-shell-[a-z-]+\);/);
  });

  it('does not reintroduce legacy hover colors (accent / muted) on menu rows', () => {
    expect(menuCss).not.toMatch(/\.app-menu-item:hover[\s\S]*background-color:\s*hsl\(var\(--accent\)\);/);
    expect(menuCss).not.toMatch(/\.app-menu-checkbox-item:hover[\s\S]*background-color:\s*hsl\(var\(--accent\)\);/);
    expect(menuCss).not.toMatch(/\.app-menu-option-item:hover[\s\S]*background-color:\s*hsl\(var\(--muted\)\s*\/\s*0\.5\);/);
  });

  it('does not reintroduce hardcoded pixel radii or the legacy 4-layer drop shadow on the menu container', () => {
    const contentRule = menuCss.match(/\.app-menu-content\s*\{[^}]+\}/)?.[0] ?? '';
    // radius 必须走 token
    expect(contentRule).toMatch(/border-radius:\s*var\(--menu-shell-radius\);/);
    expect(contentRule).not.toMatch(/border-radius:\s*\d+px;/);
    // box-shadow 必须走 token（旧实现是 4 层 hsl(0 0% 0% / 0.xx) 堆叠）
    expect(contentRule).toMatch(/box-shadow:\s*var\(--menu-shell-shadow\);/);
    expect(contentRule).not.toMatch(/box-shadow:[\s\S]*0 20px 25px -5px/);
  });

  it('no longer needs a .dark .app-menu-content override — token chain handles dark mode', () => {
    expect(menuCss).not.toMatch(/\.dark\s+\.app-menu-content\s*\{/);
    expect(menuCss).not.toMatch(/\.dark\s+\.app-menu-sub-content\s*\{/);
  });
});
