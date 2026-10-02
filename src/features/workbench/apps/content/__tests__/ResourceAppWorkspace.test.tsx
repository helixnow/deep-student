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
    window.localStorage.removeItem('wb.resourceWorkspace.essay.sidebar');
    window.localStorage.removeItem('wb.resourceWorkspace.translation.sidebar');
    document.querySelectorAll('[data-wb-titlebar-slot]').forEach((element) => element.remove());
  });

  const stubWorkspaceWidth = () => {
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
    return (width: number) => act(() => resizeCallback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ));
  };

  const mountTitlebarSlot = (windowId: string) => {
    const slot = document.createElement('div');
    slot.setAttribute('data-wb-titlebar-slot', '');
    slot.dataset.windowId = windowId;
    document.body.appendChild(slot);
  };

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

  it('keeps the standard wide sidebar visible and focuses search with the shortcut', async () => {
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveFocus());
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
    fireEvent.click(screen.getByRole('button', { name: '显示导航' }));
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');

    fireEvent.click(screen.getAllByText('Synthetic essay')[0]);
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
    expect(screen.getByRole('button', { name: '显示导航' })).toBeInTheDocument();
  });

  it('collapses the resource list once a resource opens in a narrow window', async () => {
    const setWidth = stubWorkspaceWidth();
    const { container } = render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');
    setWidth(880);

    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');

    fireEvent.click(screen.getByText('Synthetic essay'));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
    expect(container.querySelector('.wb-sys-split')).toHaveAttribute('data-wb-sys-sidebar-collapsed', 'true');
  });

  it('keeps the resource list beside an opened resource in a roomy window', async () => {
    const setWidth = stubWorkspaceWidth();
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    await screen.findByText('Synthetic essay');
    setWidth(1200);

    fireEvent.click(screen.getByText('Synthetic essay'));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');
  });

  it('remembers an explicit resource list choice per app from the titlebar toggle', async () => {
    mountTitlebarSlot('win-essay');
    const renderWorkspace = () => render(
      <ResourceAppWorkspace
        type="essay"
        windowId="win-essay"
        initialResourceId="essay-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    const first = renderWorkspace();
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');

    const toggle = screen.getByRole('button', { name: '切换边栏' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem('wb.resourceWorkspace.essay.sidebar')).toBe('collapsed');
    expect(window.localStorage.getItem('wb.resourceWorkspace.translation.sidebar')).toBeNull();

    first.unmount();
    renderWorkspace();
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
  });

  it('reveals a collapsed list for search without overwriting the saved choice', async () => {
    window.localStorage.setItem('wb.resourceWorkspace.essay.sidebar', 'collapsed');
    const second = { ...essay, id: 'essay-2', sourceId: 'essay-2', name: 'Second essay' };
    mocks.list.mockResolvedValue({ ok: true, value: [essay, second] });
    render(
      <ResourceAppWorkspace
        type="essay"
        initialResourceId="essay-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');

    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'true');
    await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveFocus());

    fireEvent.click(screen.getByText('Second essay'));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-2');
    expect(screen.getByTestId('wb-essay-workspace')).toHaveAttribute('data-sidebar-open', 'false');
    expect(window.localStorage.getItem('wb.resourceWorkspace.essay.sidebar')).toBe('collapsed');
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
