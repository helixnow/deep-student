import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('mobile shell migration contract', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const mobileShellSource = readFileSync(resolve(process.cwd(), 'src/app/shell/mobileShell.ts'), 'utf-8');
  const headerSource = readFileSync(resolve(process.cwd(), 'src/components/layout/UnifiedMobileHeader.tsx'), 'utf-8');
  const tabBarSource = readFileSync(resolve(process.cwd(), 'src/components/layout/BottomTabBar.tsx'), 'utf-8');
  const breakpointHookSource = readFileSync(resolve(process.cwd(), 'src/hooks/useBreakpoint.ts'), 'utf-8');

  it('defines a shared mobile shell contract for safe areas and chrome heights', () => {
    expect(mobileShellSource).toContain('MOBILE_SHELL');
    expect(mobileShellSource).toContain('--mobile-safe-area-top');
    expect(mobileShellSource).toContain('--mobile-safe-area-bottom');
    expect(mobileShellSource).toContain('--mobile-header-total-height');
    expect(mobileShellSource).toContain('--mobile-bottom-bar-total-height');
  });

  it('routes app shell, header, and tab bar through the shared mobile shell vars', () => {
    expect(appSource).toContain('getMobileShellCssVars');
    expect(headerSource).toContain('var(--mobile-safe-area-top');
    expect(headerSource).toContain('var(--mobile-header-total-height');
    expect(tabBarSource).toContain('var(--mobile-safe-area-bottom');
    expect(tabBarSource).toContain('var(--mobile-bottom-bar-height');
  });

  it('pulls breakpoint decisions from the shared breakpoint config', () => {
    expect(breakpointHookSource).toContain("from '@/config/breakpoints'");
    expect(breakpointHookSource).not.toContain('export const BREAKPOINTS = {');
  });
});
