import { describe, expect, it } from 'vitest';

import { textbookPdfToolsSkill } from '../builtin-tools/textbook-pdf-tools';

function tool(name: string) {
  const matches = textbookPdfToolsSkill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe('phase 8 textbook/PDF tool contracts', () => {
  it('keeps progressive disclosure closed over exactly three tools', () => {
    expect(textbookPdfToolsSkill.allowedTools).toEqual(
      textbookPdfToolsSkill.embeddedTools?.map((entry) => entry.name),
    );
    expect(new Set(textbookPdfToolsSkill.allowedTools).size).toBe(3);
    expect(textbookPdfToolsSkill.content).toContain('pdf-annotations:changed');
    expect(textbookPdfToolsSkill.content).toContain('OCC');
  });

  it('uses closed action branches and requires OCC on every bookmark write', () => {
    const schema = tool('builtin-textbook_bookmarks').inputSchema;
    expect(schema.oneOf).toHaveLength(4);
    expect(schema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    const branches = schema.oneOf as any[];
    expect(branches[0].properties.page_size.maximum).toBe(20);
    for (const branch of branches.slice(1)) {
      expect(branch.required).toContain('expected_updated_at');
    }
    expect(branches[1].properties.page_number.minimum).toBe(1);
    expect(branches[1].properties.title.maxLength).toBe(500);
  });

  it('pins highlights to reader colors and normalized coordVersion 2 rectangles', () => {
    const schema = tool('builtin-textbook_highlights').inputSchema;
    expect(schema.oneOf).toHaveLength(4);
    expect(schema.oneOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    const add = schema.oneOf?.[1] as any;
    expect(add.required).toEqual([
      'action',
      'textbook_id',
      'page_index',
      'text',
      'color',
      'rects',
      'expected_updated_at',
    ]);
    expect(add.properties.text.maxLength).toBe(20000);
    expect(add.properties.color.enum).toEqual(['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca']);
    expect(add.properties.rects.maxItems).toBe(64);
    expect(add.properties.rects.items.additionalProperties).toBe(false);
    expect(add.properties.rects.items.properties.x.maximum).toBe(1);
  });

  it('keeps PDF page images read-only, zero-based and strictly identified', () => {
    const pageImageTool = tool('builtin-pdf_page_image');
    const schema = pageImageTool.inputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['resource_id', 'page_index']);
    expect(schema.properties.resource_id.pattern).toBe('^res_[A-Za-z0-9_-]+$');
    expect(schema.properties.page_index.minimum).toBe(0);
    expect(pageImageTool.description).toContain('最长边 2048');
    expect(pageImageTool.description).toContain('绝不返回截断 base64');
  });
});
