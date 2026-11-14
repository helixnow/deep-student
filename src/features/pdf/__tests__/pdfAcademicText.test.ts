import { describe, expect, it } from 'vitest';

import {
  ACADEMIC_HIGHLIGHT_COLORS,
  cleanAcademicDocumentTitle,
  formatAcademicCitation,
  normalizePdfAcademicText,
  resolveHighlightSemanticKey,
} from '../pdfAcademicText';

describe('normalizePdfAcademicText', () => {
  it('rejoins syllable hyphenation across PDF column line wraps', () => {
    const raw =
      'We propose a new simple network architec-\nture, the Trans-\nformer, based solely on atten-\ntion mechanisms.';
    expect(normalizePdfAcademicText(raw)).toBe(
      'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
    );
  });

  it('preserves real compound hyphens across line breaks (self-attention, zero-shot, GPT-4, U-Net, k-means)', () => {
    const raw =
      'Multi-\nhead self-\nattention outperforms Cross-\nEntropy baselines on zero-\nshot tasks in GPT-\n4, U-\nNet, and k-\nmeans.';
    expect(normalizePdfAcademicText(raw)).toBe(
      'Multi-head self-attention outperforms Cross-Entropy baselines on zero-shot tasks in GPT-4, U-Net, and k-means.',
    );
  });

  it('rejoins single-letter syllable hyphenation (a-mazing, e-valuation) and 4-digit years at line start', () => {
    const raw =
      'This is an a-\nmazing e-\nvaluation released in\n2024. The dataset covers 10k papers.';
    expect(normalizePdfAcademicText(raw)).toBe(
      'This is an amazing evaluation released in 2024. The dataset covers 10k papers.',
    );
  });

  it('normalizes private-use PDF ligatures and soft hyphens', () => {
    const raw = 'ef\uFB01cient work\uFB02ow and opti\u00ad\nmization';
    expect(normalizePdfAcademicText(raw)).toBe('efficient workflow and optimization');
  });

  it('joins CJK cross-line wraps without inserting extra spaces while keeping English word spacing', () => {
    const raw = '深度神经网络在自然语言\n处理任务中展现出优异的\n泛化能力，特别是 Transformer\n模型结构。';
    expect(normalizePdfAcademicText(raw)).toBe(
      '深度神经网络在自然语言处理任务中展现出优异的泛化能力，特别是 Transformer 模型结构。',
    );
  });

  it('preserves intentional blank-line paragraph breaks and bullet lists', () => {
    const raw = [
      'First paragraph split across',
      'two hard PDF lines.',
      '',
      'Contributions:',
      '1. Fast inference on edge devices.',
      '2. Memory-efficient kv-cache.',
    ].join('\n');
    expect(normalizePdfAcademicText(raw)).toBe(
      [
        'First paragraph split across two hard PDF lines.',
        '',
        'Contributions:\n1. Fast inference on edge devices.\n2. Memory-efficient kv-cache.',
      ].join('\n'),
    );
  });
});

describe('cleanAcademicDocumentTitle & formatAcademicCitation', () => {
  it('strips .pdf extension cleanly', () => {
    expect(cleanAcademicDocumentTitle('Attention_Is_All_You_Need.PDF')).toBe(
      'Attention_Is_All_You_Need',
    );
    expect(cleanAcademicDocumentTitle('  DeepSeek-R1.pdf  ')).toBe('DeepSeek-R1');
  });

  it('formats inline academic citations with normalized text, title, and page', () => {
    expect(
      formatAcademicCitation({
        text: 'Attention is all\nyou need.',
        documentTitle: 'Vaswani2017.pdf',
        page: 3,
      }),
    ).toBe('"Attention is all you need." (Vaswani2017, p. 3)');
  });

  it('formats markdown citations with pdfref:// backlink when sourceId and page exist', () => {
    expect(
      formatAcademicCitation({
        text: 'Scaled dot-product\nattention.',
        documentTitle: 'Attention.pdf',
        page: 4,
        sourceId: 'tb_attn',
        style: 'markdown',
      }),
    ).toBe('> Scaled dot-product attention.\n\n— [Attention, p. 4](pdfref://tb_attn?page=4&quote=Scaled%20dot-product%20attention.)');
  });
});

describe('resolveHighlightSemanticKey', () => {
  it('maps the 5 academic colors case-insensitively and returns null for unknown hex', () => {
    expect(resolveHighlightSemanticKey(ACADEMIC_HIGHLIGHT_COLORS.yellow)).toBe('yellow');
    expect(resolveHighlightSemanticKey('#E9D5FF')).toBe('purple');
    expect(resolveHighlightSemanticKey('#123456')).toBeNull();
  });
});
