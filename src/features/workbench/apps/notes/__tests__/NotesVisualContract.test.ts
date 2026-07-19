import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readCss = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

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
    const mindmap = readCss('src/features/mindmap/styles/mindmap.css');

    expect(mindmap).toContain('--mm-selection: color-mix');
    expect(mindmap).toMatch(/\.outline-node-row\.selected\s*\{[^}]*var\(--mm-selection\)/s);
    expect(mindmap).toMatch(/\.outline-content-enter\s*\{[^}]*150ms/s);
    expect(mindmap).toMatch(/prefers-reduced-motion:[\s\S]*\.mindmap-container \.react-flow[\s\S]*animation:\s*none/);
  });
});
