/**
 * VendorModelFetcher - 通用供应商模型列表获取器
 * 
 * 支持从 OpenAI 兼容 API 和 Google Gemini API 获取模型列表，
 * 让用户选择并批量添加模型到供应商配置中。
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Clock, Check, Search } from 'lucide-react';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { NotionButton } from '../ui/NotionButton';
import { Badge } from '../ui/shad/Badge';
import { Input } from '../ui/shad/Input';
import { CustomScrollArea } from '../custom-scroll-area';
import { showGlobalNotification } from '../UnifiedNotification';
import { TauriAPI } from '../../utils/tauriApi';
import { getProviderIcon } from '../../utils/providerIconEngine';
import { cn } from '@/lib/utils';
import type { VendorConfig } from '../../types';

/** 支持模型列表获取的供应商 provider_type 集合 */
const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'deepseek', 'qwen', 'dashscope', 'bailian', 'zhipu', 'doubao', 'moonshot', 'openai', 'grok',
]);

const GEMINI_PROVIDER = 'gemini';

/** 检查供应商是否支持模型列表获取 */
export function supportsModelFetching(providerType?: string | null): boolean {
  if (!providerType) return false;
  const key = providerType.toLowerCase();
  return OPENAI_COMPATIBLE_PROVIDERS.has(key) || key === GEMINI_PROVIDER;
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
}

export const VendorModelFetcher: React.FC<VendorModelFetcherProps> = ({
  vendor,
  existingModelIds,
  onAddModels,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastFetchTime, setLastFetchTime] = useState<number | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

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
    if (hasApiKey) {
      void loadCache();
    } else {
      setModels([]);
      setLastFetchTime(null);
      setIsFromCache(false);
    }
  }, [hasApiKey, loadCache]);

  // 供应商切换时重置选择
  useEffect(() => {
    setSelectedIds(new Set());
    setSearchQuery('');
    setExpanded(false);
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
    if (!hasApiKey) {
      showGlobalNotification('warning', t('settings:vendor_model_fetcher.need_api_key'));
      return;
    }
    if (!forceRefresh) {
      const loaded = await loadCache();
      if (loaded) return;
    }

    setLoading(true);
    setModels([]);
    setIsFromCache(false);
    setSelectedIds(new Set());

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

      setModels(result);
      await saveCache(result);
      showGlobalNotification('success', t('settings:vendor_model_fetcher.fetch_success', { count: result.length }));
    } catch (err: unknown) {
      console.error(`[VendorModelFetcher] fetch failed for ${vendor.id}:`, err);
      showGlobalNotification('error', t('settings:vendor_model_fetcher.fetch_failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setLoading(false);
    }
  }, [hasApiKey, isGemini, loadCache, saveCache, t, vendor.id, resolvedApiKey, vendor.baseUrl]);

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

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllNew = () => {
    setSelectedIds(new Set(newModels.map(m => m.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleAddSelected = async () => {
    const toAdd = models.filter(m => selectedIds.has(m.id));
    if (toAdd.length === 0) return;
    setAdding(true);
    try {
      await onAddModels(vendor, toAdd.map(m => ({ modelId: m.id, label: m.label })));
      showGlobalNotification('success', t('settings:vendor_model_fetcher.add_success', { count: toAdd.length }));
      setSelectedIds(new Set());
    } catch (err: unknown) {
      showGlobalNotification('error', t('settings:vendor_model_fetcher.add_failed', { error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setAdding(false);
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
    <div className="rounded-lg border border-dashed border-border/50 bg-muted/20 p-4 space-y-3">
      {/* 头部：获取按钮 + 计数 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <NotionButton
          variant="default"
          size="sm"
          onClick={() => fetchModels(true)}
          disabled={loading || !hasApiKey}
        >
          <Download className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {loading ? t('settings:vendor_model_fetcher.fetching') : t('settings:vendor_model_fetcher.fetch_button')}
        </NotionButton>
        <div className="flex items-center gap-2">
          {models.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('settings:vendor_model_fetcher.model_count', { count: models.length })}
            </span>
          )}
          {lastFetchTime && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{formatTime(lastFetchTime)}</span>
              {isFromCache && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {t('settings:vendor_model_fetcher.cached')}
                </Badge>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 模型列表（可折叠） */}
      {models.length > 0 && (
        <>
          <NotionButton
            variant="outline"
            size="sm"
            className="w-full justify-between"
            onClick={() => setExpanded(v => !v)}
          >
            <span className="truncate">
              {selectedIds.size > 0
                ? t('settings:vendor_model_fetcher.selected_count', { count: selectedIds.size })
                : t('settings:vendor_model_fetcher.select_models')}
            </span>
            <span className="text-muted-foreground text-xs ml-2">
              {expanded ? '▲' : '▼'}
            </span>
          </NotionButton>

          {expanded && (
            <div className="space-y-2">
              {/* 搜索框 */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('settings:vendor_model_fetcher.search_placeholder')}
                  className="pl-8 h-8 text-xs"
                />
              </div>

              {/* 全选/清除 */}
              <div className="flex items-center gap-2">
                <NotionButton variant="ghost" size="sm" onClick={selectAllNew} className="text-xs h-6 px-2">
                  {t('settings:vendor_model_fetcher.select_all_new')}
                </NotionButton>
                {selectedIds.size > 0 && (
                  <NotionButton variant="ghost" size="sm" onClick={clearSelection} className="text-xs h-6 px-2">
                    {t('settings:vendor_model_fetcher.clear_selection')}
                  </NotionButton>
                )}
              </div>

              {/* 模型列表 */}
              <CustomScrollArea className="max-h-64">
                <div className="space-y-0.5">
                  {newModels.map(m => {
                    const isSelected = selectedIds.has(m.id);
                    const iconPath = getProviderIcon(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleSelect(m.id)}
                        className={cn(
                          "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                          isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted/50 text-foreground"
                        )}
                      >
                        <div className={cn(
                          "flex items-center justify-center h-4 w-4 rounded border shrink-0",
                          isSelected ? "bg-primary border-primary text-primary-foreground" : "border-border"
                        )}>
                          {isSelected && <Check className="h-3 w-3" />}
                        </div>
                        <img src={iconPath} alt="" className="h-4 w-4 rounded object-contain opacity-70 shrink-0" />
                        <span className="truncate font-mono">{m.label}</span>
                      </button>
                    );
                  })}

                  {/* 已添加的模型（灰色显示） */}
                  {existingModelsInList.length > 0 && (
                    <>
                      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-2 pt-2 pb-1">
                        {t('settings:vendor_model_fetcher.already_added')}
                      </div>
                      {existingModelsInList.map(m => {
                        const iconPath = getProviderIcon(m.id);
                        return (
                          <div
                            key={m.id}
                            className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-xs text-muted-foreground/50"
                          >
                            <div className="h-4 w-4 shrink-0" />
                            <img src={iconPath} alt="" className="h-4 w-4 rounded object-contain opacity-30 shrink-0" />
                            <span className="truncate font-mono line-through">{m.label}</span>
                            <Check className="h-3 w-3 ml-auto text-green-500/50" />
                          </div>
                        );
                      })}
                    </>
                  )}

                  {filteredModels.length === 0 && (
                    <div className="text-center text-xs text-muted-foreground py-4">
                      {t('settings:vendor_model_fetcher.no_match')}
                    </div>
                  )}
                </div>
              </CustomScrollArea>
            </div>
          )}

          {/* 添加按钮 */}
          {selectedIds.size > 0 && (
            <NotionButton
              variant="primary"
              size="sm"
              onClick={handleAddSelected}
              disabled={adding}
              className="w-full"
            >
              <Plus className="h-3.5 w-3.5" />
              {adding
                ? t('settings:vendor_model_fetcher.adding')
                : t('settings:vendor_model_fetcher.add_selected', { count: selectedIds.size })}
            </NotionButton>
          )}
        </>
      )}
    </div>
  );
};
