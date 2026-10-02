import { describe, expect, it } from 'vitest';
import { blocksToSourceBundle } from '@/features/chat/components/panels/sourceAdapter';
import type { Block } from '@/features/chat/core/types/block';

describe('sourceAdapter multimodal hits', () => {
  it('reads camelCase sourceId and pageIndex so the card can open the original page', () => {
    const bundle = blocksToSourceBundle([{
      id: 'b1',
      type: 'rag',
      status: 'success',
      messageId: 'msg-1',
      toolOutput: {
        sources: [{
          title: 'kb-test2.pdf',
          snippet: '第二章 泰勒公式',
          score: 0.95,
          sourceId: 'file_pxgPjJu0ox',
          resourceId: 'res_sWX1fXRWbN',
          resourceType: 'file',
          pageIndex: 1,
          source_type: 'multimodal_search',
        }],
      },
    } as Block]);
    const item = bundle?.groups.flatMap((g) => g.items)[0];
    expect(item?.sourceId).toBe('file_pxgPjJu0ox');
    expect(item?.pageIndex).toBe(1);
    expect(item?.title).toBe('kb-test2.pdf');
  });
});
