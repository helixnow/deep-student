import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceCss = readFileSync(
  resolve(process.cwd(), 'src/features/workbench/apps/notes/NotesWorkspaceApp.css'),
  'utf8',
);

describe('NotesWorkspaceApp layout contract', () => {
  it('stretches each workspace pane to the resizable panel bounds', () => {
    const paneRule = workspaceCss.match(/\.notes-workspace-pane\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(paneRule).toMatch(/width:\s*100%\s*;/);
    expect(paneRule).toMatch(/height:\s*100%\s*;/);
  });

  it('allows the workspace grid and main area to shrink within the app window', () => {
    const workspaceRule = workspaceCss.match(/\.notes-workspace\s*\{([^}]*)\}/)?.[1] ?? '';
    const mainRule = workspaceCss.match(/\.notes-workspace-main\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(workspaceRule).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(mainRule).toMatch(/min-height:\s*0\s*;/);
  });
});
