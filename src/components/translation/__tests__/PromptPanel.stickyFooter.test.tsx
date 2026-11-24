import React from 'react';
import { render, screen } from '@testing-library/react';
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

describe('PromptPanel 360px mobile sticky footer (S3-17)', () => {
  it('keeps Save and Restore Default actions pinned in a sticky footer outside the scroll area', () => {
    render(
      <PromptPanel
        customPrompt=""
        setCustomPrompt={vi.fn()}
        onSavePrompt={vi.fn()}
        onRestoreDefaultPrompt={vi.fn()}
        isOpen={true}
        setIsOpen={vi.fn()}
        formality="auto"
        setFormality={vi.fn()}
        mobileFullscreen={true}
      />,
    );

    const footer = screen.getByTestId('translation-settings-sticky-footer');
    expect(footer.className).toContain('sticky');
    expect(footer.className).toContain('bottom-0');
    expect(footer).toContainElement(
      screen.getByRole('button', { name: 'translation:prompt_editor.save' }),
    );
    expect(footer).toContainElement(
      screen.getByRole('button', { name: 'translation:prompt_editor.restore_default' }),
    );
  });
});
