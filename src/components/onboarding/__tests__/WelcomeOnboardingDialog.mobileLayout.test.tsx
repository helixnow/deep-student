import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { WelcomeOnboardingDialog } from '../WelcomeOnboardingDialog';
import { UserAgreementDialog } from '@/components/legal/UserAgreementDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock('../byok', () => ({
  QuickByokProvisionerCard: () => <div data-testid="mock-byok-card">BYOK</div>,
}));

describe('SOTA08 360px mobile onboarding & consent modal layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('WelcomeOnboardingDialog allows taller mobile viewport, shows scroll cue when overflowing, and keeps legal notice in fixed footer', () => {
    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={vi.fn()}
        preconfiguredAi={false}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh_-_1rem_');
    expect(dialog.className).toContain('sm:max-h-[min(85dvh,calc(100dvh_-_1.5rem_');

    const scrollBody = screen.getByTestId('welcome-onboarding-scroll-body');
    expect(scrollBody.className).toContain('flex-1');
    expect(scrollBody.className).toContain('min-h-0');
    expect(scrollBody.className).toContain('overflow-y-auto');

    // Simulate scrollable overflow at 360px × 125%
    Object.defineProperty(scrollBody, 'scrollHeight', { configurable: true, value: 640 });
    Object.defineProperty(scrollBody, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(scrollBody, 'scrollTop', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(scrollBody);

    expect(screen.getByTestId('welcome-onboarding-scroll-cue')).toBeInTheDocument();

    // Scrolling to bottom hides the scroll cue
    scrollBody.scrollTop = 320;
    fireEvent.scroll(scrollBody);
    expect(screen.queryByTestId('welcome-onboarding-scroll-cue')).not.toBeInTheDocument();

    // Footer legal notice stays outside scroll body so it is never clipped
    const legalNotice = screen.getByTestId('onboarding-legal-notice');
    expect(scrollBody.contains(legalNotice)).toBe(false);
    expect(legalNotice.closest('.flex-shrink-0')).not.toBeNull();
  });

  it('UserAgreementDialog allows taller mobile viewport, shows scroll cue when overflowing, and keeps consent checkbox in fixed footer', () => {
    render(<UserAgreementDialog onAccept={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh_-_1rem_');
    expect(dialog.className).toContain('sm:max-h-[min(80dvh,calc(100dvh_-_1.5rem_');

    const scrollBody = screen.getByTestId('user-agreement-scroll-body');
    expect(scrollBody.className).toContain('flex-1');
    expect(scrollBody.className).toContain('min-h-0');
    expect(scrollBody.className).toContain('overflow-y-auto');

    Object.defineProperty(scrollBody, 'scrollHeight', { configurable: true, value: 700 });
    Object.defineProperty(scrollBody, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scrollBody, 'scrollTop', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(scrollBody);

    expect(screen.getByTestId('user-agreement-scroll-cue')).toBeInTheDocument();

    scrollBody.scrollTop = 400;
    fireEvent.scroll(scrollBody);
    expect(screen.queryByTestId('user-agreement-scroll-cue')).not.toBeInTheDocument();

    const consentCheckbox = screen.getByTestId('user-agreement-consent-checkbox');
    expect(scrollBody.contains(consentCheckbox)).toBe(false);
    expect(consentCheckbox.closest('.flex-shrink-0')).not.toBeNull();
  });
});
