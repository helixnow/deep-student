import { describe, expect, it } from 'vitest';

import {
  EMPTY_JUMP_HISTORY,
  buildPaperReadingContextSnapshot,
  buildSelectedPagesLocator,
  detectAcademicReference,
  extractAcademicReferenceSnippet,
  formatPdfOutlineForAgent,
  locateAcademicReferencePage,
  navigateJumpBack,
  navigateJumpForward,
  peekJumpBackEntry,
  peekJumpForwardEntry,
  previewAcademicReference,
  recordReadingJump,
  resolvePaperGuideTargetPages,
  scorePageForAcademicReference,
} from '../pdfPaperNavigation';

describe('ReadingJumpHistory', () => {
  it('ignores 1-page (or dual-page 2-page spread) sequential scrolling unless forced, and records multi-page jumps', () => {
    const s1 = recordReadingJump(EMPTY_JUMP_HISTORY, 3, 4);
    expect(s1.backStack).toHaveLength(0);

    const dualSpread = recordReadingJump(EMPTY_JUMP_HISTORY, 2, 4, { minDelta: 3 });
    expect(dualSpread.backStack).toHaveLength(0);

    const s2 = recordReadingJump(EMPTY_JUMP_HISTORY, 3, 4, { force: true, label: '[12]' });
    expect(s2.backStack).toEqual([{ page: 3, label: '[12]' }]);

    const s3 = recordReadingJump(s2, 4, 15);
    expect(s3.backStack.map((e) => e.page)).toEqual([3, 4]);
  });

  it('supports stepping back and forward across reading positions', () => {
    let state = recordReadingJump(EMPTY_JUMP_HISTORY, 2, 8);
    state = recordReadingJump(state, 8, 14);

    const back1 = navigateJumpBack(state, 14);
    expect(back1.targetPage).toBe(8);
    expect(back1.nextState.forwardStack.map((e) => e.page)).toEqual([14]);

    const back2 = navigateJumpBack(back1.nextState, 8);
    expect(back2.targetPage).toBe(2);
    expect(back2.nextState.forwardStack.map((e) => e.page)).toEqual([14, 8]);

    const fwd = navigateJumpForward(back2.nextState, 2);
    expect(fwd.targetPage).toBe(8);
    expect(fwd.nextState.backStack.map((e) => e.page)).toEqual([2]);
  });

  it('records an external page jump and preserves its reference label while toggling between paper and appendix', () => {
    // External PDF@ reference takes the reader from the paper body to an appendix page.
    let state = recordReadingJump(EMPTY_JUMP_HISTORY, 5, 18, { force: true, label: 'Appendix B' });
    expect(peekJumpBackEntry(state)).toEqual({ page: 5, label: 'Appendix B' });

    const back = navigateJumpBack(state, 18);
    state = back.nextState;
    expect(back.targetPage).toBe(5);
    expect(peekJumpForwardEntry(state)).toEqual({ page: 18, label: 'Appendix B' });

    const forward = navigateJumpForward(state, 5);
    state = forward.nextState;
    expect(forward.targetPage).toBe(18);
    expect(peekJumpBackEntry(state)).toEqual({ page: 5, label: 'Appendix B' });

    const backAgain = navigateJumpBack(state, 18);
    expect(backAgain.targetPage).toBe(5);
    expect(peekJumpForwardEntry(backAgain.nextState)).toEqual({ page: 18, label: 'Appendix B' });
  });
});

describe('detectAcademicReference', () => {
  it('detects bracket numeric citations, author-year citations, figures, tables, equations, and appendices', () => {
    expect(detectAcademicReference('[12]')).toEqual({
      kind: 'citation',
      id: '12',
      displayLabel: '[12]',
    });
    expect(detectAcademicReference('[12].')).toEqual({
      kind: 'citation',
      id: '12',
      displayLabel: '[12]',
    });
    expect(detectAcademicReference('[3, 12, 18],')).toEqual({
      kind: 'citation',
      id: '3',
      displayLabel: '[3]',
    });
    expect(detectAcademicReference('(Vaswani et al., 2017)')).toEqual({
      kind: 'citation',
      id: 'Vaswani:2017',
      displayLabel: 'Vaswani 2017',
    });
    expect(detectAcademicReference('Fig. 3(a)')).toEqual({
      kind: 'figure',
      id: '3',
      displayLabel: 'Fig. 3',
    });
    expect(detectAcademicReference('Table 2')).toEqual({
      kind: 'table',
      id: '2',
      displayLabel: 'Table 2',
    });
    expect(detectAcademicReference('Eq. (7)')).toEqual({
      kind: 'equation',
      id: '7',
      displayLabel: 'Eq. (7)',
    });
    expect(detectAcademicReference('Appendix B')).toEqual({
      kind: 'appendix',
      id: 'B',
      displayLabel: 'Appendix B',
    });
    expect(detectAcademicReference('This is a long regular sentence in a paper.')).toBeNull();
  });
});

describe('locateAcademicReferencePage', () => {
  it('locates bibliography entries from the end of the paper first', async () => {
    const pages: Record<number, string> = {
      1: 'Introduction: Transformer [12] changed sequence modeling.',
      2: 'Method details as shown in Fig. 3.',
      3: 'Figure 3: Multi-Head Attention architecture overview.',
      4: 'Conclusion and future work.',
      5: 'References\n[11] Hochreiter & Schmidhuber, 1997.\n[12] Vaswani, A., et al. Attention is all you need, 2017.',
    };
    const visited: number[] = [];
    const citeRef = detectAcademicReference('[12]')!;
    const targetCitePage = await locateAcademicReferencePage({
      numPages: 5,
      currentPage: 1,
      ref: citeRef,
      getPageText: async (p) => {
        visited.push(p);
        return pages[p] ?? '';
      },
    });
    expect(targetCitePage).toBe(5);
    // Reverse scan hits page 5 on the very first read!
    expect(visited).toEqual([5]);

    const figRef = detectAcademicReference('Fig. 3')!;
    const targetFigPage = await locateAcademicReferencePage({
      numPages: 5,
      currentPage: 2,
      ref: figRef,
      getPageText: async (p) => pages[p] ?? '',
    });
    expect(targetFigPage).toBe(3);
  });

  it('scores figure captions higher than inline mentions', () => {
    const ref = detectAcademicReference('Figure 2')!;
    expect(scorePageForAcademicReference('As illustrated in Figure 2, accuracy rises.', ref)).toBe(
      0,
    );
    expect(
      scorePageForAcademicReference('Figure 2: Accuracy across model scales on MMLU.', ref),
    ).toBe(3);
  });
});

describe('Paper reading context snapshot & outline target page planning', () => {
  const sampleOutline = [
    { title: '1 Introduction' },
    {
      title: '2 Model Architecture',
      items: [{ title: '2.1 Scaled Dot-Product Attention' }],
    },
    { title: '3 Experiments & Ablation' },
    { title: '4 Conclusion' },
  ];
  const sampleOutlinePages = new Map<string, number>([
    ['0', 1],
    ['1', 3],
    ['1.0', 4],
    ['2', 7],
    ['3', 10],
  ]);

  it('formats hierarchical outline with mapped page numbers', () => {
    const formatted = formatPdfOutlineForAgent(sampleOutline, sampleOutlinePages);
    expect(formatted).toBe(
      [
        '- 1 Introduction (p. 1)',
        '- 2 Model Architecture (p. 3)',
        '  - 2.1 Scaled Dot-Product Attention (p. 4)',
        '- 3 Experiments & Ablation (p. 7)',
        '- 4 Conclusion (p. 10)',
      ].join('\n'),
    );
  });

  it('resolves target pages for current_page, methodology, and critique modes', () => {
    expect(
      resolvePaperGuideTargetPages({
        mode: 'current_page',
        numPages: 12,
        currentPage: 5,
      }),
    ).toEqual([5]);

    expect(
      resolvePaperGuideTargetPages({
        mode: 'current_page',
        numPages: 12,
        currentPage: 5,
        selectedPages: new Set([3, 6]),
      }),
    ).toEqual([3, 6]);

    // methodology 自动纳入首页(1, 2)、当前页(5)以及目录匹配的 Model Architecture (3, 4)
    expect(
      resolvePaperGuideTargetPages({
        mode: 'methodology',
        numPages: 12,
        currentPage: 5,
        outline: sampleOutline,
        outlinePages: sampleOutlinePages,
      }),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('builds structured paper snapshot with TOC, page citations, and resource_read hint', () => {
    const outlineText = formatPdfOutlineForAgent(sampleOutline, sampleOutlinePages);
    const snapshot = buildPaperReadingContextSnapshot({
      title: 'Attention Is All You Need',
      sourceId: 'tb_attn',
      numPages: 12,
      currentPage: 3,
      mode: 'overview',
      outlineText,
      pageTexts: [
        { page: 1, text: 'Abstract: We propose the Transformer.' },
        { page: 3, text: 'Section 2: Multi-head attention consists of h heads.' },
      ],
    });

    expect(snapshot).toContain('文档：《Attention Is All You Need》');
    expect(snapshot).toContain('【论文目录大纲（章节 → 页码）】');
    expect(snapshot).toContain('### [PDF@tb_attn:1] 第 1 页正文');
    expect(snapshot).toContain('### [PDF@tb_attn:3] 第 3 页正文');
    expect(snapshot).toContain('builtin-resource_read(resource_id="tb_attn"');
    expect(buildSelectedPagesLocator([3, 7])).toBe('page:3-7');

    // current_page 导读模式同样携带论文目录大纲，帮助模型定位当前页所属章节脉络
    const currentPageSnapshot = buildPaperReadingContextSnapshot({
      title: 'Attention Is All You Need',
      sourceId: 'tb_attn',
      numPages: 12,
      currentPage: 3,
      mode: 'current_page',
      outlineText,
      pageTexts: [{ page: 3, text: 'Section 2: Multi-head attention consists of h heads.' }],
    });
    expect(currentPageSnapshot).toContain('【论文目录大纲（章节 → 页码）】');
  });

  it('extracts inline preview snippets for citations, figures, tables, and equations', async () => {
    const pages: Record<number, string> = {
      1: 'As shown in [12] and Fig. 3, Attention Eq. (4) improves BLEU.',
      3: '3 Model Architecture\nFigure 3: Multi-Head Attention consists of several attention layers running in parallel.\n\nAttention(Q, K, V) = softmax(QK^T / sqrt(d_k))V   (4)',
      6: 'References\n[11] Hochreiter & Schmidhuber. Long short-term memory, 1997.\n[12] Vaswani, A., Shazeer, N., et al. Attention is all you need. NeurIPS, 2017.\n[13] Devlin, J., et al. BERT, 2019.',
    };

    const citePreview = await previewAcademicReference({
      numPages: 6,
      currentPage: 1,
      ref: detectAcademicReference('[12]')!,
      getPageText: async (p) => pages[p] ?? '',
    });
    expect(citePreview).toEqual({
      ref: { kind: 'citation', id: '12', displayLabel: '[12]' },
      page: 6,
      snippet: '[12] Vaswani, A., Shazeer, N., et al. Attention is all you need. NeurIPS, 2017.',
    });

    const figPreview = await previewAcademicReference({
      numPages: 6,
      currentPage: 1,
      ref: detectAcademicReference('Fig. 3')!,
      getPageText: async (p) => pages[p] ?? '',
    });
    expect(figPreview?.page).toBe(3);
    expect(figPreview?.snippet).toContain('Figure 3: Multi-Head Attention');

    const eqSnippet = extractAcademicReferenceSnippet(
      pages[3]!,
      detectAcademicReference('Eq. (4)')!,
    );
    expect(eqSnippet).toContain('Attention(Q, K, V) = softmax(QK^T / sqrt(d_k))V (4)');
  });
});
