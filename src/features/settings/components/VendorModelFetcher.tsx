/**
 * VendorModelFetcher - 通用供应商模型列表获取器
 * 
 * 支持从 OpenAI 兼容 API 和 Google Gemini API 获取模型列表，
 * 让用户选择并批量添加模型到供应商配置中。
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDown, CaretUp, Check, Clock, DownloadSimple, MagnifyingGlass, Plus, Spinner, Stack } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { TauriAPI } from '@/utils/tauriApi';
import { cn } from '@/lib/utils';
import { groupByModelFamily } from './modelFamily';
import { fetchModelsFromVendor, INVALID_VENDOR_MODEL_RESPONSE } from './vendorModelService';
import type { FetchedModel } from './vendorModelService';
import type { VendorConfig } from '@/types';

/** Codex OAuth requires a native authenticated transport, not the generic API-key fetcher. */
export function supportsModelFetching(providerType?: string | null): boolean {
  return providerType?.trim().toLowerCase() !== 'openai_codex';
}

interface VendorModelFetcherProps {
  vendor: VendorConfig;
  existingModelIds: string[];
  onAddModels: (vendor: VendorConfig, models: Array<{ modelId: string; label: string }>) => Promise<void>;
  /**
   * 'card' (default): 内嵌卡片样式（圆角边框 + bg-muted/10 外壳，列表高 15rem）。
   * 'dialog': 由外层 Dialog 提供边框/背景，列表填满弹窗剩余高度。
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

  const usesNoApiKey = vendor.authMode === 'none' || vendor.noApiKey === true;
  const rawApiKey = vendor.apiKey?.trim() ?? '';
  const fallbackApiKey = [rawApiKey, ...(vendor.apiKeys ?? [])]
    .map(key => key.trim())
    .find(key => key && key !== '***' && !key.split('').every(character => character === '*')) ?? '';
  // Tauri 运行时只会收到掩码；真实凭据由 Rust 命令在受信边界内解析。
  const hasApiKey = usesNoApiKey
    || Boolean(rawApiKey)
    || Boolean(vendor.apiKeys?.some(key => key.trim()));
  const hasBaseUrl = !!(vendor.baseUrl && vendor.baseUrl.trim());

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
      const result = await fetchModelsFromVendor(vendor, fallbackApiKey);

      // 原子替换：仅在拿到新数据后整体替换，保持已添加项的视觉连续性
      setModels(result);
      await saveCache(result);
      showGlobalNotification('success', t('settings:vendor_model_fetcher.fetch_success', { count: result.length }));
    } catch (err: unknown) {
      console.error(`[VendorModelFetcher] fetch failed for ${vendor.id}:`, err);
      const raw = err instanceof Error ? err.message : t('common:error.unknown_error');
      const error = raw === INVALID_VENDOR_MODEL_RESPONSE
        ? t('settings:vendor_model_fetcher.invalid_response')
        : raw;
      showGlobalNotification('error', t('settings:vendor_model_fetcher.fetch_failed', { error }));
    } finally {
      setLoading(false);
    }
  }, [fallbackApiKey, hasApiKey, hasBaseUrl, loadCache, saveCache, t, vendor]);

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
      showGlobalNotification('error', t('settings:vendor_model_fetcher.add_failed', { error: err instanceof Error ? err.message : t('common:error.unknown_error') }));
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
      showGlobalNotification('error', t('settings:vendor_model_fetcher.add_failed', { error: err instanceof Error ? err.message : t('common:error.unknown_error') }));
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
        embedded === 'card'
          ? 'rounded-lg border border-border/50 bg-muted/10'
          : 'flex h-full min-h-0 flex-col'
      )}
    >
      {/* 头部：搜索框 + 获取按钮 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/30">
        <div className="relative flex-1 min-w-0">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={models.length > 0
              ? t('settings:vendor_model_fetcher.search_placeholder')
              : t('settings:vendor_model_fetcher.search_placeholder_empty')
            }
            className="pl-8 h-7 text-xs border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
            disabled={models.length === 0}
          />
        </div>
        <DsButton
          variant="outline"
          size="sm"
          onClick={() => fetchModels(true)}
          disabled={loading || !hasApiKey || !hasBaseUrl}
          className="shrink-0 [@media(pointer:coarse)]:!h-11"
        >
          {loading ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : <DownloadSimple className="h-3.5 w-3.5" />}
          {loading ? t('settings:vendor_model_fetcher.fetching') : t('settings:vendor_model_fetcher.fetch_button')}
        </DsButton>
      </div>

      {/* 模型列表 */}
      {models.length > 0 ? (
        <>
          {/* 工具栏：计数 + 全部添加 */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 bg-muted/20">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Stack className="h-3 w-3" aria-hidden="true" />
                {t('settings:vendor_model_fetcher.model_count', { count: models.length })}
              </span>
              {lastFetchTime && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {formatTime(lastFetchTime)}
                  {isFromCache && (
                    <Badge variant="outline" className="text-2xs px-1 py-0 leading-tight">
                      {t('settings:vendor_model_fetcher.cached')}
                    </Badge>
                  )}
                </span>
              )}
            </div>
            {newModels.length > 0 && (
              <DsButton
                variant="outline"
                size="sm"
                onClick={handleAddAll}
                disabled={addingAll}
                className="[@media(pointer:coarse)]:!h-11"
              >
                {addingAll ? <Spinner className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                {t('settings:vendor_model_fetcher.add_all_new', { count: newModels.length })}
              </DsButton>
            )}
          </div>

          {/* 卡片给明确高度；Dialog 通过完整 flex/min-h-0 链获得可收缩视口。 */}
          <CustomScrollArea
            className={cn(
              embedded === 'dialog' ? 'min-h-0 flex-1' : 'h-60'
            )}
            viewportClassName="overscroll-contain"
            trackOffsetTop={4}
            trackOffsetBottom={4}
          >
            <div className="py-1">
              {/* 可添加的模型 - 按家族分组 */}
              {newModelGroups.map((group) => (
                <div key={group.family.id}>
                  <div
                    className={cn(
                      'sticky top-0 z-[1] flex items-baseline gap-1.5',
                      'px-3 py-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground/70',
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
                        "flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors [@media(pointer:coarse)]:min-h-11",
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
                      'flex items-center justify-between w-full gap-2 px-3 py-1.5 [@media(pointer:coarse)]:min-h-11',
                      'text-2xs uppercase tracking-wider text-muted-foreground/60',
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
          </CustomScrollArea>
        </>
      ) : !loading ? (
        /* 空状态：未获取 */
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          {hasApiKey && hasBaseUrl
            ? t('settings:vendor_model_fetcher.click_fetch')
            : t('settings:vendor_model_fetcher.need_config')
          }
        </div>
      ) : null}
    </div>
  );
};
