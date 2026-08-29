import { describe, expect, it } from 'vitest';
import { buildMarkdownIntent } from '@/features/generative-ui/utils/buildMarkdownIntent';
import { markdownPropsSchema } from '@/features/generative-ui/components/MarkdownBlock';

describe('buildMarkdownIntent', () => {
  it('emits a markdown block that passes schema after trim', () => {
    const intent = buildMarkdownIntent({
      title: '  标题  ',
      body: '  **正文**  ',
      variant: 'compact',
    });

    expect(intent.version).toBe('1');
    expect(intent.blocks).toHaveLength(1);
    expect(intent.blocks[0]?.type).toBe('markdown');

    const parsed = markdownPropsSchema.safeParse(intent.blocks[0]?.props);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe('标题');
      expect(parsed.data.body).toBe('**正文**');
      expect(parsed.data.variant).toBe('compact');
    }
  });

  it('truncates overlong title and body so schema still succeeds', () => {
    const intent = buildMarkdownIntent({
      title: 'T'.repeat(200),
      body: 'B'.repeat(25000),
    });

    const parsed = markdownPropsSchema.safeParse(intent.blocks[0]?.props);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toHaveLength(120);
      expect(parsed.data.body).toHaveLength(20000);
    }
  });

  it('uses labels.empty when body is whitespace so output remains schema-valid', () => {
    const intent = buildMarkdownIntent({
      body: '   \n',
      labels: { empty: '占位正文' },
    });

    const parsed = markdownPropsSchema.safeParse(intent.blocks[0]?.props);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.body).toBe('占位正文');
    }
  });
});
