import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOfficialShellEntries } from '@/app/__tests__/officialShellEntries';
import { readAppShellSource } from '@/app/__tests__/appShellSources';

describe('learning hub desktop header ownership', () => {
  const appSource = readAppShellSource();
  const pageSource = ['LearningHubPage.tsx', 'useLearningHubPageController.tsx']
    .map(file => readFileSync(resolve(process.cwd(), 'src/features/learning-hub', file), 'utf-8')).join('\n');
  const filesAppSource = readFileSync(resolve(process.cwd(), 'src/features/workbench/apps/files/FilesAppWindow.tsx'), 'utf-8');

  it('portals the normal-mode Finder toolbar into the global shell header', async () => {
    // 槽位为多页面共享（learning-hub / todo / skills-management 由各自 views 条目的 shell.toolbarSlot 决定 data-shell-slot）
    expect(appSource).toContain("currentView === 'learning-hub'");
    expect(appSource).toContain('data-shell-slot={activeShell.toolbarSlot}');
    const { views } = await readOfficialShellEntries();
    expect(views.get('learning-hub')?.shell?.toolbarSlot).toBe('learning-hub-toolbar');
    expect(appSource).toContain('<DesktopShellHeaderPortalProvider value={desktopShellHeaderPortalValue}>');
    expect(pageSource).toContain("useDesktopShellHeaderPortal('learning-hub')");
    expect(pageSource).toContain('toolbarPortalTarget={desktopShellHeaderTarget}');
    expect(pageSource).toContain('toolbarPortalMode="shell"');
  });

  it('keeps OS mode using its own window titlebar slot', () => {
    expect(filesAppSource).toContain("'[data-wb-titlebar-slot]'");
    expect(filesAppSource).toContain('toolbarPortalTarget={titlebarTarget}');
  });
});
