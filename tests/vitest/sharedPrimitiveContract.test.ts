import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared primitive migration contract', () => {
  const buttonPrimitiveSource = readFileSync(resolve(process.cwd(), 'src/components/ui/buttonPrimitiveContract.ts'), 'utf-8');
  const cardButtonSource = readFileSync(resolve(process.cwd(), 'src/components/ui/DsButton.tsx'), 'utf-8');
  const cardDialogSource = readFileSync(resolve(process.cwd(), 'src/components/ui/DsDialog.tsx'), 'utf-8');
  const buttonSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Button.tsx'), 'utf-8');
  const inputSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Input.tsx'), 'utf-8');
  const inputShellSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/inputShell.ts'), 'utf-8');
  const switchSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Switch.tsx'), 'utf-8');
  const switchCssSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Switch.css'), 'utf-8');
  const sheetSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Sheet.tsx'), 'utf-8');
  const tabsSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Tabs.tsx'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/UnifiedSidebar.tsx'), 'utf-8');
  const sidebarSheetSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/SidebarSheet.tsx'), 'utf-8');
  const sidebarDrawerSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/SidebarDrawer.tsx'), 'utf-8');

  it('adds explicit shell button roles beyond the legacy card variants', () => {
    expect(buttonPrimitiveSource).toContain("'utility'");
    expect(buttonPrimitiveSource).toContain("'nav'");
    expect(buttonPrimitiveSource).toContain('var(--button-plain-hover-bg)');
    expect(cardButtonSource).toContain('type ButtonPrimitiveVariant');
    expect(cardButtonSource).toContain('buttonToneClassNames[variant]');
  });

  it('routes dialog, input, and sheet surfaces through shell tokens', () => {
    expect(cardDialogSource).toContain('var(--dialog-shell-surface)');
    expect(buttonSource).toContain('buttonToneClassNames.primary');
    expect(buttonPrimitiveSource).toContain('var(--button-plain-bg)');
    expect(inputSource).toContain('inputShellClass');
    expect(inputShellSource).toContain('var(--input-shell-surface)');
    expect(switchSource).toContain('./Switch.css');
    expect(switchCssSource).toContain('hsl(var(--primary))');
    expect(sheetSource).toContain('var(--dialog-shell-surface)');
    expect(tabsSource).toContain('var(--surface-panel-strong)');
  });

  it('gives unified sidebar panel, sheet, and drawer a shared shell wrapper language', () => {
    expect(sidebarSource).toContain('sidebar-shell-surface');
    expect(sidebarSource).toContain('sidebar-shell-item');
    expect(sidebarSheetSource).toContain('sidebar-shell-sheet');
    expect(sidebarDrawerSource).toContain('sidebar-shell-drawer');
  });
});
