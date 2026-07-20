import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Workbench sidebar architecture', () => {
  it('keeps the Chat visual contract in one shared primitive module', () => {
    const source = read('src/features/workbench/components/sidebar/WorkbenchSidebar.tsx');
    expect(source).toContain('data-workbench-sidebar');
    expect(source).toContain('data-workbench-sidebar-row');
    expect(source).toContain('desktop-shell-nav-row');
    expect(source).toContain('desktop-shell-thread-row');
    expect(source).toContain('desktop-shell-sidebar-session-scroll');
  });

  it('routes every mounted first-level sidebar surface through the primitive', () => {
    const consumers = [
      'src/components/ModernSidebar.tsx',
      'src/features/todo/components/TodoShellSidebar.tsx',
      'src/features/settings/components/SettingsSidebar.tsx',
      'src/features/learning-hub/components/finder/FinderQuickAccess.tsx',
      'src/features/workbench/apps/content/ResourceAppWorkspace.tsx',
      'src/features/workbench/apps/notes/NotesWorkspaceApp.tsx',
    ];
    for (const path of consumers) {
      expect(read(path), path).toContain('WorkbenchSidebarSurface');
    }
  });

  it('uses the single OS window layout for every responsive sidebar host', () => {
    for (const path of [
      'src/features/workbench/apps/chat/ChatAppWindow.tsx',
      'src/features/workbench/apps/files/FilesAppWindow.tsx',
      'src/features/workbench/apps/content/ResourceAppWorkspace.tsx',
      'src/features/workbench/apps/notes/NotesWorkspaceApp.tsx',
      'src/features/workbench/apps/system/TodoAppWindow.tsx',
      'src/features/workbench/apps/system/SettingsAppWindow.tsx',
    ]) {
      expect(read(path), path).toContain('WorkbenchSidebarLayout');
      expect(read(path), path).not.toContain('<WbSysSidebarLayout');
    }
  });

  it('keeps layout sizing, drawer controls, and the sidebar seam under shared ownership', () => {
    const layout = read('src/features/workbench/apps/system/SystemWindowShared.tsx');
    const resourceCss = read('src/features/workbench/apps/content/ResourceAppWorkspace.css');
    const notesCss = read('src/features/workbench/apps/notes/NotesWorkspaceApp.css');
    const finder = read('src/features/learning-hub/components/finder/FinderQuickAccess.tsx');

    expect(layout).not.toContain('WbSysSidebarLayout');
    expect(resourceCss).not.toContain('--wb-resource-sidebar-width');
    expect(resourceCss).not.toContain('wb-resource-workspace-resize');
    expect(resourceCss).not.toContain('wb-resource-workspace-scrim');
    expect(resourceCss).not.toContain('border-right: 1px solid var(--wb-sidebar-seam');
    expect(notesCss).not.toContain('border-right: 1px solid var(--wb-sidebar-seam');
    expect(finder).toContain('WorkbenchSidebarRow');
  });

  it('keeps resource workspace main filling the flex content host (stats/translation/essay scroll)', () => {
    const resourceCss = read('src/features/workbench/apps/content/ResourceAppWorkspace.css');
    const sysCss = read('src/features/workbench/apps/system/SystemWindowShared.css');
    const mainRule = resourceCss.match(/\.wb-resource-workspace-main\s*\{[^}]+\}/)?.[0] ?? '';
    const contentRule = sysCss.match(/\.wb-sys-content\s*\{[^}]+\}/)?.[0] ?? '';

    // flex 宿主下 height:auto 会塌成内容高，统计页 overflow-y-auto 永不触发
    expect(mainRule).toMatch(/height:\s*100%/);
    expect(mainRule).toMatch(/max-height:\s*100%/);
    expect(mainRule).not.toMatch(/height:\s*auto/);
    expect(mainRule).not.toMatch(/max-height:\s*none/);
    expect(contentRule).toMatch(/overflow:\s*hidden/);
  });
});
