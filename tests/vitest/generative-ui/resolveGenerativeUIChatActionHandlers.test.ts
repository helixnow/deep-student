import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { schemaToPromptHint } from '@/features/generative-ui/utils/schemaToPromptHint';
import { statCardPropsSchema } from '@/features/generative-ui/schema';
import { extractNoteEditPayload } from '@/features/generative-ui/utils/extractNoteEditPayload';
import {
  resolveGenerativeUIChatActionHandlers,
  collectGenerativeUIActionIds,
} from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';

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
});

describe('resolveGenerativeUIChatActionHandlers', () => {
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
});
