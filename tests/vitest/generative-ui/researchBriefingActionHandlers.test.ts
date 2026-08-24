import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchBriefingActionHandlers } from '@/features/generative-ui/handlers/researchBriefingActionHandlers';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

import { copyTextToClipboard } from '@/utils/clipboardUtils';

const mockedCopy = vi.mocked(copyTextToClipboard);

describe('createResearchBriefingActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
  });

  it('copy-report copies report body to clipboard', async () => {
    const handlers = createResearchBriefingActionHandlers(
      {
        getReportBody: () => 'Finding summary [paper-1]',
        getExportMarkdown: () => '# Plan',
      },
      { copyReport: 'Copy', exportPlan: 'Export' },
    );

    await handlers['copy-report'].handler({} as never);
    expect(mockedCopy).toHaveBeenCalledWith('Finding summary [paper-1]');
  });

  it('export-plan copies full markdown export', async () => {
    const handlers = createResearchBriefingActionHandlers(
      {
        getReportBody: () => '',
        getExportMarkdown: () => '# Research\n\n## Plan\n- [x] Step',
      },
      { copyReport: 'Copy', exportPlan: 'Export' },
    );

    await handlers['export-plan'].handler({} as never);
    expect(mockedCopy).toHaveBeenCalledWith('# Research\n\n## Plan\n- [x] Step');
  });
});
