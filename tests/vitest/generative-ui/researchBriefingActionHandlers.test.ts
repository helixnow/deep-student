import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchBriefingActionHandlers } from '@/features/generative-ui/handlers/researchBriefingActionHandlers';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/features/generative-ui/utils/buildIntentExportMarkdown', () => ({
  buildIntentExportMarkdown: vi.fn().mockReturnValue('# Intent export'),
}));

import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { buildIntentExportMarkdown } from '@/features/generative-ui/utils/buildIntentExportMarkdown';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';

const mockedCopy = vi.mocked(copyTextToClipboard);
const mockedExport = vi.mocked(buildIntentExportMarkdown);

const SAMPLE_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: { title: 'Research' },
  blocks: [{ type: 'stat-card', props: { title: 'N', value: 1 } }],
};

describe('createResearchBriefingActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
    mockedExport.mockClear();
    mockedExport.mockReturnValue('# Intent export');
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

  it('export-intent calls buildIntentExportMarkdown and copies result', async () => {
    const exportLabels = { flashcardFront: 'Front' };
    const handlers = createResearchBriefingActionHandlers(
      {
        getReportBody: () => '',
        getExportMarkdown: () => '',
        getIntent: () => SAMPLE_INTENT,
      },
      { copyReport: 'Copy', exportPlan: 'Export', exportIntent: 'Export intent' },
      exportLabels,
    );

    await handlers['export-intent'].handler({} as never);
    expect(mockedExport).toHaveBeenCalledWith(SAMPLE_INTENT, exportLabels);
    expect(mockedCopy).toHaveBeenCalledWith('# Intent export');
  });

  it('export-intent uses onExportIntent callback instead of clipboard', async () => {
    const onExportIntent = vi.fn();
    const handlers = createResearchBriefingActionHandlers(
      {
        getReportBody: () => '',
        getExportMarkdown: () => '',
        getIntent: () => SAMPLE_INTENT,
        onExportIntent,
      },
      { copyReport: 'Copy', exportPlan: 'Export', exportIntent: 'Export intent' },
    );

    await handlers['export-intent'].handler({} as never);
    expect(mockedExport).toHaveBeenCalledWith(SAMPLE_INTENT, undefined);
    expect(onExportIntent).toHaveBeenCalledWith('# Intent export');
    expect(mockedCopy).not.toHaveBeenCalled();
  });
});
