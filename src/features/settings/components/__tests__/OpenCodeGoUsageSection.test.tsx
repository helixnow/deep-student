import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { VendorConfig } from '@/types';
import { OpenCodeGoUsageSection } from '../OpenCodeGoUsageSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { time?: string; defaultValue?: string }) => {
      const map: Record<string, string> = {
        'settings:vendor_panel.opencode_go.agent_only_notice': '仅用于 Agent 对话',
        'settings:vendor_panel.opencode_go.window_five_hour': '5 小时',
        'settings:vendor_panel.opencode_go.window_weekly': '本周',
        'settings:vendor_panel.opencode_go.window_monthly': '本月',
        'settings:vendor_panel.opencode_go.resets_at': '{{time}} 重置',
        'settings:vendor_panel.opencode_go.usage_loading': '正在查询用量',
        'settings:vendor_panel.opencode_go.usage_refresh': '刷新用量',
        'settings:vendor_panel.opencode_go.usage_failed': '用量查询失败',
      };
      const template = map[key] ?? options?.defaultValue ?? key;
      return template.replace('{{time}}', options?.time ?? '');
    },
  }),
}));

const vendor: VendorConfig = {
  id: 'builtin-opencode-go',
  name: 'OpenCode Go',
  providerType: 'opencode_go',
  baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  apiKey: '***',
};

describe('OpenCodeGoUsageSection', () => {
  it('always shows the agent-only notice and does not query while inactive', () => {
    const fetcher = vi.fn();
    render(<OpenCodeGoUsageSection vendor={vendor} active={false} fetcher={fetcher} />);
    expect(screen.getByText('仅用于 Agent 对话')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('queries once when active and renders the three windows', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      windows: [
        { window: 'five_hour', usedPercent: 12.4, resetsAtMs: null },
        { window: 'weekly', usedPercent: 40, resetsAtMs: null },
        { window: 'monthly', usedPercent: 71.6, resetsAtMs: null },
      ],
    });
    render(<OpenCodeGoUsageSection vendor={vendor} active fetcher={fetcher} />);

    expect(await screen.findByTestId('opencode-go-usage-five_hour')).toHaveTextContent('5 小时12%');
    expect(screen.getByTestId('opencode-go-usage-weekly')).toHaveTextContent('本周40%');
    expect(screen.getByTestId('opencode-go-usage-monthly')).toHaveTextContent('本月72%');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('builtin-opencode-go');
  });

  it('shows the backend error and allows a manual refresh', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('OpenCode Go API Key 已过期'))
      .mockResolvedValueOnce({ windows: [{ window: 'weekly', usedPercent: 3, resetsAtMs: null }] });
    render(<OpenCodeGoUsageSection vendor={vendor} active fetcher={fetcher} />);

    expect(await screen.findByText('OpenCode Go API Key 已过期')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '刷新用量' }));
    await waitFor(() => expect(screen.getByTestId('opencode-go-usage-weekly')).toHaveTextContent('本周3%'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
