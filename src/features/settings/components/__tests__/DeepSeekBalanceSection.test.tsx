import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VendorConfig } from '@/types';
import { DeepSeekBalanceSection } from '../DeepSeekBalanceSection';

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      const map: Record<string, string> = {
        'settings:vendor_panel.balance_title': '账户余额',
        'settings:vendor_panel.balance_loading': '正在查询余额',
        'settings:vendor_panel.balance_refresh': '刷新余额',
        'settings:vendor_panel.balance_remaining': '剩余',
        'settings:vendor_panel.balance_no_key': '未配置 API 密钥',
        'settings:vendor_panel.balance_unauthorized': 'API 密钥无效',
        'settings:vendor_panel.balance_fetch_failed': '余额查询失败',
        'settings:vendor_panel.balance_just_now': '刚刚',
        'settings:vendor_panel.balance_minutes_ago': '{{count}}分钟前',
        'settings:vendor_panel.balance_hours_ago': '{{count}}小时前',
        'settings:vendor_panel.balance_days_ago': '{{count}}天前',
      };
      const template = map[key] ?? key;
      return template.replace('{{count}}', String(options?.count ?? ''));
    },
  }),
}));

const vendor: VendorConfig = {
  id: 'builtin-deepseek',
  name: 'DeepSeek',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
};

const okResponse = (totalBalance = '6.28') =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: totalBalance }],
      }),
      { status: 200 },
    ),
  );

describe('DeepSeekBalanceSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries balance when the connection section becomes active', async () => {
    const fetcher = vi.fn().mockReturnValue(okResponse());

    const { rerender } = render(
      <DeepSeekBalanceSection vendor={vendor} active={false} fetcher={fetcher as unknown as typeof fetch} />,
    );
    expect(fetcher).not.toHaveBeenCalled();

    rerender(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/剩余/)).toBeTruthy();
    expect(screen.getByText(/6\.28/)).toBeTruthy();
    expect(screen.getByText(/6\.28/)).toHaveClass('text-primary');
    expect(screen.getByText(/刚刚/)).toBeTruthy();
  });

  it('does not auto re-query after a successful fetch when reactivating', async () => {
    const fetcher = vi.fn().mockReturnValue(okResponse());

    const { rerender } = render(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender(
      <DeepSeekBalanceSection vendor={vendor} active={false} fetcher={fetcher as unknown as typeof fetch} />,
    );
    rerender(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the refresh button is clicked', async () => {
    const fetcher = vi.fn().mockReturnValue(okResponse('6.28'));

    render(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    fetcher.mockReturnValue(okResponse('5.00'));
    await userEvent.click(screen.getByRole('button', { name: '刷新余额' }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/5\.00/)).toBeTruthy();
  });

  it('shows an unauthorized message on 401', async () => {
    const fetcher = vi
      .fn()
      .mockReturnValue(Promise.resolve(new Response('{"error":{}}', { status: 401 })));

    render(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );

    expect(await screen.findByText('API 密钥无效')).toBeTruthy();
  });

  it('shows a failure message on network errors', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));

    render(
      <DeepSeekBalanceSection vendor={vendor} active={true} fetcher={fetcher as unknown as typeof fetch} />,
    );

    expect(await screen.findByText('余额查询失败')).toBeTruthy();
  });
});
