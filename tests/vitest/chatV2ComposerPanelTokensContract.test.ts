import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 composer panel semantic token contract', () => {
  const themeSource = readFileSync(
    resolve(process.cwd(), 'src/styles/theme-colors.css'),
    'utf-8'
  );
  const overlaySource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/ComposerPanelOverlay.tsx'),
    'utf-8'
  );
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('defines composer panel tokens as a semantic layer over existing app tokens', () => {
    expect(themeSource).toContain('--composer-panel-surface:');
    expect(themeSource).toContain('--composer-panel-border:');
    expect(themeSource).toContain('--composer-panel-foreground: var(--text-primary);');
    expect(themeSource).toContain('--composer-panel-muted-foreground: var(--text-secondary);');
    expect(themeSource).toContain('--composer-panel-shadow: var(--shadow-shell-floating);');
    expect(themeSource).toContain('--composer-panel-backdrop-filter:');
    expect(themeSource).toContain('--composer-panel-muted-surface:');
    expect(themeSource).toContain('--composer-panel-control-surface:');
    expect(themeSource).toContain('--composer-panel-control-border:');
    expect(themeSource).toContain('--composer-panel-control-hover:');
    expect(themeSource).toContain('--composer-panel-focus-border:');
    expect(themeSource).toContain('--composer-panel-placeholder:');
    expect(themeSource).toContain('var(--input-shell-border)');
    expect(themeSource).toContain('var(--surface-panel-strong)');
  });

  it('renders the composer panel with semantic tokens instead of generic glass helpers', () => {
    expect(overlaySource).toContain('var(--composer-panel-surface)');
    expect(overlaySource).toContain('var(--composer-panel-border)');
    expect(overlaySource).toContain('var(--composer-panel-foreground)');
    expect(overlaySource).toContain('var(--composer-panel-shadow)');
    expect(overlaySource).toContain('var(--composer-panel-backdrop-filter)');
    expect(overlaySource).not.toContain('glass-panel');
    expect(overlaySource).not.toContain('border-[hsl(var(--border))]');
  });

  it('keeps composer panel body controls on composer semantic tokens', () => {
    expect(inputBarSource).toContain('var(--composer-panel-muted-surface)');
    expect(inputBarSource).toContain('var(--composer-panel-control-surface)');
    expect(inputBarSource).toContain('var(--composer-panel-control-border)');
    expect(inputBarSource).toContain('var(--composer-panel-control-hover)');
    expect(inputBarSource).toContain('var(--composer-panel-focus-border)');
    expect(inputBarSource).toContain('var(--composer-panel-placeholder)');
    expect(inputBarSource).not.toContain('border-[hsl(var(--border))]');
    expect(inputBarSource).not.toContain('var(--input-surface)');
    expect(inputBarSource).not.toContain('var(--text-tertiary)');
  });
});
