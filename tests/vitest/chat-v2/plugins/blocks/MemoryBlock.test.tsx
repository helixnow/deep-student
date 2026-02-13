import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

import type { Block } from '@/chat-v2/core/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'blocks.memory.title': 'Memory',
        'blocks.memory.searching': 'Searching...',
        'blocks.memory.loading': 'Loading memory...',
        'blocks.memory.error': 'Error',
        'blocks.memory.errorMessage': 'Memory search failed',
        'blocks.memory.noResults': 'No memory found',
        'blocks.memory.statsSimple': `${params?.count} results`,
        'blocks.memory.types.conversation': 'Conversation',
        'blocks.memory.types.long_term': 'Long Term',
        'blocks.memory.types.user_profile': 'User Profile',
        'blocks.retrieval.sourcesCount': 'sources',
      };
      return translations[key] || key;
    },
  }),
}));

import { MemoryBlock } from '@/chat-v2/plugins/blocks/memory';

function createMemoryBlock(overrides?: Partial<Block>): Block {
  return {
    id: 'memory-block-1',
    type: 'memory',
    status: 'success',
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('MemoryBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders legacy memory_search results when sources field is missing', () => {
    const block = createMemoryBlock({
      toolOutput: {
        results: [
          {
            note_id: 'note_legacy',
            note_title: 'Legacy Memory',
            chunk_text: 'Legacy snippet content',
            score: 0.88,
          },
        ],
      },
    });

    render(<MemoryBlock block={block} />);

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('1 results')).toBeInTheDocument();
    expect(screen.getByText('Legacy Memory')).toBeInTheDocument();
    expect(screen.getByText('Legacy snippet content')).toBeInTheDocument();
  });

  it('shows no-results state when both sources and results are empty', () => {
    const block = createMemoryBlock({
      toolOutput: {
        results: [],
      },
    });

    render(<MemoryBlock block={block} />);

    expect(screen.getByText('No memory found')).toBeInTheDocument();
  });
});
