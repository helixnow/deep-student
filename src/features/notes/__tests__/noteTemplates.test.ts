import { describe, expect, it } from 'vitest';
import { applyNoteTemplate, getNoteTemplates, renderNoteTemplate } from '../noteTemplates';

describe('note templates', () => {
  it('provides the full template library with card summaries', () => {
    const templates = getNoteTemplates('zh-CN');
    expect(templates.map((item) => item.id)).toEqual([
      'lecture',
      'mistake',
      'exam',
      'meeting',
      'reading',
      'weekly',
      'cornell',
      'literature',
    ]);
    expect(templates.every((item) => item.markdown.includes('## '))).toBe(true);
    expect(templates.every((item) => item.summary.length > 0)).toBe(true);
    expect(templates[0].markdown).toContain('本节目标');
    expect(templates[1].markdown).toContain('错因');
    expect(templates.find((item) => item.id === 'meeting')?.markdown).toContain('行动项');
    expect(templates.find((item) => item.id === 'cornell')?.markdown).toContain('总结');
    expect(templates.find((item) => item.id === 'literature')?.markdown).toContain('研究问题');
  });

  it('keeps title/time variables inside the new templates', () => {
    const templates = getNoteTemplates('zh-CN');
    const meeting = templates.find((item) => item.id === 'meeting');
    expect(meeting?.markdown).toContain('{{title}}');
    expect(meeting?.markdown).toContain('{{time}}');
    const reading = templates.find((item) => item.id === 'reading');
    expect(reading?.markdown).toContain('{{title}}');
  });

  it('returns localized English markdown bodies', () => {
    const templates = getNoteTemplates('en-US');
    expect(templates.map((item) => item.id)).toEqual(
      getNoteTemplates('zh-CN').map((item) => item.id),
    );
    expect(templates[0].markdown).toContain('Learning goals');
    expect(templates[1].markdown).toContain('Root cause');
    expect(templates[2].markdown).toContain('High-frequency topics');
    expect(templates.every((item) => !/[\u4e00-\u9fff]/u.test(item.markdown))).toBe(true);
    expect(templates.every((item) => !/[\u4e00-\u9fff]/u.test(item.summary))).toBe(true);
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

  it('substitutes {{date}}, {{time}} and {{title}} template variables', () => {
    const rendered = renderNoteTemplate('# {{title}}\n> {{date}} {{time}}', {
      date: '2026-07-19',
      time: '16:30',
      title: 'Physics',
    });
    expect(rendered).toBe('# Physics\n> 2026-07-19 16:30');
  });

  it('never leaves raw placeholders when variables are omitted', () => {
    const result = applyNoteTemplate('', '## Recap\n\n> {{date}} {{time}}{{title}}', {
      now: new Date(2026, 6, 19, 8, 5),
      locale: 'en-US',
    });
    expect(result).not.toMatch(/\{\{\s*(date|time|title)\s*\}\}/);
    expect(result.startsWith('## Recap')).toBe(true);
  });

  it('does not substitute variables inside the existing note body', () => {
    const current = 'keep my literal {{date}} text\n';
    const result = applyNoteTemplate(current, '## Goal {{date}}', { date: '2026-07-19' });
    expect(result.startsWith(current)).toBe(true);
    expect(result).toContain('## Goal 2026-07-19');
  });

  it('bundled templates stamp the current date on apply', () => {
    const [lecture] = getNoteTemplates('zh-CN');
    const result = applyNoteTemplate('', lecture.markdown, { date: '2026年7月19日' });
    expect(result.startsWith('> 2026年7月19日')).toBe(true);
  });
});
