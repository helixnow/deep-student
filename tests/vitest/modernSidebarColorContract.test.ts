import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar color contract', () => {
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const typographySource = readFileSync(resolve(process.cwd(), 'src/styles/typography.css'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  it('aligns desktop navigation row states with study-ui sidebar surfaces', () => {
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row:hover,[\s\S]*background:\s*var\(--interactive-hover\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row--active\s*\{[\s\S]*background:\s*var\(--interactive-selected\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row:hover,[\s\S]*background:\s*var\(--interactive-hover\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row--active\s*\{[\s\S]*background:\s*var\(--interactive-selected\) !important;/);
  });

  it('maps sidebar study-ui helper vars directly onto study-ui shell tokens', () => {
    expect(typographySource).toMatch(/--sidebar-study-surface:\s*var\(--sidebar\);/);
    expect(typographySource).toMatch(/--sidebar-study-hover:\s*var\(--interactive-hover\);/);
    expect(typographySource).toMatch(/--sidebar-study-selected:\s*var\(--interactive-selected\);/);
    expect(typographySource).toMatch(/--sidebar-study-border:\s*var\(--sidebar-border\);/);
    expect(typographySource).not.toContain('--sidebar-study-surface: color-mix');
    expect(typographySource).not.toContain('--sidebar-study-hover: color-mix');
    expect(typographySource).not.toContain('--sidebar-study-selected: color-mix');
  });

  it('defines the same light and dark shell palette values as study-ui', () => {
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--interactive-hover:\s*#E9E9E9;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--interactive-selected:\s*#E9E9E9;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--sidebar:\s*#F3F3F3;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--sidebar-hover:\s*#F9F9F9;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--sidebar-accent:\s*#EFEFEA;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-backdrop:\s*#ECECE7;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-panel:\s*#FFFFFF;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-panel-strong:\s*#FCFCFA;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-titlebar:\s*#F8F8F4;/);
    expect(themeSource).toMatch(/:where\(:root\)\s*\{[\s\S]*--shell-surface:\s*#ECEFE8;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--interactive-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.08\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--interactive-selected:\s*rgba\(255,\s*255,\s*255,\s*0\.14\);/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--sidebar:\s*#000000;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--sidebar-hover:\s*#2A2A2A;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--sidebar-accent:\s*#20201E;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-backdrop:\s*#141413;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-panel:\s*#1D1D1B;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-panel-strong:\s*#222220;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-titlebar:\s*#1D1D1B;/);
    expect(themeSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-surface:\s*#171917;/);
  });
});
