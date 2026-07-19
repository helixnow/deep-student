import { describe, expect, it } from 'vitest';
import { applyNoteTemplate, getNoteTemplates } from '../noteTemplates';

describe('note templates', () => {
  it('provides the three bounded learning skeletons', () => {
    const templates = getNoteTemplates('zh-CN');
    expect(templates.map((item) => item.id)).toEqual(['lecture', 'mistake', 'exam']);
    expect(templates.every((item) => item.markdown.includes('## '))).toBe(true);
    expect(templates[0].markdown).toContain('本节目标');
    expect(templates[1].markdown).toContain('错因');
  });

  it('returns localized English markdown bodies', () => {
    const templates = getNoteTemplates('en-US');
    expect(templates[0].markdown).toContain('Learning goals');
    expect(templates[1].markdown).toContain('Root cause');
    expect(templates[2].markdown).toContain('High-frequency topics');
    expect(templates.every((item) => !/[\u4e00-\u9fff]/u.test(item.markdown))).toBe(true);
  });

  it('fills an empty note without adding unrelated metadata', () => {
    expect(applyNoteTemplate('  ', '## Goal\n')).toBe('## Goal\n');
  });

  it('appends to a non-empty note instead of overwriting it', () => {
    expect(applyNoteTemplate('# Existing\n', '## Goal\n')).toBe('# Existing\n\n---\n\n## Goal\n');
  });

  it('preserves semantic whitespace in existing Markdown', () => {
    const current = '    indented code\nline with hard break  \n';
    const result = applyNoteTemplate(current, '## Goal');
    expect(result.startsWith(current)).toBe(true);
    expect(result).toContain('line with hard break  \n\n---\n');
  });
});
