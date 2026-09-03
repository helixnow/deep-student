import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TodoMainPanel } from '@/features/todo/components/TodoMainPanel';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import { useViewStore } from '@/stores/viewStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      if (vars?.date) return `${key}:${vars.date}`;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/pomodoro/components/PomodoroPanel', () => ({
  PomodoroPanel: () => null,
}));

function resetTodoStore() {
  useTodoStore.setState({
    lists: [],
    activeListId: null,
    items: [],
    selectedItemId: null,
    filter: {
      view: 'all',
      search: '',
      priorityFilter: null,
      showCompleted: false,
    },
    isLoadingLists: false,
    isLoadingItems: false,
    itemsRequestVersion: 0,
    error: null,
  });
}

function seedPendingItem(id = 'item-1', title = 'Pending item') {
  useTodoStore.setState({
    items: [
      {
        id,
        todoListId: 'list-1',
        title,
        status: 'pending',
        priority: 'none',
        tagsJson: '[]',
        sortOrder: 0,
        attachmentsJson: '[]',
        createdAt: '',
        updatedAt: '',
      },
    ] as any,
  });
}

describe('TodoMainPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    // jsdom 未实现 scrollIntoView；键盘焦点行滚动依赖它
    Element.prototype.scrollIntoView = vi.fn();
    resetTodoStore();
    useViewStore.setState({ currentView: 'todo', previousView: null });
  });

  afterEach(() => {
    resetTodoStore();
    useViewStore.setState({ currentView: 'chat-v2', previousView: null });
  });

  it('renders completed items in the completed smart view even when showCompleted is false', () => {
    useTodoStore.setState({
      filter: {
        view: 'completed',
        search: '',
        priorityFilter: null,
        showCompleted: false,
      },
      items: [
        {
          id: 'done-1',
          todoListId: 'list-1',
          title: 'Completed item',
          status: 'completed',
          priority: 'none',
          tagsJson: '[]',
          sortOrder: 0,
          attachmentsJson: '[]',
          createdAt: '',
          updatedAt: '',
        },
      ] as any,
    });

    render(<TodoMainPanel />);

    expect(screen.getByText('Completed item')).toBeInTheDocument();
  });

  describe('keyboard shortcut scope', () => {
    const row = () => document.querySelector('[data-agent-entity="todo:item-1"]');

    it('moves keyboard focus with j in the legacy todo view', () => {
      seedPendingItem();
      render(<TodoMainPanel />);

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(row()).toHaveAttribute('data-focused', 'true');
    });

    it('stays inert in other legacy views', () => {
      useViewStore.setState({ currentView: 'chat-v2', previousView: null });
      seedPendingItem();
      render(<TodoMainPanel />);

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(row()).not.toHaveAttribute('data-focused');
    });

    it('works inside a focused workbench todo window even when currentView is not todo', () => {
      useViewStore.setState({ currentView: 'chat-v2', previousView: null });
      seedPendingItem();
      render(
        <section data-wb-window="" data-focused="">
          <div data-wb-sys-app="todo">
            <TodoMainPanel />
          </div>
        </section>,
      );

      fireEvent.keyDown(document.querySelector('[data-wb-sys-app="todo"]')!, { key: 'j' });

      expect(row()).toHaveAttribute('data-focused', 'true');
    });

    it('ignores keys when the hosting workbench window is not focused', () => {
      useViewStore.setState({ currentView: 'chat-v2', previousView: null });
      seedPendingItem();
      render(
        <section data-wb-window="">
          <div data-wb-sys-app="todo">
            <TodoMainPanel />
          </div>
        </section>,
      );

      fireEvent.keyDown(document.querySelector('[data-wb-sys-app="todo"]')!, { key: 'j' });

      expect(row()).not.toHaveAttribute('data-focused');
    });

    it('ignores keys originating outside the hosting workbench window', () => {
      // 即便 legacy 视图恰好是 todo，窗口化承载也只认窗内事件
      seedPendingItem();
      render(
        <section data-wb-window="" data-focused="">
          <div data-wb-sys-app="todo">
            <TodoMainPanel />
          </div>
        </section>,
      );

      fireEvent.keyDown(document.body, { key: 'j' });

      expect(row()).not.toHaveAttribute('data-focused');
    });
  });
});
