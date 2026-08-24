import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('@/features/generative-ui/handlers/workbenchLearningHandlers', () => ({
  workbenchLearningHandlers: {},
}));

vi.mock('../../apps/system/flashcardsDueSource', () => ({
  getFlashcardsDueCount: () => 3,
  subscribeFlashcardsDueCount: () => () => {},
}));

const todoAgendaSnapshot = {
  items: [{ id: '1', dueDate: '2000-01-01', status: 'pending' as const }],
  lists: [],
  isLoading: false,
  error: null,
  updatedAt: 1,
};

vi.mock('../../apps/system/todoAgendaSource', () => ({
  getTodoAgendaSnapshot: () => todoAgendaSnapshot,
  subscribeTodoAgenda: () => () => {},
}));

import { DesktopAiBriefingWidget } from '../DesktopAiBriefingWidget';

describe('DesktopAiBriefingWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders briefing widget with due flashcards stat', () => {
    render(<DesktopAiBriefingWidget />);
    expect(screen.getByTestId('wb-ai-briefing-widget')).toBeInTheDocument();
    expect(screen.getByText('到期闪卡')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
