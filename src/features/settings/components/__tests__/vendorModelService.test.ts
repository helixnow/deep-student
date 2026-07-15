import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: tauriFetchMock,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn(),
  },
}));

import type { VendorConfig } from '@/types';
import {
  buildVendorModelsUrl,
  fetchModelsFromVendor,
  mergeVendorModelRequestHeaders,
} from '../vendorModelService';

const vendor: VendorConfig = {
  id: 'custom-proxy',
  name: 'Custom Proxy',
  providerType: 'custom',
  baseUrl: 'https://proxy.example.com/v1',
  apiKey: '***',
  headers: {
    'X-Tenant-Id': 'tenant-42',
    authorization: 'Bearer stale-key',
  },
};

describe('vendorModelService request headers', () => {
  beforeEach(() => {
    tauriFetchMock.mockReset();
  });

  it.each([
    ['https://proxy.example.com', 'https://proxy.example.com/models'],
    ['https://proxy.example.com/v1/', 'https://proxy.example.com/v1/models'],
    [
      'https://proxy.example.com/v1/chat/completions/?token=signed#tenant-a',
      'https://proxy.example.com/v1/models?token=signed',
    ],
    [
      'https://proxy.example.com/v1/responses?token=signed#tenant-a',
      'https://proxy.example.com/v1/models?token=signed',
    ],
    [
      'https://proxy.example.com/v1/models/?token=signed#tenant-a',
      'https://proxy.example.com/v1/models?token=signed',
    ],
  ])('builds a model-list URL from %s', (baseUrl, expected) => {
    expect(buildVendorModelsUrl(baseUrl)).toBe(expected);
  });

  it('fetches models from the sibling endpoint when the vendor stores a full Responses URL', async () => {
    tauriFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await fetchModelsFromVendor(
      {
        ...vendor,
        baseUrl: 'https://proxy.example.com/v1/responses?token=signed#tenant-a',
      },
      'live-key'
    );

    expect(tauriFetchMock).toHaveBeenCalledWith(
      'https://proxy.example.com/v1/models?token=signed',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('keeps custom headers while transport authorization wins case-insensitively', async () => {
    tauriFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(fetchModelsFromVendor(vendor, 'live-key')).resolves.toEqual([
      { id: 'gpt-5', label: 'gpt-5' },
    ]);

    expect(tauriFetchMock).toHaveBeenCalledWith(
      'https://proxy.example.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'X-Tenant-Id': 'tenant-42',
          Authorization: 'Bearer live-key',
        },
      })
    );
  });

  it('preserves a custom authorization header when the transport has no API key', () => {
    expect(
      mergeVendorModelRequestHeaders(vendor.headers, { 'X-Transport': 'native' })
    ).toEqual({
      'X-Tenant-Id': 'tenant-42',
      authorization: 'Bearer stale-key',
      'X-Transport': 'native',
    });
  });

  it('lets Anthropic transport headers replace custom values without losing tenant headers', () => {
    expect(
      mergeVendorModelRequestHeaders(
        {
          'X-Tenant-Id': 'tenant-42',
          'X-API-Key': 'stale-key',
          'x-api-key': 'also-stale',
          'Anthropic-Version': 'old-version',
        },
        {
          'x-api-key': 'live-key',
          'anthropic-version': '2023-06-01',
        }
      )
    ).toEqual({
      'X-Tenant-Id': 'tenant-42',
      'x-api-key': 'live-key',
      'anthropic-version': '2023-06-01',
    });
  });
});
