import { describe, expect, it } from 'vitest';
import { computeDiffLines } from '../hooks/useAIEditState';
import {
  acceptAllPendingHunks,
  buildHunkDocumentPlan,
  composeMarkdownFromHunkPlan,
  updateHunkDecision,
} from '../hunkReviewModel';

describe('hunkReviewModel (C4 §3.2.2)', () => {
  it.each([
    ['', 'First\n'], ['First\n', ''], ['Old', 'New\n'], ['Old\n', 'New'],
    ['Same', 'Same\n'], ['Same\n', 'Same'],
    ['Old\r\nTail\r\n', 'New\r\nTail\r\n'],
    ['Old\r\nTail', 'New\nTail\n'],
    ['Body\n', 'Before\nBody\nAfter\n'], ['Before\nBody\nAfter', 'Body'],
    ['A\nOld\nB\nOld2\n', 'A\nNew\nB\nNew2'],
  ])('preserves exact source bytes for all decisions: %j -> %j', (original, proposed) => {
    const plan = buildHunkDocumentPlan(computeDiffLines(original, proposed), { original, proposed });
    expect(composeMarkdownFromHunkPlan(plan).markdown).toBe(original);
    let rejected = plan;
    for (const hunk of plan.hunks) rejected = updateHunkDecision(rejected, hunk.id, 'rejected');
    expect(composeMarkdownFromHunkPlan(rejected).markdown).toBe(original);
    expect(composeMarkdownFromHunkPlan(acceptAllPendingHunks(plan)).markdown).toBe(proposed);
  });

  it('composes partial CRLF edits and deletes an explicitly empty tweak without blank lines', () => {
    const original = 'A\r\nOld\r\nB\r\nOld2\r\n';
    const proposed = 'A\r\nNew\r\nB\r\nNew2\r\n';
    let plan = buildHunkDocumentPlan(computeDiffLines(original, proposed), { original, proposed });
    plan = updateHunkDecision(plan, 0, 'tweaked', '');
    plan = updateHunkDecision(plan, 1, 'accepted');
    expect(composeMarkdownFromHunkPlan(plan).markdown).toBe('A\r\nB\r\nNew2\r\n');
  });

  it('keeps the accepted EOF hunk terminator when an earlier hunk is rejected', () => {
    const original = 'Old A\nBridge\nOld B\nTail';
    const proposed = 'New A\nBridge\nNew B\nTail\n';
    let plan = buildHunkDocumentPlan(computeDiffLines(original, proposed), { original, proposed });
    plan = updateHunkDecision(plan, 0, 'rejected');
    plan = updateHunkDecision(plan, 1, 'accepted');
    expect(composeMarkdownFromHunkPlan(plan).markdown).toBe('Old A\nBridge\nNew B\nTail\n');
  });
  const original = [
    '# Lecture 1',
    'Intro line A',
    'Intro line B',
    'Old theorem statement',
    'Middle bridge 1',
    'Middle bridge 2',
    'Middle bridge 3',
    'Draft proof sketch',
    'Closing summary',
  ].join('\n');

  const proposed = [
    '# Lecture 1',
    'Intro line A',
    'Intro line B',
    'Refined theorem statement',
    'With explicit boundedness condition',
    'Middle bridge 1',
    'Middle bridge 2',
    'Middle bridge 3',
    'Complete epsilon-N proof',
    'Closing summary',
    'Appendix remark',
  ].join('\n');

  it('segments multi-hunk diffs with accurate 1-based line numbers and 2-line context windows', () => {
    const diffLines = computeDiffLines(original, proposed);
    const plan = buildHunkDocumentPlan(diffLines);

    expect(plan.hunks).toHaveLength(3);

    expect(plan.hunks[0]).toMatchObject({
      id: 0,
      oldStartLine: 4,
      newStartLine: 4,
      removedLines: ['Old theorem statement'],
      addedLines: ['Refined theorem statement', 'With explicit boundedness condition'],
      contextBefore: ['Intro line A', 'Intro line B'],
      contextAfter: ['Middle bridge 1', 'Middle bridge 2'],
      status: 'pending',
    });

    expect(plan.hunks[1]).toMatchObject({
      id: 1,
      oldStartLine: 8,
      newStartLine: 9,
      removedLines: ['Draft proof sketch'],
      addedLines: ['Complete epsilon-N proof'],
      contextBefore: ['Middle bridge 2', 'Middle bridge 3'],
      contextAfter: ['Closing summary'],
      status: 'pending',
    });

    // Pure insertion at end of document
    expect(plan.hunks[2]).toMatchObject({
      id: 2,
      oldStartLine: 10,
      newStartLine: 11,
      removedLines: [],
      addedLines: ['Appendix remark'],
      contextBefore: ['Closing summary'],
      contextAfter: [],
      status: 'pending',
    });
  });

  it('composes mixed accepted, rejected, and tweaked hunks accurately', () => {
    const diffLines = computeDiffLines(original, proposed);
    let plan = buildHunkDocumentPlan(diffLines);

    plan = updateHunkDecision(plan, 0, 'accepted');
    plan = updateHunkDecision(plan, 1, 'rejected');
    plan = updateHunkDecision(plan, 2, 'tweaked', 'Custom remark line 1\nCustom remark line 2');

    const composed = composeMarkdownFromHunkPlan(plan);
    expect(composed.acceptedOrTweakedCount).toBe(2);
    expect(composed.rejectedCount).toBe(1);
    expect(composed.pendingCount).toBe(0);

    expect(composed.markdown).toBe(
      [
        '# Lecture 1',
        'Intro line A',
        'Intro line B',
        'Refined theorem statement',
        'With explicit boundedness condition',
        'Middle bridge 1',
        'Middle bridge 2',
        'Middle bridge 3',
        'Draft proof sketch',
        'Closing summary',
        'Custom remark line 1',
        'Custom remark line 2',
      ].join('\n'),
    );
  });

  it('deletes the hunk segment cleanly when tweakedText is an empty string', () => {
    const diffLines = computeDiffLines('Line 1\nRemove me\nLine 3', 'Line 1\nCandidate\nLine 3');
    let plan = buildHunkDocumentPlan(diffLines);
    expect(plan.hunks).toHaveLength(1);

    plan = updateHunkDecision(plan, 0, 'tweaked', '');
    const composed = composeMarkdownFromHunkPlan(plan);
    expect(composed.acceptedOrTweakedCount).toBe(1);
    expect(composed.markdown).toBe('Line 1\nLine 3');
  });

  it('acceptAllPendingHunks converts pending hunks to accepted while preserving rejected and tweaked hunks', () => {
    const diffLines = computeDiffLines(original, proposed);
    let plan = buildHunkDocumentPlan(diffLines);

    plan = updateHunkDecision(plan, 0, 'rejected');
    plan = updateHunkDecision(plan, 1, 'tweaked', 'Hand-tuned proof');
    plan = acceptAllPendingHunks(plan);

    expect(plan.hunks.map((h) => h.status)).toEqual(['rejected', 'tweaked', 'accepted']);
    const composed = composeMarkdownFromHunkPlan(plan);
    expect(composed.pendingCount).toBe(0);
    expect(composed.acceptedOrTweakedCount).toBe(2);
    expect(composed.rejectedCount).toBe(1);
    expect(composed.markdown).toContain('Old theorem statement');
    expect(composed.markdown).toContain('Hand-tuned proof');
    expect(composed.markdown).toContain('Appendix remark');
  });
});
