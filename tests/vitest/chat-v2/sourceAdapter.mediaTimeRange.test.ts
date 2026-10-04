import { describe, expect, it } from 'vitest';
import { blocksToSourceBundle } from '@/features/chat/components/panels/sourceAdapter';
import type { Block } from '@/features/chat/core/types/block';

describe('sourceAdapter media transcript hits', () => {
  it('carries timeRange and mediaCitation from numbered sources', () => {
    const bundle = blocksToSourceBundle([{
      id: 'b1',
      type: 'rag',
      status: 'success',
      messageId: 'msg-1',
      toolOutput: {
        sources: [
          {
            title: 'lecture.mp4',
            snippet: '[01:30] 接下来介绍卷积定理',
            sourceId: 'file_lecture',
            resourceId: 'res_lecture',
            resourceType: 'file',
            pageIndex: 1,
            citationTag: '[知识库-1]',
            timeRange: { startMs: 90_000, endMs: 178_000 },
            mediaCitation: '[媒体@file_lecture:01:30]',
          },
          { title: 'notes', snippet: 'plain', resourceId: 'res_note', citationTag: '[知识库-2]' },
        ],
      },
    } as Block]);
    const items = bundle?.groups.flatMap((g) => g.items) ?? [];
    expect(items[0]?.timeRange).toEqual({ startMs: 90_000, endMs: 178_000 });
    expect(items[0]?.mediaCitation).toBe('[媒体@file_lecture:01:30]');
    expect(items[1]?.timeRange).toBeUndefined();
    expect(items[1]?.mediaCitation).toBeUndefined();
  });
});
