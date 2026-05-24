import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('semantic token migration contract', () => {
  const shadcnVarsSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');
  const themeSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  const appCssSource = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf-8');
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const thinkingScrollbarSource = readFileSync(resolve(process.cwd(), 'src/styles/thinking-scrollbar.css'), 'utf-8');
  const analysisCssSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/styles/analysis.css'), 'utf-8');
  const markdownCssSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/styles/markdown.css'), 'utf-8');
  const modernButtonsSource = readFileSync(resolve(process.cwd(), 'src/styles/modern-buttons.css'), 'utf-8');
  const styleLabScannerSource = readFileSync(resolve(process.cwd(), 'scripts/scan-component-usage.mjs'), 'utf-8');

  const stripCssComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
  const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(\s*\d|oklch\(\s*\d|oklab\(\s*\d/;

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
    expect(shadcnVarsSource).toContain('--primary: 215 72% 42%;');
    expect(shadcnVarsSource).toContain('--ring: 214 62% 50%;');
    expect(shadcnVarsSource).toContain('--primary: 214 64% 72%;');
    expect(shadcnVarsSource).toContain('--ring: 214 58% 68%;');
  });

  it('consumes shell geometry through semantic vars instead of local hardcoded islands', () => {
    expect(appCssSource).toContain('var(--radius-shell-panel)');
    expect(appCssSource).toContain('var(--size-shell-control)');
    expect(modernButtonsSource).not.toContain('#eff6ff');
    expect(modernButtonsSource).not.toContain('#3b82f6');
    expect(modernButtonsSource).toContain('var(--button-primary-surface)');
  });

  it('keeps migrated color consumers on semantic tokens instead of raw color literals', () => {
    const consumers = {
      'src/App.tsx': appSource,
      'src/styles/thinking-scrollbar.css': thinkingScrollbarSource,
      'src/chat-v2/styles/analysis.css': analysisCssSource,
      'src/chat-v2/styles/markdown.css': markdownCssSource,
    };

    for (const [file, source] of Object.entries(consumers)) {
      expect(stripCssComments(source), `${file} should use semantic color tokens`).not.toMatch(hardcodedColorPattern);
    }
  });

  it('tracks hardcoded color debt in CSS files and modern color functions', () => {
    expect(styleLabScannerSource).toMatch(/SCAN_EXTS\s*=\s*new Set\(\[[^\]]*'\.css'/s);
    expect(styleLabScannerSource).toMatch(/hsl\[a\]\?\\\(/);
    expect(styleLabScannerSource).toMatch(/oklch\\\(/);
    expect(styleLabScannerSource).toMatch(/oklab\\\(/);
  });
});
