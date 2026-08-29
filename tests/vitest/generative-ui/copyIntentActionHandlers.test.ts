import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  COPY_INTENT_ACTION_ID,
  createCopyIntentActionHandlers,
  serializeGenerativeUIIntent,
} from '@/features/generative-ui/handlers/copyIntentActionHandlers';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
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
      type: 'action-bar',
      props: {
        actions: [{ id: COPY_INTENT_ACTION_ID, label: 'Copy intent', riskLevel: 'low' }],
      },
    },
  ],
};

describe('createCopyIntentActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
  });

  it('registers copy-intent as a low-risk handler', () => {
    const handlers = createCopyIntentActionHandlers(sampleIntent, { copyIntent: '复制意图' });
    expect(handlers[COPY_INTENT_ACTION_ID]).toBeDefined();
    expect(handlers[COPY_INTENT_ACTION_ID]?.id).toBe(COPY_INTENT_ACTION_ID);
    expect(handlers[COPY_INTENT_ACTION_ID]?.riskLevel).toBe('low');
    expect(handlers[COPY_INTENT_ACTION_ID]?.label).toBe('复制意图');
  });

  it('copies pretty-printed intent JSON to clipboard', async () => {
    const handlers = createCopyIntentActionHandlers(sampleIntent, { copyIntent: 'Copy intent' });
    await handlers[COPY_INTENT_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).toHaveBeenCalledTimes(1);
    expect(mockedCopy).toHaveBeenCalledWith(serializeGenerativeUIIntent(sampleIntent));
    const payload = mockedCopy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(payload)).toEqual(sampleIntent);
    expect(payload).toContain('\n');
  });
});

describe('resolveGenerativeUIChatActionHandlers copy-intent', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
  });

  it('registers copy-intent when action-bar declares it', async () => {
    const handlers = resolveGenerativeUIChatActionHandlers({ intent: sampleIntent });
    expect(handlers[COPY_INTENT_ACTION_ID]).toBeDefined();
    expect(handlers[COPY_INTENT_ACTION_ID]?.riskLevel).toBe('low');

    await handlers[COPY_INTENT_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).toHaveBeenCalledWith(serializeGenerativeUIIntent(sampleIntent));
  });

  it('does not register copy-intent when action-bar omits it', () => {
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [
        {
          type: 'action-bar',
          props: {
            actions: [{ id: 'start-review', label: 'Review', riskLevel: 'low' }],
          },
        },
      ],
    };
    const handlers = resolveGenerativeUIChatActionHandlers({ intent });
    expect(handlers[COPY_INTENT_ACTION_ID]).toBeUndefined();
  });
});
