import { describe, expect, it } from 'vitest';
import { parseQuickAssistantBounds } from '../src/quick-assistant.ts';
import {
  formatApa, formatBibtex, formatGbt7714, localizedPaperFailure, paperSaveCanHandle,
  paperSaveSensitivity, sanitizeFilename, stripToolNamespace,
} from '../src/paper-save.ts';

describe('quick assistant bounds', () => {
  it('parses_valid_bounds', () => {
    expect(parseQuickAssistantBounds('10,-20,520,420')).toEqual([10, -20, 520, 420]);
  });

  it('rejects_malformed_bounds', () => {
    expect(parseQuickAssistantBounds('')).toBeNull();
    expect(parseQuickAssistantBounds('10,20')).toBeNull();
    expect(parseQuickAssistantBounds('10,20,0,420')).toBeNull();
    expect(parseQuickAssistantBounds('a,b,c,d')).toBeNull();
  });
});

describe('paper save executor pure layer', () => {
  it('test_can_handle paper_save', () => {
    expect(paperSaveCanHandle('builtin-paper_save')).toBe(true);
    expect(paperSaveCanHandle('builtin-cite_format')).toBe(true);
    expect(paperSaveCanHandle('builtin-arxiv_search')).toBe(false);
    expect(paperSaveCanHandle('builtin-web_search')).toBe(false);
    expect(stripToolNamespace('builtin-paper_save')).toBe('paper_save');
    expect(stripToolNamespace('paper_save')).toBe('paper_save');
  });

  it('test_sensitivity paper_save', () => {
    expect(paperSaveSensitivity('builtin-paper_save')).toBe('medium');
    expect(paperSaveSensitivity('builtin-cite_format')).toBe('low');
  });

  it('executor_failure_boundary_localizes_paper_errors', () => {
    const error = JSON.parse(localizedPaperFailure(
      "Missing required parameter 'papers' (array)")) as Record<string, unknown>;
    expect(error['code']).toBe('PAPER_OPERATION_FAILED');
    expect(error['messageKey']).toBe('chat.tools.paper.error');
    expect(typeof (error['messageFallback'] as Record<string, unknown>)['zh-CN']).toBe('string');
    expect(typeof (error['messageFallback'] as Record<string, unknown>)['en-US']).toBe('string');
  });

  it('test_sanitize_filename', () => {
    expect(sanitizeFilename('A Survey of Transformers')).toBe('A Survey of Transformers');
    expect(sanitizeFilename('What/Why:How?')).toBe('What_Why_How_');
    expect(sanitizeFilename('Test <file> "name"')).toBe('Test _file_ _name_');
  });

  it('test_sanitize_filename_chinese_truncation', () => {
    const longChinese = '基'.repeat(101);
    const result = sanitizeFilename(longChinese);
    expect(Array.from(result)).toHaveLength(100);
    // Valid UTF-8: the JS string still contains the original code points.
    expect(result).toBe('基'.repeat(100));
  });

  it('test_format_bibtex', () => {
    const paper = {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      venue: 'NeurIPS',
      doi: '10.5555/3295222.3295349',
    };
    const bib = formatBibtex(paper);
    expect(bib).toContain('@article{vaswani2017');
    expect(bib).toContain('Attention Is All You Need');
    expect(bib).toContain('Ashish Vaswani and Noam Shazeer');
  });

  it('test_format_gbt7714', () => {
    const paper = {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      venue: 'NeurIPS',
    };
    const citation = formatGbt7714(paper);
    expect(citation).toContain('Ashish Vaswani, Noam Shazeer.');
    expect(citation).toContain('Attention Is All You Need[J].');
    expect(citation).toContain('NeurIPS, 2017.');
  });

  it('test_format_apa', () => {
    const paper = {
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      venue: 'NeurIPS',
      doi: '10.5555/3295222.3295349',
    };
    const citation = formatApa(paper);
    expect(citation).toContain('Vaswani, A.');
    expect(citation).toContain('(2017)');
    expect(citation).toContain('*NeurIPS*');
  });

  it('test_format_gbt7714_many_authors', () => {
    const paper = {
      title: 'Test Paper',
      authors: ['Author A', 'Author B', 'Author C', 'Author D', 'Author E'],
      year: 2024,
    };
    const citation = formatGbt7714(paper);
    expect(citation).toContain('Author A, Author B, Author C, 等.');
  });
});
