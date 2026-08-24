import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { schemaToPromptHint } from '@/features/generative-ui/utils/schemaToPromptHint';
import { statCardPropsSchema } from '@/features/generative-ui/schema';
import {
  extractNoteEditPayload,
  MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES,
} from '@/features/generative-ui/utils/extractNoteEditPayload';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { buildResearchReportIntent } from '@/features/generative-ui/utils/buildResearchReportIntent';
import {
  resolveGenerativeUIChatActionHandlers,
  collectGenerativeUIActionIds,
} from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/features/workbench', () => ({
  workbenchBus: {
    launch: vi.fn(),
    activateDetailed: vi.fn(),
  },
}));

import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { workbenchBus } from '@/features/workbench';

const mockedCopy = vi.mocked(copyTextToClipboard);
const mockedLaunch = vi.mocked(workbenchBus.launch);

describe('schemaToPromptHint', () => {
  it('summarizes object schema fields', () => {
    const hint = schemaToPromptHint(statCardPropsSchema);
    expect(hint).toContain('title');
    expect(hint).toContain('value');
    expect(hint).toContain('trend');
  });

  it('handles nested enum fields', () => {
    const schema = z.object({ mode: z.enum(['a', 'b']) });
    expect(schemaToPromptHint(schema)).toContain('mode: a|b');
  });
});

describe('extractNoteEditPayload', () => {
  it('reads noteEdit from toolInput', () => {
    const payload = extractNoteEditPayload({
      intent: {},
      noteEdit: { operation: 'append', content: 'text' },
    });
    expect(payload?.operation).toBe('append');
  });

  it('returns null for invalid noteEdit', () => {
    expect(extractNoteEditPayload({ noteEdit: { operation: 'invalid' } })).toBeNull();
  });

  it('rejects model-controlled regex replacement', () => {
    expect(extractNoteEditPayload({
      noteEdit: {
        operation: 'replace',
        search: '(a+)+$',
        replace: 'x',
        isRegex: true,
      },
    })).toBeNull();
  });

  it('rejects oversized aggregate note edit input', () => {
    expect(extractNoteEditPayload({
      noteEdit: {
        operation: 'append',
        content: 'a'.repeat(MAX_GENERATIVE_NOTE_EDIT_INPUT_BYTES + 1),
      },
    })).toBeNull();
  });
});

describe('resolveGenerativeUIChatActionHandlers', () => {
  beforeEach(() => {
    mockedCopy.mockClear();
    mockedLaunch.mockClear();
  });

  it('includes workbench handlers for learning dashboard actions', () => {
    const intent = {
      version: '1' as const,
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
    expect(handlers['start-review']).toBeDefined();
  });

  it('includes note edit handlers when canvasNoteId and noteEdit present', () => {
    const intent = buildNoteEditSuggestionIntent({
      operation: 'replace',
      operationLabel: 'Replace',
      previewText: 'x',
      labels: {
        metaTitle: 'T',
        metaDescription: 'D',
        operationKey: 'Op',
        previewTitle: 'P',
        applyEdit: 'Apply',
        dismissSuggestion: 'Dismiss',
      },
    });
    const handlers = resolveGenerativeUIChatActionHandlers({
      canvasNoteId: 'note-1',
      intent,
      toolInput: { noteEdit: { operation: 'replace', search: 'a', replace: 'b' } },
    });
    expect(collectGenerativeUIActionIds(intent)).toContain('apply-note-edit');
    expect(handlers['apply-note-edit']).toBeDefined();
    expect(handlers['dismiss-note-suggestion']).toBeDefined();
  });

  it('research export-plan overrides workbench handler and copies markdown', async () => {
    const reportIntent = buildResearchReportIntent({
      title: 'Findings',
      body: 'Summary [paper-1]',
      labels: { metaTitle: 'Report', citationStatTitle: 'Citations' },
    });
    const intent = {
      ...reportIntent,
      blocks: [
        ...reportIntent.blocks,
        {
          type: 'action-bar' as const,
          props: {
            actions: [
              { id: 'copy-report', label: 'Copy', riskLevel: 'low' as const },
              { id: 'export-plan', label: 'Export', riskLevel: 'medium' as const },
              { id: 'export-intent', label: 'Export intent', riskLevel: 'low' as const },
            ],
          },
        },
      ],
    };

    const handlers = resolveGenerativeUIChatActionHandlers({
      intent,
      researchExportLabels: { report: 'Localized report' },
    });
    expect(handlers['copy-report']).toBeDefined();
    expect(handlers['export-plan']).toBeDefined();
    expect(handlers['export-intent']).toBeDefined();

    await handlers['export-plan'].handler({} as never);
    expect(mockedLaunch).not.toHaveBeenCalled();
    expect(mockedCopy).toHaveBeenCalled();
    const exported = mockedCopy.mock.calls[0]?.[0] as string;
    expect(exported).toContain('Summary [paper-1]');
    expect(exported).toContain('## Localized report');

    mockedCopy.mockClear();
    await handlers['export-intent'].handler({} as never);
    expect(mockedCopy).toHaveBeenCalled();
    const intentExport = mockedCopy.mock.calls[0]?.[0] as string;
    expect(intentExport).toContain('Summary [paper-1]');
  });

  it('includes copy-block handler and copies block JSON to clipboard', async () => {
    const intent = {
      version: '1' as const,
      blocks: [
        {
          type: 'stat-card' as const,
          props: { title: 'Coverage', value: 87 },
        },
        {
          type: 'action-bar' as const,
          props: {
            actions: [{ id: 'copy-block', label: 'Copy block', riskLevel: 'low' as const }],
          },
        },
      ],
    };
    const handlers = resolveGenerativeUIChatActionHandlers({ intent });
    expect(handlers['copy-block']).toBeDefined();
    await handlers['copy-block'].handler({} as never);
    expect(mockedCopy).toHaveBeenCalled();
  });

  it('includes generic export-intent handler when only a text block is present', () => {
    const intent = {
      version: '1' as const,
      blocks: [
        {
          type: 'text' as const,
          props: { title: 'Summary', body: 'Hello' },
        },
        {
          type: 'action-bar' as const,
          props: {
            actions: [{ id: 'export-intent', label: 'Export intent', riskLevel: 'low' as const }],
          },
        },
      ],
    };
    const handlers = resolveGenerativeUIChatActionHandlers({ intent });
    expect(handlers['export-intent']).toBeDefined();
  });
});
