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
});
