import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createEmpty: vi.fn(),
  watch: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: {
    list: mocks.list,
    watch: mocks.watch,
    rename: mocks.rename,
    delete: mocks.delete,
  },
  createEmpty: mocks.createEmpty,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.notify,
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
    mocks.rename.mockReset();
    mocks.delete.mockReset();
    mocks.notify.mockReset();
    __resetContentDirtyRegistry();
    useReviewPlanStore.getState().endSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetContentDirtyRegistry();
    useReviewPlanStore.getState().endSession();
    window.localStorage.removeItem('wb.resourceWorkspace.exam.sidebar');
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

  it.each([
    { type: 'exam' as const, id: 'exam_1', name: '高数错题集', renamed: '线性代数题库' },
    { type: 'essay' as const, id: 'essay_session_1', name: 'Synthetic essay', renamed: '议论文草稿' },
    { type: 'translation' as const, id: 'tr_1', name: 'Abstract translation', renamed: '论文摘要翻译' },
  ])('renames a $type item via the row AppMenu dropdown without premature blur cancel', async ({ type, id, name, renamed }) => {
    const node = {
      id,
      sourceId: id,
      path: `/${id}`,
      name,
      type,
      createdAt: 1,
      updatedAt: Date.now(),
    };
    mocks.list.mockResolvedValue({ ok: true, value: [node] });
    mocks.rename.mockResolvedValue({ ok: true, value: { ...node, name: renamed } });

    render(
      <ResourceAppWorkspace
        type={type}
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    await screen.findByText(name);
    const menuTrigger = screen.getByRole('button', { name: `${name} 的更多操作` });
    // Ensure no nested <button> inside <button>
    expect(menuTrigger.parentElement?.closest('button')).toBeNull();

    fireEvent.click(menuTrigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: /重命名/ }));

    const input = await screen.findByRole('textbox', { name: `重命名 ${name}` });
    expect(input).toHaveFocus();

    // Immediate unmodified blur within <250ms (e.g. menu teardown) must not auto-cancel
    fireEvent.blur(input);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(screen.getByRole('textbox', { name: `重命名 ${name}` })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: `  ${renamed}  ` } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith(`/${id}`, renamed));
    expect(await screen.findByText(renamed)).toBeInTheDocument();
  });

  it('supports inline rename via context menu, double-click, and F2 with IME & Escape cancellation', async () => {
    const exam1 = { ...essay, id: 'exam_1', sourceId: 'exam_1', path: '/exam_1', name: '数学试卷 A', type: 'exam' as const };
    const exam2 = { ...essay, id: 'exam_2', sourceId: 'exam_2', path: '/exam_2', name: '数学试卷 B', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [exam1, exam2] });
    mocks.rename.mockImplementation(async (_path: string, newName: string) => ({
      ok: true,
      value: { ...exam1, name: newName },
    }));

    render(
      <ResourceAppWorkspace
        type="exam"
        initialResourceId="exam_1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam_1');

    // 1. Right-click context menu -> Rename -> Escape cancels without calling dstu.rename
    fireEvent.contextMenu(screen.getByText('数学试卷 A'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /重命名/ }));
    const ctxInput = await screen.findByRole('textbox', { name: '重命名 数学试卷 A' });
    fireEvent.change(ctxInput, { target: { value: '临时修改' } });
    fireEvent.keyDown(ctxInput, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mocks.rename).not.toHaveBeenCalled();

    // 2. Double-click -> IME Enter/Escape ignored, Home/End does not switch selection, blur commits
    fireEvent.doubleClick(screen.getByText('数学试卷 A'));
    const dblInput = await screen.findByRole('textbox', { name: '重命名 数学试卷 A' });
    fireEvent.change(dblInput, { target: { value: '高数期末卷' } });
    fireEvent.keyDown(dblInput, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(dblInput, { key: 'Escape', keyCode: 229 });
    fireEvent.keyDown(dblInput, { key: 'End' });
    expect(screen.getByTestId('resource-content')).toHaveTextContent('exam:exam_1');
    expect(mocks.rename).not.toHaveBeenCalled();

    fireEvent.blur(dblInput);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith('/exam_1', '高数期末卷'));
    expect(await screen.findByText('高数期末卷')).toBeInTheDocument();

    // 3. F2 shortcut on listbox renames selected item; whitespace-only cancels cleanly
    const list = screen.getByRole('listbox', { name: '题目集' });
    fireEvent.keyDown(list, { key: 'F2' });
    const f2Input = await screen.findByRole('textbox', { name: '重命名 高数期末卷' });
    fireEvent.change(f2Input, { target: { value: '   ' } });
    fireEvent.keyDown(f2Input, { key: 'Enter' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });

  it('notifies errors on rename failure without hiding the resource list', async () => {
    const exam1 = { ...essay, id: 'exam_1', sourceId: 'exam_1', path: '/exam_1', name: '原题集', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [exam1] });
    mocks.rename.mockResolvedValue({
      ok: false,
      error: { toUserMessage: () => '重命名失败：权限不足' },
    });

    render(
      <ResourceAppWorkspace
        type="exam"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    fireEvent.doubleClick(await screen.findByText('原题集'));
    const input = await screen.findByRole('textbox', { name: '重命名 原题集' });
    fireEvent.change(input, { target: { value: '新题集' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('error', '重命名失败：权限不足'));
    expect(screen.getByText('原题集')).toBeInTheDocument();
  });

  it('confirms deletion, calls dstu.delete, and selects the adjacent sibling fallback cleanly', async () => {
    let notifyResourceChange!: () => void;
    mocks.watch.mockImplementation((_pattern: string, callback: () => void) => {
      notifyResourceChange = callback;
      return () => {};
    });
    const exam1 = { ...essay, id: 'exam_1', sourceId: 'exam_1', path: '/exam_1', name: '题集一', type: 'exam' as const };
    const exam2 = { ...essay, id: 'exam_2', sourceId: 'exam_2', path: '/exam_2', name: '题集二', type: 'exam' as const };
    const exam3 = { ...essay, id: 'exam_3', sourceId: 'exam_3', path: '/exam_3', name: '题集三', type: 'exam' as const };
    mocks.list.mockResolvedValueOnce({ ok: true, value: [exam1, exam2, exam3] });

    render(
      <ResourceAppWorkspace
        type="exam"
        initialResourceId="exam_2"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam_2');

    // Open delete via row menu -> Cancel aborts deletion
    fireEvent.click(screen.getByRole('button', { name: '题集二 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.delete).not.toHaveBeenCalled();

    // Confirm deletion while dstu.watch fires mid-flight -> selects next sibling exam_3
    mocks.list.mockResolvedValueOnce({ ok: true, value: [exam1, exam3] });
    mocks.delete.mockImplementationOnce(async () => {
      act(() => notifyResourceChange());
      return { ok: true, value: undefined };
    });

    fireEvent.click(screen.getByRole('button', { name: '题集二 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/exam_2'));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam_3');
    expect(screen.queryByText('题集二')).not.toBeInTheDocument();

    // Delete last item exam_3 via Delete key -> falls back to previous sibling exam_1
    mocks.delete.mockResolvedValueOnce({ ok: true, value: undefined });
    fireEvent.keyDown(screen.getByRole('listbox', { name: '题目集' }), { key: 'Delete' });
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/exam_3'));
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam_1');

    // Delete final remaining item exam_1 -> clears selection to empty state
    mocks.delete.mockResolvedValueOnce({ ok: true, value: undefined });
    fireEvent.contextMenu(screen.getByText('题集一'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/exam_1'));
    await waitFor(() => expect(screen.queryByTestId('resource-content')).not.toBeInTheDocument());
    expect(screen.getByText('选择一个项目')).toBeInTheDocument();
  });

  it('honors dirty unsaved guard when deleting the active essay without affecting inactive deletion', async () => {
    const second = { ...essay, id: 'essay-2', sourceId: 'essay-2', path: '/essay-2', name: 'Second essay' };
    mocks.list.mockResolvedValue({ ok: true, value: [essay, second] });
    mocks.delete.mockResolvedValue({ ok: true, value: undefined });
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

    // Deleting active dirty essay requires unsaved-discard confirmation
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic essay 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(await screen.findByText('删除有未保存更改的项目？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    // Deleting INACTIVE essay uses normal confirmation and keeps dirty essay-1 open
    fireEvent.click(screen.getByRole('button', { name: 'Second essay 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(await screen.findByText('移到回收站')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/essay-2'));
    expect(screen.getByTestId('resource-content')).toHaveTextContent('essay:essay-1');

    // Confirming delete on active dirty essay discards and deletes cleanly
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic essay 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '丢弃并删除' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/essay-1'));
    await waitFor(() => expect(screen.queryByTestId('resource-content')).not.toBeInTheDocument());
    unregister();
  });

  it('honors active review session guard when deleting the active exam set', async () => {
    const firstExam = { ...essay, id: 'exam-1', sourceId: 'exam-1', path: '/exam-1', name: 'First exam', type: 'exam' as const };
    const secondExam = { ...essay, id: 'exam-2', sourceId: 'exam-2', path: '/exam-2', name: 'Second exam', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [firstExam, secondExam] });
    mocks.delete.mockResolvedValue({ ok: true, value: undefined });
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

    fireEvent.click(screen.getByRole('button', { name: 'First exam 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(await screen.findByText('结束复习并删除？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(useReviewPlanStore.getState().session.isActive).toBe(true);
    expect(mocks.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'First exam 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '结束复习并删除' }));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/exam-1'));
    expect(useReviewPlanStore.getState().session.isActive).toBe(false);
    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam-2');
  });

  it('steps through both active-review and unsaved-draft guards when deleting an exam with both', async () => {
    const firstExam = { ...essay, id: 'exam-1', sourceId: 'exam-1', path: '/exam-1', name: 'Draft exam', type: 'exam' as const };
    mocks.list.mockResolvedValue({ ok: true, value: [firstExam] });
    mocks.delete.mockResolvedValue({ ok: true, value: undefined });
    useReviewPlanStore.getState().startSession([reviewItem], 'exam-1');
    const unregister = registerContentDirtyChecker('exam', 'exam-1', () => true);

    render(
      <ResourceAppWorkspace
        type="exam"
        initialResourceId="exam-1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam-1');

    fireEvent.click(screen.getByRole('button', { name: 'Draft exam 的更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    expect(await screen.findByText('结束复习并删除？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '结束复习并删除' }));
    expect(useReviewPlanStore.getState().session.isActive).toBe(false);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(await screen.findByText('删除有未保存更改的项目？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '丢弃并删除' }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/exam-1'));
    await waitFor(() => expect(screen.queryByTestId('resource-content')).not.toBeInTheDocument());
    unregister();
  });

  it('keeps the compact drawer open when opening the row action menu and displays delete errors inline', async () => {
    const setWidth = stubWorkspaceWidth();
    const translation = {
      ...essay,
      id: 'tr_1',
      sourceId: 'tr_1',
      path: '/tr_1',
      name: 'Paper abstract',
      type: 'translation' as const,
    };
    mocks.list.mockResolvedValue({ ok: true, value: [translation] });
    mocks.delete.mockResolvedValue({
      ok: false,
      error: { toUserMessage: () => '删除失败：文件被占用' },
    });

    render(
      <ResourceAppWorkspace
        type="translation"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    await screen.findByText('Paper abstract');
    setWidth(600);
    fireEvent.click(screen.getByRole('button', { name: '显示导航' }));
    expect(screen.getByTestId('wb-translation-workspace')).toHaveAttribute('data-sidebar-open', 'true');

    // Clicking the row menu trigger inside compact drawer keeps drawer open (data-wb-drawer-stay)
    fireEvent.click(screen.getByRole('button', { name: 'Paper abstract 的更多操作' }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(screen.getByTestId('wb-translation-workspace')).toHaveAttribute('data-sidebar-open', 'true');

    fireEvent.click(await screen.findByRole('menuitem', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));

    expect(await screen.findByText('删除失败：文件被占用')).toBeInTheDocument();
    expect(mocks.notify).toHaveBeenCalledWith('error', '删除失败：文件被占用');
    expect(screen.getByText('Paper abstract')).toBeInTheDocument();
  });

  it('cancels pending blur rAF without calling dstu.rename when collapsing the sidebar mid-edit', async () => {
    mountTitlebarSlot('win-exam-collapse');
    const exam = {
      ...essay,
      id: 'exam_1',
      sourceId: 'exam_1',
      path: '/exam_1',
      name: '初始题集',
      type: 'exam' as const,
    };
    mocks.list.mockResolvedValue({ ok: true, value: [exam] });

    render(
      <ResourceAppWorkspace
        type="exam"
        windowId="win-exam-collapse"
        initialResourceId="exam_1"
        isActive
        onTitleChange={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('exam:exam_1');

    fireEvent.doubleClick(screen.getByText('初始题集'));
    const input = await screen.findByRole('textbox', { name: '重命名 初始题集' });
    fireEvent.change(input, { target: { value: '未提交的草稿名' } });

    // Simulate blur firing right as the sidebar toggle collapses and unmounts the input
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: '切换边栏' }));

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(screen.getByText('初始题集')).toBeInTheDocument();
  });

  it('delegates the app title to the outer window titlebar without repeating it in the sidebar', async () => {
    const onTitleChange = vi.fn();
    render(
      <ResourceAppWorkspace
        type="essay"
        isActive
        onTitleChange={onTitleChange}
      />,
    );
    await screen.findByText('Synthetic essay');

    expect(onTitleChange).toHaveBeenCalledWith('作文批改');
    expect(screen.queryByText('作文批改')).not.toBeInTheDocument();
    expect(document.querySelector('.wb-resource-workspace-create-btn')).toHaveAttribute('aria-label', '新建作文批改');
  });
});
