import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import zhCommon from '@/locales/zh-CN/common.json';
import { WelcomeOnboardingDialog } from '../WelcomeOnboardingDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

vi.mock('../byok', () => ({
  QuickByokProvisionerCard: () => <div data-testid="byok-provisioner-card" />,
}));

describe('WelcomeOnboardingDialog non-blocking Terms & Privacy footer (S4-01)', () => {
  it('shows non-blocking footer notice and opens/closes User Agreement and Privacy Policy viewers', () => {
    const onConfigure = vi.fn();
    const onSkip = vi.fn();

    render(
      <WelcomeOnboardingDialog
        onConfigure={onConfigure}
        onSkip={onSkip}
        preconfiguredAi={{ modelLabel: 'DeepSeek' }}
      />
    );

    const notice = screen.getByTestId('onboarding-legal-notice');
    expect(notice.textContent).toBe('继续使用即表示同意《用户协议》与《隐私政策》');

    // Primary CTA stays enabled immediately without any checkbox or gating
    const startBtn = screen.getByRole('button', { name: /先随便看看|开始使用/ });
    expect(startBtn).toBeEnabled();

    // Open User Agreement preview viewer and verify all 3 legal tabs render non-empty scrollable text
    fireEvent.click(screen.getByTestId('onboarding-terms-link'));
    expect(document.getElementById('user-agreement-title')).toHaveTextContent(zhCommon.legal.userAgreement.welcomeTitle);
    const legalBody = screen.getByTestId('onboarding-legal-body');
    expect(legalBody.textContent?.trim().length).toBeGreaterThan(20);
    expect(legalBody.textContent).toContain(zhCommon.legal.userAgreement.agreementContent.intro);

    fireEvent.click(screen.getByTestId('onboarding-legal-tab-privacy'));
    expect(screen.getByTestId('onboarding-legal-body').textContent).toContain(
      zhCommon.legal.privacyPolicy.sections.overview.content,
    );

    fireEvent.click(screen.getByTestId('onboarding-legal-tab-safety'));
    expect(screen.getByTestId('onboarding-legal-body').textContent).toContain(
      zhCommon.legal.userAgreement.contentSafety.intro,
    );

    // Re-clicking active tab keeps body visible instead of collapsing to empty
    fireEvent.click(screen.getByTestId('onboarding-legal-tab-safety'));
    expect(screen.getByTestId('onboarding-legal-body').textContent).toContain(
      zhCommon.legal.userAgreement.contentSafety.rule1,
    );

    const termsCloseBtn = screen.getByRole('button', { name: zhCommon.close });
    fireEvent.click(termsCloseBtn);
    expect(onSkip).not.toHaveBeenCalled();

    // Capability cards are interactive and update selection state
    const hubCard = screen.getByTestId('welcome-feature-card-hub');
    const ankiCard = screen.getByTestId('welcome-feature-card-anki');
    expect(hubCard).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(hubCard);
    expect(hubCard).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(ankiCard);
    expect(ankiCard).toHaveAttribute('aria-pressed', 'true');
    expect(hubCard).toHaveAttribute('aria-pressed', 'false');

    // Open Privacy Policy viewer and close via 关闭 without calling onSkip
    fireEvent.click(screen.getByTestId('onboarding-privacy-link'));
    expect(screen.getByRole('heading', { name: zhCommon.legal.privacyPolicy.title })).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-legal-body').textContent).toContain(
      zhCommon.legal.privacyPolicy.sections.localStorage.content,
    );
    const privacyCloseBtns = screen.getAllByRole('button', { name: zhCommon.actions.close });
    const footerCloseBtn = privacyCloseBtns[privacyCloseBtns.length - 1];
    fireEvent.click(footerCloseBtn);
    expect(onSkip).not.toHaveBeenCalled();

    // Starting works directly without being blocked
    fireEvent.click(startBtn);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('closes open legal viewer on Escape without dismissing WelcomeOnboardingDialog', () => {
    const onConfigure = vi.fn();
    const onSkip = vi.fn();

    render(
      <WelcomeOnboardingDialog
        onConfigure={onConfigure}
        onSkip={onSkip}
        preconfiguredAi={false}
      />
    );

    fireEvent.click(screen.getByTestId('onboarding-terms-link'));
    expect(document.getElementById('user-agreement-title')).toHaveTextContent(zhCommon.legal.userAgreement.welcomeTitle);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSkip).not.toHaveBeenCalled();
    expect(document.getElementById('user-agreement-title')).toBeNull();
    expect(screen.getByRole('button', { name: '先随便看看' })).toBeEnabled();
  });
});
