import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('learning hub desktop header ownership', () => {
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const pageSource = readFileSync(resolve(process.cwd(), 'src/features/learning-hub/LearningHubPage.tsx'), 'utf-8');
  const filesAppSource = readFileSync(resolve(process.cwd(), 'src/features/workbench/apps/files/FilesAppWindow.tsx'), 'utf-8');

  it('portals the normal-mode Finder toolbar into the global shell header', () => {
    expect(appSource).toContain('data-shell-slot="learning-hub-toolbar"');
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
