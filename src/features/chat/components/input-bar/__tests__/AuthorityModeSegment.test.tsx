import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthorityModeSegment } from '../AuthorityModeSegment';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('AuthorityModeSegment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates persistence to onModeChange and shows aria-busy while pending', async () => {
    let resolveChange!: () => void;
    const onModeChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );

    render(
      <AuthorityModeSegment
        sessionId="sess_auth"
        mode="craft"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '问一问' }));

    await waitFor(() => {
      expect(onModeChange).toHaveBeenCalledWith('ask');
    });
    expect(screen.getByTestId('authority-mode-segment')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('authority-mode-ask')).toBeDisabled();

    resolveChange();
    await waitFor(() => {
      expect(screen.getByTestId('authority-mode-segment')).not.toHaveAttribute('aria-busy');
    });
  });

  it('shows switch-to-plan CTA when Ask write was blocked', async () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthorityModeSegment
        sessionId="sess_auth"
        mode="ask"
        onModeChange={onModeChange}
        showSwitchToPlanHint
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '切换到想一想' }));

    await waitFor(() => {
      expect(onModeChange).toHaveBeenCalledWith('plan');
    });
  });

  it('exposes group label and aria-pressed on the active segment', () => {
    render(
      <AuthorityModeSegment sessionId="sess_auth" mode="plan" onModeChange={() => undefined} />,
    );

    expect(screen.getByRole('group', { name: '会话权限档位' })).toBeInTheDocument();
    expect(screen.getByTestId('authority-mode-plan')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('authority-mode-ask')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('authority-mode-craft')).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not call onModeChange when selecting the already-active mode', () => {
    const onModeChange = vi.fn();
    render(
      <AuthorityModeSegment sessionId="sess_auth" mode="ask" onModeChange={onModeChange} />,
    );

    fireEvent.click(screen.getByTestId('authority-mode-ask'));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('switches the session-only permission preset independently', async () => {
    const onPermissionPresetChange = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthorityModeSegment
        sessionId="sess_auth"
        mode="craft"
        onModeChange={() => undefined}
        permissionPreset="cautious"
        onPermissionPresetChange={onPermissionPresetChange}
      />,
    );
    expect(screen.getByTestId('permission-preset-cautious')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('permission-preset-relaxed'));
    await waitFor(() => expect(onPermissionPresetChange).toHaveBeenCalledWith('relaxed'));
  });
});
