import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserAgreementDialog } from '../UserAgreementDialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 1 },
  registerBackHandler: vi.fn(() => vi.fn()),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('UserAgreementDialog visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the mandatory agreement visibly on the first frame', () => {
    render(<UserAgreementDialog onAccept={vi.fn()} />);

    const dialog = document.body.querySelector('.fixed.inset-0');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveClass('opacity-100');
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('falls back to a timer when preview animation frames are suspended', () => {
    render(<UserAgreementDialog preview open onAccept={vi.fn()} />);

    act(() => {
      vi.advanceTimersByTime(100);
    });

    const dialog = document.body.querySelector('.fixed.inset-0');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveClass('opacity-100');
  });
});
