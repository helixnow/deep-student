import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesEditorHeader, type NoteBreadcrumbItem } from '../NotesEditorHeader';
import { NOTE_TAG_MAX_CHARS, NOTE_TAGS_MAX_COUNT } from '../../noteInputLimits';

const mockAppearance = vi.hoisted(() => ({
  value: { preset: 'standard' as const, icon: '', smallText: false, fullWidth: false, font: 'default' as const },
  loading: false,
  saving: false,
  error: null as 'load' | 'save' | null,
  update: vi.fn(async () => true),
  reload: vi.fn(async () => {}),
}));

const mockNotify = vi.hoisted(() => vi.fn());

vi.mock('@phosphor-icons/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@phosphor-icons/react')>();
  return {
    ...actual,
    Smiley: (props: React.ComponentProps<typeof actual.Smiley>) => (
      <actual.Smiley data-testid="phosphor-smiley" {...props} />
    ),
    SlidersHorizontal: (props: React.ComponentProps<typeof actual.SlidersHorizontal>) => (
      <actual.SlidersHorizontal data-testid="phosphor-sliders" {...props} />
    ),
  };
});

vi.mock('../../noteAppearance', () => ({
  NOTE_APPEARANCE_PRESETS: ['standard', 'compact', 'wide'],
  NOTE_APPEARANCE_ICONS: ['', 'file-text', 'book-open', 'lightbulb', 'flask', 'pencil-simple'],
  NOTE_ICON_GROUPS: [],
  ALL_NOTE_ICONS: ['file-text', 'book-open', 'lightbulb'],
  renderNoteIcon: (icon: string) => (icon ? <svg data-testid={`note-icon-${icon}`} /> : null),
  useNoteAppearance: () => mockAppearance,
  useNoteIcon: () => mockAppearance.value.icon,
}));

vi.mock('../../hooks/useTagSuggestions', () => ({
  useTagSuggestions: () => ({
    suggestions: [],
    isLoading: false,
    highlightIndex: -1,
    highlighted: null,
    moveHighlight: vi.fn(() => false),
    setHighlightIndex: vi.fn(),
  }),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mockNotify,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | { defaultValue?: string; max?: number }) => {
      if (typeof opts === 'string') return opts;
      if (opts?.defaultValue) {
        return opts.max !== undefined
          ? opts.defaultValue.replace('{{max}}', String(opts.max))
          : opts.defaultValue;
      }
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

describe('NotesEditorHeader — DSTU breadcrumbs, Smiley affordance, title & tags', () => {
  beforeEach(() => {
    mockAppearance.value = {
      preset: 'standard',
      icon: '',
      smallText: false,
      fullWidth: false,
      font: 'default',
    };
    mockAppearance.loading = false;
    mockAppearance.saving = false;
    mockAppearance.error = null;
    mockAppearance.update.mockClear();
    mockAppearance.reload.mockClear();
    mockNotify.mockClear();
  });

  describe('DSTU breadcrumbs', () => {
    it('renders folders and current note with aria-current="page" and invokes onBreadcrumbClick', () => {
      const onBreadcrumbClick = vi.fn();
      const breadcrumbs: NoteBreadcrumbItem[] = [
        { id: 'folder-cs', title: 'Computer Science', type: 'folder' },
        { id: 'folder-algo', title: 'Algorithms & Data Structures', type: 'folder' },
        { id: 'note-dp', title: 'Dynamic Programming Notes', type: 'note' },
      ];

      const { container } = render(
        <NotesEditorHeader
          noteId="note-dp"
          initialTitle="Dynamic Programming Notes"
          lastSaved={null}
          tags={['CS']}
          breadcrumbs={breadcrumbs}
          onBreadcrumbClick={onBreadcrumbClick}
        />,
      );

      const header = container.querySelector('header');
      expect(header).toHaveClass('pt-5');

      const nav = screen.getByRole('navigation', { name: '笔记路径' });
      expect(nav).toBeInTheDocument();

      // Breadcrumbs sit below the document title and tags row
      const titleEl = screen.getByRole('textbox', { name: 'notes:header.documentTitle' });
      const tagsEl = screen.getByTestId('notes-editor-tags');
      expect(titleEl.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(tagsEl.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      const csButton = screen.getByRole('button', { name: 'Computer Science' });
      const algoButton = screen.getByRole('button', { name: 'Algorithms & Data Structures' });
      expect(csButton).toHaveAttribute('title', 'Computer Science');
      expect(algoButton).toHaveAttribute('title', 'Algorithms & Data Structures');

      const currentNote = within(nav).getByText('Dynamic Programming Notes').closest('[aria-current="page"]');
      expect(currentNote).not.toBeNull();
      expect(currentNote).toHaveAttribute('title', 'Dynamic Programming Notes');
      expect(within(nav).queryByRole('button', { name: 'Dynamic Programming Notes' })).toBeNull();

      fireEvent.click(csButton);
      expect(onBreadcrumbClick).toHaveBeenCalledTimes(1);
      expect(onBreadcrumbClick).toHaveBeenCalledWith(breadcrumbs[0]);

      fireEvent.click(algoButton);
      expect(onBreadcrumbClick).toHaveBeenCalledTimes(2);
      expect(onBreadcrumbClick).toHaveBeenLastCalledWith(breadcrumbs[1]);
    });

    it('renders every item as a clickable button when breadcrumbs is a parent-folder-only path', () => {
      const onBreadcrumbClick = vi.fn();
      const breadcrumbs: NoteBreadcrumbItem[] = [
        { id: 'f1', title: 'Semester 1', type: 'folder' },
        { id: 'f2', title: 'Physics', type: 'folder' },
      ];

      const { container } = render(
        <NotesEditorHeader
          noteId="note-1"
          initialTitle="Kinematics"
          lastSaved={null}
          breadcrumbs={breadcrumbs}
          onBreadcrumbClick={onBreadcrumbClick}
        />,
      );

      expect(container.querySelector('[aria-current="page"]')).toBeNull();

      const f1Btn = screen.getByRole('button', { name: 'Semester 1' });
      const f2Btn = screen.getByRole('button', { name: 'Physics' });

      fireEvent.click(f1Btn);
      fireEvent.click(f2Btn);
      expect(onBreadcrumbClick).toHaveBeenNthCalledWith(1, breadcrumbs[0]);
      expect(onBreadcrumbClick).toHaveBeenNthCalledWith(2, breadcrumbs[1]);
    });

    it('hides breadcrumb nav and keeps compact pt-5 spacing when breadcrumbs are omitted or empty', () => {
      const { container, rerender } = render(
        <NotesEditorHeader
          noteId="note-root"
          initialTitle="Root Note"
          lastSaved={null}
        />,
      );

      expect(screen.queryByRole('navigation')).toBeNull();
      expect(container.querySelector('header')).toHaveClass('pt-5');

      rerender(
        <NotesEditorHeader
          noteId="note-root"
          initialTitle="Root Note"
          lastSaved={null}
          breadcrumbs={[]}
        />,
      );

      expect(screen.queryByRole('navigation')).toBeNull();
      expect(container.querySelector('header')).toHaveClass('pt-5');
    });
  });

  describe('Smiley icon affordance', () => {
    it('renders Smiley icon (not SlidersHorizontal) for Add icon and Change icon affordances', () => {
      const { rerender } = render(
        <NotesEditorHeader
          noteId="note-icon"
          initialTitle="Untitled"
          lastSaved={null}
        />,
      );

      const trigger = screen.getByRole('button', { name: '页面图标' });
      expect(trigger).toHaveTextContent('添加图标');
      expect(trigger.querySelector('[data-testid="phosphor-smiley"]')).not.toBeNull();
      expect(trigger.querySelector('[data-testid="phosphor-sliders"]')).toBeNull();

      mockAppearance.value = { ...mockAppearance.value, icon: '📚' };
      rerender(
        <NotesEditorHeader
          noteId="note-icon"
          initialTitle="Untitled"
          lastSaved={null}
        />,
      );

      const updatedTrigger = screen.getByRole('button', { name: '页面图标' });
      expect(updatedTrigger).toHaveTextContent('更换图标');
      expect(updatedTrigger.querySelector('[data-testid="phosphor-smiley"]')).not.toBeNull();
      expect(updatedTrigger.querySelector('[data-testid="phosphor-sliders"]')).toBeNull();
    });
  });

  describe('title keyboard interactions and IME safety', () => {
    it('commits trimmed title on Enter and calls onExitToBody', async () => {
      const onTitleChange = vi.fn(async () => {});
      const onExitToBody = vi.fn();

      render(
        <NotesEditorHeader
          noteId="note-title"
          initialTitle="Old Title"
          lastSaved={null}
          onTitleChange={onTitleChange}
          onExitToBody={onExitToBody}
        />,
      );

      const title = screen.getByRole('textbox', { name: 'notes:header.documentTitle' });
      act(() => title.focus());
      fireEvent.change(title, { target: { value: '  New Title  ' } });
      fireEvent.keyDown(title, { key: 'Enter' });

      await waitFor(() => expect(onTitleChange).toHaveBeenCalledExactlyOnceWith('New Title'));
      expect(onExitToBody).toHaveBeenCalledTimes(1);
    });

    it('moves focus to body on ArrowDown only when caret is at the end of the title', async () => {
      const onTitleChange = vi.fn(async () => {});
      const onExitToBody = vi.fn();

      render(
        <NotesEditorHeader
          noteId="note-arrow"
          initialTitle="Hello"
          lastSaved={null}
          onTitleChange={onTitleChange}
          onExitToBody={onExitToBody}
        />,
      );

      const title = screen.getByRole('textbox', { name: 'notes:header.documentTitle' }) as HTMLTextAreaElement;
      act(() => title.focus());

      // Caret in the middle: should NOT exit to body
      title.setSelectionRange(2, 2);
      fireEvent.keyDown(title, { key: 'ArrowDown' });
      expect(onExitToBody).not.toHaveBeenCalled();

      // Caret at the end: should commit and exit to body
      fireEvent.change(title, { target: { value: 'Hello World' } });
      title.setSelectionRange(11, 11);
      fireEvent.keyDown(title, { key: 'ArrowDown' });

      await waitFor(() => expect(onTitleChange).toHaveBeenCalledExactlyOnceWith('Hello World'));
      expect(onExitToBody).toHaveBeenCalledTimes(1);
    });

    it('reverts unsaved title on Escape without calling onTitleChange', () => {
      const onTitleChange = vi.fn(async () => {});

      render(
        <NotesEditorHeader
          noteId="note-esc"
          initialTitle="Original Title"
          lastSaved={null}
          onTitleChange={onTitleChange}
        />,
      );

      const title = screen.getByRole('textbox', { name: 'notes:header.documentTitle' });
      act(() => title.focus());
      fireEvent.change(title, { target: { value: 'Draft Title' } });
      expect(title).toHaveValue('Draft Title');

      fireEvent.keyDown(title, { key: 'Escape' });
      expect(title).toHaveValue('Original Title');
      expect(onTitleChange).not.toHaveBeenCalled();
    });

    it.each([{ isComposing: true }, { keyCode: 229 }])(
      'ignores Enter, Escape, and ArrowDown during IME composition (%j)',
      (composition) => {
        const onTitleChange = vi.fn(async () => {});
        const onExitToBody = vi.fn();

        render(
          <NotesEditorHeader
            noteId="note-ime"
            initialTitle="Initial"
            lastSaved={null}
            onTitleChange={onTitleChange}
            onExitToBody={onExitToBody}
          />,
        );

        const title = screen.getByRole('textbox', { name: 'notes:header.documentTitle' }) as HTMLTextAreaElement;
        act(() => title.focus());
        fireEvent.change(title, { target: { value: '候选词' } });
        title.setSelectionRange(3, 3);

        for (const key of ['Enter', 'Escape', 'ArrowDown']) {
          fireEvent.keyDown(title, { key, ...composition });
        }

        expect(title).toHaveFocus();
        expect(title).toHaveValue('候选词');
        expect(onTitleChange).not.toHaveBeenCalled();
        expect(onExitToBody).not.toHaveBeenCalled();
      },
    );
  });

  describe('inline tag addition, validation, and removal', () => {
    it('adds a valid tag, ignores case-insensitive duplicates, and removes an existing tag', async () => {
      const onTagsChange = vi.fn(async () => {});

      const { rerender } = render(
        <NotesEditorHeader
          noteId="note-tags"
          initialTitle="Tagged Note"
          lastSaved={null}
          tags={['Math']}
          onTagsChange={onTagsChange}
        />,
      );

      // Open tag input
      fireEvent.click(screen.getByRole('button', { name: 'notes:header.add_tags' }));
      const input = screen.getByRole('combobox', { name: 'notes:header.add_tags' });

      // Duplicate (case-insensitive) should be ignored without calling onTagsChange
      fireEvent.change(input, { target: { value: 'math' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onTagsChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('');

      // Add a valid new tag
      fireEvent.change(input, { target: { value: 'Physics' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(onTagsChange).toHaveBeenCalledWith(['Math', 'Physics']));

      // Rerender with updated tags and remove 'Math'
      rerender(
        <NotesEditorHeader
          noteId="note-tags"
          initialTitle="Tagged Note"
          lastSaved={null}
          tags={['Math', 'Physics']}
          onTagsChange={onTagsChange}
        />,
      );

      const removeButtons = screen.getAllByRole('button', { name: 'notes:header.remove_tag' });
      expect(removeButtons).toHaveLength(2);
      fireEvent.click(removeButtons[0]);
      await waitFor(() => expect(onTagsChange).toHaveBeenLastCalledWith(['Physics']));
    });

    it('validates tag length, control characters, and maximum tag count', () => {
      const onTagsChange = vi.fn(async () => {});

      const { rerender } = render(
        <NotesEditorHeader
          noteId="note-tag-validation"
          initialTitle="Validation"
          lastSaved={null}
          tags={[]}
          onTagsChange={onTagsChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'notes:header.add_tags' }));
      const input = screen.getByRole('combobox', { name: 'notes:header.add_tags' });

      // Too long
      fireEvent.change(input, { target: { value: 'a'.repeat(NOTE_TAG_MAX_CHARS + 1) } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent(
        `Tags can be at most ${NOTE_TAG_MAX_CHARS} characters`,
      );
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(onTagsChange).not.toHaveBeenCalled();

      // Control characters
      fireEvent.change(input, { target: { value: 'bad\u0007tag' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent("Tags can't contain control characters");
      expect(onTagsChange).not.toHaveBeenCalled();

      // Max count reached
      const maxTags = Array.from({ length: NOTE_TAGS_MAX_COUNT }, (_, i) => `tag-${i + 1}`);
      rerender(
        <NotesEditorHeader
          noteId="note-tag-validation"
          initialTitle="Validation"
          lastSaved={null}
          tags={maxTags}
          onTagsChange={onTagsChange}
        />,
      );

      fireEvent.change(input, { target: { value: 'one-more' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByRole('alert')).toHaveTextContent(
        `You can add up to ${NOTE_TAGS_MAX_COUNT} tags`,
      );
      expect(onTagsChange).not.toHaveBeenCalled();
    });
  });
});
