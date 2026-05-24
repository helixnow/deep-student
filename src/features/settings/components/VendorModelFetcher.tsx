/**
 * VendorModelFetcher - 通用供应商模型列表获取器
 * 
 * 支持从 OpenAI 兼容 API 和 Google Gemini API 获取模型列表，
 * 让用户选择并批量添加模型到供应商配置中。
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretUp, Check, Clock, DownloadSimple, MagnifyingGlass, Plus, Spinner, Stack } from '@phosphor-icons/react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { NotionButton } from '@/components/ui/NotionButton';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { TauriAPI } from '@/utils/tauriApi';
import { cn } from '@/lib/utils';
import { groupByModelFamily } from './modelFamily';
import type { VendorConfig } from '@/types';

const GEMINI_PROVIDER = 'gemini';

/** 检查供应商是否支持模型列表获取 — 所有有 baseUrl 的供应商均可尝试（默认 OpenAI 兼容） */
export function supportsModelFetching(_providerType?: string | null): boolean {
  return true;
}

/** OpenAI 兼容 API 返回的模型对象 */
interface OpenAIModelItem {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/** Gemini API 返回的模型对象 */
interface GeminiModelItem {
  name: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

/** 统一的模型项 */
interface FetchedModel {
  id: string;
  label: string;
}

interface VendorModelFetcherProps {
  vendor: VendorConfig;
  existingModelIds: string[];
  onAddModels: (vendor: VendorConfig, models: Array<{ modelId: string; label: string }>) => Promise<void>;
  /**
   * 'card' (default): 内嵌卡片样式（圆角边框 + bg-muted/10 外壳，列表 max-h-60）。
   * 'dialog': 由外层 Dialog 提供边框/背景，组件移除外壳并放宽列表高度至 max-h-[60vh]。
   */
  embedded?: 'card' | 'dialog';
}

export const VendorModelFetcher: React.FC<VendorModelFetcherProps> = ({
  vendor,
  existingModelIds,
  onAddModels,
  embedded = 'card',
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addingAll, setAddingAll] = useState(false);
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [lastFetchTime, setLastFetchTime] = useState<number | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [existingExpanded, setExistingExpanded] = useState(false);

  const cacheKey = `vendor_models.${vendor.id}`;
  const cacheTimeKey = `vendor_models_time.${vendor.id}`;

  // 对于内置供应商，vendor.apiKey 是掩码 "***"，需要从安全存储读取真实密钥
  const [resolvedApiKey, setResolvedApiKey] = useState<string | null>(null);
  const resolvingRef = useRef(false);

  const isBuiltinVendor = vendor.isBuiltin || vendor.id.startsWith('builtin-');

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      if (isBuiltinVendor) {
        // 内置供应商：从安全存储读取真实 API key
        if (resolvingRef.current) return;
        resolvingRef.current = true;
        try {
          // 标准格式：{vendor_id}.api_key
          let key = await TauriAPI.getSetting(`${vendor.id}.api_key`);
          // 兼容 SiliconFlow 旧格式
          if (!key && vendor.id === 'builtin-siliconflow') {
            key = await TauriAPI.getSetting('siliconflow.api_key');
          }
          if (!cancelled) {
            setResolvedApiKey(key && key.trim() ? key.trim() : null);
          }
        } catch {
          if (!cancelled) setResolvedApiKey(null);
        } finally {
          resolvingRef.current = false;
        }
      } else {
        // 非内置供应商：vendor.apiKey 是明文
        const raw = vendor.apiKey?.trim();
        if (raw && raw !== '***' && !raw.split('').every(c => c === '*')) {
          setResolvedApiKey(raw);
        } else {
          setResolvedApiKey(null);
        }
      }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [vendor.id, vendor.apiKey, isBuiltinVendor]);

  const hasApiKey = resolvedApiKey !== null;
  const hasBaseUrl = !!(vendor.baseUrl && vendor.baseUrl.trim());

  const isGemini = (vendor.providerType ?? '').toLowerCase() === GEMINI_PROVIDER;

  // 缓存：加载
  const loadCache = useCallback(async (): Promise<boolean> => {
    try {
      const cached = await TauriAPI.getSetting(cacheKey);
      const cachedTime = await TauriAPI.getSetting(cacheTimeKey);
      if (cached && cachedTime) {
        const data = JSON.parse(cached) as FetchedModel[];
        if (Array.isArray(data) && data.length > 0) {
          setModels(data);
          setLastFetchTime(parseInt(cachedTime));
          setIsFromCache(true);
          return true;
        }
      }
    } catch (e) {
      console.warn(`[VendorModelFetcher] load cache failed for ${vendor.id}:`, e);
    }
    return false;
  }, [cacheKey, cacheTimeKey, vendor.id]);

  // 缓存：保存
  const saveCache = useCallback(async (data: FetchedModel[]) => {
    try {
      await TauriAPI.saveSetting(cacheKey, JSON.stringify(data));
      await TauriAPI.saveSetting(cacheTimeKey, Date.now().toString());
      setLastFetchTime(Date.now());
    } catch (e) {
      console.warn(`[VendorModelFetcher] save cache failed for ${vendor.id}:`, e);
    }
  }, [cacheKey, cacheTimeKey, vendor.id]);

  // 初始加载缓存
  useEffect(() => {
    let cancelled = false;
    if (hasApiKey) {
      void (async () => {
        const loaded = await loadCache();
        if (!cancelled && !loaded) {
          setModels([]);
          setLastFetchTime(null);
          setIsFromCache(false);
        }
      })();
    } else {
      setModels([]);
      setLastFetchTime(null);
      setIsFromCache(false);
    }
    return () => { cancelled = true; };
  }, [hasApiKey, loadCache]);

  // 供应商切换时重置所有状态（防御性：配合 key prop 双重保障）
  useEffect(() => {
    setSearchQuery('');
    setModels([]);
    setLastFetchTime(null);
    setIsFromCache(false);
  }, [vendor.id]);

  const isStreamChannelError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('fetch_read_body') && message.includes('streamChannel');
  };

  /** 获取 OpenAI 兼容 API 的模型列表 */
  const fetchOpenAICompatible = async (doFetch: typeof fetch): Promise<FetchedModel[]> => {
    const baseUrl = vendor.baseUrl.replace(/\/+$/, '');
    const response = await doFetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${resolvedApiKey!}` },
    });
    if (!response.ok) {
      let detail: string;
      try { detail = JSON.stringify(await response.json()); } catch { detail = response.statusText || `HTTP ${response.status}`; }
      throw new Error(`${response.status}: ${detail}`);
    }
    let body: { data?: OpenAIModelItem[] };
    try {
      body = await response.json();
    } catch (err: unknown) {
      if (isStreamChannelError(err)) {
        throw new Error('TAURI_HTTP_READ_BODY_FAILED');
      }
      throw err;
    }
    if (!body?.data || !Array.isArray(body.data)) {
      throw new Error(t('settings:vendor_model_fetcher.invalid_response'));
    }
    return body.data
      .filter((m: OpenAIModelItem) =>
        // 排除音频/视频/图片生成模型
        !m.id.includes('tts') &&
        !m.id.includes('whisper') &&
        !m.id.includes('video') &&
        !m.id.includes('kolors') &&
        !m.id.includes('flux') &&
        !m.id.includes('dall-e') &&
        !m.id.includes('audio')
      )
      .map((m: OpenAIModelItem) => ({ id: m.id, label: m.id }))
      .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
  };

  /** 获取 Google Gemini API 的模型列表 */
  const fetchGemini = async (doFetch: typeof fetch): Promise<FetchedModel[]> => {
    const baseUrl = vendor.baseUrl.replace(/\/+$/, '');
    const response = await doFetch(`${baseUrl}/v1beta/models?key=${resolvedApiKey!}&pageSize=100`, {
      method: 'GET',
    });
    if (!response.ok) {
      let detail: string;
      try { detail = JSON.stringify(await response.json()); } catch { detail = response.statusText || `HTTP ${response.status}`; }
      throw new Error(`${response.status}: ${detail}`);
    }
    let body: { models?: GeminiModelItem[] };
    try {
      body = await response.json();
    } catch (err: unknown) {
      if (isStreamChannelError(err)) {
        throw new Error('TAURI_HTTP_READ_BODY_FAILED');
      }
      throw err;
    }
    if (!body?.models || !Array.isArray(body.models)) {
      throw new Error(t('settings:vendor_model_fetcher.invalid_response'));
    }
    return body.models
      .filter((m: GeminiModelItem) =>
        // 只保留支持文本生成的模型
        m.supportedGenerationMethods?.includes('generateContent')
      )
      .map((m: GeminiModelItem) => {
        // Gemini name 格式: "models/gemini-2.5-pro" → 取 "gemini-2.5-pro"
        const modelId = m.name.replace(/^models\//, '');
        return { id: modelId, label: m.displayName || modelId };
      })
      .sort((a: FetchedModel, b: FetchedModel) => a.id.localeCompare(b.id));
  };

  const fetchModels = useCallback(async (forceRefresh = false) => {
    if (!hasBaseUrl) {
      showGlobalNotification('warning', t('settings:vendor_model_fetcher.need_base_url'));
      return;
    }
    if (!hasApiKey) {
      showGlobalNotification('warning', t('settings:vendor_model_fetcher.need_api_key'));
      return;
    }
    if (!forceRefresh) {
      const loaded = await loadCache();
      if (loaded) return;
    }

    setLoading(true);
    // 注意：刷新期间保留旧列表（如有），让 React 通过稳定的 m.id key 做增量 diff，
    // 避免出现「整列表先全部消失再重新出现」的闪烁。
    setIsFromCache(false);

    try {
      const fetcher = isGemini ? fetchGemini : fetchOpenAICompatible;
      let result: FetchedModel[];
      try {
        result = await fetcher(tauriFetch as typeof fetch);
      } catch (err: unknown) {
        if (isStreamChannelError(err) || (err instanceof Error && err.message === 'TAURI_HTTP_READ_BODY_FAILED')) {
          result = await fetcher(fetch);
        } else {
          throw err;
        }
      }

      // 原子替换：仅在拿到新数据后整体替换，保持已添加项的视觉连续性
      setModels(result);
      await saveCache(result);
      showGlobalNotification('success', t('settings:vendor_model_fetcher.fetch_success', { count: result.length }));
    } catch (err: unknown) {
      console.error(`[VendorModelFetcher] fetch failed for ${vendor.id}:`, err);
      showGlobalNotification('error', t('settings:vendor_model_fetcher.fetch_failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setLoading(false);
    }
  }, [hasApiKey, hasBaseUrl, isGemini, loadCache, saveCache, t, vendor.id, resolvedApiKey, vendor.baseUrl]);

  // 过滤 + 分组
  const existingSet = useMemo(() => new Set(existingModelIds.map(id => id.toLowerCase())), [existingModelIds]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = models;
    if (q) {
      list = list.filter(m => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    }
    return list;
  }, [models, searchQuery]);

  const newModels = useMemo(() => filteredModels.filter(m => !existingSet.has(m.id.toLowerCase())), [filteredModels, existingSet]);
  const existingModelsInList = useMemo(() => filteredModels.filter(m => existingSet.has(m.id.toLowerCase())), [filteredModels, existingSet]);

  // 可添加模型按家族分组（GPT-4 / Claude Opus / Gemini 2.5 …）
  // 单家族时也分组，因为远程 list 经常 100+ 模型，sticky 小标题帮助定位
  const newModelGroups = useMemo(
    () => groupByModelFamily(newModels, (m) => m.id),
    [newModels],
  );

  // 单条添加
  const handleAddSingle = async (model: FetchedModel) => {
    setAddingId(model.id);
    try {
      await onAddModels(vendor, [{ modelId: model.id, label: model.label }]);
      showGlobalNotification('success', t('settings:vendor_model_fetcher.add_success', { count: 1 }));
    } catch (err: unknown) {
      showGlobalNotification('error', t('settings:vendor_model_fetcher.add_failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setAddingId(null);
    }
  };

  // 全部添加（未添加的）
  const handleAddAll = async () => {
    if (newModels.length === 0) return;
    setAddingAll(true);
    try {
      await onAddModels(vendor, newModels.map(m => ({ modelId: m.id, label: m.label })));
      showGlobalNotification('success', t('settings:vendor_model_fetcher.add_success', { count: newModels.length }));
    } catch (err: unknown) {
      showGlobalNotification('error', t('settings:vendor_model_fetcher.add_failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setAddingAll(false);
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return t('settings:vendor_model_fetcher.just_now');
    if (diff < 3600000) return t('settings:vendor_model_fetcher.minutes_ago', { minutes: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('settings:vendor_model_fetcher.hours_ago', { hours: Math.floor(diff / 3600000) });
    return new Date(ts).toLocaleString();
  };

  return (
    <div
      className={cn(
        'overflow-hidden',
        embedded === 'card' && 'rounded-lg border border-border/50 bg-muted/10'
      )}
    >
      {/* 头部：搜索框 + 获取按钮 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/30">
        <div className="relative flex-1 min-w-0">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={models.length > 0
              ? t('settings:vendor_model_fetcher.search_placeholder')
              : t('settings:vendor_model_fetcher.search_placeholder_empty', { defaultValue: '\u83b7\u53d6\u6a21\u578b\u5217\u8868\u540e\u53ef\u641c\u7d22...' })
            }
            className="pl-8 h-7 text-xs border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
            disabled={models.length === 0}
          />
        </div>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => fetchModels(true)}
          disabled={loading || !hasApiKey || !hasBaseUrl}
          className="shrink-0 h-7 text-xs"
        >
          {loading ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <DownloadSimple className="h-3.5 w-3.5" />}
          {loading ? t('settings:vendor_model_fetcher.fetching') : t('settings:vendor_model_fetcher.fetch_button')}
        </NotionButton>
      </div>

      {/* 模型列表 */}
      {models.length > 0 ? (
        <>
          {/* 工具栏：计数 + 全部添加 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 bg-muted/20">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Stack className="h-3 w-3" aria-hidden="true" />
                {t('settings:vendor_model_fetcher.model_count', { count: models.length })}
              </span>
              {lastFetchTime && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {formatTime(lastFetchTime)}
                  {isFromCache && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 leading-tight">
                      {t('settings:vendor_model_fetcher.cached')}
                    </Badge>
                  )}
                </span>
              )}
            </div>
            {newModels.length > 0 && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleAddAll}
                disabled={addingAll}
                className="text-[11px] h-6 px-2"
              >
                {addingAll ? <Spinner className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {t('settings:vendor_model_fetcher.add_all_new', { defaultValue: '\u5168\u90e8\u6dfb\u52a0 ({{count}})', count: newModels.length })}
              </NotionButton>
            )}
          </div>

          {/* 列表：使用原生 overflow，避免 OverlayScrollbars 在 max-height（无固定 height）父级下高度解析失败导致不滚动。 */}
          <div
            className={cn(
              'overflow-y-auto overscroll-contain',
              embedded === 'dialog' ? 'max-h-[60vh]' : 'max-h-60'
            )}
          >
            <div className="py-1">
              {/* 可添加的模型 - 按家族分组 */}
              {newModelGroups.map((group) => (
                <div key={group.family.id}>
                  <div
                    className={cn(
                      'sticky top-0 z-[1] flex items-baseline gap-1.5',
                      'px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70',
                      'bg-background',
                      'border-b border-border/30'
                    )}
                  >
                    <span>{group.family.label}</span>
                    <span className="text-muted-foreground/40" aria-hidden="true">·</span>
                    <span className="tabular-nums normal-case tracking-normal text-muted-foreground/60">{group.items.length}</span>
                  </div>
                  {group.items.map(m => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleAddSingle(m)}
                      disabled={addingId === m.id}
                      className={cn(
                        "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors",
                        "hover:bg-[var(--interactive-hover)] text-foreground",
                        addingId === m.id && "opacity-50 pointer-events-none"
                      )}
                    >
                      <ProviderIcon modelId={m.id} size={16} showTooltip={false} variant="color" style={{ opacity: 0.7 }} />
                      <span className="truncate font-mono flex-1 min-w-0">{m.label}</span>
                      <span className="shrink-0 text-muted-foreground/50 group-hover:text-primary">
                        {addingId === m.id
                          ? <Spinner className="h-3.5 w-3.5 animate-spin" />
                          : <Plus className="h-3.5 w-3.5" />
                        }
                      </span>
                    </button>
                  ))}
                </div>
              ))}

              {/* 已添加的模型 - 可折叠 */}
              {existingModelsInList.length > 0 && (
                <>
                  {newModels.length > 0 && <div className="my-1 border-t border-border/20" />}
                  <button
                    type="button"
                    onClick={() => setExistingExpanded(v => !v)}
                    aria-expanded={existingExpanded}
                    aria-controls="vendor-model-fetcher-existing-list"
                    className={cn(
                      'flex items-center justify-between w-full gap-2 px-3 py-1.5',
                      'text-[10px] uppercase tracking-wider text-muted-foreground/60',
                      'hover:text-muted-foreground hover:bg-[var(--interactive-hover)]',
                      'transition-colors'
                    )}
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span>{t('settings:vendor_model_fetcher.already_added')}</span>
                      <span className="tabular-nums normal-case tracking-normal text-muted-foreground/40">
                        {existingModelsInList.length}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted-foreground/50" aria-hidden="true">
                      {existingExpanded ? <CaretUp className="h-3 w-3" /> : <CaretDown className="h-3 w-3" />}
                    </span>
                  </button>
                  <div
                    id="vendor-model-fetcher-existing-list"
                    className={cn(
                      'grid transition-all duration-300 ease-in-out',
                      existingExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    )}
                  >
                    <div className="overflow-hidden">
                      {existingModelsInList.map(m => (
                        <div
                          key={m.id}
                          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-muted-foreground/40"
                        >
                          <ProviderIcon
                            modelId={m.id}
                            size={16}
                            showTooltip={false}
                            variant="color"
                            style={{ filter: 'grayscale(1)', opacity: 0.3 }}
                          />
                          <span className="truncate font-mono flex-1 min-w-0">{m.label}</span>
                          <Check className="h-3.5 w-3.5 text-green-500/40 shrink-0" />
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* 无匹配 */}
              {filteredModels.length === 0 && (
                <div className="text-center text-xs text-muted-foreground py-6">
                  {t('settings:vendor_model_fetcher.no_match')}
                </div>
              )}
            </div>
          </div>
        </>
      ) : !loading ? (
        /* 空状态：未获取 */
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {hasApiKey && hasBaseUrl
            ? t('settings:vendor_model_fetcher.click_fetch', { defaultValue: '\u70b9\u51fb\u4e0a\u65b9\u6309\u94ae\u83b7\u53d6\u53ef\u7528\u6a21\u578b\u5217\u8868' })
            : t('settings:vendor_model_fetcher.need_config', { defaultValue: '\u8bf7\u5148\u914d\u7f6e\u63a5\u53e3\u5730\u5740\u548c API Key' })
          }
        </div>
      ) : null}
    </div>
  );
};
