import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  COPY_BLOCK_ACTION_ID,
  createCopyBlockActionHandlers,
  serializeGenerativeUIBlock,
} from '@/features/generative-ui/handlers/copyBlockActionHandlers';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

import { copyTextToClipboard } from '@/utils/clipboardUtils';

const mockedCopy = vi.mocked(copyTextToClipboard);

const sampleIntent: GenerativeUIIntent = {
  version: '1',
  meta: { title: 'Briefing' },
  blocks: [
    {
      id: 'stat-coverage',
      type: 'stat-card',
      props: { title: 'Coverage score', value: 87 },
    },
    {
      id: 'text-takeaway',
      type: 'text',
      props: { title: 'Key takeaway', body: 'Review spaced repetition tonight.' },
    },
  ],
};

describe('createCopyBlockActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
  });

  it('registers copy-block as a low-risk handler', () => {
    const handlers = createCopyBlockActionHandlers(sampleIntent, { copyBlock: '复制该组件' });
    expect(handlers[COPY_BLOCK_ACTION_ID]).toBeDefined();
    expect(handlers[COPY_BLOCK_ACTION_ID]?.id).toBe(COPY_BLOCK_ACTION_ID);
    expect(handlers[COPY_BLOCK_ACTION_ID]?.riskLevel).toBe('low');
    expect(handlers[COPY_BLOCK_ACTION_ID]?.label).toBe('复制该组件');
  });

  it('copies pretty-printed JSON for the block matching blockId', async () => {
    const target = sampleIntent.blocks[1]!;
    const handlers = createCopyBlockActionHandlers(
      sampleIntent,
      { copyBlock: 'Copy this block' },
      { blockId: 'text-takeaway' },
    );
    await handlers[COPY_BLOCK_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).toHaveBeenCalledTimes(1);
    expect(mockedCopy).toHaveBeenCalledWith(serializeGenerativeUIBlock(target));
    const payload = mockedCopy.mock.calls[0]?.[0] as string;
    expect(payload).toContain('"type": "text"');
    expect(JSON.parse(payload)).toEqual(target);
  });

  it('copies pretty-printed JSON for the block at blockIndex', async () => {
    const target = sampleIntent.blocks[0]!;
    const handlers = createCopyBlockActionHandlers(
      sampleIntent,
      { copyBlock: 'Copy this block' },
      { blockIndex: 0 },
    );
    await handlers[COPY_BLOCK_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).toHaveBeenCalledTimes(1);
    expect(mockedCopy).toHaveBeenCalledWith(serializeGenerativeUIBlock(target));
    const payload = mockedCopy.mock.calls[0]?.[0] as string;
    expect(payload).toContain('"type": "stat-card"');
    expect(JSON.parse(payload)).toEqual(target);
  });

  it('does not copy when the intent has no blocks', async () => {
    const emptyIntent: GenerativeUIIntent = { version: '1', blocks: [] };
    const handlers = createCopyBlockActionHandlers(emptyIntent, { copyBlock: 'Copy this block' });
    await handlers[COPY_BLOCK_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).not.toHaveBeenCalled();
  });
});
