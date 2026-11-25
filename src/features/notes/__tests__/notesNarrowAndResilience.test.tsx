import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, stableTranslate } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  stableTranslate: (key: string, opts?: string | { defaultValue?: string }) =>
    typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: stableTranslate,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
}));

vi.mock('@/components/ui/DsDialog', () => ({
  DsDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DsAlertDialog: () => null,
}));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: ({ resourceId }: { resourceId: string }) => <div data-testid="mock-pdf-panel">{resourceId}</div>,
}));

vi.mock('../noteAppearance', () => ({
  ALL_NOTE_ICONS: ['📝'],
  NOTE_APPEARANCE_ICONS: ['📝'],
  NOTE_ICON_GROUPS: [{ key: 'study', icons: ['📝'] }],
  useNoteIcon: () => undefined,
  useNoteAppearance: () => ({
    value: { preset: 'default', smallText: false, fullWidth: false, font: 'default', icon: '' },
    loading: false,
    saving: false,
    error: null,
    update: vi.fn(),
    reload: vi.fn(),
  }),
}));

vi.mock('../noteTagsApi', () => ({
  listAllNoteTags: vi.fn().mockResolvedValue([]),
  renameNoteTagAcrossLibrary: vi.fn().mockResolvedValue({ updatedCount: 0 }),
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import { NotesEditorHeader } from '../components/NotesEditorHeader';
import { NoteRelationPreview } from '../components/NoteRelationPreview';
import { NotesContextPanel } from '../NotesContextPanel';

const LONG_SPECIAL_TITLE =
  '学习笔记🚀Quantum Mechanics & Linear Algebra <α+β>[2026]/#?&最终修订版测试标题超长边界校验XYZ12345';

const readCss = (relPath: string) => readFileSync(resolve(process.cwd(), relPath), 'utf8');

describe('Notes narrow container CSS contracts (440–560px split window)', () => {
  it('defines container queries for NotesWorkspaceApp, notes-editor-chrome, and NotesEditorHeader', () => {
    const workspaceCss = readCss('src/features/workbench/apps/notes/NotesWorkspaceApp.css');
    const chromeCss = readCss('src/features/notes/styles/notes-editor-chrome.css');
    const headerCss = readCss('src/features/notes/components/NotesEditorHeader.css');
    const backlinksExtrasCss = readCss('src/features/workbench/apps/notes/notes-backlinks-extras.css');
    const searchCss = readCss('src/features/workbench/apps/notes/NotesSearchOverlay.css');

    expect(workspaceCss).toContain('container-type: inline-size;');
    expect(workspaceCss).toMatch(/@container\s+notes-tabbar\s*\(max-width:\s*560px\)[\s\S]*\.notes-chrome-backlinks-btn\s*>\s*span[\s\S]*display:\s*none/);
    expect(workspaceCss).toMatch(/@container\s+notes-tabbar\s*\(max-width:\s*460px\)[\s\S]*\.notes-tab\s*\{[^}]*min-width:\s*72px/s);

    expect(chromeCss).toMatch(/@container\s+notes-shell\s*\(max-width:\s*560px\)[\s\S]*\.notes-editor-chrome-row\s+\.notes-save-indicator-meta[\s\S]*display:\s*none/);
    expect(chromeCss).toMatch(/@container\s+notes-shell\s*\(max-width:\s*460px\)[\s\S]*--notes-gutter:\s*16px/);

    expect(headerCss).toContain('container-type: inline-size;');
    expect(headerCss).toMatch(/@container\s*\(max-width:\s*560px\)[\s\S]*\.notes-document-breadcrumbs\s+\.notes-breadcrumb-label[\s\S]*max-width:\s*120px/);
    expect(headerCss).toMatch(/@container\s*\(max-width:\s*460px\)[\s\S]*\.notes-document-breadcrumbs\s+\.notes-breadcrumb-label[\s\S]*max-width:\s*96px/);

    expect(backlinksExtrasCss).toMatch(/\.notes-backlinks-panel-link-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(searchCss).toMatch(/@container\s+notes-search\s*\(max-width:\s*560px\)/);
  });
});

describe('Notes long & special-character title resilience', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('safely renders 80-char CJK/Latin/Emoji/<>[]/#?& titles and tags in NotesEditorHeader', () => {
    render(
      <NotesEditorHeader
        noteId="note-long-1"
        lastSaved={null}
        saveStatus="saved"
        initialTitle={LONG_SPECIAL_TITLE}
        tags={[LONG_SPECIAL_TITLE]}
        breadcrumbs={[
          { id: 'folder-1', type: 'folder', title: `目录/${LONG_SPECIAL_TITLE}` },
          { id: 'note-long-1', type: 'note', title: LONG_SPECIAL_TITLE },
        ]}
        onBreadcrumbClick={vi.fn()}
      />,
    );

    const titleTextarea = screen.getByRole('textbox', { name: 'notes:header.documentTitle' });
    expect(titleTextarea).toHaveValue(LONG_SPECIAL_TITLE);
    expect(titleTextarea).toHaveAttribute('title', LONG_SPECIAL_TITLE);
    expect(titleTextarea).toHaveClass('min-w-0');

    const folderCrumb = screen.getByRole('button', { name: `目录/${LONG_SPECIAL_TITLE}` });
    expect(folderCrumb).toHaveAttribute('title', `目录/${LONG_SPECIAL_TITLE}`);

    const currentCrumb = screen.getByText(LONG_SPECIAL_TITLE, { selector: '.notes-breadcrumb-label' }).closest('.notes-breadcrumb-current');
    expect(currentCrumb).toHaveAttribute('title', LONG_SPECIAL_TITLE);

    const tagEl = screen.getByTestId('notes-editor-tags').querySelector('[title]');
    expect(tagEl).toHaveAttribute('title', LONG_SPECIAL_TITLE);
    expect(tagEl).toHaveClass('min-w-0', 'truncate');
  });

  it('safely renders 80-char CJK/Latin/Emoji/<>[]/#?& headings and tags in NotesContextPanel', () => {
    const { container } = render(
      <NotesContextPanel
        noteId="note-long-1"
        title={LONG_SPECIAL_TITLE}
        createdAt={1700000000000}
        updatedAt={1700000000000}
        tags={[LONG_SPECIAL_TITLE]}
        content={`# ${LONG_SPECIAL_TITLE}\n\nParagraph text`}
        contentStatus="ready"
        sections="all"
      />,
    );

    const outlineRow = container.querySelector('.notes-outline-row');
    expect(outlineRow).toHaveClass('min-w-0', 'overflow-hidden');

    const outlineBtn = screen.getByRole('button', { name: LONG_SPECIAL_TITLE });
    expect(outlineBtn).toHaveAttribute('title', LONG_SPECIAL_TITLE);

    const tagSpan = container.querySelector('.notes-context-tag span[title]');
    expect(tagSpan).toHaveAttribute('title', LONG_SPECIAL_TITLE);
    expect(tagSpan).toHaveClass('min-w-0', 'truncate');
  });
});

describe('NoteRelationPreview PDF auto-focus precision', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('automatically focuses the exact PDF page once the preview source resolves without staying on Page 1', async () => {
    invokeMock.mockResolvedValue({ sourceId: 'tb_calculus' });

    const focusDetails: Array<{ sourceId?: string; pageNumber?: number }> = [];
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      focusDetails.push({ sourceId: detail.sourceId, pageNumber: detail.pageNumber });
      detail.acknowledge?.(true);
    };
    document.addEventListener('pdf-ref:focus', onFocus);

    render(
      <NoteRelationPreview
        relation={{
          id: 'rel-1',
          type: 'textbook',
          resource_id: 'vfs_calculus_pdf',
          locator: { type: 'page', value: 27 },
          created_at: 1,
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(focusDetails).toEqual([{ sourceId: 'tb_calculus', pageNumber: 27 }]);
    });

    document.removeEventListener('pdf-ref:focus', onFocus);
  });
});
