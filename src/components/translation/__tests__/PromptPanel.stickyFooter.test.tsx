import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  saveSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

import { PromptPanel } from '../PromptPanel';

describe('PromptPanel instant-apply settings layout', () => {
  it('omits manual save footer and applies changes immediately on mobile and desktop', () => {
    const setFormality = vi.fn();
    const onRestoreDefaultPrompt = vi.fn();

    render(
      <PromptPanel
        customPrompt="custom"
        setCustomPrompt={vi.fn()}
        onRestoreDefaultPrompt={onRestoreDefaultPrompt}
        isOpen={true}
        setIsOpen={vi.fn()}
        formality="auto"
        setFormality={setFormality}
        mobileFullscreen={true}
      />,
    );

    expect(screen.queryByTestId('translation-settings-sticky-footer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'translation:prompt_editor.save' })).toBeNull();
    expect(screen.getByTestId('translation-settings-autosave-hint')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'translation:prompt_editor.restore_default' }));
    expect(onRestoreDefaultPrompt).toHaveBeenCalledTimes(1);
  });
});
