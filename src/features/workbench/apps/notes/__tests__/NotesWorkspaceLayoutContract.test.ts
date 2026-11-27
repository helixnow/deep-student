import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceCss = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/apps/notes/NotesWorkspaceApp.css'),
  'utf8',
);
const workspaceSource = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/apps/notes/NotesWorkspaceApp.tsx'),
  'utf8',
);
const chromeCss = readFileSync(
  resolve(process.cwd(), 'src/features/notes/styles/notes-editor-chrome.css'),
  'utf8',
);
const pageActionsSource = readFileSync(
  resolve(process.cwd(), 'src/features/notes/components/NotesPageActionsMenu.tsx'),
  'utf8',
);

describe('NotesWorkspaceApp layout contract', () => {
  it('stretches each workspace pane to the resizable panel bounds', () => {
    const paneRule = workspaceCss.match(/\.notes-workspace-pane\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(paneRule).toMatch(/width:\s*100%\s*;/);
    expect(paneRule).toMatch(/height:\s*100%\s*;/);
  });

  it('delegates the outer split to the shared layout and lets the main area shrink', () => {
    const workspaceRule = workspaceCss.match(/\.notes-workspace\s*\{([^}]*)\}/)?.[1] ?? '';
    const mainRule = workspaceCss.match(/\.notes-workspace-main\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(workspaceSource).toContain('WorkbenchSidebarLayout');
    expect(workspaceRule).toMatch(/display:\s*block\s*;/);
    expect(workspaceRule).not.toMatch(/grid-template-columns/);
    expect(mainRule).toMatch(/min-height:\s*0\s*;/);
  });

  it('prioritizes tabs in the notes titlebar right half with compact icon actions and quiet idle save chrome', () => {
    const titlebarTabsRule = workspaceCss.match(/\.notes-titlebar-tabs\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(titlebarTabsRule).toMatch(/padding-right:\s*10px\s*;/);
    expect(titlebarTabsRule).not.toMatch(/78px/);

    expect(workspaceCss).toMatch(/\.notes-titlebar-tabs\s+\.notes-chrome-backlinks-btn\s*\{[^}]*width:\s*28px\s*;/s);
    expect(workspaceCss).toMatch(/\.notes-titlebar-tabs\s+\.notes-chrome-backlinks-btn\s*>\s*span\s*\{[^}]*display:\s*none\s*;/s);

    expect(chromeCss).toMatch(/\.notes-tab-actions-slot\s+\.notes-chrome-text-button\s*\{[^}]*width:\s*28px\s*;/s);
    expect(chromeCss).toMatch(/\.notes-tab-actions-slot\s+\.notes-save-indicator\[data-status='saved'\]:not\(\[data-just-saved='true'\]\)/);
    expect(chromeCss).toMatch(/\.notes-tab-actions-slot\s+\.notes-save-indicator-meta\s*\{[^}]*display:\s*none\s*;/s);

    expect(pageActionsSource).toContain('notes-page-actions-meta');
  });
});
