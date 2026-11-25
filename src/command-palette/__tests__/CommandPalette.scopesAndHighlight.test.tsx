import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DstuNode } from '@/dstu/types';
import type { FlashcardSearchItem, SessionSearchItem } from '@/command-palette/hooks/useResourceSearch';

const resourceMocks = vi.hoisted(() => ({
  fileResults: [] as DstuNode[],
  flashcardResults: [] as FlashcardSearchItem[],
  sessionResults: [] as SessionSearchItem[],
  loading: false,
  lastQuery: '' as string,
  lastEnabled: false as boolean,
  openFileFromPalette: vi.fn(),
  openFlashcardFromPalette: vi.fn(),
  openSessionFromPalette: vi.fn(),
}));

vi.mock('@/command-palette/hooks/useResourceSearch', () => ({
  useResourceSearch: (query: string, enabled: boolean) => {
    resourceMocks.lastQuery = query;
    resourceMocks.lastEnabled = enabled;
    return {
      fileResults: enabled ? resourceMocks.fileResults : [],
      flashcardResults: enabled ? resourceMocks.flashcardResults : [],
      sessionResults: enabled ? resourceMocks.sessionResults : [],
      loading: enabled && resourceMocks.loading,
    };
  },
  formatDstuSearchSubtitle: (node: DstuNode) => node.path || node.type,
  formatFlashcardSearchSubtitle: (item: FlashcardSearchItem) => item.deck || 'Deck',
  openFileFromPalette: resourceMocks.openFileFromPalette,
  openFlashcardFromPalette: resourceMocks.openFlashcardFromPalette,
  openSessionFromPalette: resourceMocks.openSessionFromPalette,
}));

import {
  CommandPalette,
  parsePaletteQuery,
  renderHighlightedText,
  scorePaletteTextMatch,
  stripPaletteQueryPrefix,
} from '@/command-palette/CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from '@/command-palette/CommandPaletteProvider';
import { commandRegistry } from '@/command-palette/registry/commandRegistry';
import type { Command } from '@/command-palette/registry/types';

function setDesktopViewport() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: /\(min-width:\s*(\d+)px\)/.test(query),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function OpenTrigger() {
  const { open } = useCommandPalette();
  return <button type="button" onClick={open}>open-palette</button>;
}

async function renderAndOpenPalette() {
  render(
    <CommandPaletteProvider
      currentView="chat-v2"
      navigate={() => undefined}
      toggleTheme={() => undefined}
      isDarkMode={false}
      switchLanguage={() => undefined}
    >
      <OpenTrigger />
      <CommandPalette />
    </CommandPaletteProvider>,
  );
  fireEvent.click(screen.getByText('open-palette'));
  return screen.findByRole('combobox');
}

const SAMPLE_COMMANDS: Command[] = [
  {
    id: 'test.generic.needle',
    name: 'Toggle Study Mode',
    description: 'General command with ScaleNeedle keyword',
    keywords: ['ScaleNeedle_Mitochondria_ATP_Synthase_777', 'CRISPR_PAM', 'theme'],
    category: 'global',
    execute: () => undefined,
  },
  {
    id: 'test.open.settings',
    name: 'Open Settings',
    description: 'Configure app preferences',
    keywords: ['settings', 'theme'],
    category: 'settings',
    execute: () => undefined,
  },
];

const SAMPLE_FILES: DstuNode[] = [
  {
    id: 'note-777',
    name: 'ScaleNeedle_Mitochondria_ATP_Synthase_777.md',
    type: 'note',
    path: '/Biology/ScaleNeedle_Mitochondria_ATP_Synthase_777.md',
  } as DstuNode,
];

const SAMPLE_FLASHCARDS: FlashcardSearchItem[] = [
  {
    cardId: 'card-4242',
    front: 'ScaleCardNeedle_CRISPR_PAM_4242',
    back: 'NGG motif recognized by SpCas9',
    deck: 'Genetics::CRISPR',
    tags: ['crispr'],
  },
];

describe('CommandPalette S4 scopes, content-first ranking & <mark> highlights', () => {
  beforeEach(() => {
    setDesktopViewport();
    commandRegistry.clear();
    commandRegistry.registerAll(SAMPLE_COMMANDS);
    resourceMocks.fileResults = SAMPLE_FILES;
    resourceMocks.flashcardResults = SAMPLE_FLASHCARDS;
    resourceMocks.sessionResults = [];
    resourceMocks.loading = false;
    resourceMocks.lastQuery = '';
    resourceMocks.lastEnabled = false;
    resourceMocks.openFileFromPalette.mockReset();
    resourceMocks.openFlashcardFromPalette.mockReset();
    resourceMocks.openSessionFromPalette.mockReset();
  });

  afterEach(async () => {
    commandRegistry.clear();
    await new Promise((resolve) => setTimeout(resolve, 180));
  });

  it('parses >, @, # (and fullwidth equivalents) prefixes and strips them cleanly', () => {
    expect(parsePaletteQuery('> theme', 'all')).toEqual({
      prefixScope: 'commands',
      effectiveScope: 'commands',
      searchTerm: 'theme',
    });
    expect(parsePaletteQuery('@Mitochondria', 'all')).toEqual({
      prefixScope: 'files',
      effectiveScope: 'files',
      searchTerm: 'Mitochondria',
    });
    expect(parsePaletteQuery('#CRISPR_PAM', 'all')).toEqual({
      prefixScope: 'flashcards',
      effectiveScope: 'flashcards',
      searchTerm: 'CRISPR_PAM',
    });
    expect(parsePaletteQuery('＠生物笔记', 'all')).toEqual({
      prefixScope: 'files',
      effectiveScope: 'files',
      searchTerm: '生物笔记',
    });
    expect(parsePaletteQuery('plain', 'flashcards')).toEqual({
      prefixScope: null,
      effectiveScope: 'flashcards',
      searchTerm: 'plain',
    });
    expect(stripPaletteQueryPrefix('# CRISPR')).toBe('CRISPR');
    expect(stripPaletteQueryPrefix('plain')).toBe('plain');
  });

  it('scores exact and prefix matches above description-only matches', () => {
    expect(scorePaletteTextMatch('ATP_Synthase', 'Bio', 'atp_synthase')).toBe(100);
    expect(scorePaletteTextMatch('ATP_Synthase_777', 'Bio', 'atp_synthase')).toBe(85);
    expect(scorePaletteTextMatch('ScaleNeedle_ATP_Synthase', 'Bio', 'atp_synthase')).toBe(70);
    expect(scorePaletteTextMatch('Unrelated', 'Contains atp_synthase', 'atp_synthase')).toBe(45);
  });

  it('wraps case-insensitive substring matches in accessible <mark> elements', () => {
    const { container } = render(
      <div>{renderHighlightedText('ScaleNeedle_Mitochondria_ATP_Synthase_777', 'mitochondria')}</div>,
    );
    const marks = container.querySelectorAll('mark.command-palette-highlight');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('Mitochondria');
  });

  it('promotes strong deep-content matches above generic commands on >=3 char queries and highlights matches', async () => {
    const input = await renderAndOpenPalette();

    fireEvent.change(input, { target: { value: 'ScaleNeedle_Mitochondria' } });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(2);
    // Exact/strong file match is promoted to index 0 ahead of generic command keyword match.
    expect(options[0]).toHaveTextContent('ScaleNeedle_Mitochondria_ATP_Synthase_777.md');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    const firstMarks = options[0].querySelectorAll('mark.command-palette-highlight');
    expect(firstMarks.length).toBeGreaterThanOrEqual(1);
    expect(firstMarks[0].textContent).toBe('ScaleNeedle_Mitochondria');
  });

  it('supports >, @, # prefix filtering and strips prefixes when querying/opening resources', async () => {
    const input = await renderAndOpenPalette();

    // '>' scope shows only commands and skips resource search.
    fireEvent.change(input, { target: { value: '>Settings' } });
    expect(resourceMocks.lastEnabled).toBe(false);
    expect(screen.getByTestId('command-palette-scope-commands')).toHaveAttribute('aria-pressed', 'true');
    const cmdOptions = screen.getAllByRole('option');
    expect(cmdOptions.every((el) => !el.textContent?.includes('ScaleCardNeedle'))).toBe(true);

    // '#' scope shows only flashcards and passes stripped query to resource search & openFlashcardFromPalette.
    fireEvent.change(input, { target: { value: '#CRISPR_PAM' } });
    expect(resourceMocks.lastEnabled).toBe(true);
    expect(resourceMocks.lastQuery).toBe('CRISPR_PAM');
    expect(screen.getByTestId('command-palette-scope-flashcards')).toHaveAttribute('aria-pressed', 'true');
    const cardOptions = screen.getAllByRole('option');
    expect(cardOptions).toHaveLength(1);
    expect(cardOptions[0]).toHaveTextContent('ScaleCardNeedle_CRISPR_PAM_4242');

    fireEvent.click(cardOptions[0]);
    expect(resourceMocks.openFlashcardFromPalette).toHaveBeenCalledWith(
      expect.anything(),
      SAMPLE_FLASHCARDS[0],
      'CRISPR_PAM',
    );
  });

  it('switches scope cleanly via scope chips while preserving the typed search term', async () => {
    const input = await renderAndOpenPalette();

    fireEvent.change(input, { target: { value: '@Mitochondria' } });
    expect(screen.getByTestId('command-palette-scope-files')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('ScaleNeedle_Mitochondria_ATP_Synthase_777.md');

    // Click Flashcards chip: strips '@' and switches to flashcards scope while keeping query text.
    fireEvent.click(screen.getByTestId('command-palette-scope-flashcards'));
    expect((input as HTMLInputElement).value).toBe('Mitochondria');
    expect(screen.getByTestId('command-palette-scope-flashcards')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('ScaleCardNeedle_CRISPR_PAM_4242');
  });
});
