import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar typography contract', () => {
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const typographyCssSource = readFileSync(resolve(process.cwd(), 'src/styles/typography.css'), 'utf-8');
  const shadcnVariablesSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');
  const notionButtonSource = readFileSync(resolve(process.cwd(), 'src/components/ui/NotionButton.tsx'), 'utf-8');
  const mobileSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/MobileSidebarLayout.tsx'), 'utf-8');

  it('keeps sidebar labels on the quieter study-ui weight scale', () => {
    expect(sidebarSource).toContain('font-sidebar-study-ui');
    expect(sidebarSource).toContain("aria-label={t('sidebar:aria.workspace_primary_entry', '工作区主入口')}");
    expect(sidebarSource).toContain('className="space-y-0.5" role="list"');
    expect(sidebarSource).toContain('className="block truncate"');
    expect(sidebarSource).toContain('className="block min-w-0 flex-1 truncate leading-4"');
    expect(sidebarSource).toContain("aria-label={t('sidebar:aria.recent_sessions', '最近会话')}");
    expect(sidebarSource).toContain('className="px-3"');
    expect(shadcnVariablesSource).toContain('--app-font-family: "PingFang SC", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Microsoft YaHei", sans-serif;');
    expect(typographyCssSource).toMatch(/\.font-sidebar-study-ui\s*\{[\s\S]*font-family:\s*ui-sans-serif,\s*system-ui,\s*sans-serif,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji";/);
    expect(typographyCssSource).toMatch(/\.font-sidebar-study-ui\s*\{[\s\S]*font-weight:\s*var\(--font-weight-normal\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-section-label\s*\{[^}]*font-weight:\s*400;/);
    expect(appCssSource).not.toMatch(/\.desktop-shell-nav-section-label\s*\{[^}]*padding-inline:/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row\s*\{[\s\S]*font-size:\s*14px !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row\s*\{[\s\S]*font-weight:\s*400 !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row\s*\{[\s\S]*font-size:\s*14px !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row\s*\{[\s\S]*font-weight:\s*400 !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row--active\s*\{[\s\S]*font-weight:\s*400 !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row--active\s*\{[\s\S]*font-weight:\s*400 !important;/);
    expect(notionButtonSource).toMatch(/nav:\s*'[^']*text-sm[^']*'/);
    expect(notionButtonSource).toContain('const shellNavBaseClassName =');
    expect(notionButtonSource).toMatch(/variant === 'nav'[\s\S]*\? shellNavBaseClassName/);
    expect(notionButtonSource).toContain("iconOnly ? iconSizeStyles[resolvedSize] : variant !== 'icon' && variant !== 'nav' ? sizeStyles[resolvedSize] : null");
  });

  it('removes leftover medium sidebar copy from unified sidebar surfaces', () => {
    const unifiedSidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/UnifiedSidebar.tsx'), 'utf-8');
    expect(unifiedSidebarSource).toContain('text-base truncate">{title}</span>');
    expect(unifiedSidebarSource).toContain('text-sm">{title}</span>');
    expect(unifiedSidebarSource).not.toContain('font-medium text-base truncate');
    expect(unifiedSidebarSource).not.toContain('font-medium text-sm');
  });

  it('keeps sidebar section labels free of uppercase tracking treatment', () => {
    expect(appCssSource).toMatch(/\.desktop-shell-nav-section-label\s*\{[^}]*letter-spacing:\s*0;/);
    expect(mobileSidebarSource).toContain('text-xs font-normal text-muted-foreground/60 px-2 py-2');
    expect(mobileSidebarSource).not.toContain('uppercase tracking-wider');
  });
});
