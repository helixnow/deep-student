import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import enSettings from '@/locales/en-US/settings.json';
import zhSettings from '@/locales/zh-CN/settings.json';
import { searchDetailsFor } from '@/ui-plugins/official/settings/search';
import { createDefaultSystemConfig } from '../settingsConfigDefaults';
import type { SystemConfig } from '../types';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockGetSetting = vi.hoisted(() => vi.fn());
const mockSaveSetting = vi.hoisted(() => vi.fn());
const mockSaveSettings = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@/utils/settingsApi', () => ({
  getSetting: mockGetSetting,
  saveSetting: mockSaveSetting,
  saveSettings: mockSaveSettings,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/utils/urlOpener', () => ({
  openUrl: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const lookup = (root: Record<string, unknown>, path: string): string | undefined => {
    let cur: unknown = root;
    for (const part of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  return {
    initReactI18next: { type: '3rdParty', init: () => undefined },
    useTranslation: () => ({
      t: (key: string) => {
        const bare = key.includes(':') ? key.split(':', 2)[1]! : key;
        return lookup(enSettings as unknown as Record<string, unknown>, bare) ?? key;
      },
      i18n: { language: 'en-US' },
    }),
  };
});

describe('EngineSettingsSection: G23 policy grid & PR #524 Google CSE endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_provider_strategies_config') {
        return {
          provider_strategies: {
            default: {
              timeout_ms: 10000,
              max_retries: 2,
              initial_retry_delay_ms: 200,
              max_concurrent_requests: 3,
              rate_limit_per_minute: 20,
              cache_ttl_seconds: 300,
              cache_max_entries: 128,
            },
          },
        };
      }
      return null;
    });
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__;
  });

  it('uses responsive minmax(132px,1fr) grid and unclipped tabular number inputs for Search Policy', async () => {
    vi.resetModules();
    const { EngineSettingsSection } = await import('../EngineSettingsSection');

    function Wrapper() {
      const [config, setConfig] = React.useState({
        webSearchEngine: 'bing_rss',
        webSearchTimeoutMs: 15000,
      });
      return <EngineSettingsSection config={config} setConfig={setConfig} />;
    }

    render(<Wrapper />);

    const grid = await screen.findByTestId('search-strategy-grid-bing_rss');
    expect(grid.className).toContain('grid-cols-[repeat(auto-fill,minmax(132px,1fr))]');
    expect(grid.className).not.toContain('lg:grid-cols-7');

    const timeoutInput = document.getElementById('search-strategy-bing_rss-timeout_ms') as HTMLInputElement;
    expect(timeoutInput).not.toBeNull();
    expect(timeoutInput.value).toBe('10000');
    expect(timeoutInput.className).toContain('min-w-0');
    expect(timeoutInput.className).toContain('px-2.5');
    expect(timeoutInput.className).toContain('tabular-nums');
  });

  it('renders Google CSE custom endpoint input with empty fallback and updates config', async () => {
    vi.resetModules();
    const { EngineSettingsSection } = await import('../EngineSettingsSection');
    const latest: { endpoint?: string } = {};

    function Wrapper() {
      const [config, setConfig] = React.useState<{
        webSearchEngine?: string;
        webSearchGoogleKey?: string;
        webSearchGoogleCx?: string;
        webSearchGoogleEndpoint?: string;
      }>({
        webSearchEngine: 'google_cse',
        webSearchGoogleKey: 'gkey',
        webSearchGoogleCx: 'gcx',
      });
      latest.endpoint = config.webSearchGoogleEndpoint;
      return <EngineSettingsSection config={config} setConfig={setConfig} />;
    }

    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: 'Google CSE' }));

    const endpointInput = await screen.findByTestId('google-cse-endpoint-input') as HTMLInputElement;
    expect(endpointInput.value).toBe('');
    expect(endpointInput.placeholder).toBe('https://www.googleapis.com/customsearch/v1');

    fireEvent.change(endpointInput, { target: { value: 'https://cse.example.com/customsearch/v1' } });
    expect(endpointInput.value).toBe('https://cse.example.com/customsearch/v1');
    expect(latest.endpoint).toBe('https://cse.example.com/customsearch/v1');
  });
});

describe('useSettingsConfig: web_search.google_cse.endpoint load, save & auto-save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValue([]);
    mockGetSetting.mockImplementation(async (key: string) =>
      key === 'web_search.google_cse.endpoint' ? 'https://loaded.example.com/cse' : '',
    );
    mockSaveSettings.mockResolvedValue(undefined);
    mockSaveSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__;
  });

  it('loads and saves web_search.google_cse.endpoint and auto-saves endpoint edits without Settings.tsx', async () => {
    vi.resetModules();
    const { useSettingsConfig } = await import('../useSettingsConfig');

    const configLoadedRef = { current: false };
    let latestConfig: SystemConfig = createDefaultSystemConfig();
    const setConfig = vi.fn((updater: React.SetStateAction<SystemConfig>) => {
      latestConfig = typeof updater === 'function' ? updater(latestConfig) : updater;
    });

    const makeDeps = (config: SystemConfig, loading: boolean) => ({
      setLoading: vi.fn(),
      configLoadedRef,
      setExtra: vi.fn(),
      setActiveTab: vi.fn(),
      activeTab: 'search',
      modelAssignments: {},
      vendors: [],
      modelProfiles: [],
      resolvedApiConfigs: [],
      refreshVendors: undefined,
      refreshProfiles: undefined,
      refreshApiConfigsFromBackend: vi.fn(async () => undefined),
      persistAssignments: vi.fn(async () => undefined),
      saving: false,
      setSaving: vi.fn(),
      t: ((key: string) => key) as never,
      config,
      setConfig,
      loading,
      updateIndicatorRaf: vi.fn(),
    });

    const { result, rerender } = renderHook(
      ({ config, loading }) => useSettingsConfig(makeDeps(config, loading)),
      { initialProps: { config: latestConfig, loading: true } },
    );

    await act(async () => {
      await result.current.loadConfig();
    });
    expect(latestConfig.webSearchGoogleEndpoint).toBe('https://loaded.example.com/cse');
    expect(configLoadedRef.current).toBe(true);

    rerender({ config: latestConfig, loading: false });
    await act(async () => {
      await result.current.handleSave(true);
    });
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        'web_search.google_cse.endpoint': 'https://loaded.example.com/cse',
      }),
    );

    mockSaveSettings.mockClear();
    vi.useFakeTimers();
    const updatedConfig: SystemConfig = {
      ...latestConfig,
      autoSave: true,
      webSearchGoogleEndpoint: 'https://updated.example.com/cse',
    };
    rerender({ config: updatedConfig, loading: false });
    await act(async () => {
      vi.advanceTimersByTime(1050);
    });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        'web_search.google_cse.endpoint': 'https://updated.example.com/cse',
      }),
    );
    vi.useRealTimers();
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1));
  });
});

describe('S7 learner-friendly settings copy & preserved hidden search keywords', () => {
  it('removes raw RAG/Embedding/Reranker/Vector/Endpoint jargon from primary learner labels in en-US and zh-CN', () => {
    const jargonRe = /\b(RAG|Embedding|Reranker|Vector|Endpoint)\b|嵌入模型|重排序模型|检索增强生成|向量嵌入/i;

    for (const bundle of [enSettings, zhSettings]) {
      const checkedValues = [
        bundle.api.embedding_title,
        bundle.api.embedding_description,
        bundle.api.reranker_title,
        bundle.api.reranker_description,
        bundle.rag.title,
        bundle.rag.description,
        bundle.rag.enabled,
        bundle.rag.enabled_description,
        bundle.external_search.title,
        bundle.external_search.searxng_endpoint_label,
        bundle.external_search.google_cse_endpoint_label,
        bundle.mcp_descriptions.http_endpoint_label,
        bundle.mcp_descriptions.sse_endpoint_label,
        bundle.cards.embedding_title,
        bundle.cards.reranker_title,
        bundle.groups.rag_models,
        bundle.tabs.rag,
      ];
      for (const value of checkedValues) {
        expect(value, `unexpected jargon in "${value}"`).not.toMatch(jargonRe);
      }
    }
  });

  it('preserves technical search keywords in searchDetailsFor("models")', () => {
    const modelSearchDetails = searchDetailsFor('models');
    const embeddingEntry = modelSearchDetails.find(item => item.labelKey === 'settings:api.embedding_title');
    const rerankerEntry = modelSearchDetails.find(item => item.labelKey === 'settings:api.reranker_title');
    expect(embeddingEntry?.keywords).toEqual(expect.arrayContaining(['embedding', 'RAG', 'vector']));
    expect(rerankerEntry?.keywords).toEqual(expect.arrayContaining(['reranker', 'RAG']));
  });
});
