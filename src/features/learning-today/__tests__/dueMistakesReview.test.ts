import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  closeDueMistakesReview,
  isDueMistakesReviewOpen,
  loadDueMistakeItems,
  openDueMistakesReview,
  subscribeDueMistakesReview,
} from '../dueMistakesReview';

const plan = (i: number) => ({ id: `p${i}`, question_id: `q${i}`, exam_id: i % 2 ? 'exam-a' : 'exam-b' });
const question = (id: string) => ({ id, content: `Q ${id}`, question_type: 'single_choice', tags: [] });

describe('loadDueMistakeItems', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('collects due plans from every question set and pairs them with their questions', async () => {
    const plans = Array.from({ length: 10 }, (_, i) => plan(i));
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'review_plan_get_due') return { plans };
      if (cmd === 'qbank_get_question') return args.questionId === 'q3' ? null : question(String(args.questionId));
      throw new Error(`unexpected ${cmd}`);
    });

    const { items, missing } = await loadDueMistakeItems();

    expect(invoke).toHaveBeenCalledWith('review_plan_get_due', { examId: null, untilDate: null });
    expect(items.map((item) => item.plan.id)).toEqual(['p0', 'p1', 'p2', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(new Set(items.map((item) => item.plan.exam_id))).toEqual(new Set(['exam-a', 'exam-b']));
    expect(items[0].question?.content).toBe('Q q0');
    expect(missing).toBe(1);
  });

  it('skips a question that fails to load instead of failing the whole review', async () => {
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'review_plan_get_due') return { plans: [plan(0), plan(1)] };
      if (args.questionId === 'q0') throw new Error('gone');
      return question(String(args.questionId));
    });
    const { items, missing } = await loadDueMistakeItems();
    expect(items.map((item) => item.plan.id)).toEqual(['p1']);
    expect(missing).toBe(1);
  });

  it('returns an empty queue when nothing is due', async () => {
    invoke.mockResolvedValue({ plans: [] });
    expect(await loadDueMistakeItems()).toEqual({ items: [], missing: 0 });
  });
});

describe('due mistakes review open state', () => {
  it('notifies subscribers once per change', () => {
    closeDueMistakesReview();
    const listener = vi.fn();
    const unsubscribe = subscribeDueMistakesReview(listener);
    openDueMistakesReview();
    openDueMistakesReview();
    expect(isDueMistakesReviewOpen()).toBe(true);
    closeDueMistakesReview();
    expect(isDueMistakesReviewOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
