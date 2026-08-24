import { describe, it, expect } from 'vitest';
import { markdownPropsSchema } from '@/features/generative-ui/components/MarkdownBlock';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { parseGenerativeUIIntent } from '@/features/generative-ui/schema';

describe('buildNoteEditSuggestionIntent', () => {
  it('builds intent with truncated preview and action-bar', () => {
    const longPreview = 'x'.repeat(300);
    const intent = buildNoteEditSuggestionIntent({
      operation: 'replace',
      operationLabel: '替换',
      previewText: longPreview,
      labels: {
        metaTitle: '编辑建议',
        metaDescription: '请确认',
        operationKey: '操作',
        previewTitle: '预览',
        applyEdit: '应用',
        dismissSuggestion: '忽略',
      },
    });

    expect(intent.meta?.title).toBe('编辑建议');
    const textBlock = intent.blocks.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    const body = (textBlock!.props as { body: string }).body;
    expect(body.length).toBeLessThan(longPreview.length);
    expect(body.endsWith('…')).toBe(true);

    const markdown = intent.blocks.find((b) => b.type === 'markdown');
    expect(markdown).toBeDefined();
    expect((markdown?.props as { body?: string }).body).toContain('请确认');
    expect(markdownPropsSchema.safeParse(markdown?.props).success).toBe(true);
    expect(parseGenerativeUIIntent(JSON.stringify(intent)).ok).toBe(true);

    const actionBar = intent.blocks.find((b) => b.type === 'action-bar');
    const actions = (actionBar!.props as { actions: Array<{ id: string; riskLevel?: string }> }).actions;
    expect(actions.find((a) => a.id === 'apply-note-edit')?.riskLevel).toBe('high');
  });
});
