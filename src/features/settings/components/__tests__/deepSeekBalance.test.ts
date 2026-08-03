import { describe, expect, it, vi } from 'vitest';
import type { VendorConfig } from '@/types';

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn().mockResolvedValue(null),
  },
}));

import {
  buildDeepSeekBalanceUrl,
  formatBalanceFetchedAt,
  isOfficialDeepSeekVendor,
  queryDeepSeekBalance,
} from '../deepSeekBalance';

const officialVendor: VendorConfig = {
  id: 'builtin-deepseek',
  name: 'DeepSeek',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
};

const deepseekResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '6.28',
          granted_balance: '0.00',
          topped_up_balance: '6.28',
        },
      ],
      ...overrides,
    }),
    { status: 200 },
  );

describe('isOfficialDeepSeekVendor', () => {
  it('accepts the builtin deepseek vendor', () => {
    expect(isOfficialDeepSeekVendor(officialVendor)).toBe(true);
  });

  it('accepts a custom deepseek vendor pointing at the official host', () => {
    expect(
      isOfficialDeepSeekVendor({
        ...officialVendor,
        id: 'custom',
        isBuiltin: false,
        baseUrl: 'https://api.deepseek.com',
      }),
    ).toBe(true);
  });

  it('rejects non-deepseek providers', () => {
    expect(isOfficialDeepSeekVendor({ ...officialVendor, providerType: 'siliconflow' })).toBe(false);
  });

  it('rejects deepseek vendors with a non-official base url', () => {
    expect(
      isOfficialDeepSeekVendor({
        ...officialVendor,
        id: 'proxy',
        isBuiltin: false,
        baseUrl: 'https://proxy.example.com/v1',
      }),
    ).toBe(false);
  });
});

describe('buildDeepSeekBalanceUrl', () => {
  it('uses the official endpoint rather than the OpenAI-compatible /v1 URL', () => {
    expect(buildDeepSeekBalanceUrl()).toBe('https://api.deepseek.com/user/balance');
  });
});

describe('queryDeepSeekBalance', () => {
  it('returns the first balance info on success', async () => {
    const fetcher = vi.fn().mockResolvedValue(deepseekResponse());
    const result = await queryDeepSeekBalance(officialVendor, fetcher as unknown as typeof fetch);

    expect(result.balance).toBe('6.28');
    expect(result.currency).toBe('CNY');
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('throws when the API key is rejected', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":{}}', { status: 401 }));
    await expect(queryDeepSeekBalance(officialVendor, fetcher as unknown as typeof fetch)).rejects.toThrow(
      'unauthorized',
    );
  });

  it('throws on a non-OK response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await expect(queryDeepSeekBalance(officialVendor, fetcher as unknown as typeof fetch)).rejects.toThrow(
      'fetch_failed',
    );
  });

  it('throws when no balance infos are returned', async () => {
    const fetcher = vi.fn().mockResolvedValue(deepseekResponse({ balance_infos: [] }));
    await expect(queryDeepSeekBalance(officialVendor, fetcher as unknown as typeof fetch)).rejects.toThrow(
      'no_balance_info',
    );
  });

  it('throws when the key is missing', async () => {
    const fetcher = vi.fn();
    await expect(
      queryDeepSeekBalance({ ...officialVendor, apiKey: '' }, fetcher as unknown as typeof fetch),
    ).rejects.toThrow('no_api_key');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('formatBalanceFetchedAt', () => {
  const now = 1_800_000_000_000;

  it('returns just_now for less than a minute', () => {
    expect(formatBalanceFetchedAt(now - 30_000, now)).toEqual({ key: 'just_now', count: 0 });
  });

  it('returns minutes_ago for recent fetches', () => {
    expect(formatBalanceFetchedAt(now - 31 * 60_000, now)).toEqual({
      key: 'minutes_ago',
      count: 31,
    });
  });

  it('returns hours_ago after an hour', () => {
    expect(formatBalanceFetchedAt(now - 2 * 3_600_000, now)).toEqual({ key: 'hours_ago', count: 2 });
  });

  it('returns days_ago after 24 hours', () => {
    expect(formatBalanceFetchedAt(now - 3 * 86_400_000, now)).toEqual({ key: 'days_ago', count: 3 });
  });
});
