import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import {
  checkpointState,
  findCrossedCheckpoint,
  normalizeCheckpoint,
  parseCheckpointOptions,
  type MediaCheckpoint,
} from '../mediaCheckpoints';
import { MediaCheckpointCard, readableExplanation } from '../MediaCheckpointCard';
import { MediaScrubber } from '../MediaScrubber';

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

const checkpoint = (overrides: Partial<MediaCheckpoint> = {}): MediaCheckpoint => ({
  questionId: 'q1',
  examId: 'exam_a',
  seconds: 750,
  content: '正则化为什么能抑制过拟合？',
  questionType: 'single_choice',
  options: [{ key: 'A', content: '惩罚大权重' }, { key: 'B', content: '增加数据' }],
  answer: 'A',
  explanation: '惩罚项让模型更平滑\n[媒体@file_lec:12:30]',
  attemptCount: 0,
  isCorrect: null,
  ...overrides,
});

describe('checkpoint helpers', () => {
  it('parses options leniently', () => {
    expect(parseCheckpointOptions('[{"key":"A","content":"甲"},{"label":"B","text":"乙"}]'))
      .toEqual([{ key: 'A', content: '甲' }, { key: 'B', content: '乙' }]);
    expect(parseCheckpointOptions(['对', '错'])).toEqual([{ key: 'A', content: '对' }, { key: 'B', content: '错' }]);
    expect(parseCheckpointOptions('not json')).toEqual([]);
    expect(parseCheckpointOptions(null)).toEqual([]);
  });

  it('normalizes backend rows and derives the state', () => {
    const cp = normalizeCheckpoint({
      questionId: 'q1', examId: 'e', seconds: 30, content: 'c', questionType: 'true_false',
      optionsJson: null, answer: 'true', explanation: null, attemptCount: 2, isCorrect: false,
    });
    expect(cp?.options).toEqual([]);
    expect(cp && checkpointState(cp)).toBe('wrong');
    expect(normalizeCheckpoint({ questionId: 'q1', examId: 'e' })).toBeNull();
    expect(checkpointState({ attemptCount: 0, isCorrect: null })).toBe('pending');
    expect(checkpointState({ attemptCount: 1, isCorrect: true })).toBe('correct');
  });

  it('only fires when continuous playback crosses an unprompted checkpoint', () => {
    const list = [checkpoint({ questionId: 'q1', seconds: 100 }), checkpoint({ questionId: 'q2', seconds: 300 })];
    expect(findCrossedCheckpoint(list, 99.6, 100.1, new Set())?.questionId).toBe('q1');
    expect(findCrossedCheckpoint(list, 99.6, 100.1, new Set(['q1']))).toBeNull();
    expect(findCrossedCheckpoint(list, 50, 120, new Set())).toBeNull();
    expect(findCrossedCheckpoint(list, 101, 100.5, new Set())).toBeNull();
  });

  it('shows media anchors in explanations as play labels', () => {
    expect(readableExplanation('见 [媒体@file_lec:12:30] 与 [媒体@file_lec:1:02:03]')).toBe('见 ▶ 12:30 与 ▶ 1:02:03');
  });
});

describe('MediaCheckpointCard', () => {
  const renderCard = (cp: MediaCheckpoint) => {
    const handlers = {
      onPauseAtCheckpointsChange: vi.fn(),
      onSeek: vi.fn(),
      onResume: vi.fn(),
      onClose: vi.fn(),
      onAnswered: vi.fn(),
    };
    render(<MediaCheckpointCard checkpoint={cp} pauseAtCheckpoints={false} {...handlers} />);
    return handlers;
  };

  it('grades a choice through the question bank and offers a rewatch from just before the anchor', async () => {
    invokeMock.mockResolvedValueOnce({ is_correct: false, correct_answer: 'A' });
    const handlers = renderCard(checkpoint());
    fireEvent.click(screen.getByRole('button', { name: /增加数据/ }));
    expect(invokeMock).toHaveBeenCalledWith('qbank_submit_answer', {
      request: expect.objectContaining({ question_id: 'q1', user_answer: 'B' }),
    });
    await waitFor(() => expect(screen.getByText('答错了')).toBeInTheDocument());
    expect(handlers.onAnswered).toHaveBeenCalledWith('q1', false);
    expect(screen.getByText(/惩罚项让模型更平滑\s+▶ 12:30/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /回看这一段/ }));
    expect(handlers.onSeek).toHaveBeenCalledWith(735);
  });

  it('lets learners self-grade open questions after revealing the answer', async () => {
    invokeMock.mockResolvedValueOnce({ is_correct: null, correct_answer: null });
    const handlers = renderCard(checkpoint({ questionType: 'short_answer', options: [], answer: '惩罚大权重' }));
    fireEvent.click(screen.getByRole('button', { name: '显示参考答案' }));
    expect(screen.getByText('参考答案：惩罚大权重')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我答对了/ }));
    expect(invokeMock).toHaveBeenCalledWith('qbank_submit_answer', {
      request: expect.objectContaining({ question_id: 'q1', is_correct_override: true }),
    });
    await waitFor(() => expect(handlers.onAnswered).toHaveBeenCalledWith('q1', true));
  });
});

describe('MediaScrubber markers', () => {
  it('draws checkpoint dots by state and weak ranges', () => {
    const { container } = render(
      <MediaScrubber
        currentTime={0}
        duration={1000}
        ariaLabel="进度"
        onSeek={vi.fn()}
        markers={[{ at: 100, kind: 'checkpoint', state: 'wrong' }, { at: 500, kind: 'chapter' }]}
        highlightRanges={[{ from: 85, to: 130 }]}
      />,
    );
    const dot = container.querySelector('[data-scrubber-marker="checkpoint"]') as HTMLElement;
    expect(dot.dataset.state).toBe('wrong');
    expect(dot.style.left).toBe('10%');
    expect(container.querySelector('[data-scrubber-marker="chapter"]')).not.toBeNull();
    expect((container.querySelector('[data-scrubber-range]') as HTMLElement).style.width).toBe('4.5%');
  });
});
