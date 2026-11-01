import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settings } = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  saveSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.endsWith('.show_all') ? `show all ${options?.count}` : key.split('.').pop() ?? key,
    i18n: { language: 'en-US' },
  }),
}));

import { OpenCodeGoPlanQuotaSection } from '../OpenCodeGoPlanQuotaSection';

describe('OpenCodeGoPlanQuotaSection', () => {
  beforeEach(() => settings.clear());

  it('lists only configured models by default, with official numbers for the Go plan', async () => {
    render(<OpenCodeGoPlanQuotaSection configuredModelIds={['deepseek-v4.1-flash', 'claude-haiku-5-5']} />);
    const deepseek = screen.getByTestId('opencode-go-quota-deepseek-v4.1-flash');
    expect(within(deepseek).getByText('$100')).toBeInTheDocument();
    expect(within(deepseek).getByText('43.3K')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-go-quota-claude-haiku-5-5')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-go-quota-glm-5.3')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /show all/ }));
    expect(screen.getByTestId('opencode-go-quota-glm-5.3')).toBeInTheDocument();
    // 允许训练的型号带警示
    expect(within(screen.getByTestId('opencode-go-quota-muse-spark-1.3-contributor')).getByText('training_tag')).toBeInTheDocument();
  });

  it('switches plan, updates numbers and persists the choice', async () => {
    render(<OpenCodeGoPlanQuotaSection configuredModelIds={['deepseek-v4.1-flash']} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Go Plus' }).closest('button') ?? screen.getByText('Go Plus'));
    await waitFor(() =>
      expect(within(screen.getByTestId('opencode-go-quota-deepseek-v4.1-flash')).getByText('$200')).toBeInTheDocument(),
    );
    expect(settings.get('opencode_go.plan')).toBe('go_plus');
  });

  it('restores the saved plan', async () => {
    settings.set('opencode_go.plan', 'go_teams');
    render(<OpenCodeGoPlanQuotaSection configuredModelIds={['deepseek-v4.1-flash']} />);
    await waitFor(() =>
      expect(within(screen.getByTestId('opencode-go-quota-deepseek-v4.1-flash')).getByText('$105')).toBeInTheDocument(),
    );
  });
});
