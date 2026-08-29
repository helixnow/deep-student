import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}));

vi.mock('@/features/generative-ui/handlers/learningHubActionHandlers', () => ({
  learningHubActionHandlers: {},
  createLearningHubActionHandlers: () => ({}),
}));

const mockItems = [{ id: '1', name: 'note.md' }];
const mockBreadcrumbs = [{ id: 'f1', name: 'Notes', dstuPath: '/Notes' }];

vi.mock('../../stores/finderStore', () => ({
  useFinderStore: (selector: (s: {
    items: typeof mockItems;
    currentPath: { breadcrumbs: typeof mockBreadcrumbs };
  }) => unknown) =>
    selector({ items: mockItems, currentPath: { breadcrumbs: mockBreadcrumbs } }),
}));

import { LearningHubGenerativeBriefing } from '../LearningHubGenerativeBriefing';

describe('LearningHubGenerativeBriefing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders briefing with resource stat from finder store', () => {
    render(<LearningHubGenerativeBriefing />);
    expect(screen.getByTestId('lh-generative-briefing')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="steps"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-steps]')).toBeTruthy();
  });
});
