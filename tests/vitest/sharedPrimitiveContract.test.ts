import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('shared primitive migration contract', () => {
  const notionButtonSource = readFileSync(resolve(process.cwd(), 'src/components/ui/NotionButton.tsx'), 'utf-8');
  const notionDialogSource = readFileSync(resolve(process.cwd(), 'src/components/ui/NotionDialog.tsx'), 'utf-8');
  const buttonSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Button.tsx'), 'utf-8');
  const inputSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Input.tsx'), 'utf-8');
  const switchSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Switch.tsx'), 'utf-8');
  const sheetSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Sheet.tsx'), 'utf-8');
  const tabsSource = readFileSync(resolve(process.cwd(), 'src/components/ui/shad/Tabs.tsx'), 'utf-8');
  const sidebarSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/UnifiedSidebar.tsx'), 'utf-8');
  const sidebarSheetSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/SidebarSheet.tsx'), 'utf-8');
  const sidebarDrawerSource = readFileSync(resolve(process.cwd(), 'src/components/ui/unified-sidebar/SidebarDrawer.tsx'), 'utf-8');

  it('adds explicit shell button roles beyond the legacy notion variants', () => {
    expect(notionButtonSource).toContain("'utility'");
    expect(notionButtonSource).toContain("'nav'");
    expect(notionButtonSource).toContain('var(--button-utility-hover)');
  });

  it('routes dialog, input, and sheet surfaces through shell tokens', () => {
    expect(notionDialogSource).toContain('var(--dialog-shell-surface)');
    expect(buttonSource).toContain('var(--button-primary-surface)');
    expect(inputSource).toContain('var(--input-shell-surface)');
    expect(switchSource).toContain('var(--button-primary-foreground)');
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
