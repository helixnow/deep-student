import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCtInvokeHandlers, setCtInvokeHandlers } from '../../../../tests/ct/mocks/tauri-core-mock';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { UnifiedDailySprintPlayer } from '../UnifiedDailySprintPlayer';
import { buildFallbackSettlement, MINDMAP_RECITE_STATS_PREFIX } from '../sprintBridge';
import type { SettleSprintSessionRequest } from '../sprintContracts';
import type {
  DailySprintPlan,
  ExamReadinessSnapshot,
  SemanticAnchor,
  SprintCompoundPlan,
  SprintSessionSettlement,
} from '../sprintContracts';

const EMOJI_RE = /[\p{Extended_Pictographic}]/u;

function buildReadinessFixture(overrides: Partial<ExamReadinessSnapshot> = {}): ExamReadinessSnapshot {
  return {
    spaceId: 'space_calc',
    examDate: '2026-11-29',
    daysUntilExam: 18,
    phase: 'reinforce',
    effectiveTargetRetention: 0.91,
    dailyNewCardQuota: 12,
    newIntakeFrozen: false,
    predictedExamRetrievability: 0.864,
    currentRetrievability: 0.892,
    totalActiveItems: 40,
    selectedSprintCount: 3,
    estimatedSprintMinutes: 12,
    estimatedSprintSeconds: 720,
    deferredBacklogCount: 9,
    breakdown: {
      fsrsDueCount: 1,
      fsrsNewCount: 0,
      mistakeDueCount: 1,
      mindmapWeakCount: 1,
    },
    computedAtMs: 1_762_000_000_000,
    ...overrides,
  };
}

function buildPlanFixture(): DailySprintPlan {
  return {
    planSessionId: 'sprint_session_test_1',
    config: {
      spaceId: 'space_calc',
      rootFolderId: 'fld_calc',
      examDate: '2026-11-29',
      sprintBudgetMinutes: 15,
      baseTargetRetention: 0.88,
      defaultDeckId: null,
      dayRolloverHour: 4,
    },
    readinessBefore: buildReadinessFixture(),
    deferredBacklogCount: 9,
    generatedVariantsCount: 1,
    createdAtMs: 1_762_000_000_000,
    items: [
      {
        kind: 'fsrs_card',
        sprintItemId: 'fsrs:state_1',
        cardStateId: 'state_1',
        ankiCardId: 'card_1',
        deckName: '高等数学::中值定理',
        cardFormat: 'cloze',
        front: '拉格朗日中值定理要求函数在闭区间连续且在开区间 {{c1::可导}}。',
        back: '闭区间连续，开区间处处可导',
        fields: {
          Text: '拉格朗日中值定理要求函数在闭区间连续且在开区间 {{c1::可导}}。',
          Back: '闭区间连续，开区间处处可导',
        },
        templateId: null,
        state: 2,
        lapses: 1,
        reps: 4,
        stability: 4.5,
        difficulty: 5.2,
        sourceAnchor: {
          anchorUri: 'ds-anchor://v1/note/note_calc_1?block=blk_3',
          kind: 'note',
          resourceId: 'note_calc_1',
          label: '微分中值定理讲义',
          page: null,
          startMs: null,
          blockId: 'blk_3',
          nodeId: null,
          questionId: null,
          quote: null,
        },
        triage: {
          utilityScore: 0.082,
          currentRetrievability: 0.81,
          examRetrievabilityBefore: 0.74,
          importance: 1.35,
          estimatedSeconds: 14,
          conceptTags: ['拉格朗日中值定理'],
        },
      },
      {
        kind: 'mistake_question',
        sprintItemId: 'mistake:plan_2',
        planId: 'plan_2',
        examId: 'exam_calc_1',
        examName: '第三章阶段测验',
        questionId: 'q_variant_2',
        originalQuestionId: 'q_root_2',
        isVariant: true,
        variantBadgeReason: 'high_lapses',
        questionType: 'single_choice',
        content: '设 f(x) = x^2 - 4x + 5 在 [1, 3] 上满足罗尔定理条件，则内部驻点 ξ 为多少？',
        options: [
          { key: 'A', content: 'ξ = 1' },
          { key: 'B', content: 'ξ = 2' },
          { key: 'C', content: 'ξ = 2.5' },
          { key: 'D', content: 'ξ = 3' },
        ],
        answer: 'B',
        explanation: '求导得 f′(x) = 2x - 4 = 0，解得 ξ = 2。',
        structuredData: null,
        originalPromptPreview: '设 f(x) = x^2 - 2x + 3 在 [0, 2] 上满足罗尔定理条件，求 ξ。',
        originalAnswerPreview: 'C (ξ = 1)',
        lapsesCount: 3,
        repetitions: 1,
        intervalDays: 2,
        sourceAnchor: null,
        triage: {
          utilityScore: 0.075,
          currentRetrievability: 0.65,
          examRetrievabilityBefore: 0.58,
          importance: 1.5,
          estimatedSeconds: 38,
          conceptTags: ['罗尔定理'],
        },
      },
      {
        kind: 'mindmap_cloze',
        sprintItemId: 'mindmap:mm_calc:node_rolle',
        mindmapId: 'mm_calc',
        mindmapTitle: '中值定理知识图谱',
        nodeId: 'node_rolle',
        ancestorPath: ['高等数学', '第三章 微分中值定理', '罗尔定理'],
        siblingHints: ['闭区间连续', '开区间可导'],
        fullText: '边界条件：f(a) = f(b)',
        maskedText: '边界条件：［ ？ ］',
        blankedRanges: [{ start: 5, end: 16 }],
        noteExcerpt: '三个条件缺一不可，否则内部未必存在水平切线。',
        smoothedErrorRate: 0.66,
        attempts: 1,
        misses: 1,
        sourceAnchor: {
          anchorUri: 'ds-anchor://v1/pdf/doc_calc_textbook?page=42',
          kind: 'pdf',
          resourceId: 'doc_calc_textbook',
          label: '高等数学上册.pdf',
          page: 42,
          startMs: null,
          blockId: null,
          nodeId: null,
          questionId: null,
          quote: 'f(a) = f(b)',
        },
        triage: {
          utilityScore: 0.068,
          currentRetrievability: 0.62,
          examRetrievabilityBefore: 0.55,
          importance: 1.4,
          estimatedSeconds: 20,
          conceptTags: ['罗尔定理'],
        },
      },
    ],
  };
}

describe('UnifiedDailySprintPlayer', () => {
  beforeEach(() => {
    resetCtInvokeHandlers();
    localStorage.clear();
  });

  it('leaves scratchpad and nested contenteditable keystrokes alone, including IME and held keys', () => {
    const plan = buildPlanFixture();
    const mistake = plan.items[1];
    if (mistake.kind !== 'mistake_question') throw new Error('fixture');
    mistake.options = [];
    mistake.questionType = 'short_answer';
    plan.items = [mistake];
    const anchorRevealer = vi.fn();
    render(<UnifiedDailySprintPlayer initialPlan={plan} usePortal={false} onClose={vi.fn()} anchorRevealer={anchorRevealer} />);
    const textarea = screen.getByTestId('sprint-mistake-scratchpad');
    for (const key of [' ', 'Enter', '1', '2', '3', '4', 'O']) fireEvent.keyDown(textarea, { key });
    expect(screen.queryByTestId('sprint-rating-bar')).toBeNull();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.append(child);
    document.body.append(editable);
    for (const key of [' ', 'Enter', '3', 'O']) fireEvent.keyDown(child, { key });
    editable.remove();
    fireEvent.keyDown(window, { key: ' ', keyCode: 229 });
    fireEvent.keyDown(window, { key: ' ', repeat: true });
    expect(screen.queryByTestId('sprint-rating-bar')).toBeNull();
    expect(anchorRevealer).not.toHaveBeenCalled();
  });

  it('deduplicates same-render rating presses and preserves progress for settlement retry', async () => {
    const plan = buildPlanFixture();
    plan.items = [plan.items[0]];
    const requests: SettleSprintSessionRequest[] = [];
    const fsrsRate = vi.fn();
    setCtInvokeHandlers({
      fsrs_rate: fsrsRate,
      'plugin:host|call': async (_cmd, payload) => {
        if (payload?.method !== 'settleSprintSession') return null;
        const request = (payload.args as SettleSprintSessionRequest[])[0];
        requests.push(request);
        if (requests.length === 1) throw new Error('连接断开');
        return buildFallbackSettlement(request);
      },
    });
    render(<UnifiedDailySprintPlayer initialPlan={plan} usePortal={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('sprint-reveal-button'));
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
      fireEvent.keyDown(window, { key: '3' });
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].completedItems).toHaveLength(1);
    expect(fsrsRate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sprint-settlement-screen')).toBeNull();
    fireEvent.click(screen.getByText('重试'));
    await screen.findByTestId('sprint-settlement-screen');
    expect(requests[1].planSessionId).toBe(requests[0].planSessionId);
    expect(requests[1].completedItems).toEqual(requests[0].completedItems);
  });

  it('ignores late settlement after a space change or unmount', async () => {
    const plan = buildPlanFixture();
    plan.items = [plan.items[0]];
    const onSettled = vi.fn();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    setCtInvokeHandlers({ 'plugin:host|call': async (_cmd, payload) => {
      if (payload?.method !== 'settleSprintSession') return null;
      await pending;
      return buildFallbackSettlement((payload.args as SettleSprintSessionRequest[])[0]);
    } });
    const { rerender, unmount } = render(<UnifiedDailySprintPlayer spaceId="old" initialPlan={plan} usePortal={false} onClose={vi.fn()} onSettled={onSettled} />);
    fireEvent.click(screen.getByTestId('sprint-reveal-button'));
    fireEvent.click(screen.getByTestId('sprint-rate-3'));
    rerender(<UnifiedDailySprintPlayer spaceId="new" initialPlan={{ ...plan, planSessionId: 'new-session' }} usePortal={false} onClose={vi.fn()} onSettled={onSettled} />);
    unmount();
    await act(async () => { release(); });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('discards late fetched plans and refreshes initialPlan when props change', async () => {
    const stale = buildPlanFixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    setCtInvokeHandlers({ 'plugin:host|call': async (_cmd, payload) => {
      if (payload?.method !== 'buildDailySprintPlan') return null;
      await pending;
      return stale;
    } });
    const { rerender } = render(<UnifiedDailySprintPlayer spaceId="old" usePortal={false} onClose={vi.fn()} />);
    rerender(<UnifiedDailySprintPlayer spaceId="new" initialPlan={{ ...stale, items: [] }} usePortal={false} onClose={vi.fn()} />);
    await act(async () => { release(); });
    expect(screen.queryByTestId('sprint-progress-ordinal')).toBeNull();
    expect(screen.queryByTestId('sprint-reveal-button')).toBeNull();
  });

  it('drives full keyboard interleaved flow (FSRS Cloze -> AI Variant Mistake -> MindMap Cloze with anchor reveal & single Again requeue) with 44px touch targets and zero emojis', async () => {
    const plan = buildPlanFixture();
    let settledPayload: Record<string, unknown> | null = null;
    const inlineFsrsRateSpy = vi.fn(async () => ({
      logId: 'log_inline_1',
      cardState: { id: 'state_1' },
    }));

    setCtInvokeHandlers({
      fsrs_rate: inlineFsrsRateSpy,
      'plugin:host|call': async (_cmd, payload) => {
        if (payload?.method === 'settleSprintSession') {
          const args = payload.args as Array<Record<string, unknown>>;
          settledPayload = args[0] ?? null;
          const settlement: SprintSessionSettlement = {
            planSessionId: plan.planSessionId,
            readinessBefore: plan.readinessBefore,
            readinessAfter: {
              ...plan.readinessBefore,
              predictedExamRetrievability: 0.891,
            },
            readinessDeltaPctPoints: 2.7,
            totalCompleted: 3,
            passedCount: 2,
            againCount: 2,
            totalElapsedSeconds: 840,
            studyTimeRecordedSeconds: 840,
            masteryEventsWritten: 3,
            byKind: {
              fsrsCards: 1,
              mistakes: 1,
              variantsSolved: 1,
              mindmapNodes: 1,
            },
            conceptDeltas: [
              { concept: '拉格朗日中值定理', scoreAfter: 0.84, outcome: 'improved' },
              { concept: '罗尔定理', scoreAfter: 0.56, outcome: 'needs_reinforce' },
            ],
          };
          return settlement;
        }
        return null;
      },
    });

    const anchorRevealer = vi.fn(async () => ({
      ok: true,
      outcome: 'revealed-in-open-pane',
      elapsedMs: 12,
    }));
    const onClose = vi.fn();

    const { container } = render(
      <UnifiedDailySprintPlayer
        initialPlan={plan}
        anchorRevealer={anchorRevealer}
        usePortal={false}
        onClose={onClose}
      />,
    );

    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
    expect(screen.getByTestId('sprint-modality-badge').textContent).toBe('闪卡');
    expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('1 / 3');
    expect(screen.getByTestId('sprint-cloze-masked')).toBeTruthy();

    // Space reveals FSRS Cloze card
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    expect(screen.getByTestId('sprint-cloze-revealed').textContent).toBe('可导');

    // Assert >= 44px touch target classes on all 4 rating controls and exit button
    for (const r of [1, 2, 3, 4]) {
      const rateBtn = screen.getByTestId(`sprint-rate-${r}`);
      expect(rateBtn.className).toContain('min-h-[44px]');
    }
    expect(screen.getByTestId('sprint-player-exit').className).toContain('min-h-[44px]');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    // Press '3' to rate Good on FSRS card and advance to AI Variant Mistake
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-mistake-stage')).toBeTruthy();
    });
    expect(screen.getByTestId('sprint-variant-badge').textContent).toContain('AI 变式');
    expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('2 / 3');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    // Press '2' to select option B on Variant Mistake
    await act(async () => {
      fireEvent.keyDown(window, { key: '2' });
    });
    expect(screen.getByTestId('sprint-option-B').getAttribute('aria-pressed')).toBe('true');

    // Press 'Enter' to check answer
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(screen.getByTestId('sprint-mistake-feedback').textContent).toContain('良好');

    // Open original mistake comparison drawer
    fireEvent.click(screen.getByTestId('sprint-compare-original'));
    expect(container.textContent).toContain('设 f(x) = x^2 - 2x + 3');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    // Press 'Space' to confirm suggested rating (3 Good) and advance to MindMap Cloze
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-mindmap-stage')).toBeTruthy();
    });
    expect(screen.getByTestId('sprint-mindmap-ancestors').textContent).toContain('第三章 微分中值定理');
    expect(screen.getByTestId('sprint-mindmap-siblings').textContent).toContain('闭区间连续');
    expect(screen.getByTestId('sprint-mindmap-masked-pill').textContent).toBe('［ ？ ］');

    // Press 'Space' to reveal MindMap Cloze
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    expect(screen.getByTestId('sprint-mindmap-revealed-span').textContent).toContain('f(a) = f(b)');

    // Click [溯源跳回原文] (sprint-mindmap-reveal-source) -> invokes anchors.reveal with item's anchorUri
    const revealSourceBtn = screen.getByTestId('sprint-mindmap-reveal-source');
    expect(revealSourceBtn.className).toContain('min-h-[44px]');
    await act(async () => {
      fireEvent.click(revealSourceBtn);
    });
    expect(anchorRevealer).toHaveBeenCalledWith(
      'ds-anchor://v1/pdf/doc_calc_textbook?page=42',
      { splitIfClosed: true, pulse: true },
    );

    // Rate '1' (Again) -> re-queues MindMap Cloze once to tail (4 / 4) and syncs localStorage recite stats
    await act(async () => {
      fireEvent.keyDown(window, { key: '1' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('4 / 4');
    });
    expect(screen.getByTestId('sprint-requeued-badge')).toBeTruthy();

    const storedReciteRaw = localStorage.getItem(`${MINDMAP_RECITE_STATS_PREFIX}mm_calc`);
    expect(storedReciteRaw).not.toBeNull();
    const storedRecite = JSON.parse(storedReciteRaw!);
    expect(storedRecite.node_rolle['0'].attempts).toBe(1);
    expect(storedRecite.node_rolle['0'].misses).toBe(1);

    // Reveal the re-queued MindMap Cloze and rate '1' (Again) a second time -> must NOT re-queue again, settles!
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: '1' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-settlement-screen')).toBeTruthy();
    });
    expect(settledPayload).not.toBeNull();
    expect(inlineFsrsRateSpy).not.toHaveBeenCalled();
    const completedItemsPayload = (settledPayload?.completedItems ?? []) as Array<
      Record<string, unknown>
    >;
    expect(completedItemsPayload[0]?.alreadyCommittedInline).toBe(false);
    expect(screen.getByTestId('settlement-readiness-before').textContent).toBe('86.4%');
    expect(screen.getByTestId('settlement-readiness-after').textContent).toBe('89.1%');
    expect(screen.getByTestId('settlement-readiness-delta').textContent).toBe('+2.7%');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('settles completed progress cleanly when pressing Escape mid-session after >= 1 completed item', async () => {
    const plan = buildPlanFixture();
    const onClose = vi.fn();
    const fallbackFsrsRateSpy = vi.fn(async () => ({
      logId: 'log_fallback_1',
      cardState: { id: 'state_1' },
    }));
    setCtInvokeHandlers({
      fsrs_rate: fallbackFsrsRateSpy,
      'plugin:host|call': async (_cmd, payload) => payload?.method === 'settleSprintSession'
        ? buildFallbackSettlement((payload.args as SettleSprintSessionRequest[])[0]) : null,
    });

    render(
      <UnifiedDailySprintPlayer
        initialPlan={plan}
        usePortal={false}
        onClose={onClose}
      />,
    );

    // Reveal and rate first card Good
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('2 / 3');
    });

    // Press Escape with 1 completed and 2 remaining -> transitions to settlement rather than discarding
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-settlement-screen')).toBeTruthy();
    });
    expect(fallbackFsrsRateSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders Mineral breadcrumb context, multi-excerpt back evidence (quotes, image crops, child summary bullets), and 1-click multi-source provenance pills (导图节点 · P.42 · P.108) with O-key primary reveal', async () => {
    const compoundAnchors: SemanticAnchor[] = [
      {
        kind: 'mindmap',
        resourceId: 'mm_prob_ch3',
        nodeId: 'node_clt',
        label: '概率论第三章导图',
      },
      {
        kind: 'pdf',
        resourceId: 'pdf_prob_textbook',
        page: 42,
        quote: '设随机变量序列独立同分布，且数学期望 μ 与有限正方差 σ² 存在。',
      },
      {
        kind: 'pdf',
        resourceId: 'pdf_prob_textbook',
        page: 108,
        quote: '当样本容量 n 充分大时，标准化部分和依分布收敛于标准正态分布 N(0,1)。',
      },
    ];

    const sampleCropDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const compoundPlan: SprintCompoundPlan = {
      planSessionId: 'sprint_compound_c7_1',
      config: {
        spaceId: 'space_prob',
        rootFolderId: 'fld_prob',
        examDate: '2026-11-29',
        sprintBudgetMinutes: 15,
        baseTargetRetention: 0.9,
        defaultDeckId: null,
        dayRolloverHour: 4,
      },
      readinessBefore: buildReadinessFixture({ selectedSprintCount: 1 }),
      deferredBacklogCount: 0,
      generatedVariantsCount: 0,
      createdAtMs: 1_762_000_000_000,
      items: [
        {
          kind: 'fsrs_card',
          sprintItemId: 'fsrs:compound_clt',
          cardStateId: 'state_clt',
          ankiCardId: 'card_clt',
          deckName: '概率论与数理统计::极限理论',
          cardFormat: 'qa',
          front: '[第三章 · 极限] 中心极限定理适用条件',
          back: '独立同分布且二阶矩有限时，样本均值渐近正态。',
          fields: {
            Front: '[第三章 · 极限] 中心极限定理适用条件',
            Back: '独立同分布且二阶矩有限时，样本均值渐近正态。',
          },
          templateId: null,
          state: 2,
          lapses: 0,
          reps: 3,
          stability: 6.0,
          difficulty: 4.8,
          sourceAnchor: null,
          sourceAnchors: compoundAnchors,
          personalNote: '注意区分林德伯格条件与列维同分布条件，柯西分布无有限方差故不成立。',
          excerpts: [
            {
              id: 'ex_quote_42',
              kind: 'quote',
              text: '设随机变量序列独立同分布，且数学期望 μ 与有限正方差 σ² 存在。',
              anchor: compoundAnchors[1],
            },
            {
              id: 'ex_crop_108',
              kind: 'image',
              imageDataUrl: sampleCropDataUrl,
              text: '定理推论框图摘录',
              anchor: compoundAnchors[2],
            },
          ],
          childSummaries: [
            '独立同分布（i.i.d.）随机变量序列',
            '有限非零方差 0 < σ² < ∞（排除重尾柯西分布）',
          ],
          triage: {
            utilityScore: 0.091,
            currentRetrievability: 0.78,
            examRetrievabilityBefore: 0.71,
            importance: 1.6,
            estimatedSeconds: 22,
            conceptTags: ['中心极限定理'],
          },
        },
      ],
    };

    const anchorRevealer = vi.fn(async () => ({
      ok: true,
      outcome: 'revealed-in-open-pane',
      elapsedMs: 6,
    }));

    const { container } = render(
      <UnifiedDailySprintPlayer
        initialPlan={compoundPlan}
        anchorRevealer={anchorRevealer}
        usePortal={false}
        onClose={vi.fn()}
      />,
    );

    // 1. Crisp Mineral breadcrumb header above card face (1px border-border/35, 6px dot, zero emojis)
    const breadcrumb = screen.getByTestId('sprint-card-breadcrumb');
    expect(breadcrumb.className).toContain('border-border/35');
    expect(breadcrumb.textContent).toContain('思维导图');
    expect(breadcrumb.textContent).toContain('第三章');
    expect(breadcrumb.textContent).toContain('极限');
    expect(screen.getByTestId('sprint-breadcrumb-source-count').textContent).toBe('3 处出处');

    const dot = screen.getByTestId('sprint-breadcrumb-dot');
    expect(dot.className).toContain('h-1.5');
    expect(dot.className).toContain('w-1.5');

    // Redundant bracket prefix stripped from front prompt while keeping question crisp
    const stageEl = screen.getByTestId('sprint-fsrs-stage');
    expect(stageEl.textContent).toContain('中心极限定理适用条件');
    expect(stageEl.textContent).not.toContain('[第三章 · 极限]');

    // Multi-excerpt back blocks must remain hidden prior to reveal
    expect(screen.queryByTestId('sprint-compound-excerpts')).toBeNull();
    expect(screen.queryByTestId('sprint-compound-bullets')).toBeNull();

    // 2. Multi-source provenance pills (导图节点 · P.42 · P.108) rendered in font-mono tabular-nums
    const provenanceBar = screen.getByTestId('sprint-provenance-bar');
    expect(provenanceBar.textContent).toContain('导图节点');
    expect(provenanceBar.textContent).toContain('P.42');
    expect(provenanceBar.textContent).toContain('P.108');

    const primaryPill = screen.getByTestId('sprint-fsrs-reveal-source');
    const pill42 = screen.getByTestId('sprint-provenance-pill-1');
    const pill108 = screen.getByTestId('sprint-provenance-pill-2');
    expect(primaryPill.className).toContain('font-mono');
    expect(primaryPill.className).toContain('tabular-nums');
    expect(primaryPill.className).toContain('min-h-[44px]');
    expect(pill42.className).toContain('min-h-[44px]');
    expect(pill108.className).toContain('min-h-[44px]');

    // Pressing 'O' jumps immediately to primaryAnchor (<50ms) and docks player
    let oRevealLatencyMs = Infinity;
    anchorRevealer.mockImplementationOnce(async () => {
      oRevealLatencyMs = performance.now() - t0;
      return {
        ok: true,
        outcome: 'revealed-in-open-pane',
        elapsedMs: 6,
      };
    });
    const t0 = performance.now();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'O' });
    });
    expect(oRevealLatencyMs).toBeLessThan(50);
    expect(anchorRevealer).toHaveBeenCalledTimes(1);
    expect(anchorRevealer.mock.calls[0]?.[0]).toContain(
      'ds-anchor://v1/mindmap/mm_prob_ch3?node=node_clt',
    );
    expect(
      screen.getByTestId('unified-daily-sprint-player').getAttribute('data-split-docked'),
    ).toBe('true');

    // 1-click direct jump to secondary anchors P.42 and P.108
    await act(async () => {
      fireEvent.click(pill42);
    });
    expect(anchorRevealer).toHaveBeenCalledTimes(2);
    expect(anchorRevealer.mock.calls[1]?.[0]).toContain(
      'ds-anchor://v1/pdf/pdf_prob_textbook?page=42',
    );

    await act(async () => {
      fireEvent.click(pill108);
    });
    expect(anchorRevealer).toHaveBeenCalledTimes(3);
    expect(anchorRevealer.mock.calls[2]?.[0]).toContain(
      'ds-anchor://v1/pdf/pdf_prob_textbook?page=108',
    );

    // Reveal back face -> renders personal note, quotes, image crop, and child summary bullets
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    expect(screen.getByTestId('sprint-compound-excerpts')).toBeTruthy();
    expect(screen.getAllByTestId('sprint-excerpt-block').length).toBeGreaterThanOrEqual(2);
    const cropImg = screen.getByTestId('sprint-excerpt-image') as HTMLImageElement;
    expect(cropImg.getAttribute('src')).toBe(sampleCropDataUrl);

    const bullets = screen.getAllByTestId('sprint-child-bullet');
    expect(bullets).toHaveLength(2);
    expect(bullets[0]?.textContent).toContain('独立同分布');
    expect(bullets[1]?.textContent).toContain('有限非零方差');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
  });

  it('parses projected Markdown back blocks (quotes, image crops, bullets) + fields.SourceAnchors and routes O-key reveal through getAppKernel().anchors in <50ms', async () => {
    const kernel = getAppKernel();
    const revealedTargets: Array<{ kind: string; resourceId: string; page?: number; blockId?: string }> = [];

    let keyDownStartedAt = 0;
    let firstRevealLatencyMs = Infinity;

    const disposeNote = kernel.anchors.registerAnchorRevealHandler('note', {
      canHandle: (anchor) => (anchor.resourceId === 'note_inline_lim' ? 'exact-focused' : false),
      reveal: (anchor) => {
        firstRevealLatencyMs = performance.now() - keyDownStartedAt;
        revealedTargets.push({
          kind: anchor.kind,
          resourceId: anchor.resourceId,
          blockId: anchor.blockId,
        });
        return true;
      },
    });
    const disposePdf = kernel.anchors.registerAnchorRevealHandler('pdf', {
      canHandle: (anchor) => (anchor.resourceId === 'pdf_calc_notes' ? 'exact-mounted' : false),
      reveal: (anchor) => {
        revealedTargets.push({
          kind: anchor.kind,
          resourceId: anchor.resourceId,
          page: anchor.page,
        });
        return true;
      },
    });

    try {
      const serializedAnchors: SemanticAnchor[] = [
        { kind: 'note', resourceId: 'note_inline_lim', blockId: 'blk_squeeze' },
        { kind: 'pdf', resourceId: 'pdf_calc_notes', page: 19 },
      ];
      const markdownBack = [
        '夹逼准则用于无法直接拆分求极限的数列或函数。',
        '',
        '> 若在去心邻域内 g(x) <= f(x) <= h(x)，且两侧极限同为 A，则 lim f(x) = A。',
        '',
        '![夹逼几何示意](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=)',
        '',
        '- 先构造容易求极限的上下界函数',
        '- 验证上下界在同一趋近过程下收敛到同一常数',
      ].join('\n');

      const projectedPlan: DailySprintPlan = {
        planSessionId: 'sprint_projected_md_1',
        config: {
          spaceId: 'space_calc',
          rootFolderId: 'fld_calc',
          examDate: '2026-11-29',
          sprintBudgetMinutes: 15,
          baseTargetRetention: 0.88,
          defaultDeckId: null,
          dayRolloverHour: 4,
        },
        readinessBefore: buildReadinessFixture({ selectedSprintCount: 1 }),
        deferredBacklogCount: 0,
        generatedVariantsCount: 0,
        createdAtMs: 1_762_000_000_000,
        items: [
          {
            kind: 'fsrs_card',
            sprintItemId: 'fsrs:projected_squeeze',
            cardStateId: 'state_squeeze',
            ankiCardId: 'card_squeeze',
            deckName: '高等数学::第一章',
            cardFormat: 'qa',
            front: '[第一章 · 函数与极限] 夹逼准则构造要领',
            back: markdownBack,
            fields: {
              Front: '[第一章 · 函数与极限] 夹逼准则构造要领',
              Back: markdownBack,
              SourceKind: 'note',
              SourceAnchors: JSON.stringify(serializedAnchors),
            },
            templateId: null,
            state: 2,
            lapses: 0,
            reps: 2,
            stability: 3.5,
            difficulty: 5.0,
            sourceAnchor: null,
            triage: {
              utilityScore: 0.08,
              currentRetrievability: 0.8,
              examRetrievabilityBefore: 0.72,
              importance: 1.3,
              estimatedSeconds: 18,
              conceptTags: ['夹逼准则'],
            },
          },
        ],
      };

      const { container } = render(
        <UnifiedDailySprintPlayer
          initialPlan={projectedPlan}
          usePortal={false}
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByTestId('sprint-card-breadcrumb').textContent).toContain('精读笔记');
      expect(screen.getByTestId('sprint-card-breadcrumb').textContent).toContain('函数与极限');
      expect(screen.getByTestId('sprint-provenance-bar').textContent).toContain('笔记段落');
      expect(screen.getByTestId('sprint-provenance-bar').textContent).toContain('P.19');

      // Reveal card and verify Markdown back blocks parsed into quote + image + child bullets
      await act(async () => {
        fireEvent.keyDown(window, { key: ' ' });
      });

      expect(screen.getAllByTestId('sprint-excerpt-block')).toHaveLength(2);
      expect(screen.getByTestId('sprint-excerpt-image')).toBeTruthy();
      expect(screen.getAllByTestId('sprint-child-bullet')).toHaveLength(2);

      // Press 'o' -> routes directly through getAppKernel().anchors.reveal(primaryAnchor) in <50ms
      keyDownStartedAt = performance.now();
      await act(async () => {
        fireEvent.keyDown(window, { key: 'o' });
      });
      expect(firstRevealLatencyMs).toBeLessThan(50);
      expect(revealedTargets).toEqual([
        { kind: 'note', resourceId: 'note_inline_lim', blockId: 'blk_squeeze' },
      ]);

      // Click secondary pill 'P.19' -> routes directly to mounted PDF handler
      await act(async () => {
        fireEvent.click(screen.getByTestId('sprint-provenance-pill-1'));
      });
      expect(revealedTargets).toEqual([
        { kind: 'note', resourceId: 'note_inline_lim', blockId: 'blk_squeeze' },
        { kind: 'pdf', resourceId: 'pdf_calc_notes', page: 19 },
      ]);
      expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);
    } finally {
      disposeNote();
      disposePdf();
    }
  });
});
