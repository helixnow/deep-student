import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createEmpty: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { list: mocks.list, watch: mocks.watch },
  createEmpty: mocks.createEmpty,
}));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: ({ type, resourceId }: { type: string; resourceId: string }) => (
    <div data-testid="resource-content">{type}:{resourceId}</div>
  ),
}));

import { ResourceAppWorkspace } from '../ResourceAppWorkspace';
import {
  requestResourceWorkspace,
  waitForResourceWorkspaceActive,
} from '../resourceWorkspaceRegistry';
import { __resetContentDirtyRegistry, registerContentDirtyChecker } from '../contentDirtyRegistry';
import { useReviewPlanStore, type ReviewItemWithQuestion } from '@/stores/reviewPlanStore';

const essay = {
  id: 'essay-1',
  sourceId: 'essay-1',
  path: '/essay-1',
  name: 'Synthetic essay',
  type: 'essay' as const,
  createdAt: 1,
  updatedAt: Date.now(),
};

const reviewItem: ReviewItemWithQuestion = {
  plan: {
    id: 'plan-1',
    question_id: 'question-1',
    exam_id: 'exam-1',
    ease_factor: 2.5,
    interval_days: 1,
    repetitions: 0,
    next_review_date: '2026-07-13',
    last_review_date: null,
    status: 'learning',
    total_reviews: 0,
    total_correct: 0,
    consecutive_failures: 0,
    is_difficult: false,
    created_at: '2026-07-13T00:00:00Z',
    updated_at: '2026-07-13T00:00:00Z',
  },
  question: {
    id: 'question-1',
    content: 'Question',
    question_type: 'single_choice',
    tags: [],
  },
};

describe('ResourceAppWorkspace', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ ok: true, value: [essay] });
    mocks.createEmpty.mockReset();
    mocks.watch.mockReset().mockReturnValue(() => {});
    __resetContentDirtyRegistry();
    useReviewPlanStore.getState().endSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetContentDirtyRegistry();
    useReviewPlanStore.getState().endSession();
  });

  it('uses the same workspace to select and render existing resources', async () => {
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByText('Synthetic essay'));

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(mocks.list).toHaveBeenCalledWith('/', expect.objectContaining({ typeFilter: 'essay' }));
  });

  it('creates and selects a resource without opening a second window implementation', async () => {
    const exam = { ...essay, id: 'exam-1', sourceId: 'exam-1', name: 'New exam', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [] });
    mocks.createEmpty.mockResolvedValue({ ok: true, value: exam });

    render(
      <ResourceAppWorkspace
        type="exam"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    const createButtons = await screen.findAllByRole('button', { name: '新建题目集' });
    fireEvent.click(createButtons[0]);

    await waitFor(() => expect(mocks.createEmpty).toHaveBeenCalledWith({ type: 'exam' }));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam-1');
  });

  it('accepts resource navigation events in the mounted workspace', async () => {
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');

    const active = waitForResourceWorkspaceActive('essay', 'essay-1', 500);
    requestResourceWorkspace('essay', 'essay-1');

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    await expect(active).resolves.toBe(true);
  });

  it('bounds resource activation waits when no workspace accepts the target', async () => {
    await expect(waitForResourceWorkspaceActive('exam', 'missing-exam', 5)).resolves.toBe(false);
  });

  it('collapses the shared sidebar and reopens it with the search shortcut', async () => {
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');

    fireEvent.click(screen.getByRole('button', { name: '隐藏侧边栏' }));
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索' })).toHaveFocus());
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');
  });

  it('supports Home and End navigation across resources', async () => {
    const second = { ...essay, id: 'essay-2', sourceId: 'essay-2', name: 'Second essay' };
    mocks.list.mockResolvedValue({ ok: true, value: [essay, second] });
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    const list = await screen.findByRole('listbox', { name: '作文批改' });
    fireEvent.keyDown(list, { key: 'End' });
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-2');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
  });

  it('uses an overlay sidebar in compact windows and closes it after selection', async () => {
    let resizeCallback!: ResizeObserverCallback;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');

    act(() => resizeCallback(
      [{ contentRect: { width: 600 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ));
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-compact', 'true');
    expect(screen.getAllByRole('button', { name: '隐藏侧边栏' })).toHaveLength(2);

    fireEvent.click(screen.getByText('Synthetic essay'));
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
    expect(screen.queryAllByRole('button', { name: '隐藏侧边栏' })).toHaveLength(0);
  });

  it('uses an in-app confirmation before leaving a dirty essay', async () => {
    const second = { ...essay, id: 'essay-2', sourceId: 'essay-2', name: 'Second essay' };
    mocks.list.mockResolvedValue({ ok: true, value: [essay, second] });
    const unregister = registerContentDirtyChecker('essay', 'essay-1', () => true);

    render(
      <ResourceAppWorkspace
        type="essay"
        initialResourceId="essay-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    fireEvent.click(screen.getByText('Second essay'));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    fireEvent.click(screen.getByText('Second essay'));
    fireEvent.click(await screen.findByRole('button', { name: '丢弃' }));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-2');
    unregister();
  });

  it('keeps a dirty resource mounted until an external removal is confirmed', async () => {
    let notifyResourceChange!: () => void;
    mocks.watch.mockImplementation((_pattern: string, callback: () => void) => {
      notifyResourceChange = callback;
      return () => {};
    });
    mocks.list
      .mockResolvedValueOnce({ ok: true, value: [essay] })
      .mockResolvedValue({ ok: true, value: [] });
    const unregister = registerContentDirtyChecker('essay', 'essay-1', () => true);

    render(
      <ResourceAppWorkspace
        type="essay"
        initialResourceId="essay-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    await waitFor(() => expect(notifyResourceChange).toBeTypeOf('function'));

    act(() => notifyResourceChange());
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    act(() => notifyResourceChange());
    fireEvent.click(await screen.findByRole('button', { name: '丢弃' }));
    await waitFor(() => {
      expect(screen.queryByTestId('resource-content')).not.toBeInTheDocument();
    });
    unregister();
  });

  it('confirms before switching away from an unfinished review session', async () => {
    const firstExam = { ...essay, id: 'exam-1', sourceId: 'exam-1', name: 'First exam', type: 'exam' as const };
    const secondExam = { ...essay, id: 'exam-2', sourceId: 'exam-2', name: 'Second exam', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [firstExam, secondExam] });
    useReviewPlanStore.getState().startSession([reviewItem], 'exam-1');

    render(
      <ResourceAppWorkspace
        type="exam"
        initialResourceId="exam-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam-1');
    fireEvent.click(screen.getByText('Second exam'));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByTestId('resource-content')).toHaveTextContent('exam:exam-1');
    expect(useReviewPlanStore.getState().session.isActive).toBe(true);

    fireEvent.click(screen.getByText('Second exam'));
    fireEvent.click(await screen.findByRole('button', { name: '结束复习' }));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam-2');
    expect(useReviewPlanStore.getState().session.isActive).toBe(false);
  });
});
