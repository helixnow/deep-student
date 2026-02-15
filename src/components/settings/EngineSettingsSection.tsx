/**
 * 外部搜索引擎配置组件
 * 
 * 从 Settings.tsx 拆分：EngineCard、EngineSettingsSection
 * Notion 风格：简洁、无边框、hover 效果
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

/** Properties accessed on the web-search config object passed to EngineSettingsSection. */
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

/** Per-provider strategy configuration used by the backend. */
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

// 内部组件：设置行 - Notion 风格
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
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors", className)}>
    <div className="flex-1 min-w-0 pt-1.5">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

// EngineCard 组件 - Notion 风格可折叠卡片
interface EngineCardProps {
  id: string;
  name: string;
  body: React.ReactNode;
  enabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  configuredLabel: string;
  notConfiguredLabel: string;
}

export const EngineCard: React.FC<EngineCardProps> = React.memo(({ id, name, body, enabled, expanded, onToggle, configuredLabel, notConfiguredLabel }) => (
  <div className="rounded-lg overflow-hidden">
    <NotionButton
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className={cn(
        "w-full !justify-between !py-2.5 !px-3",
        expanded && "bg-muted/20"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground/90">{name}</span>
        <span className={cn(
          "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
          enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground/70'
        )}>
          {enabled ? configuredLabel : notConfiguredLabel}
        </span>
      </div>
      <svg 
        className={cn(
          "w-4 h-4 text-muted-foreground/50 transition-transform duration-200",
          expanded && "rotate-180"
        )} 
        viewBox="0 0 20 20" 
        fill="currentColor" 
        aria-hidden="true"
      >
        <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clipRule="evenodd" />
      </svg>
    </NotionButton>
    {expanded && (
      <div className="px-3 pb-4 pt-2 space-y-4 animate-in slide-in-from-top-2 duration-200">
        {body}
      </div>
    )}
  </div>
));
EngineCard.displayName = 'EngineCard';

// 设计组件
// 文档31清理：SubjectBackfillSelector 和 ChatIndexStatsViewer 组件已彻底删除
// 子组件：外部搜索-按引擎分类的卡片（包含策略摘要、API配置、状态测试）
export const EngineSettingsSection: React.FC<{
  config: WebSearchConfig;
  setConfig: React.Dispatch<React.SetStateAction<WebSearchConfig>>;
}> = ({ config, setConfig }) => {
  const { t } = useTranslation('settings');
  const [providerStrategies, setProviderStrategies] = React.useState<ProviderStrategiesMap | null>(null);
  const [engineTesting, setEngineTesting] = React.useState<string | null>(null);
  const [engineResults, setEngineResults] = React.useState<Record<string, { ok: boolean; msg: string; ms?: number }>>({});
  const [providerSaving, setProviderSaving] = React.useState(false);
  // 折叠状态：默认全部折叠
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({
    google_cse: false,
    serpapi: false,
    tavily: false,
    brave: false,
    searxng: false,
    zhipu: false,
    bocha: false,
  });

  // 延迟加载，避免阻塞 UI 首帧渲染
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
    // 使用 requestIdleCallback 或 setTimeout 延迟加载
    // 🔧 修复 #3: 正确清理 setTimeout 分支
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-[11px] text-muted-foreground/70">
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
      <div className="mt-3 grid gap-3 text-xs grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.timeout_ms')}
          </label>
          <Input
            type="number"
            min={1000}
            value={s.timeout_ms ?? ''}
            onChange={handleStrategyFieldChange(id, 'timeout_ms')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.max_retries')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.max_retries ?? ''}
            onChange={handleStrategyFieldChange(id, 'max_retries')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.initial_delay_ms')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.initial_retry_delay_ms ?? ''}
            onChange={handleStrategyFieldChange(id, 'initial_retry_delay_ms')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.max_concurrent_requests')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.max_concurrent_requests ?? ''}
            onChange={handleStrategyFieldChange(id, 'max_concurrent_requests')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.rate_limit_per_minute')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.rate_limit_per_minute ?? ''}
            onChange={handleStrategyFieldChange(id, 'rate_limit_per_minute')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.cache_ttl_seconds')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.cache_ttl_seconds ?? ''}
            onChange={handleStrategyFieldChange(id, 'cache_ttl_seconds')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground/70">
            {t('settings:advanced_search.providers.cache_max_entries')}
          </label>
          <Input
            type="number"
            min={0}
            value={s.cache_max_entries ?? ''}
            onChange={handleStrategyFieldChange(id, 'cache_max_entries')}
            className="h-7 text-xs bg-transparent"
          />
        </div>
      </div>
    );
  };

  // 渲染引擎卡片底部的策略和测试区域
  const renderEngineFooter = (id: string, enabled: boolean) => (
    <div className="pt-3 mt-3 border-t border-border/30 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-muted-foreground/60 mb-1.5">
          {t('settings:advanced_search.providers.strategy_hint', '策略配置（引擎特定，未配置则回退 default）')}
        </div>
        <StrategySummary id={id} />
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {engineResults[id] && (
          <span className={cn(
            "text-[11px]",
            engineResults[id].ok ? 'text-success' : 'text-destructive'
          )}>
            {engineResults[id].ok ? '✓' : '✗'} {engineResults[id].ms ? `${engineResults[id].ms}ms` : ''}
          </span>
        )}
        <NotionButton onClick={() => testEngine(id)} disabled={engineTesting === id || !enabled} size="sm" variant="default">
          {engineTesting === id ? t('settings:status_labels.testing') : t('settings:status_labels.test_availability')}
        </NotionButton>
      </div>
    </div>
  );

  // 翻译标签（避免在每个 EngineCard 中重复获取）
  const configuredLabel = t('settings:status_labels.configured');
  const notConfiguredLabel = t('settings:status_labels.not_configured');

  return (
    <div className="space-y-4">
      {/* 默认搜索引擎选择 */}
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
      </div>

      {/* 按引擎分类的独立卡片 */}
      <div className="space-y-1">
        <EngineCard id="google_cse" name="Google CSE" enabled={!!(config.webSearchGoogleKey && config.webSearchGoogleCx)} expanded={!!expanded.google_cse} onToggle={() => setExpanded(prev => ({ ...prev, google_cse: !prev.google_cse }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.google_api_key_label')}</label>
                  <SecurePasswordInput value={config.webSearchGoogleKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchGoogleKey: v }))} placeholder="GOOGLE_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.google_api_key_desc')}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.google_cse_cx_label')}</label>
                  <Input
                    type="text"
                    value={config.webSearchGoogleCx}
                    onChange={(e) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchGoogleCx: e.target.value }))}
                    placeholder="GOOGLE_CSE_CX"
                    className="h-8 text-xs bg-transparent"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.google_cse_cx_desc')}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <a 
                  href="https://developers.google.com/custom-search/v1/introduction" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="inline-flex items-center gap-1.5 text-primary hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('settings:external_search.apply_google_cse', '申请 Google CSE API')}
                </a>
                <a 
                  href="https://cse.google.com/cse/create/new" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="inline-flex items-center gap-1.5 text-success hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('settings:external_search.create_custom_search', '创建自定义搜索引擎')}
                </a>
              </div>
              {providerStrategies && <StrategyEditor id="google_cse" />}
              {renderEngineFooter('google_cse', !!(config.webSearchGoogleKey && config.webSearchGoogleCx))}
            </div>
          }
        />

        <EngineCard id="serpapi" name="SerpAPI" enabled={!!config.webSearchSerpApiKey} expanded={!!expanded.serpapi} onToggle={() => setExpanded(prev => ({ ...prev, serpapi: !prev.serpapi }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.serpapi_key_label')}</label>
                <SecurePasswordInput value={config.webSearchSerpApiKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSerpApiKey: v }))} placeholder="SERPAPI_KEY" isSensitive />
                <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.serpapi_key_desc')}</p>
              </div>
              <a 
                href="https://serpapi.com/users/sign_up" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:opacity-80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('settings:external_search.get_serpapi_key', '注册并获取 SerpAPI Key')}
              </a>
              {providerStrategies && <StrategyEditor id="serpapi" />}
              {renderEngineFooter('serpapi', !!config.webSearchSerpApiKey)}
            </div>
          }
        />

        <EngineCard id="tavily" name="Tavily" enabled={!!config.webSearchTavilyKey} expanded={!!expanded.tavily} onToggle={() => setExpanded(prev => ({ ...prev, tavily: !prev.tavily }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.tavily_key_label')}</label>
                <SecurePasswordInput value={config.webSearchTavilyKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchTavilyKey: v }))} placeholder="TAVILY_API_KEY" isSensitive />
                <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.tavily_key_desc')}</p>
              </div>
              <a 
                href="https://tavily.com" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:opacity-80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('settings:external_search.get_tavily_key', '注册并获取 Tavily API Key')}
              </a>
              {providerStrategies && <StrategyEditor id="tavily" />}
              {renderEngineFooter('tavily', !!config.webSearchTavilyKey)}
            </div>
          }
        />

        <EngineCard id="brave" name="Brave" enabled={!!config.webSearchBraveKey} expanded={!!expanded.brave} onToggle={() => setExpanded(prev => ({ ...prev, brave: !prev.brave }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.brave_key_label')}</label>
                <SecurePasswordInput value={config.webSearchBraveKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchBraveKey: v }))} placeholder="BRAVE_API_KEY" isSensitive />
                <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.brave_key_desc')}</p>
              </div>
              <a 
                href="https://api.search.brave.com/" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:opacity-80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('settings:external_search.get_brave_key', '申请 Brave Search API Key')}
              </a>
              {providerStrategies && <StrategyEditor id="brave" />}
              {renderEngineFooter('brave', !!config.webSearchBraveKey)}
            </div>
          }
        />

        <EngineCard id="searxng" name="SearXNG" enabled={!!config.webSearchSearxngEndpoint} expanded={!!expanded.searxng} onToggle={() => setExpanded(prev => ({ ...prev, searxng: !prev.searxng }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.searxng_endpoint_label')}</label>
                  <Input
                    type="text"
                    value={config.webSearchSearxngEndpoint}
                    onChange={(e) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSearxngEndpoint: e.target.value }))}
                    placeholder="https://searx.example.com"
                    className="h-8 text-xs bg-transparent"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.searxng_endpoint_desc')}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.searxng_key_label')}</label>
                  <SecurePasswordInput value={config.webSearchSearxngKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchSearxngKey: v }))} placeholder="SEARXNG_API_KEY" isSensitive />
                  <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.searxng_key_desc')}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <a 
                  href="https://docs.searxng.org/" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="inline-flex items-center gap-1.5 text-primary hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('settings:external_search.searxng_docs', 'SearXNG 部署文档')}
                </a>
                <a 
                  href="https://searx.space/" 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="inline-flex items-center gap-1.5 text-success hover:opacity-80"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('settings:external_search.public_instances', '公共实例列表')}
                </a>
              </div>
              {providerStrategies && <StrategyEditor id="searxng" />}
              {renderEngineFooter('searxng', !!config.webSearchSearxngEndpoint)}
            </div>
          }
        />

        {/* 智谱 AI 搜索 */}
        <EngineCard id="zhipu" name={t('settings:external_search.zhipu_name')} enabled={!!config.webSearchZhipuKey} expanded={!!expanded.zhipu} onToggle={() => setExpanded(prev => ({ ...prev, zhipu: !prev.zhipu }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.zhipu_key_label')}</label>
                <SecurePasswordInput value={config.webSearchZhipuKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchZhipuKey: v }))} placeholder="ZHIPU_API_KEY" isSensitive />
                <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.zhipu_key_desc')}</p>
              </div>
              <div className="px-3 py-2 bg-primary/5 rounded-md">
                <p className="text-[11px] text-muted-foreground/70">
                  {t('settings:external_search.zhipu_desc')}
                </p>
              </div>
              <a 
                href="https://open.bigmodel.cn/" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:opacity-80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('settings:external_search.zhipu_apply')}
              </a>
              {providerStrategies && <StrategyEditor id="zhipu" />}
              {renderEngineFooter('zhipu', !!config.webSearchZhipuKey)}
            </div>
          }
        />

        {/* 博查 AI 搜索 */}
        <EngineCard id="bocha" name={t('settings:external_search.bocha_name')} enabled={!!config.webSearchBochaKey} expanded={!!expanded.bocha} onToggle={() => setExpanded(prev => ({ ...prev, bocha: !prev.bocha }))} configuredLabel={configuredLabel} notConfiguredLabel={notConfiguredLabel}
          body={
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">{t('settings:external_search.bocha_key_label')}</label>
                <SecurePasswordInput value={config.webSearchBochaKey} onChange={(v) => setConfig((prev: WebSearchConfig) => ({ ...prev, webSearchBochaKey: v }))} placeholder="BOCHA_API_KEY" isSensitive />
                <p className="text-[11px] text-muted-foreground/70">{t('settings:external_search.bocha_key_desc')}</p>
              </div>
              <div className="px-3 py-2 bg-success/5 rounded-md">
                <p className="text-[11px] text-muted-foreground/70">
                  {t('settings:external_search.bocha_desc')}
                </p>
              </div>
              <a 
                href="https://open.bochaai.com/" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:opacity-80"
              >
                <ExternalLink className="w-3 h-3" />
                {t('settings:external_search.bocha_apply')}
              </a>
              {providerStrategies && <StrategyEditor id="bocha" />}
              {renderEngineFooter('bocha', !!config.webSearchBochaKey)}
            </div>
          }
        />
      </div>

      {/* 全局请求超时 */}
      <div className="space-y-px mt-4">
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

      {/* 保存策略按钮 */}
      {providerStrategies && (
        <div className="flex justify-end pt-4">
          <NotionButton size="sm" variant="primary" onClick={handleSaveProviderStrategies} disabled={providerSaving}>
            {providerSaving
              ? t('common:actions.saving', '保存中…')
              : t('settings:advanced_search.providers.save_button')}
          </NotionButton>
        </div>
      )}
    </div>
  );
};
