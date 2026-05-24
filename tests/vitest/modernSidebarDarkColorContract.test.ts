import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('modern sidebar dark color contract', () => {
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const themeColorsSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');

  it('keeps primary navigation and conversation rows white in dark mode', () => {
    expect(themeColorsSource).toMatch(/--shell-navigation-row-foreground:\s*var\(--shell-navigation-muted\);/);
    expect(themeColorsSource).toMatch(/--shell-navigation-thread-foreground:\s*var\(--shell-navigation-row-foreground\);/);
    expect(themeColorsSource).toMatch(/:root\.dark\s*\{[\s\S]*--shell-navigation-row-foreground:\s*var\(--shell-navigation-foreground\);/);
    expect(themeColorsSource).toMatch(/--shell-navigation-section-label:\s*color-mix\(in oklch,\s*var\(--shell-navigation-row-foreground\)\s*72%,\s*transparent\);/);
    expect(appCssSource).toMatch(/\.desktop-shell-sidebar-row,\s*\.desktop-shell-nav-row,\s*\.desktop-shell-thread-row\s*\{[^}]*color:\s*var\(--shell-navigation-row-foreground\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row\s*\{[^}]*color:\s*var\(--shell-navigation-thread-foreground\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-nav-row:hover,[\s\S]*color:\s*var\(--shell-navigation-foreground\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row:hover,[\s\S]*color:\s*var\(--shell-navigation-foreground\) !important;/);
  });

  it('keeps selected and unselected sidebar title hover text on the same foreground token', () => {
    expect(appCssSource).toMatch(/\.desktop-shell-sidebar-row:hover,[\s\S]*color:\s*var\(--shell-navigation-foreground\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-sidebar-row--active,\s*\.desktop-shell-nav-row--active\s*\{[^}]*color:\s*var\(--shell-navigation-foreground\) !important;/);
    expect(appCssSource).toMatch(/\.desktop-shell-thread-row--active\s*\{[^}]*color:\s*var\(--shell-navigation-foreground\) !important;/);
    expect(appCssSource).not.toMatch(/\.desktop-shell(?:-sidebar)?-(?:nav|thread)-row--active\s*\{[^}]*color:\s*var\(--shell-nav-item-active-foreground\) !important;/);
  });
});
