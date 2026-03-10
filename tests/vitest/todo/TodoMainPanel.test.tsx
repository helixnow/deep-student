import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TodoMainPanel } from '@/components/todo/TodoMainPanel';
import { useTodoStore } from '@/components/todo/useTodoStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) => {
      if (vars?.date) return `${key}:${vars.date}`;
      return key;
    },
  }),
}));

vi.mock('@/components/pomodoro/PomodoroPanel', () => ({
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

describe('TodoMainPanel', () => {
  beforeEach(() => {
    resetTodoStore();
  });

  afterEach(() => {
    resetTodoStore();
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
});
