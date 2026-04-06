import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('semantic token migration contract', () => {
  const shadcnVarsSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const modernButtonsSource = readFileSync(resolve(process.cwd(), 'src/styles/modern-buttons.css'), 'utf-8');

  it('defines canonical shell geometry and shadow tokens in the token layer', () => {
    expect(shadcnVarsSource).toContain('--radius-shell-panel');
    expect(shadcnVarsSource).toContain('--radius-shell-toolbar');
    expect(shadcnVarsSource).toContain('--size-shell-control');
    expect(themeSource).toContain('--shadow-shell-panel');
    expect(themeSource).toContain('--shadow-shell-floating');
  });

  it('defines quiet sidebar and utility button tokens for shared shell states', () => {
    expect(themeSource).toContain('--sidebar-quiet-hover');
    expect(themeSource).toContain('--sidebar-quiet-active');
    expect(themeSource).toContain('--button-utility-hover');
    expect(themeSource).toContain('--button-utility-active');
    expect(themeSource).toContain('--interactive-hover');
    expect(themeSource).toContain('--sidebar-hover');
    expect(themeSource).toContain('--sidebar');
    expect(themeSource).toContain('--sidebar-accent');
  });

  it('aligns the default blue tokens with the study-ui primary and ring values', () => {
    expect(shadcnVarsSource).toContain('--primary: 215 72% 54.2%;');
    expect(shadcnVarsSource).toContain('--ring: 214.2 62.1% 62.6%;');
    expect(shadcnVarsSource).toContain('--primary: 213.9 77.9% 68.7%;');
    expect(shadcnVarsSource).toContain('--ring: 214 70.8% 70.8%;');
  });

  it('consumes shell geometry through semantic vars instead of local hardcoded islands', () => {
    expect(appCssSource).toContain('var(--radius-shell-panel)');
    expect(appCssSource).toContain('var(--size-shell-control)');
    expect(modernButtonsSource).not.toContain('#eff6ff');
    expect(modernButtonsSource).not.toContain('#3b82f6');
    expect(modernButtonsSource).toContain('var(--button-primary-surface)');
  });
});
