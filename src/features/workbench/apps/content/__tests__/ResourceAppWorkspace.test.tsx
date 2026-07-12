import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  createEmpty: vi.fn(),
}));

vi.mock('@/dstu', () => ({
  dstu: { list: mocks.list, watch: vi.fn(() => () => {}) },
  createEmpty: mocks.createEmpty,
}));

vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({
  default: ({ type, resourceId }: { type: string; resourceId: string }) => (
    <div data-testid="resource-content">{type}:{resourceId}</div>
  ),
}));

import { ResourceAppWorkspace } from '../ResourceAppWorkspace';
import { requestResourceWorkspace } from '../resourceWorkspaceRegistry';

const essay = {
  id: 'essay-1',
  sourceId: 'essay-1',
  path: '/essay-1',
  name: 'Synthetic essay',
  type: 'essay' as const,
  createdAt: 1,
  updatedAt: Date.now(),
};

describe('ResourceAppWorkspace', () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ ok: true, value: [essay] });
    mocks.createEmpty.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

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

    requestResourceWorkspace('essay', 'essay-1');

    expect(await screen.findByTestId('resource-content')).toHaveTextContent('essay:essay-1');
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
});
