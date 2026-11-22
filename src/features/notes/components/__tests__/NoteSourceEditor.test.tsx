import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteSourceEditor, type NoteSourceEditorHandle } from '../NoteSourceEditor';

const sourceEditorCss = readFileSync(
  resolve(process.cwd(), 'src/features/notes/components/NoteSourceEditor.css'),
  'utf8',
);

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

const findEditorView = (container: HTMLElement): EditorView => {
  const cmEditor = container.querySelector('.cm-editor');
  if (!cmEditor) {
    throw new Error('CodeMirror .cm-editor element not found');
  }
  const view = EditorView.findFromDOM(cmEditor as HTMLElement);
  if (!view) {
    throw new Error('EditorView instance not attached to .cm-editor');
  }
  return view;
};

describe('NoteSourceEditor', () => {
  it('renders the source badge, line count, and initial markdown content', () => {
    const initial = '# Hello\n\nSecond paragraph\nThird line';
    const { container } = render(
      <NoteSourceEditor
        value={initial}
        onChange={vi.fn()}
        ariaLabel="Test Source Editor"
      />,
    );

    expect(screen.getByText('Markdown 源码')).toBeInTheDocument();
    expect(screen.getByTestId('notes-source-line-count')).toHaveTextContent('4 行');

    const contentEl = container.querySelector('.cm-content');
    expect(contentEl).toHaveAttribute('aria-label', 'Test Source Editor');

    const view = findEditorView(container);
    expect(view.state.doc.toString()).toBe(initial);
  });

  it('emits onChange on local edits while preserving cursor across controlled re-render', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <NoteSourceEditor value="Hello world" onChange={onChange} />,
    );

    const view = findEditorView(container);
    act(() => {
      view.dispatch({
        changes: { from: 5, to: 5, insert: ' Markdown' },
        selection: { anchor: 14 },
      });
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Hello Markdown world');
    expect(view.state.selection.main.head).toBe(14);

    // Controlled parent reflects the same value back: cursor stays intact, no extra onChange
    rerender(<NoteSourceEditor value="Hello Markdown world" onChange={onChange} />);
    expect(view.state.selection.main.head).toBe(14);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('syncs external value updates cleanly without emitting onChange', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <NoteSourceEditor value="# Initial" onChange={onChange} />,
    );

    const view = findEditorView(container);
    expect(view.state.doc.toString()).toBe('# Initial');

    rerender(<NoteSourceEditor value={'# Updated\nLine 2\nLine 3'} onChange={onChange} />);

    expect(view.state.doc.toString()).toBe('# Updated\nLine 2\nLine 3');
    expect(screen.getByTestId('notes-source-line-count')).toHaveTextContent('3 行');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('supports readOnly mode and blocks editing callbacks', () => {
    const onChange = vi.fn();
    const { container } = render(
      <NoteSourceEditor value="# Locked" readOnly onChange={onChange} />,
    );

    const root = container.querySelector('.notes-source-editor');
    expect(root).toHaveAttribute('data-readonly', 'true');
    expect(screen.getByText('只读')).toBeInTheDocument();

    const contentEl = container.querySelector('.cm-content');
    expect(contentEl).toHaveAttribute('aria-readonly', 'true');

    const view = findEditorView(container);
    expect(view.state.readOnly).toBe(true);
  });

  it('fires onFocus and onBlur callbacks', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const { container } = render(
      <NoteSourceEditor
        value="Focus test"
        onChange={vi.fn()}
        onFocus={onFocus}
        onBlur={onBlur}
      />,
    );

    const contentEl = container.querySelector('.cm-content') as HTMLElement;
    fireEvent.focus(contentEl);
    fireEvent.blur(contentEl);

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('tracks light/dark theme changes via html class observer', async () => {
    const { container } = render(
      <NoteSourceEditor value="# Theme" onChange={vi.fn()} />,
    );

    const root = container.querySelector('.notes-source-editor');
    expect(root).toHaveAttribute('data-theme-mode', 'light');

    act(() => {
      document.documentElement.classList.add('dark');
    });

    await waitFor(() => {
      expect(root).toHaveAttribute('data-theme-mode', 'dark');
    });
  });

  it('uses paper canvas tokens, notes-ink, mono typography, coarse 16px, shadow-base, and reduced-motion in CSS', () => {
    expect(sourceEditorCss).toContain('background: transparent;');
    expect(sourceEditorCss).toContain('var(--notes-ink, hsl(var(--foreground)))');
    expect(sourceEditorCss).toContain('font-family: var(--font-mono);');
    expect(sourceEditorCss).toContain('font-size: calc(14px * var(--font-size-scale, 1));');
    expect(sourceEditorCss).toContain('line-height: 1.7;');
    expect(sourceEditorCss).toContain('@media (pointer: coarse)');
    expect(sourceEditorCss).toContain('font-size: 16px;');
    expect(sourceEditorCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(sourceEditorCss).not.toMatch(/box-shadow[^;]*--foreground/);
    expect(sourceEditorCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('exposes imperative focus and openSearch handle methods and renders exit button when onExitSourceMode is provided', () => {
    const ref = React.createRef<NoteSourceEditorHandle>();
    const onExitSourceMode = vi.fn();
    const { container } = render(
      <NoteSourceEditor
        ref={ref}
        value={'# GFM Title\n\n- [x] Done\n~~strike~~\n\n| A | B |\n| - | - |\n| 1 | 2 |'}
        onChange={vi.fn()}
        onExitSourceMode={onExitSourceMode}
      />,
    );

    const exitBtn = screen.getByRole('button', { name: '返回可视化编辑' });
    fireEvent.click(exitBtn);
    expect(onExitSourceMode).toHaveBeenCalledTimes(1);

    const view = findEditorView(container);
    const focusSpy = vi.spyOn(view, 'focus');
    act(() => {
      ref.current?.focus();
    });
    expect(focusSpy).toHaveBeenCalled();

    act(() => {
      ref.current?.openSearch();
    });
    expect(container.querySelector('.cm-search')).toBeInTheDocument();
  });
});
