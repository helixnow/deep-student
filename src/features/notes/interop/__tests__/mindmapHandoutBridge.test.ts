import { describe, expect, it } from 'vitest';
import { serializeSemanticAnchor, type SemanticAnchor } from '@/ui-kernel/contracts/interop';
import {
  buildNoteBlockExcerptPayload,
  buildNoteHandoutAnchorEdges,
  compileMindMapSubtreeToHandout,
  compileMindMapSubtreeToHandoutMarkdown,
  extractProvenanceLinksFromHandout,
  parseHandoutMarkdownToMindMapDraft,
  type HandoutMindMapNodeInput,
} from '../mindmapHandoutBridge';

describe('mindmapHandoutBridge (C7 §2.3 & §3.2)', () => {
  it('round-trips escaped labels, encoded parentheses, multiline math, images and personal notes without quoting citations', () => {
    const anchor: SemanticAnchor = { kind: 'pdf', resourceId: 'pdf_1', page: 12,
      label: 'Book [A] (2026)', quote: 'f(x) in [0, 1] (bounded)' };
    const latex = ['\\begin{aligned}', 'a &= b', 'c &= d', '\\end{aligned}'].join('\n');
    const result = compileMindMapSubtreeToHandout({ id: 'root', text: 'Theorem',
      cardNote: 'Personal synthesis.\n\nSecond paragraph.',
      excerpts: [{ text: 'First quote line\nSecond quote line', latex, imageAssetId: 'crop_12', anchor }] });
    expect(result.markdown).toContain('%28');
    expect(result.markdown).toContain('Book \\[A\\] (2026)');
    expect(result.provenanceLinks).toHaveLength(1);
    expect(result.provenanceLinks[0].anchor).toEqual(anchor);
    const draft = parseHandoutMarkdownToMindMapDraft(result.markdown)!;
    expect(draft.note).toBe('Personal synthesis.\n\nSecond paragraph.');
    expect(draft.excerpts).toHaveLength(1);
    expect(draft.excerpts[0]).toMatchObject({ text: 'First quote line\nSecond quote line', latex,
      imageDataUrl: 'vfs://asset/crop_12', anchor });
    expect(draft.excerptQuote).not.toContain('ds-anchor:');
    expect(compileMindMapSubtreeToHandout(draft).provenanceLinks).toHaveLength(1);
  });

  it('retains invalid citation text and unterminated math instead of silently dropping source text', () => {
    const draft = parseHandoutMarkdownToMindMapDraft('## A\n\n> — [Broken](ds-anchor://v1/pdf/bad?page=0)\n> $$x\n> y')!;
    expect(draft.excerpts[0].text).toBe('— [Broken](ds-anchor://v1/pdf/bad?page=0)\n$$x\ny');
  });
  const pdfAnchor: SemanticAnchor = {
    kind: 'pdf',
    resourceId: 'pdf_calc_01',
    page: 42,
    rect: { x: 0.12, y: 0.25, w: 0.64, h: 0.18 },
    quote: 'Every bounded monotonic sequence converges.',
    label: 'Calculus (8th Ed.)',
  };

  const mediaAnchor: SemanticAnchor = {
    kind: 'media',
    resourceId: 'vid_lec_07',
    startMs: 862_000,
    endMs: 895_000,
    label: 'MIT 18.01 Lecture 7',
  };

  const qbankAnchor: SemanticAnchor = {
    kind: 'qbank',
    resourceId: 'exam_2025_math1',
    questionId: 'q_14',
    label: '2025 Math I Real Exam',
  };

  it('compiles a multi-level MindMap subtree into structured Markdown preserving all downstream provenance capsules', () => {
    const subtree: HandoutMindMapNodeInput = {
      id: 'node_convergence',
      text: 'Monotone Convergence & Compactness',
      note: 'Core bridge between order completeness and Bolzano-Weierstrass.',
      excerpts: [
        {
          id: 'ex_1',
          excerptKind: 'text',
          text: 'Every bounded monotonic sequence of real numbers converges to its supremum or infimum.',
          latex: '\\lim_{n \\to \\infty} a_n = \\sup_n a_n',
          anchor: pdfAnchor,
          sourceTitle: 'Calculus (8th Ed.)',
        },
        {
          id: 'ex_2',
          excerptKind: 'transcript-cue',
          text: 'Watch where boundedness fails on open intervals.',
          anchor: mediaAnchor,
        },
      ],
      children: [
        {
          id: 'node_counterexample',
          text: 'Classic Exam Counterexamples',
          note: 'Check endpoint compactness first.',
          anchors: [qbankAnchor],
          excerptQuote: 'Construct a strictly increasing sequence in (0, 1) with no maximum.',
          imageAssetId: 'crop_9f2a',
          children: [
            {
              id: 'node_deep_leaf',
              text: 'Harmonic partial sums diverge',
              children: [
                {
                  id: 'node_nested_bullet',
                  text: 'Oresme grouping proof',
                  note: 'Group 2^k terms bounded below by 1/2.',
                },
              ],
            },
          ],
        },
      ],
    };

    const result = compileMindMapSubtreeToHandout(subtree, {
      mindmapId: 'mm_analysis_hub',
      mindmapTitle: 'Real Analysis Hub',
      baseHeadingLevel: 2,
      maxHeadingLevel: 4,
    });

    expect(result.sectionCount).toBe(4);
    expect(result.markdown).toContain('## Monotone Convergence & Compactness');
    expect(result.markdown).toContain('### Classic Exam Counterexamples');
    expect(result.markdown).toContain('#### Harmonic partial sums diverge');
    expect(result.markdown).toContain('- **Oresme grouping proof**');
    // Parentheses in label are safely percent-encoded so CommonMark links never break.
    expect(result.markdown).toContain('label=Calculus%20%288th%20Ed.%29');
    expect(result.markdown).toContain('p.42');
    expect(result.markdown).toContain('14:22');
    expect(result.markdown).toContain('vfs://asset/crop_9f2a');
    expect(result.markdown).toContain('$$\\lim_{n \\to \\infty} a_n = \\sup_n a_n$$');

    expect(result.provenanceLinks).toHaveLength(3);
    expect(result.provenanceLinks.map((l) => l.anchor.kind)).toEqual(['pdf', 'media', 'qbank']);
    expect(result.provenanceLinks[0].anchor).toMatchObject({
      kind: 'pdf',
      resourceId: 'pdf_calc_01',
      page: 42,
      rect: { x: 0.12, y: 0.25, w: 0.64, h: 0.18 },
      label: 'Calculus (8th Ed.)',
    });
    expect(result.provenanceLinks[1].shortLocator).toBe('14:22');
    expect(result.provenanceLinks[1].sectionHeading).toBe('Monotone Convergence & Compactness');
    expect(result.provenanceLinks[2].sectionHeading).toBe('Classic Exam Counterexamples');

    expect(result.anchorEdges).toHaveLength(3);
    expect(result.anchorEdges[0].sourceKind).toBe('mindmap');
    expect(result.anchorEdges[0].targetPage).toBe(42);
    expect(result.anchorEdges[1].targetStartMs).toBe(862_000);
  });

  it('reads a provenance destination that the editor escaped as `\\&`', () => {
    // Crepe 序列化 `?node=…&label=…` 时会写成 `…\&label=…`，这是合法的 CommonMark 转义。
    const md = [
      '# 糖酵解途径',
      '',
      '> — [高等数学](ds-anchor://v1/mindmap/mm_es?node=node_a\\&label=%E9%AB%98%E7%AD%89)',
    ].join('\n');

    const links = extractProvenanceLinksFromHandout(md);
    expect(links).toHaveLength(1);
    expect(links[0].anchor.kind).toBe('mindmap');
    expect(links[0].anchor.resourceId).toBe('mm_es');
    expect((links[0].anchor as { nodeId?: string }).nodeId).toBe('node_a');

    const draft = parseHandoutMarkdownToMindMapDraft(md, { noteId: 'note_es' });
    expect(draft?.anchors?.some((anchor) => anchor.kind === 'mindmap' && (anchor as { nodeId?: string }).nodeId === 'node_a')).toBe(true);
  });

  it('ignores ds-anchor strings inside fenced code blocks and rejects malformed anchor URIs', () => {
    const validUri = serializeSemanticAnchor(pdfAnchor);
    const md = [
      '## Valid Section',
      `See [Textbook p.42](${validUri.replace(/\(/g, '%28').replace(/\)/g, '%29')}) and [Tampered](ds-anchor://v1/pdf/../etc/passwd?page=0).`,
      '```markdown',
      `[Ignored In Code Fence](${validUri})`,
      '```',
    ].join('\n');

    const links = extractProvenanceLinksFromHandout(md);
    expect(links).toHaveLength(1);
    expect(links[0].anchor.resourceId).toBe('pdf_calc_01');
  });

  it('round-trips compiled handout Markdown back into a Compound MindMap node draft and Note anchor edges', () => {
    const original: HandoutMindMapNodeInput = {
      id: 'node_root',
      text: 'Linear Algebra Spectral Theorem',
      note: 'Real symmetric matrices are orthogonally diagonalizable.',
      excerpts: [
        {
          excerptKind: 'text',
          text: 'Eigenvalues of real symmetric matrices are real.',
          latex: 'A = Q \\Lambda Q^T',
          anchor: pdfAnchor,
        },
      ],
      children: [
        {
          id: 'node_child',
          text: 'Quadratic Form Extremal Values',
          note: 'Rayleigh quotient attains lambda_max on the unit sphere.',
          excerpts: [
            {
              excerptKind: 'transcript-cue',
              text: 'Visualize the principal axes of the ellipsoid.',
              anchor: mediaAnchor,
            },
          ],
        },
      ],
    };

    const markdown = compileMindMapSubtreeToHandoutMarkdown(original, { baseHeadingLevel: 2 });
    const draft = parseHandoutMarkdownToMindMapDraft(markdown, {
      noteId: 'note_la_01',
      noteTitle: 'Spectral Lecture Notes',
    });

    expect(draft).not.toBeNull();
    expect(draft!.text).toBe('Linear Algebra Spectral Theorem');
    expect(draft!.note).toBe('Real symmetric matrices are orthogonally diagonalizable.');
    expect(draft!.excerpts).toHaveLength(1);
    expect(draft!.excerpts[0].text).toBe('Eigenvalues of real symmetric matrices are real.');
    expect(draft!.excerpts[0].latex).toBe('A = Q \\Lambda Q^T');
    expect(draft!.excerpts[0].anchor).toMatchObject({
      kind: 'pdf',
      resourceId: 'pdf_calc_01',
      page: 42,
    });
    expect(draft!.sourceNoteAnchor).toMatchObject({
      kind: 'note',
      resourceId: 'note_la_01',
      heading: 'Linear Algebra Spectral Theorem',
    });

    expect(draft!.children).toHaveLength(1);
    expect(draft!.children[0].text).toBe('Quadratic Form Extremal Values');
    expect(draft!.children[0].note).toBe(
      'Rayleigh quotient attains lambda_max on the unit sphere.',
    );
    expect(draft!.children[0].excerpts[0].excerptKind).toBe('transcript-cue');
    expect(draft!.children[0].anchors[0]).toMatchObject({
      kind: 'media',
      resourceId: 'vid_lec_07',
      startMs: 862_000,
    });

    const noteEdges = buildNoteHandoutAnchorEdges('note_la_01', markdown, {
      noteTitle: 'Spectral Lecture Notes',
      studySpaceId: 'space_math_2026',
      now: 1_700_000_000_000,
    });
    expect(noteEdges).toHaveLength(2);
    expect(noteEdges[0].sourceKind).toBe('note');
    expect(noteEdges[0].studySpaceId).toBe('space_math_2026');
  });

  it('builds persistent block-level Note ExcerptDragPayloads for dragging Note paragraphs into MindMap', () => {
    const payload = buildNoteBlockExcerptPayload({
      noteId: 'note_topology_03',
      noteTitle: 'Compactness Notes',
      blockId: 'blk_9f8a77c1',
      heading: 'Heine-Borel Theorem',
      text: 'Closed and bounded subsets of R^n are compact.',
      createdAt: 1_700_000_123_000,
    });

    expect(payload).not.toBeNull();
    expect(payload!.version).toBe(1);
    expect(payload!.excerptKind).toBe('text');
    expect(payload!.anchor).toEqual({
      kind: 'note',
      resourceId: 'note_topology_03',
      blockId: 'blk_9f8a77c1',
      heading: 'Heine-Borel Theorem',
      label: 'Compactness Notes',
    });
    expect(payload!.anchorUri).toContain('ds-anchor://v1/note/note_topology_03?block=blk_9f8a77c1');
  });
});
