import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EXPORT_INTENT_ACTION_ID,
  createExportIntentActionHandlers,
} from '@/features/generative-ui/handlers/exportIntentActionHandlers';
import { buildIntentExportMarkdown } from '@/features/generative-ui/utils/buildIntentExportMarkdown';
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
      type: 'stat-card',
      props: { title: 'Coverage score', value: 87 },
    },
    {
      type: 'text',
      props: { title: 'Key takeaway', body: 'Review spaced repetition tonight.' },
    },
  ],
};

describe('createExportIntentActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
  });

  it('registers export-intent as a low-risk handler', () => {
    const handlers = createExportIntentActionHandlers(sampleIntent, {
      exportMarkdown: '导出 Markdown',
    });
    expect(handlers[EXPORT_INTENT_ACTION_ID]).toBeDefined();
    expect(handlers[EXPORT_INTENT_ACTION_ID]?.id).toBe(EXPORT_INTENT_ACTION_ID);
    expect(handlers[EXPORT_INTENT_ACTION_ID]?.riskLevel).toBe('low');
    expect(handlers[EXPORT_INTENT_ACTION_ID]?.label).toBe('导出 Markdown');
  });

  it('copies intent markdown that includes known block titles', async () => {
    const markdownLabels = { statFallbackTitle: 'Metric' };
    const handlers = createExportIntentActionHandlers(sampleIntent, {
      exportMarkdown: 'Export Markdown',
    }, markdownLabels);
    await handlers[EXPORT_INTENT_ACTION_ID]!.handler({} as never);
    expect(mockedCopy).toHaveBeenCalledTimes(1);
    expect(mockedCopy).toHaveBeenCalledWith(
      buildIntentExportMarkdown(sampleIntent, markdownLabels),
    );
    const payload = mockedCopy.mock.calls[0]?.[0] as string;
    expect(payload).toContain('Coverage score');
    expect(payload).toContain('Key takeaway');
  });
});
