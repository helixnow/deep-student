import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSetting, saveSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock('@/utils/settingsApi', () => ({ getSetting, saveSetting }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

import { RendererCapabilitiesSection } from '../RendererCapabilitiesSection';
import { RENDERER_CAPABILITIES_SETTING_KEY } from '@/features/chat/components/renderers/rendererCapabilities';

beforeEach(() => {
  getSetting.mockReset().mockResolvedValue(null);
  saveSetting.mockReset().mockResolvedValue(undefined);
});

describe('RendererCapabilitiesSection — generativeUiInline', () => {
  it('toggles generativeUiInline and persists it with the other capabilities', async () => {
    render(<RendererCapabilitiesSection />);
    const title = await screen.findByText(/正文内联界面|Inline UI in replies|generativeUiInline/);
    const row = title.closest('div.group') as HTMLElement;
    const toggle = await waitFor(() => {
      const el = row.querySelector('[role="switch"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(saveSetting).toHaveBeenCalledTimes(1));
    const [key, raw] = saveSetting.mock.calls[0]!;
    expect(key).toBe(RENDERER_CAPABILITIES_SETTING_KEY);
    const saved = JSON.parse(raw as string);
    expect(saved.generativeUiInline).toBe(true);
    expect(saved.chemicalStructures).toBe(true);
    expect(saved.charts).toBe(false);
  });
});
