import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { getContent, search, watch } = vi.hoisted(() => ({
  getContent: vi.fn(),
  search: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { getContent, search, watch },
}));

import { BACKLINK_CANDIDATE_LIMIT, NotesBacklinksPanel } from '../NotesBacklinksPanel';

const notes: DstuNode[] = [
  {
    id: 'note_alpha', sourceId: 'note_alpha', path: '/math/note_alpha', name: 'Alpha', type: 'note', createdAt: 1, updatedAt: 1,
  },
  {
    id: 'note_beta', sourceId: 'note_beta', path: '/math/note_beta', name: 'Beta', type: 'note', createdAt: 2, updatedAt: 2,
  },
  {
    id: 'note_gamma', sourceId: 'note_gamma', path: '/math/note_gamma', name: 'Gamma', type: 'note', createdAt: 3, updatedAt: 3,
  },
  {
    id: 'note_delta', sourceId: 'note_delta', path: '/math/note_delta', name: 'Delta', type: 'note', createdAt: 4, updatedAt: 4,
  },
];

const contentByPath: Record<string, string> = {
  '/math/note_alpha': '[[Beta]] [[note_gamma|Gamma alias]] [[missing]]',
  '/math/note_beta': 'Points back to [[Alpha|Alpha alias]].',
  '/math/note_gamma': 'Points back to [[note_alpha]].',
  '/math/note_delta': 'No links here.',
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof NotesBacklinksPanel>> = {}) {
  const onOpenResource = vi.fn();
  const onClose = vi.fn();
  return {
    onOpenResource,
    onClose,
    ...render(
      <NotesBacklinksPanel
        open
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={onOpenResource}
        onClose={onClose}
        {...overrides}
      />,
    ),
  };
}

describe('NotesBacklinksPanel', () => {
  beforeEach(() => {
    getContent.mockReset();
    search.mockReset();
    watch.mockReset();
    getContent.mockImplementation(async (path: string) => ({ ok: true, value: contentByPath[path] }));
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_alpha]]'
        ? [notes[2]]
        : query === '[[Alpha|'
          ? [notes[1]]
          : [],
    }));
    watch.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads only the active note and narrow backlink candidates', async () => {
    const { rerender } = renderPanel({ open: false });
    expect(getContent).not.toHaveBeenCalled();

    rerender(
      <NotesBacklinksPanel
        open
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('Outgoing links')).toBeInTheDocument();
    expect(getContent).toHaveBeenCalledTimes(3);
    expect(getContent).toHaveBeenCalledWith('/math/note_alpha');
    expect(getContent).toHaveBeenCalledWith('/math/note_beta');
    expect(getContent).toHaveBeenCalledWith('/math/note_gamma');
    expect(getContent).not.toHaveBeenCalledWith('/math/note_delta');
    expect(search).toHaveBeenCalledWith('[[note_alpha]]', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[note_alpha|', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha]]', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha|', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[ Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(screen.getByText('Gamma alias')).toBeInTheDocument();
    expect(screen.getByText('[[missing]]')).toBeInTheDocument();
    expect(screen.getByText('Backlinks')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /Outgoing links/ }))
      .getByRole('button', { name: 'Open Beta' })).toHaveTextContent('Beta');
    expect(screen.queryByText('Alpha alias')).toBeNull();
  });

  it('opens a resolved linked note and refreshes all cached note contents on request', async () => {
    const { onOpenResource } = renderPanel();
    await screen.findByText('Outgoing links');

    fireEvent.click(within(screen.getByRole('region', { name: /Outgoing links/ }))
      .getByRole('button', { name: 'Open Gamma' }));
    await waitFor(() => expect(onOpenResource).toHaveBeenCalledWith(notes[2]));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh linked notes' }));
    await waitFor(() => expect(getContent).toHaveBeenCalledTimes(6));
    expect(search).toHaveBeenCalledTimes(24);
  });

  it('limits note-content fetches to the bounded concurrency pool', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const manyNotes = Array.from({ length: 12 }, (_, index): DstuNode => ({
      id: `note_${index}`,
      sourceId: `note_${index}`,
      path: `/math/note_${index}`,
      name: `Note ${index}`,
      type: 'note',
      createdAt: index,
      updatedAt: index,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_0]]' ? manyNotes.slice(1) : [],
    }));
    getContent.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { ok: true, value: '' };
    });

    renderPanel({ activeResource: manyNotes[0], notes: manyNotes });

    await waitFor(() => expect(getContent).toHaveBeenCalledTimes(8));
    expect(maxInFlight).toBe(8);
    releaseGate();

    await screen.findByText('Outgoing links');
    expect(getContent).toHaveBeenCalledTimes(12);
  });

  it('bounds popular backlink loads and marks the incoming list as partial', async () => {
    const activeNote: DstuNode = {
      id: 'note_active', sourceId: 'note_active', path: '/math/note_active', name: 'Active', type: 'note', createdAt: 0, updatedAt: 0,
    };
    const candidateNotes = Array.from({ length: BACKLINK_CANDIDATE_LIMIT + 1 }, (_, index): DstuNode => ({
      id: `note_candidate_${index}`,
      sourceId: `note_candidate_${index}`,
      path: `/math/note_candidate_${index}`,
      name: `Candidate ${index}`,
      type: 'note',
      createdAt: index + 1,
      updatedAt: index + 1,
    }));
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[note_active]]' ? candidateNotes : [],
    }));
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === activeNote.path ? '' : '[[note_active]]',
    }));

    renderPanel({ activeResource: activeNote, notes: [activeNote, ...candidateNotes] });

    expect(await screen.findByText('Outgoing links')).toBeInTheDocument();
    expect(getContent).toHaveBeenCalledTimes(BACKLINK_CANDIDATE_LIMIT + 1);
    expect(getContent).not.toHaveBeenCalledWith(candidateNotes[0].path);
    expect(screen.getByRole('status')).toHaveTextContent(String(BACKLINK_CANDIDATE_LIMIT));
  });

  it('invalidates cached markdown from an updated-note event while the panel is open', async () => {
    let watchCallback: ((event: { type: string; node?: DstuNode }) => void) | null = null;
    watch.mockImplementation((_path: string, callback: (event: { type: string; node?: DstuNode }) => void) => {
      watchCallback = callback;
      return () => {};
    });
    const { rerender } = renderPanel();
    await screen.findByText('Outgoing links');
    expect(getContent).toHaveBeenCalledTimes(3);

    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[0].path
        ? '[[Beta]] [[note_gamma|Gamma alias]] [[missing]]\nUpdated'
        : contentByPath[path],
    }));
    watchCallback?.({ type: 'updated', node: { ...notes[0], updatedAt: 2 } });

    await waitFor(() => expect(search).toHaveBeenCalledTimes(24));
    expect(getContent).toHaveBeenCalledTimes(4);

    rerender(
      <NotesBacklinksPanel
        open={false}
        activeResource={notes[0]}
        notes={notes}
        onOpenResource={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  });

  it('shows a retryable error when content loading fails and closes through the close control', async () => {
    getContent.mockResolvedValueOnce({ ok: false, error: new Error('offline') });
    const { onClose } = renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Outgoing links');

    fireEvent.click(screen.getByRole('button', { name: 'Close linked notes' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('counts inbound links with padded targets and aliases', async () => {
    search.mockImplementation(async (query: string) => ({
      ok: true,
      value: query === '[[ Alpha '
        ? [notes[1], notes[3]]
        : query === '[[Alpha '
          ? [notes[2]]
          : [],
    }));
    getContent.mockImplementation(async (path: string) => ({
      ok: true,
      value: path === notes[1].path
        ? '[[ Alpha | both padded]]'
        : path === notes[2].path
          ? '[[Alpha | spaced alias]]'
          : path === notes[3].path
            ? '[[ Alpha ]]'
        : contentByPath[path],
    }));

    renderPanel();

    const incoming = await screen.findByRole('region', { name: /Backlinks/ });
    expect(search).toHaveBeenCalledWith('[[ Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(search).toHaveBeenCalledWith('[[Alpha ', {
      typeFilter: 'note',
      limit: BACKLINK_CANDIDATE_LIMIT + 1,
    });
    expect(getContent).toHaveBeenCalledWith(notes[1].path);
    expect(getContent).toHaveBeenCalledWith(notes[2].path);
    expect(getContent).toHaveBeenCalledWith(notes[3].path);
    expect(within(incoming).getByRole('button', { name: 'Open Beta' })).toBeInTheDocument();
    expect(within(incoming).getByRole('button', { name: 'Open Gamma' })).toBeInTheDocument();
    expect(within(incoming).getByRole('button', { name: 'Open Delta' })).toBeInTheDocument();
  });
});
