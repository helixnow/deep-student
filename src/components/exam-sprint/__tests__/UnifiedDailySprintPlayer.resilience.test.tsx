import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCtInvokeHandlers, setCtInvokeHandlers } from '../../../../tests/ct/mocks/tauri-core-mock';
import { handleAndroidBack } from '@/app/navigation/androidBackCoordinator';
import { APP_EVENTS } from '@/events';
import { UnifiedDailySprintPlayer } from '../UnifiedDailySprintPlayer';
import { buildFallbackSettlement } from '../sprintBridge';
import { loadSprintCheckpoint } from '../sprintCheckpointStorage';
import type {
  DailySprintPlan,
  ExamReadinessSnapshot,
  SettleSprintSessionRequest,
} from '../sprintContracts';

const ttsMocks = vi.hoisted(() => ({
  speak: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));

vi.mock('@/utils/tts', () => ({
  speak: ttsMocks.speak,
  stop: ttsMocks.stop,
}));

function buildReadinessFixture(): ExamReadinessSnapshot {
  return {
    spaceId: 'space_resilience',
    examDate: '2026-11-29',
    daysUntilExam: 10,
    phase: 'reinforce',
    effectiveTargetRetention: 0.91,
    dailyNewCardQuota: 10,
    newIntakeFrozen: false,
    predictedExamRetrievability: 0.85,
    currentRetrievability: 0.88,
    totalActiveItems: 20,
    selectedSprintCount: 2,
    estimatedSprintMinutes: 5,
    estimatedSprintSeconds: 300,
    deferredBacklogCount: 0,
    breakdown: {
      fsrsDueCount: 1,
      fsrsNewCount: 0,
      mistakeDueCount: 1,
      mindmapWeakCount: 0,
    },
    computedAtMs: 1_762_000_000_000,
  };
}

function buildResiliencePlan(): DailySprintPlan {
  return {
    planSessionId: 'sprint_resilience_1',
    config: {
      spaceId: 'space_resilience',
      rootFolderId: 'fld_res',
      examDate: '2026-11-29',
      sprintBudgetMinutes: 15,
      baseTargetRetention: 0.88,
      defaultDeckId: null,
      dayRolloverHour: 4,
    },
    readinessBefore: buildReadinessFixture(),
    deferredBacklogCount: 0,
    generatedVariantsCount: 0,
    createdAtMs: 1_762_000_000_000,
    items: [
      {
        kind: 'fsrs_card',
        sprintItemId: 'fsrs:latex_cloze_1',
        cardStateId: 'state_latex_1',
        ankiCardId: 'card_latex_1',
        deckName: '大学物理::相对论',
        cardFormat: 'cloze',
        front: '质能方程 $E = {{c1::mc^2}}$，以及 $\\int_a^b f(x)dx = $ {{c2::$F(b)-F(a)$}}。',
        back: '质能等价与微积分基本定理',
        fields: {
          Text: '质能方程 $E = {{c1::mc^2}}$，以及 $\\int_a^b f(x)dx = $ {{c2::$F(b)-F(a)$}}。',
          Back: '质能等价与微积分基本定理',
        },
        templateId: null,
        state: 2,
        lapses: 0,
        reps: 2,
        stability: 4,
        difficulty: 5,
        sourceAnchor: {
          anchorUri: 'ds-anchor://v1/pdf/doc_physics?page=12',
          kind: 'pdf',
          resourceId: 'doc_physics',
          label: '大学物理.pdf',
          page: 12,
          startMs: null,
          blockId: null,
          nodeId: null,
          questionId: null,
          quote: null,
        },
        triage: {
          utilityScore: 0.09,
          currentRetrievability: 0.78,
          examRetrievabilityBefore: 0.72,
          importance: 1.4,
          estimatedSeconds: 18,
          conceptTags: ['质能方程'],
        },
      },
      {
        kind: 'mistake_question',
        sprintItemId: 'mistake:plan_img_1',
        planId: 'plan_img_1',
        examId: 'exam_circuit',
        examName: '电路分析期中卷',
        questionId: 'q_circuit_1',
        originalQuestionId: 'q_circuit_1',
        isVariant: false,
        variantBadgeReason: null,
        questionType: 'single_choice',
        content: '根据阅读材料和电路图，求节点电压 $U_a$。',
        options: [
          { key: 'A', content: '2V' },
          { key: 'B', content: '4V' },
        ],
        images: [
          {
            id: 'att_circuit_fig1',
            name: 'circuit_fig1.png',
            mime: 'image/png',
            hash: 'hash_fig1',
            role: 'question',
          },
        ],
        materials: [
          {
            id: 'mat_shared_1',
            content: '已知理想电源 $U_s = 12\\text{V}$，电阻 $R_1 = 2\\Omega, R_2 = 4\\Omega$。',
            images: [],
            version: 1,
          },
        ],
        answer: 'B',
        explanation: '分压公式 $U_a = 12 \\times \\frac{2}{6} = 4\\text{V}$。',
        structuredData: null,
        originalPromptPreview: null,
        originalAnswerPreview: null,
        lapsesCount: 2,
        repetitions: 1,
        intervalDays: 2,
        sourceAnchor: null,
        triage: {
          utilityScore: 0.08,
          currentRetrievability: 0.65,
          examRetrievabilityBefore: 0.6,
          importance: 1.5,
          estimatedSeconds: 35,
          conceptTags: ['节点电压法'],
        },
      },
    ],
  };
}

describe('UnifiedDailySprintPlayer resilience, mobile UX, rescue tools, images & Cloze LaTeX', () => {
  beforeEach(() => {
    resetCtInvokeHandlers();
    localStorage.clear();
    ttsMocks.speak.mockClear();
    ttsMocks.stop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists progress checkpoint to localStorage, auto-resumes after remount, and clears checkpoint after settlement', async () => {
    const plan = buildResiliencePlan();
    const settledRequests: SettleSprintSessionRequest[] = [];
    setCtInvokeHandlers({
      'plugin:host|call': async (_cmd, payload) => {
        if (payload?.method === 'settleSprintSession') {
          const req = (payload.args as SettleSprintSessionRequest[])[0]!;
          settledRequests.push(req);
          return buildFallbackSettlement(req);
        }
        return null;
      },
    });

    const first = render(
      <UnifiedDailySprintPlayer
        spaceId="space_resilience"
        initialPlan={plan}
        usePortal={false}
        onClose={vi.fn()}
      />,
    );

    // Rate card 1 via keyboard
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('2 / 2');
    });

    const saved = loadSprintCheckpoint('space_resilience');
    expect(saved).not.toBeNull();
    expect(saved?.planSessionId).toBe('sprint_resilience_1');
    expect(saved?.cursor).toBe(1);
    expect(saved?.completedRecords).toHaveLength(1);

    // Simulate OS killing the app / remounting fresh without initialPlan
    first.unmount();

    render(
      <UnifiedDailySprintPlayer
        spaceId="space_resilience"
        usePortal={false}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('2 / 2');
    });
    expect(screen.getByTestId('sprint-resumed-badge')).toBeTruthy();

    // Finish card 2 -> settles with BOTH completed records and clears checkpoint
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
    });

    await screen.findByTestId('sprint-settlement-screen');
    expect(settledRequests).toHaveLength(1);
    expect(settledRequests[0]?.completedItems).toHaveLength(2);
    expect(loadSprintCheckpoint('space_resilience')).toBeNull();
  });

  it('collapses to a compact bottom return bar on <640px mobile when viewing source and restores sprint via button or Android back', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)' || query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);

    const plan = buildResiliencePlan();
    const anchorRevealer = vi.fn(async () => ({ ok: true, outcome: 'revealed', elapsedMs: 5 }));
    const onClose = vi.fn();

    render(
      <UnifiedDailySprintPlayer
        initialPlan={plan}
        anchorRevealer={anchorRevealer}
        usePortal={false}
        onClose={onClose}
      />,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('sprint-fsrs-reveal-source'));
    });

    // Mobile docked state: collapsed compact return bar, not fullscreen dialog
    const docked = screen.getByTestId('unified-daily-sprint-player');
    expect(docked.getAttribute('data-mobile-docked')).toBe('true');
    expect(screen.getByTestId('sprint-return-from-source').textContent).toContain('正在查看来源 · 回到冲刺');

    // Android back first returns from source view back into the sprint without closing
    act(() => {
      expect(handleAndroidBack()).toBe(true);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sprint-return-from-source')).toBeNull();
    expect(screen.getByTestId('sprint-rating-bar')).toBeTruthy();

    // Android back again closes when 0 items completed
    act(() => {
      expect(handleAndroidBack()).toBe(true);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows restore-fullscreen button on desktop splitDocked and hides keyboard badges on mobile viewports', async () => {
    const plan = buildResiliencePlan();
    const anchorRevealer = vi.fn(async () => ({ ok: true, outcome: 'revealed', elapsedMs: 5 }));

    render(
      <UnifiedDailySprintPlayer
        initialPlan={plan}
        anchorRevealer={anchorRevealer}
        usePortal={false}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });

    // Rating button kbd and provenance O kbd both carry mobile-hiding classes
    const rate1Kbd = screen.getByTestId('sprint-rate-1').querySelector('kbd');
    expect(rate1Kbd?.className).toContain('hidden');
    expect(rate1Kbd?.className).toContain('sm:inline');

    const sourceKbd = screen.getByTestId('sprint-fsrs-reveal-source').querySelector('kbd');
    expect(sourceKbd?.className).toContain('hidden');
    expect(sourceKbd?.className).toContain('sm:inline-block');

    await act(async () => {
      fireEvent.click(screen.getByTestId('sprint-fsrs-reveal-source'));
    });
    const restoreBtn = screen.getByTestId('sprint-restore-fullscreen');
    fireEvent.click(restoreBtn);
    expect(screen.queryByTestId('sprint-restore-fullscreen')).toBeNull();
  });

  it('enforces 280ms pointer anti-misclick guard after reveal, supports Undo, Ask AI rescue, and TTS read-aloud', async () => {
    const plan = buildResiliencePlan();
    const prefillEvents: Array<{ content?: string; newSession?: boolean }> = [];
    const listener = (event: Event) => prefillEvents.push((event as CustomEvent).detail);
    window.addEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, listener);

    try {
      render(
        <UnifiedDailySprintPlayer
          initialPlan={plan}
          usePortal={false}
          onClose={vi.fn()}
        />,
      );

      // TTS toggle speaks current card
      fireEvent.click(screen.getByTestId('sprint-tts-toggle'));
      expect(ttsMocks.speak).toHaveBeenCalledTimes(1);

      // Reveal card 1 and immediately fire a real pointer click (detail: 1) within 280ms -> ignored!
      fireEvent.click(screen.getByTestId('sprint-reveal-button'));
      fireEvent.click(screen.getByTestId('sprint-rate-3'), { detail: 1 });
      expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('1 / 2');

      // Keyboard rating (or click after >280ms) advances to card 2
      await act(async () => {
        fireEvent.keyDown(window, { key: '3' });
      });
      await waitFor(() => {
        expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('2 / 2');
      });

      // Undo button restores card 1 in revealed state
      fireEvent.click(screen.getByTestId('sprint-undo-last'));
      await waitFor(() => {
        expect(screen.getByTestId('sprint-progress-ordinal').textContent).toBe('1 / 2');
      });
      expect(screen.getByTestId('sprint-rating-bar')).toBeTruthy();

      // Ask AI dispatches PREFILL_CHAT_INPUT with card context and docks player
      fireEvent.click(screen.getByTestId('sprint-ask-ai'));
      expect(prefillEvents).toHaveLength(1);
      expect(prefillEvents[0]?.content).toContain('质能方程');
      expect(prefillEvents[0]?.newSession).toBe(true);
      expect(screen.getByTestId('unified-daily-sprint-player').getAttribute('data-split-docked')).toBe('true');
    } finally {
      window.removeEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, listener);
    }
  });

  it('renders plain-text Cloze LaTeX with KaTeX and renders mistake card images and shared reading materials', async () => {
    const plan = buildResiliencePlan();
    setCtInvokeHandlers({
      vfs_get_attachment_content: async (_cmd, payload) => {
        if (payload?.attachmentId === 'att_circuit_fig1') {
          return {
            found: true,
            content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          };
        }
        return { found: false, content: null };
      },
    });

    const { container } = render(
      <UnifiedDailySprintPlayer
        initialPlan={plan}
        usePortal={false}
        onClose={vi.fn()}
      />,
    );

    // Card 1: plain Cloze with LaTeX renders KaTeX spans instead of leaking raw `$` delimiters
    await act(async () => {
      fireEvent.keyDown(window, { key: ' ' });
    });
    const katexNodes = container.querySelectorAll('.katex');
    expect(katexNodes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('sprint-fsrs-stage').textContent).not.toContain('$E =');
    expect(screen.getByTestId('sprint-fsrs-stage').textContent).not.toContain('$F(b)-F(a)$');

    // Advance to Card 2: mistake card with shared reading material and question image
    await act(async () => {
      fireEvent.keyDown(window, { key: '3' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('sprint-mistake-stage')).toBeTruthy();
    });
    expect(screen.getByTestId('sprint-mistake-materials').textContent).toContain('12');
    const mistakeImg = await screen.findByTestId('sprint-mistake-image');
    expect(mistakeImg.getAttribute('src')).toContain('data:image/png;base64,');
  });
});
