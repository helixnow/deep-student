import { describe, expect, it } from 'vitest';

import {
  blocksToSourceBundle,
  extractSourcesFromSharedContext,
} from '@/chat-v2/components/panels/sourceAdapter';
import type { Block } from '@/chat-v2/core/types/block';

function makeMemoryBlock(toolOutput: unknown): Block {
  return {
    id: 'blk-memory-1',
    type: 'memory',
    status: 'success',
    messageId: 'msg-1',
    toolOutput,
  };
}

describe('sourceAdapter memory sources', () => {
  it('uses metadata note id for memory locate id', () => {
    const bundle = blocksToSourceBundle([
      makeMemoryBlock({
        sources: [
          {
            title: 'Memory Title',
            snippet: 'Memory snippet',
            score: 0.9,
            metadata: {
              note_id: 'note_123',
            },
          },
        ],
      }),
    ]);

    expect(bundle).not.toBeNull();
    const item = bundle!.groups[0].items[0];
    expect(item.raw.document_id).toBe('note_123');
    expect(item.sourceId).toBe('note_123');
  });

  it('does not synthesize memory document_id when missing', () => {
    const bundle = blocksToSourceBundle([
      makeMemoryBlock({
        sources: [
          {
            title: 'No Id Memory',
            snippet: 'No id snippet',
            score: 0.5,
          },
        ],
      }),
    ]);

    expect(bundle).not.toBeNull();
    const item = bundle!.groups[0].items[0];
    expect(item.raw.document_id).toBe('');
  });

  it('supports legacy memory results fields', () => {
    const bundle = blocksToSourceBundle([
      makeMemoryBlock({
        results: [
          {
            note_id: 'note_legacy',
            note_title: 'Legacy Memory',
            chunk_text: 'Legacy snippet',
            score: 0.77,
          },
        ],
      }),
    ]);

    expect(bundle).not.toBeNull();
    const item = bundle!.groups[0].items[0];
    expect(item.title).toBe('Legacy Memory');
    expect(item.snippet).toBe('Legacy snippet');
    expect(item.raw.document_id).toBe('note_legacy');
  });

  it('sharedContext memory keeps document_id empty if no real id exists', () => {
    const bundle = extractSourcesFromSharedContext({
      memorySources: [
        {
          title: 'Shared Memory',
          snippet: 'Shared snippet',
          score: 0.6,
        },
      ],
    });

    expect(bundle).not.toBeNull();
    const item = bundle!.groups[0].items[0];
    expect(item.raw.document_id).toBe('');
  });
});
