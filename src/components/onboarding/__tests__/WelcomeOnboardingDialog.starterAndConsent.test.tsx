import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCommon from '@/locales/zh-CN/common.json';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  LEGAL_CONSENT_STORAGE_KEY,
  USER_AGREEMENT_ACCEPTED_KEY,
  USER_AGREEMENT_VERSION,
  UserAgreementDialog,
} from '@/components/legal/UserAgreementDialog';
import { WelcomeOnboardingDialog } from '../WelcomeOnboardingDialog';

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../byok', () => ({
  QuickByokProvisionerCard: ({ onCompleted }: { onCompleted: () => void }) => (
    <button
      type="button"
      data-testid="byok-mock-complete"
      onClick={onCompleted}
    >
      complete-byok
    </button>
  ),
}));

describe('S4-01 Onboarding starter app launch & explicit legal consent', () => {
  beforeEach(() => {
    invokeMock.mockClear();
    localStorage.clear();
    workbenchBus.setEnabled(false);
  });

  afterEach(() => {
    workbenchBus.setEnabled(false);
    vi.restoreAllMocks();
    cleanup();
  });

  it('activates Chat workbench window and resets starter cue dismissal when AI Chat is chosen and Get Started is clicked', () => {
    workbenchBus.setEnabled(true);
    localStorage.setItem('onboarding_starter_cue_dismissed', 'true');
    const activateSpy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
    const onSkip = vi.fn();
    let starterEventCount = 0;
    const onStarterUpdated = () => {
      starterEventCount += 1;
    };
    window.addEventListener('deepstudent:onboarding-starter-updated', onStarterUpdated);

    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={onSkip}
        preconfiguredAi={{ modelLabel: 'DeepSeek' }}
      />,
    );

    expect(screen.getByTestId('welcome-feature-card-chat')).toHaveAttribute('aria-pressed', 'true');

    const startBtn = screen.getByRole('button', { name: /开始使用|先随便看看/ });
    fireEvent.click(startBtn);

    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: '',
      action: 'focusInput',
      fallbackLaunch: { typeId: 'chat', reason: 'api' },
    });
    expect(localStorage.getItem('onboarding_starter_focus')).toBe('chat');
    expect(localStorage.getItem('onboarding_starter_cue_dismissed')).toBeNull();
    expect(starterEventCount).toBeGreaterThanOrEqual(1);
    expect(onSkip).toHaveBeenCalledTimes(1);

    window.removeEventListener('deepstudent:onboarding-starter-updated', onStarterUpdated);
  });

  it('activates Notes or Flashcards workbench app when corresponding starter card is selected', () => {
    workbenchBus.setEnabled(true);
    const activateSpy = vi.spyOn(workbenchBus, 'activate').mockResolvedValue(true);
    const onSkip = vi.fn();

    const { unmount } = render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={onSkip}
        preconfiguredAi={{ modelLabel: 'DeepSeek' }}
      />,
    );

    fireEvent.click(screen.getByTestId('welcome-feature-card-hub'));
    fireEvent.click(screen.getByRole('button', { name: /开始使用|先随便看看/ }));

    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'notes',
      instanceKey: '',
      action: 'openWorkspace',
      fallbackLaunch: { typeId: 'notes', reason: 'api' },
    });
    expect(localStorage.getItem('onboarding_starter_focus')).toBe('hub');
    unmount();

    activateSpy.mockClear();
    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={onSkip}
        preconfiguredAi={false}
      />,
    );

    fireEvent.click(screen.getByTestId('welcome-feature-card-anki'));
    fireEvent.click(screen.getByTestId('byok-mock-complete'));

    expect(activateSpy).toHaveBeenCalledWith({
      typeId: 'flashcards',
      instanceKey: '',
      action: 'open',
      fallbackLaunch: { typeId: 'flashcards', reason: 'api' },
    });
    expect(localStorage.getItem('onboarding_starter_focus')).toBe('anki');
  });

  it('requires explicit consent checkbox in OnboardingLegalDialog, records version + ISO timestamp, and reflects agreed badge in onboarding screen', () => {
    render(
      <WelcomeOnboardingDialog
        onConfigure={vi.fn()}
        onSkip={vi.fn()}
        preconfiguredAi={{ modelLabel: 'DeepSeek' }}
      />,
    );

    const notice = screen.getByTestId('onboarding-legal-notice');
    expect(notice).toHaveAttribute('data-agreed', 'false');

    fireEvent.click(screen.getByTestId('onboarding-terms-link'));

    const checkbox = screen.getByTestId('onboarding-legal-consent-checkbox') as HTMLInputElement;
    const agreeBtn = screen.getByTestId('onboarding-legal-agree-continue');
    expect(checkbox.checked).toBe(false);
    expect(agreeBtn).toBeDisabled();
    expect(screen.getByText(zhCommon.legal.userAgreement.explicitConsentLabel)).toBeInTheDocument();
    expect(agreeBtn).toHaveTextContent(zhCommon.legal.userAgreement.agreeAndContinueCta);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(agreeBtn).toBeEnabled();

    fireEvent.click(agreeBtn);

    expect(screen.queryByTestId('onboarding-legal-dialog')).toBeNull();
    const rawSaved = localStorage.getItem(LEGAL_CONSENT_STORAGE_KEY);
    expect(rawSaved).toBeTruthy();
    const parsed = JSON.parse(rawSaved!);
    expect(parsed.version).toBe(USER_AGREEMENT_VERSION);
    expect(Number.isNaN(Date.parse(parsed.acceptedAt))).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('save_setting', {
      key: USER_AGREEMENT_ACCEPTED_KEY,
      value: USER_AGREEMENT_VERSION,
    });

    expect(screen.getByTestId('onboarding-legal-notice')).toHaveAttribute('data-agreed', 'true');
    expect(screen.getByTestId('onboarding-legal-agreed-badge')).toHaveTextContent(
      zhCommon.legal.userAgreement.agreedBadge,
    );
  });

  it('enforces explicit checkbox + Agree & Continue in mandatory UserAgreementDialog and persists consent record', () => {
    const onAccept = vi.fn();
    render(<UserAgreementDialog onAccept={onAccept} />);

    const checkbox = screen.getByTestId('user-agreement-consent-checkbox') as HTMLInputElement;
    const agreeBtn = screen.getByTestId('user-agreement-agree-continue');

    expect(checkbox.checked).toBe(false);
    expect(agreeBtn).toBeDisabled();
    expect(agreeBtn).toHaveTextContent(zhCommon.legal.userAgreement.agreeAndContinueCta);

    fireEvent.click(agreeBtn);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(checkbox);
    expect(agreeBtn).toBeEnabled();
    fireEvent.click(agreeBtn);

    expect(onAccept).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(localStorage.getItem(LEGAL_CONSENT_STORAGE_KEY) || '{}');
    expect(saved.version).toBe(USER_AGREEMENT_VERSION);
    expect(typeof saved.acceptedAt).toBe('string');
  });
});
