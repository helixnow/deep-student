import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tauriFetchMock, showGlobalNotificationMock, debugWarnMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
  showGlobalNotificationMock: vi.fn(),
  debugWarnMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: tauriFetchMock,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    debug: vi.fn(),
    warn: debugWarnMock,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getSetting: vi.fn(),
  },
}));

import type { VendorConfig } from '@/types';
import {
  autoPostSaveFlow,
  buildVendorModelsUrl,
  fetchModelsFromVendor,
  formatVendorModelFetchError,
  INVALID_VENDOR_MODEL_RESPONSE,
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
    showGlobalNotificationMock.mockReset();
    debugWarnMock.mockReset();
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

  it('backfills context window and max output tokens from provider metadata', async () => {
    tauriFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'model-a', context_length: 128000, max_completion_tokens: 8192 },
            { id: 'model-b', max_model_len: '32768', top_provider: { max_completion_tokens: 4096 } },
            { id: 'model-c' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(fetchModelsFromVendor(vendor, 'live-key')).resolves.toEqual([
      { id: 'model-a', label: 'model-a', contextWindow: 128000, maxOutputTokens: 8192 },
      { id: 'model-b', label: 'model-b', contextWindow: 32768, maxOutputTokens: 4096 },
      { id: 'model-c', label: 'model-c' },
    ]);
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

  it('extracts actionable detail from IPC error objects and strips legacy Chinese prefixes (G22)', () => {
    const t = (key: string) => key;
    expect(
      formatVendorModelFetchError(
        { error_type: 'Network', message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:19999', details: null },
        t
      )
    ).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:19999');

    expect(
      formatVendorModelFetchError(
        { error_type: 'Network', message: '获取供应商模型失败: 502 Bad Gateway', details: null },
        t
      )
    ).toBe('502 Bad Gateway');

    const withCause = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:19999'),
    });
    expect(formatVendorModelFetchError(withCause, t)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:19999');

    expect(formatVendorModelFetchError(new Error(INVALID_VENDOR_MODEL_RESPONSE), t)).toBe(
      'settings:vendor_model_fetcher.invalid_response'
    );
    expect(formatVendorModelFetchError(null, t)).toBe('common:error.unknown_error');
  });

  it('logs unreachable provider errors via debugLog.warn and notifies UI without console.error (G22)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauriFetchMock.mockRejectedValueOnce({
      error_type: 'Network',
      message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:19999',
      details: null,
    });

    try {
      await autoPostSaveFlow(
        {
          ...vendor,
          id: 'unreachable-local',
          name: 'Local Unreachable',
          authMode: 'none',
          apiKey: '',
          baseUrl: 'http://127.0.0.1:19999/v1',
        },
        {
          existingModelIds: [],
          onAddModels: vi.fn(),
        }
      );

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(debugWarnMock).toHaveBeenCalledTimes(1);
      expect(debugWarnMock.mock.calls[0]?.[0]).toContain('ECONNREFUSED 127.0.0.1:19999');
      expect(showGlobalNotificationMock).toHaveBeenCalledTimes(1);
      expect(showGlobalNotificationMock).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('ECONNREFUSED 127.0.0.1:19999')
      );
      expect(String(showGlobalNotificationMock.mock.calls[0]?.[1])).not.toContain('Unknown error');
      expect(String(showGlobalNotificationMock.mock.calls[0]?.[1])).not.toContain('获取供应商模型失败');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
