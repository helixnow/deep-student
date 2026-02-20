/**
 * 外部搜索引擎配置组件
 * 
 * 从 Settings.tsx 拆分：EngineSettingsSection
 * Notion 风格：简洁、无边框、双栏布局
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { AppSelect } from '../ui/app-menu';
import { SecurePasswordInput } from '../SecurePasswordInput';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

export interface WebSearchConfig {
  webSearchEngine?: string;
  webSearchGoogleKey?: string;
  webSearchGoogleCx?: string;
  webSearchSerpApiKey?: string;
  webSearchTavilyKey?: string;
  webSearchBraveKey?: string;
  webSearchSearxngEndpoint?: string;
  webSearchSearxngKey?: string;
  webSearchZhipuKey?: string;
  webSearchBochaKey?: string;
  webSearchTimeoutMs?: number;
}

interface ProviderStrategy {
  timeout_ms?: number;
  max_retries?: number;
  initial_retry_delay_ms?: number;
  max_concurrent_requests?: number;
  rate_limit_per_minute?: number;
  cache_ttl_seconds?: number;
  cache_max_entries?: number;
}

type ProviderStrategiesMap = Record<string, ProviderStrategy>;

// 内部组件：设置行 - Notion 风格（与 ModelAssignmentRow 保持一致的结构）
const SettingRow = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden", className)}>
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="w-full sm:w-[280px] flex-shrink-0 [&>div]:w-full [&_button]:w-full flex items-center justify-end sm:justify-start">
      {children}
    </div>
  </div>
);

export const EngineSettingsSection: React.FC<{
  config: WebSearchConfig;
  setConfig: React.Dispatch<React.SetStateAction<WebSearchConfig>>;
}> = ({ config, setConfig }) => {
  const { t } = useTranslation('settings');
  const [providerStrategies, setProviderStrategies] = React.useState<ProviderStrategiesMap | null>(null);
  const [engineTesting, setEngineTesting] = React.useState<string | null>(null);
  const [engineResults, setEngineResults] = React.useState<Record<string, { ok: boolean; msg: string; ms?: number }>>({});
  const [providerSaving, setProviderSaving] = React.useState(false);
  const [activeEngine, setActiveEngine] = React.useState<string>('google_cse');

  React.useEffect(() => {
    const loadData = async () => {
      try {
        if (!invoke) return;
        const res = await invoke('get_provider_strategies_config') as { provider_strategies?: ProviderStrategiesMap } | null;
        setProviderStrategies(res?.provider_strategies || null);
      } catch {
        setProviderStrategies(null);
      }
    };
    let usedIdleCallback = false;
    let handle: number;
    if (typeof requestIdleCallback === 'function') {
      handle = requestIdleCallback(() => loadData(), { timeout: 100 });
      usedIdleCallback = true;
    } else {
      handle = setTimeout(loadData, 16) as unknown as number;
    }
    return () => {
      if (usedIdleCallback && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle);
      }
    };
  }, []);

  const testEngine = async (id: string) => {
    if (!invoke) return;
    try {
      setEngineTesting(id);
      const res = await invoke('test_search_engine', { engine: id }) as { ok?: boolean; message?: string; response_time?: number } | null;
      const ok = !!res?.ok;
      const msg = ok ? t('status.test_success', { ns: 'settings' }) : String(res?.message || '');
      setEngineResults(prev => ({ ...prev, [id]: { ok, msg, ms: res?.response_time } }));
    } catch (e: unknown) {
      setEngineResults(prev => ({ ...prev, [id]: { ok: false, msg: `${t('settings:status.test_failed', '测试失败')}: ${e}` } }));
    } finally {
      setEngineTesting(null);
    }
  };

  const StrategySummary: React.FC<{ id: string }> = ({ id }) => {
    const s = providerStrategies?.[id] || providerStrategies?.default;
    if (!s) return <div className="text-[11px] text-muted-foreground/70">{t('settings:config_status.not_configured_use_default')}</div>;
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[11px] text-muted-foreground/70 mt-1">
        <div>{t('settings:advanced_search.providers.timeout_ms')}: {s.timeout_ms ?? '-'}ms</div>
        <div>{t('settings:advanced_search.providers.max_retries')}: {s.max_retries ?? '-'}</div>
        <div>{t('settings:advanced_search.providers.initial_delay_ms')}: {s.initial_retry_delay_ms ?? '-'}ms</div>
        <div>{t('settings:advanced_search.providers.max_concurrent_requests')}: {s.max_concurrent_requests ?? '-'}</div>
        <div>{t('settings:advanced_search.providers.rate_limit_per_minute')}: {s.rate_limit_per_minute ?? '-'}/min</div>
      </div>
    );
  };

  const getEffectiveStrategy = (id: string): ProviderStrategy => {
    if (!providerStrategies) return {};
    return providerStrategies[id] || providerStrategies.default || {};
  };

  const handleStrategyFieldChange =
    (id: string, field: keyof ProviderStrategy) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = event.target.value.trim();
      const value = raw === '' ? undefined : Number(raw);
      if (raw !== '' && Number.isNaN(value)) return;
      setProviderStrategies(prev => {
        const base = prev || {};
        const current = base[id] || {};
        return {
          ...base,
          [id]: { ...current, [field]: value },
        };
      });
    };

  const handleSaveProviderStrategies = async () => {
    if (!invoke || !providerStrategies) return;
    try {
      setProviderSaving(true);
      await invoke('save_provider_strategies_config', { strategies: providerStrategies });
      showGlobalNotification('success', t('settings:advanced_search.messages.strategies_saved'));
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setProviderSaving(false);
    }
  };

  const StrategyEditor: React.FC<{ id: string }> = ({ id }) => {
    const s = getEffectiveStrategy(id);
    return (
      <div className="mt-6 grid gap-4 text-xs grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.timeout_ms')}</div>
          <Input
            type="number"
            min={1000}
            value={s.timeout_ms ?? ''}
            onChange={handleStrategyFieldChange(id, 'timeout_ms')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.max_retries')}</div>
          <Input
            type="number"
            min={0}
            value={s.max_retries ?? ''}
            onChange={handleStrategyFieldChange(id, 'max_retries')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.initial_delay_ms')}</div>
          <Input
            type="number"
            min={0}
            value={s.initial_retry_delay_ms ?? ''}
            onChange={handleStrategyFieldChange(id, 'initial_retry_delay_ms')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.max_concurrent_requests')}</div>
          <Input
            type="number"
            min={0}
            value={s.max_concurrent_requests ?? ''}
            onChange={handleStrategyFieldChange(id, 'max_concurrent_requests')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.rate_limit_per_minute')}</div>
          <Input
            type="number"
            min={0}
            value={s.rate_limit_per_minute ?? ''}
            onChange={handleStrategyFieldChange(id, 'rate_limit_per_minute')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.cache_ttl_seconds')}</div>
          <Input
            type="number"
            min={0}
            value={s.cache_ttl_seconds ?? ''}
            onChange={handleStrategyFieldChange(id, 'cache_ttl_seconds')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:advanced_search.providers.cache_max_entries')}</div>
          <Input
            type="number"
            min={0}
            value={s.cache_max_entries ?? ''}
            onChange={handleStrategyFieldChange(id, 'cache_max_entries')}
            className="h-8 text-xs bg-transparent"
          />
        </div>
      </div>
    );
  };

  const renderEngineFooter = (id: string, enabled: boolean) => (
    <div className="w-full pt-8 border-t border-border/40 mt-8">
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-lg font-medium text-foreground">{t('settings:advanced_search.providers.strategy_title', '策略配置')}</h3>
            <p className="text-sm text-muted-foreground">{t('settings:advanced_search.providers.strategy_hint', '未配置则回退 default')}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {engineResults[id] && (
              <span className={cn(
                "text-[11px] mr-2",
                engineResults[id].ok ? 'text-success' : 'text-destructive'
              )}>
                {engineResults[id].ok ? '✓' : '✗'} {engineResults[id].ms ? `${engineResults[id].ms}ms` : ''}
              </span>
            )}
            <NotionButton onClick={() => testEngine(id)} disabled={engineTesting === id || !enabled} size="sm" variant="ghost" className="border border-border/30">
              {engineTesting === id ? t('settings:status_labels.testing') : t('settings:status_labels.test_availability')}
            </NotionButton>
            <NotionButton size="sm" variant="primary" onClick={handleSaveProviderStrategies} disabled={providerSaving || !providerStrategies}>
              {providerSaving ? t('common:actions.saving', '保存中…') : t('settings:advanced_search.providers.save_button')}
            </NotionButton>
          </div>
        </div>
        <div>
          <StrategySummary id={id} />
          {providerStrategies && <StrategyEditor id={id} />}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-8 md:grid md:grid-cols-[minmax(180px,200px)_1fr]">
        <div className="space-y-3 w-full min-w-0 pr-0 md:pr-6 md:border-r border-border/40 md:sticky md:top-6 md:self-start">
          <div className="w-full">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">
                {t('settings:groups.search_engines_list', '搜索引擎列表')}
              </div>
            </div>
            
            <div className="flex flex-col gap-1 mt-4">
              {['google_cse', 'serpapi', 'tavily', 'brave', 'searxng', 'zhipu', 'bocha'].map((id) => {
                const labelMap: Record<string, string> = {
                  google_cse: 'Google CSE',
                  serpapi: 'SerpAPI',
                  tavily: 'Tavily',
                  brave: 'Brave',
                  searxng: 'SearXNG',
                  zhipu: t('settings:external_search.zhipu_name', '智谱 AI 搜索'),
                  bocha: t('settings:external_search.bocha_name', '博查 AI 搜索')
                };
                const isConfiguredMap: Record<string, boolean> = {
                  google_cse: !!(config.webSearchGoogleKey && config.webSearchGoogleCx),
                  serpapi: !!config.webSearchSerpApiKey,
                  tavily: !!config.webSearchTavilyKey,
                  brave: !!config.webSearchBraveKey,
                  searxng: !!config.webSearchSearxngEndpoint,
                  zhipu: !!config.webSearchZhipuKey,
                  bocha: !!config.webSearchBochaKey
                };
                const isActive = activeEngine === id;
                const isConfigured = isConfiguredMap[id];
                return (
                  <NotionButton
                    key={id}
                    variant="ghost"
                    size="sm"
                    onClick={() => setActiveEngine(id)}
                    className={cn(
                      '!rounded-lg !px-3 !py-2 text-left w-full !justify-start group relative',
                      isActive ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5 w-full">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="truncate">{labelMap[id]}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isConfigured ? 'bg-success/80' : 'bg-muted-foreground/30')} />
                      </div>
                    </div>
                  </NotionButton>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-8 w-full min-w-0">
          {activeEngine === 'google_cse' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">Google CSE</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://cse.google.com/cse/create/new", "_blank")} title={t('settings:external_search.create_custom_search', '创建自定义搜索引擎')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.google_cse_desc', 'Google 自定义搜索引擎 API，提供最准确全面的网页搜索。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.google_api_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchGoogleKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchGoogleKey: v }))} placeholder="GOOGLE_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.google_api_key_desc')}</p>
                </div>
                <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.google_cse_cx_label')}</div>
                          <Input
                    type="text"
                    value={config.webSearchGoogleCx}
                    onChange={(e) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchGoogleCx: e.target.value }))}
                    placeholder="GOOGLE_CSE_CX"
                    className="font-mono bg-muted/30 border-transparent focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.google_cse_cx_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('google_cse', !!(config.webSearchGoogleKey && config.webSearchGoogleCx))}
            </div>
          )}

          {activeEngine === 'serpapi' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">SerpAPI</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://serpapi.com/users/sign_up", "_blank")} title={t('settings:external_search.get_serpapi_key', '注册并获取 SerpAPI Key')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.serpapi_desc', '封装了 Google、Bing 等多个引擎的聚合搜索 API。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.serpapi_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchSerpApiKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSerpApiKey: v }))} placeholder="SERPAPI_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.serpapi_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('serpapi', !!config.webSearchSerpApiKey)}
            </div>
          )}

          {activeEngine === 'tavily' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">Tavily</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://tavily.com", "_blank")} title={t('settings:external_search.get_tavily_key', '注册并获取 Tavily API Key')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.tavily_desc', '专为大语言模型打造的检索优化型搜索引擎。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.tavily_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchTavilyKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchTavilyKey: v }))} placeholder="TAVILY_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.tavily_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('tavily', !!config.webSearchTavilyKey)}
            </div>
          )}

          {activeEngine === 'brave' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">Brave</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://api.search.brave.com/", "_blank")} title={t('settings:external_search.get_brave_key', '申请 Brave Search API Key')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.brave_desc', '注重隐私的独立网页搜索引擎。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.brave_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchBraveKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchBraveKey: v }))} placeholder="BRAVE_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.brave_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('brave', !!config.webSearchBraveKey)}
            </div>
          )}

          {activeEngine === 'searxng' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">SearXNG</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://docs.searxng.org/", "_blank")} title={t('settings:external_search.searxng_docs', 'SearXNG 部署文档')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.searxng_desc', '免费开源、聚合多个搜索源的元搜索引擎。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.searxng_endpoint_label')}</div>
                          <Input
                    type="text"
                    value={config.webSearchSearxngEndpoint}
                    onChange={(e) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSearxngEndpoint: e.target.value }))}
                    placeholder="https://searx.example.com"
                    className="font-mono bg-muted/30 border-transparent focus:bg-muted/20 focus-visible:ring-0 focus-visible:ring-offset-0 transition-colors"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.searxng_endpoint_desc')}</p>
                </div>
                <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.searxng_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchSearxngKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSearxngKey: v }))} placeholder="SEARXNG_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.searxng_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('searxng', !!config.webSearchSearxngEndpoint)}
            </div>
          )}

          {activeEngine === 'zhipu' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">{t('settings:external_search.zhipu_name', '智谱 AI 搜索')}</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://open.bigmodel.cn/", "_blank")} title={t('settings:external_search.zhipu_apply', '申请智谱大模型 API')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.zhipu_desc', '智谱提供的国产化互联网搜索聚合服务。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.zhipu_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchZhipuKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchZhipuKey: v }))} placeholder="ZHIPU_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.zhipu_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('zhipu', !!config.webSearchZhipuKey)}
            </div>
          )}

          {activeEngine === 'bocha' && (
            <div className="w-full animate-in fade-in duration-200">
              <div className="flex flex-col gap-2 mb-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-lg font-medium text-foreground truncate">{t('settings:external_search.bocha_name', '博查 AI 搜索')}</h3>
                    <NotionButton size="sm" variant="ghost" iconOnly className="opacity-60 hover:opacity-100" onClick={() => window.open("https://open.bochaai.com/", "_blank")} title={t('settings:external_search.bocha_apply', '申请博查 API')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </NotionButton>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {t('settings:descriptions.bocha_desc', '专注于中文资料索引的轻量级检索服务。')}
                </p>
              </div>
              <div className="flex flex-col gap-6 text-sm md:grid md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('settings:external_search.bocha_key_label')}</div>
                          <SecurePasswordInput value={config.webSearchBochaKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchBochaKey: v }))} placeholder="BOCHA_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.bocha_key_desc')}</p>
                </div>
              </div>
              {renderEngineFooter('bocha', !!config.webSearchBochaKey)}
            </div>
          )}

        </div>
      </div>

      <div className="pt-8 border-t border-border/40 mt-8">
        <h3 className="text-base font-semibold text-foreground mb-4">{t('settings:groups.global_search_settings', '全局搜索配置')}</h3>
        <div className="space-y-px">
          <SettingRow
          title={t('settings:field_labels.default_search_engine')}
          description={t('settings:sections.search_engine_desc')}
        >
          {(() => {
            const noneValue = '__none__';
            const selectValue = (config.webSearchEngine ?? '').trim() ? config.webSearchEngine : noneValue;
            return (
              <AppSelect
                value={selectValue}
                onValueChange={(value) =>
                  setConfig((prev: WebSearchConfig) => ({
                    ...prev,
                    webSearchEngine: value === noneValue ? '' : value,
                  }))
                }
                placeholder={t('settings:external_search.engine_options.none')}
                options={[
                  { value: noneValue, label: t('settings:external_search.engine_options.none') },
                  { value: 'google_cse', label: t('settings:external_search.engine_options.google_cse'), disabled: !(config.webSearchGoogleKey && config.webSearchGoogleCx) },
                  { value: 'serpapi', label: t('settings:external_search.engine_options.serpapi'), disabled: !config.webSearchSerpApiKey },
                  { value: 'tavily', label: t('settings:external_search.engine_options.tavily'), disabled: !config.webSearchTavilyKey },
                  { value: 'brave', label: t('settings:external_search.engine_options.brave'), disabled: !config.webSearchBraveKey },
                  { value: 'searxng', label: t('settings:external_search.engine_options.searxng'), disabled: !config.webSearchSearxngEndpoint },
                  { value: 'zhipu', label: t('settings:external_search.engine_options.zhipu'), disabled: !config.webSearchZhipuKey },
                  { value: 'bocha', label: t('settings:external_search.engine_options.bocha'), disabled: !config.webSearchBochaKey },
                ]}
                size="sm"
                variant="ghost"
                className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
                width={140}
              />
            );
          })()}
        </SettingRow>
        
        <SettingRow
          title={t('settings:field_labels.request_timeout')}
          description={t('settings:sections.timeout_desc')}
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1000}
              step={500}
              value={config.webSearchTimeoutMs}
              onChange={(e) => {
                const v = parseInt(e.target.value || '0', 10) || 15000;
                setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchTimeoutMs: Math.min(60000, Math.max(1000, v)) }));
              }}
              className="!w-24 h-8 text-xs bg-transparent"
            />
            <span className="text-[11px] text-muted-foreground/70">ms</span>
          </div>
        </SettingRow>
      </div>

      </div>
    </div>
  );
};
