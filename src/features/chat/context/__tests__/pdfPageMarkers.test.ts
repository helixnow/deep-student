import { describe, expect, it } from 'vitest';
import {
  fileDefinition,
  formatPdfTextWithPageMarkers as formatFilePdfPages,
} from '../definitions/file';
import {
  textbookDefinition,
  formatPdfTextWithPageMarkers as formatTextbookPdfPages,
} from '../definitions/textbook';
import type { Resource } from '../types';

describe('formatPdfTextWithPageMarkers blank-page numbering preservation', () => {
  it('preserves original 1-based page numbers when middle pages are blank (file.ts)', () => {
    const raw = 'Page 1 intro\u000C   \u000CPage 3 content\u000C\u000CPage 5 table';
    const output = formatFilePdfPages('paper.pdf', 'att_pdf1', raw);

    expect(output).toContain('page="1"');
    expect(output).toContain('[PDF@att_pdf1:1] paper.pdf 第1页');
    expect(output).not.toContain('page="2"');
    expect(output).toContain('page="3"');
    expect(output).toContain('[PDF@att_pdf1:3] paper.pdf 第3页');
    expect(output).not.toContain('page="4"');
    expect(output).toContain('page="5"');
    expect(output).toContain('[PDF@att_pdf1:5] paper.pdf 第5页');
  });

  it('preserves original 1-based page numbers when leading pages are blank (file.ts)', () => {
    const raw = '\u000CPage 2 body';
    const output = formatFilePdfPages('cover.pdf', 'att_cover', raw);

    expect(output).not.toContain('page="1"');
    expect(output).toContain('page="2"');
    expect(output).toContain('[PDF@att_cover:2] cover.pdf 第2页');
  });

  it('preserves original 1-based page numbers in fileDefinition.formatToBlocks', () => {
    const resource: Resource = {
      id: 'res_1',
      typeId: 'file',
      sourceId: 'att_pdf1',
      metadata: { name: 'paper.pdf', mimeType: 'application/pdf' },
      _resolvedResources: [
        {
          sourceId: 'att_pdf1',
          found: true,
          name: 'paper.pdf',
          content: 'P1\u000C\u000CP3',
          metadata: { name: 'paper.pdf', mimeType: 'application/pdf' },
        },
      ],
    };

    const blocks = fileDefinition.formatToBlocks(resource, { injectModes: { pdf: ['text'] } });
    const attachmentBlock = blocks.find((b) => b.type === 'text' && b.text.includes('<attachment'));
    expect(attachmentBlock?.type).toBe('text');
    if (attachmentBlock?.type === 'text') {
      expect(attachmentBlock.text).toContain('page="1"');
      expect(attachmentBlock.text).toContain('page="3"');
      expect(attachmentBlock.text).not.toContain('page="2"');
    }
  });

  it('preserves original 1-based page numbers when middle pages are blank (textbook.ts)', () => {
    const raw = 'Chapter 1\u000C\n  \u000CChapter 3';
    const output = formatTextbookPdfPages('book.pdf', 'tb_1', raw);

    expect(output).toContain('page="1"');
    expect(output).toContain('[PDF@tb_1:1] book.pdf 第1页');
    expect(output).not.toContain('page="2"');
    expect(output).toContain('page="3"');
    expect(output).toContain('[PDF@tb_1:3] book.pdf 第3页');
  });

  it('preserves original 1-based page numbers in textbookDefinition.formatToBlocks', () => {
    const resource: Resource = {
      id: 'res_tb1',
      typeId: 'textbook',
      sourceId: 'tb_1',
      metadata: { title: 'book.pdf' },
      _resolvedResources: [
        {
          sourceId: 'tb_1',
          found: true,
          name: 'book.pdf',
          path: '/tb_1',
          content: 'Page 1\u000C\u000CPage 3',
          metadata: { title: 'book.pdf' },
        },
      ],
    };

    const blocks = textbookDefinition.formatToBlocks(resource);
    const textbookBlock = blocks.find((b) => b.type === 'text' && b.text.includes('<textbook'));
    expect(textbookBlock?.type).toBe('text');
    if (textbookBlock?.type === 'text') {
      expect(textbookBlock.text).toContain('page="1"');
      expect(textbookBlock.text).toContain('page="3"');
      expect(textbookBlock.text).not.toContain('page="2"');
    }
  });
});
