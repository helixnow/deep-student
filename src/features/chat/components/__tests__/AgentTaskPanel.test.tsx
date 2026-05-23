import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand';
import { AgentTaskPanel } from '../AgentTaskPanel';

interface MockChatStore {
  blocks: Map<string, unknown>;
  activeBlockIds: Set<string>;
}

function createMockStore(state: MockChatStore): StoreApi<MockChatStore> {
  return createStore<MockChatStore>(() => state);
}

describe('AgentTaskPanel', () => {
  it('does not render an empty Plan 0/0 shell before todo steps arrive', () => {
    const store = createMockStore({
      blocks: new Map(),
      activeBlockIds: new Set(['streaming-block']),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
  });

  it('renders todo progress once todo steps exist in the store', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(screen.getByText('增加 todo sample 数据与交互入口')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('expands inline instead of overlaying the composer with an absolute panel', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /增加 todo sample 数据与交互入口/i }));

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(container.innerHTML).toContain('width="10" height="10"');
    expect(container.innerHTML).not.toContain('absolute left-0 top-full');
  });

  it('replaces the compact pill with a single expanded panel header', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    fireEvent.click(screen.getByRole('button', { name: /增加 todo sample 数据与交互入口/i }));

    expect(screen.getByText('迁移 study-ui playground 调试能力')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('h-7 px-2.5');
  });

  it('shows only title and progress in collapsed mode without progress dots', () => {
    const store = createMockStore({
      blocks: new Map([
        [
          'todo-1',
          {
            toolName: 'todo_init',
            toolOutput: {
              title: '迁移 study-ui playground 调试能力',
              steps: [
                { id: 'todo_1', description: '梳理真实阻塞交互链路', status: 'completed' },
                { id: 'todo_2', description: '增加 todo sample 数据与交互入口', status: 'running' },
                { id: 'todo_3', description: '跑测试并记录剩余风险', status: 'pending' },
              ],
            },
          },
        ],
      ]),
      activeBlockIds: new Set(),
    });

    const { container } = render(<AgentTaskPanel store={store as unknown as StoreApi<any>} />);

    expect(screen.getByText('增加 todo sample 数据与交互入口')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('w-1 h-1 rounded-full');
  });
});
