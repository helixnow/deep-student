import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'name' in opts) {
        return `${key}:${String(opts.name)}`;
      }
      return key;
    },
  }),
}));

import { PresetServerSelector } from '../McpToolsSection';

describe('PresetServerSelector permission drawer a11y', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens selector with dialog role and closes on Escape with focus return', async () => {
    render(
      <PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />,
    );

    const addBtn = screen.getByTestId('mcp-preset-add-btn');
    expect(addBtn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(addBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(addBtn);
    expect(addBtn).toHaveAttribute('aria-expanded', 'true');

    const selector = await screen.findByTestId('mcp-preset-selector');
    expect(selector).toHaveAttribute('role', 'dialog');
    expect(selector).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(window, { key: 'Escape', bubbles: true });
    await waitFor(() => {
      expect(screen.queryByTestId('mcp-preset-selector')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(addBtn).toHaveFocus();
    });
  });

  it('renders full permission summary in the install drawer', async () => {
    const onAddPreset = vi.fn();
    render(
      <PresetServerSelector existingServerIds={[]} onAddPreset={onAddPreset} />,
    );

    fireEvent.click(screen.getByTestId('mcp-preset-add-btn'));
    fireEvent.click(await screen.findByTestId('mcp-preset-item-context7'));

    const drawer = await screen.findByTestId('mcp-preset-permission-drawer');
    const summary = within(drawer).getByTestId('mcp-preset-permission-summary');
    expect(summary).toHaveAttribute('role', 'region');
    expect(within(summary).getByTestId('mcp-preset-permission-risk')).toBeInTheDocument();
    expect(within(summary).getByTestId('mcp-preset-permission-scope')).toHaveTextContent(
      'settings:mcp_presets.permissions.context7_scope',
    );
    expect(within(summary).getByTestId('mcp-preset-permission-egress')).toHaveTextContent(
      'settings:mcp_presets.network_egress_yes',
    );
    expect(within(summary).getByTestId('mcp-preset-permission-notes')).toHaveTextContent(
      'settings:mcp_presets.permissions.context7_notes',
    );

    fireEvent.click(
      within(drawer).getByRole('button', { name: 'settings:mcp_presets.confirm_install' }),
    );
    expect(onAddPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'context7' }),
      expect.any(Object),
    );
  });

  it('hides OAuth choices on Android while keeping API-key installation available', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36',
    });
    try {
      render(<PresetServerSelector existingServerIds={[]} onAddPreset={() => undefined} />);
      fireEvent.click(screen.getByTestId('mcp-preset-add-btn'));
      fireEvent.click(await screen.findByTestId('mcp-preset-item-github'));

      const drawer = await screen.findByTestId('mcp-preset-permission-drawer');
      expect(within(drawer).getByText('settings:mcp.api_key')).toBeInTheDocument();
      expect(within(drawer).queryByText('settings:mcp_presets.enable_oauth_install')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
  });
});
