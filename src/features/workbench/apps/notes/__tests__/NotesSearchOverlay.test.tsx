import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { search } = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { search },
}));

import { NotesSearchOverlay, stripNotesSearchSnippet } from '../NotesSearchOverlay';

function node(overrides: Partial<DstuNode> = {}): DstuNode {
  return {
    id: 'note_1',
    sourceId: 'note_1',
    path: '/course/note_1',
    name: 'Algebra',
    type: 'note',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('NotesSearchOverlay', () => {
  beforeEach(() => {
    search.mockReset();
  });

  it('quick-opens only passed workspace resources without issuing a DSTU search', async () => {
    const algebra = node();
    const geometry = node({
      id: 'mindmap_2',
      sourceId: 'mindmap_2',
      path: '/course/mindmap_2',
      name: 'Geometry map',
      type: 'mindmap',
    });
    const attachment = node({
      id: 'file_3',
      sourceId: 'file_3',
      path: '/course/file_3',
      name: 'Geometry handout',
      type: 'file',
    });
    const onOpenResource = vi.fn();
    const onClose = vi.fn();

    render(
      <NotesSearchOverlay
        open
        resources={[algebra, geometry, attachment]}
        onOpenResource={onOpenResource}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    fireEvent.change(input, { target: { value: 'geometry' } });

    expect(screen.getByRole('option', { name: /Geometry map/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Geometry handout/ })).toBeNull();
    expect(search).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('option', { name: /Geometry map/ }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(geometry, {
      mode: 'quick-open',
      query: 'geometry',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leads an empty quick-open query with the recently opened group', () => {
    const algebra = node({ updatedAt: 10 });
    const biology = node({
      id: 'note_2',
      sourceId: 'note_2',
      path: '/science/note_2',
      name: 'Biology',
      updatedAt: 20,
    });
    const chemistry = node({
      id: 'note_3',
      sourceId: 'note_3',
      path: '/science/note_3',
      name: 'Chemistry',
      updatedAt: 30,
    });

    render(
      <NotesSearchOverlay
        open
        resources={[algebra, biology, chemistry]}
        recentResources={[biology]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const options = screen.getAllByRole('option');
    // 最近打开的 Biology 置顶，其余按更新时间排序且不重复出现
    expect(options[0]).toHaveTextContent('Biology');
    expect(options).toHaveLength(3);
    expect(screen.getByText('Recently opened')).toBeInTheDocument();
    expect(screen.getByText('All files')).toBeInTheDocument();

    // 输入查询后回到纯相关性排序，分组标题消失
    fireEvent.change(screen.getByRole('combobox', { name: 'Search notes' }), {
      target: { value: 'chem' },
    });
    expect(screen.queryByText('Recently opened')).toBeNull();
    expect(screen.getByRole('option', { name: /Chemistry/ })).toBeInTheDocument();
  });

  it('searches full text through DSTU, renders a safe snippet, and filters unsupported results', async () => {
    const matchedNote = node({
      name: 'Quadratic equations',
      metadata: { snippet: 'Solve <b>quadratic</b> equations with the formula.' },
    });
    const matchedMindMap = node({
      id: 'mindmap_2',
      sourceId: 'mindmap_2',
      type: 'mindmap',
      name: 'Quadratic map',
    });
    const unsupportedFile = node({
      id: 'file_3',
      sourceId: 'file_3',
      type: 'file',
      name: 'Quadratic worksheet',
    });
    search.mockResolvedValue({ ok: true, value: [matchedNote, matchedMindMap, unsupportedFile] });
    const onOpenResource = vi.fn();
    const onClose = vi.fn();

    render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        initialQuery="quadratic"
        searchDebounceMs={0}
        resources={[]}
        onOpenResource={onOpenResource}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(search).toHaveBeenCalledWith('quadratic', expect.objectContaining({
      types: ['note', 'mindmap'],
    })));
    expect(await screen.findByRole('option', { name: /Quadratic equations/ })).toBeInTheDocument();
    expect(screen.getByText((_, node) => (
      node?.classList.contains('notes-search-overlay-result-snippet')
      && node.textContent === 'Solve quadratic equations with the formula.'
    ))).toBeInTheDocument();
    expect(document.querySelectorAll('mark.nso-hl').length).toBeGreaterThan(0);
    expect(screen.queryByRole('option', { name: /Quadratic worksheet/ })).toBeNull();

    fireEvent.click(screen.getByRole('option', { name: /Quadratic equations/ }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(matchedNote, {
      mode: 'full-text',
      query: 'quadratic',
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the combobox while arrow keys navigate options, Enter opens, and Escape closes', async () => {
    const algebra = node({ name: 'Algebra' });
    const biology = node({
      id: 'note_2',
      sourceId: 'note_2',
      path: '/science/note_2',
      name: 'Biology',
    });
    const onOpenResource = vi.fn();
    const onClose = vi.fn();

    render(
      <NotesSearchOverlay
        open
        resources={[algebra, biology]}
        onOpenResource={onOpenResource}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    await waitFor(() => expect(input).toHaveFocus());
    const initialActive = input.getAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveFocus();
    expect(input.getAttribute('aria-activedescendant')).not.toBe(initialActive);
    expect(screen.getByRole('option', { name: /Biology/ })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(biology, {
      mode: 'quick-open',
      query: '',
    }));

    fireEvent.keyDown(screen.getByRole('region', { name: 'Search notes' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not let a slower full-text request replace a newer query result', async () => {
    const resolvers = new Map<string, (value: { ok: true; value: DstuNode[] }) => void>();
    search.mockImplementation((query: string) => new Promise((resolve) => {
      resolvers.set(query, resolve as (value: { ok: true; value: DstuNode[] }) => void);
    }));

    render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        initialQuery="first"
        searchDebounceMs={0}
        resources={[]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(search).toHaveBeenCalledWith('first', expect.any(Object)));
    const input = screen.getByRole('combobox', { name: 'Search notes' });
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('second', expect.any(Object)));

    await act(async () => {
      resolvers.get('second')?.({ ok: true, value: [node({ name: 'Second result' })] });
    });
    expect(await screen.findByRole('option', { name: /Second result/ })).toBeInTheDocument();

    await act(async () => {
      resolvers.get('first')?.({ ok: true, value: [node({ name: 'First result' })] });
    });
    expect(screen.queryByRole('option', { name: /First result/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Second result/ })).toBeInTheDocument();
  });

  it('does not leave old full-text results actionable while a new query is pending', async () => {
    let resolveSecond: ((value: { ok: true; value: DstuNode[] }) => void) | undefined;
    search.mockImplementation((query: string) => {
      if (query === 'first') return Promise.resolve({ ok: true, value: [node({ name: 'First result' })] });
      return new Promise((resolve) => {
        resolveSecond = resolve as (value: { ok: true; value: DstuNode[] }) => void;
      });
    });
    const onOpenResource = vi.fn();

    render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        initialQuery="first"
        searchDebounceMs={0}
        resources={[]}
        onOpenResource={onOpenResource}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('option', { name: /First result/ })).toBeInTheDocument();
    const input = screen.getByRole('combobox', { name: 'Search notes' });
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => expect(search).toHaveBeenCalledWith('second', expect.any(Object)));
    expect(screen.queryByRole('option', { name: /First result/ })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenResource).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecond?.({ ok: true, value: [node({ name: 'Second result' })] });
    });
    expect(await screen.findByRole('option', { name: /Second result/ })).toBeInTheDocument();
  });

  it('clears a full-text error when switching back to quick open', async () => {
    search.mockResolvedValue({ ok: false, error: new Error('offline') });
    render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        initialQuery="term"
        searchDebounceMs={0}
        resources={[node({ name: 'Term quick result' })]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Quick open' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('option', { name: /Term quick result/ })).toBeInTheDocument();
  });

  it('strips FTS markup before snippets are exposed as text', () => {
    expect(stripNotesSearchSnippet('  <b>term</b>\n  x < y > z <em>context</em>  '))
      .toBe('term x < y > z <em>context</em>');
    expect(stripNotesSearchSnippet(null)).toBeNull();
  });

  it('parses tag: filters in full-text mode and strips them from the DSTU query', async () => {
    const kept = node({
      name: 'Tagged note',
      metadata: { tags: ['math'], snippet: 'body with formula' },
    });
    const dropped = node({
      id: 'note_2',
      sourceId: 'note_2',
      name: 'Other note',
      metadata: { tags: ['physics'], snippet: 'body with formula' },
    });
    search.mockResolvedValue({ ok: true, value: [kept, dropped] });

    render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        initialQuery="formula tag:math"
        searchDebounceMs={0}
        resources={[]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(search).toHaveBeenCalledWith(
      'formula',
      expect.objectContaining({ tags: ['math'] }),
    ));
    expect(await screen.findByRole('option', { name: /Tagged note/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Other note/ })).toBeNull();
    expect(screen.getByText('math')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /移除标签 math/ }));
    expect(screen.getByRole('combobox')).toHaveValue('formula');
  });

  it('only exposes a combobox popup relationship when its result list is rendered', async () => {
    const { rerender } = render(
      <NotesSearchOverlay
        open
        initialMode="full-text"
        resources={[]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Search notes' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');

    rerender(
      <NotesSearchOverlay
        open
        mode="quick-open"
        resources={[node()]}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'true'));
    expect(input).toHaveAttribute('aria-controls');
  });
});
