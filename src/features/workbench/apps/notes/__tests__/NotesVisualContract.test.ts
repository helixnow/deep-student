import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readCss = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const readCssBundle = (path: string): string => {
  const fullPath = resolve(process.cwd(), path);
  const content = readFileSync(fullPath, 'utf8');
  return content.replace(/@import\s+['"](\.[^'"]+)['"]\s*;/g, (_, rel: string) =>
    readFileSync(resolve(dirname(fullPath), rel), 'utf8'),
  );
};

describe('Notes and outline visual contracts', () => {
  it('keeps note motion short and disables tab crossfade for reduced motion', () => {
    const tokens = readCss('src/styles/notes-typography.css');
    const workspace = readCss('src/features/workbench/apps/notes/NotesWorkspaceApp.css');

    expect(tokens).toContain('--notes-hover-transition: 120ms ease');
    expect(tokens).toContain('--notes-popup-enter-duration: 150ms');
    expect(tokens).toContain('--notes-tab-transition-duration: 150ms');
    expect(workspace).toContain('.notes-document-host:not([hidden])');
    expect(workspace).toMatch(/prefers-reduced-motion:[\s\S]*\.notes-document-host:not\(\[hidden\]\)[\s\S]*animation:\s*none/);
  });

  it('uses neutral inline code and contains wide tables', () => {
    const typography = readCss('src/styles/notes-typography.css');
    const editor = readCss('src/components/crepe/CrepeEditor.css');

    expect(typography).toContain('--notes-inline-code-color: hsl(var(--foreground) / 0.86)');
    expect(editor).not.toMatch(/--crepe-color-inline-code:\s*hsl\(var\(--destructive\)\)/);
    expect(editor).toMatch(/\.crepe-editor-wrapper \.tableWrapper\s*\{[^}]*overflow-x:\s*auto/s);
  });

  it('uses neutral outline selection and respects reduced motion', () => {
    const mindmap = readCssBundle('src/features/mindmap/styles/mindmap.css');

    expect(mindmap).toContain('--mm-selection: color-mix');
    expect(mindmap).toMatch(/\.outline-node-row\.selected\s*\{[^}]*var\(--mm-selection\)/s);
    expect(mindmap).toMatch(/\.outline-content-enter\s*\{[^}]*150ms/s);
    expect(mindmap).toMatch(/prefers-reduced-motion:[\s\S]*\.mindmap-container \.react-flow[\s\S]*animation:\s*none/);
  });

  it('enforces 4-tab inspector sizing, single top divider, tree layering, split focus bar, and coarse touch targets', () => {
    const workspace = readCss('src/features/workbench/apps/notes/NotesWorkspaceApp.css');
    const backlinks = readCss('src/features/workbench/apps/notes/NotesBacklinksPanel.css');
    const propsEditor = readCss('src/features/workbench/apps/notes/NoteCustomPropsEditor.css');
    const tree = readCss('src/features/workbench/apps/notes/tree/NotesWorkspaceTree.css');

    // Inspector width & coarse tab targets
    expect(workspace).toContain('clamp(236px, 22vw, 300px)');
    expect(backlinks).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.notes-backlinks-panel-tab\s*\{[^}]*min-width:\s*44px/s);
    // Avoid double top divider on properties tab
    expect(propsEditor).toContain('.notes-props-editor:not(:first-child)');
    expect(propsEditor).not.toMatch(/\.notes-props-editor\s*\{[^}]*border-top:/s);
    // Tree indent guide beneath row, popover z-index token, coarse touch cleanup
    expect(tree).toMatch(/\.nwt-indent-guide\s*\{[^}]*z-index:\s*0\s*;/s);
    expect(tree).toMatch(/\.nwt-row\s*\{[^}]*z-index:\s*1\s*;/s);
    expect(tree).toMatch(/\.nwt-context-menu\s*\{[^}]*z-index:\s*var\(--z-popover,\s*3100\)\s*;/s);
    expect(tree).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.nwt-indent-guide\s*\{[^}]*opacity:\s*0\.42/s);
    expect(tree).toMatch(/@media\s*\(pointer:\s*coarse\)[\s\S]*\.nwt-link-drag\s*\{[^}]*display:\s*none/s);
    // Split focus bar & coarse subscreen tree rows (explorer keeps file tree only, no 4-view switch bar)
    expect(workspace).toContain(".notes-workspace-main[data-notes-split='true'] .notes-workspace-pane[data-focused='true']::before");
    expect(workspace).not.toMatch(/\.notes-tab\[data-(?:main|right)-split='true'\][\s\S]*?inset\s+0\s+-2px/);
    expect(workspace).toContain('.notes-files-subscreen .nwt-row');
    expect(workspace).not.toContain('.notes-view-switch');
  });
});
