/**
 * RuntimeModelMenu - 独立的模型选择 AppMenu
 *
 * 由 thinking 菜单中的模型项触发打开。
 * 受控模式：通过 open/onOpenChange 控制显示。
 * 使用 AppMenuContent 的 showSearch 实现搜索过滤。
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuGroup,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import type { ChatStore } from '../../core/types';

// ============================================================================
// Types
// ============================================================================

interface ModelConfig {
  id: string;
  name: string;
  model: string;
  vendorId?: string;
  vendorName?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
  isEmbedding?: boolean;
  is_embedding?: boolean;
  isReranker?: boolean;
  is_reranker?: boolean;
  isFavorite?: boolean;
  is_favorite?: boolean;
}

interface VendorConfigSlim {
  id: string;
  providerType?: string;
  sortOrder?: number;
  name: string;
}

export interface RuntimeModelMenuProps {
  store: StoreApi<ChatStore>;
  /** 受控开关 */
  open: boolean;
  /** 开关变化回调 */
  onOpenChange: (open: boolean) => void;
  /** 锚定元素 ref（菜单相对此元素定位） */
  anchorRef: React.RefObject<HTMLElement | null>;
}

// ============================================================================
// Component
// ============================================================================

export const RuntimeModelMenu: React.FC<RuntimeModelMenuProps> = ({
  store,
  open,
  onOpenChange,
  anchorRef,
}) => {
  const { t } = useTranslation(['chat_host', 'common', 'chatV2']);

  const selectedModelId = useStore(store, (s) => s.chatParams.model2OverrideId);

  // Local state
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [vendorOrderMap, setVendorOrderMap] = useState<Map<string, number>>(new Map());
  const [vendorNameMap, setVendorNameMap] = useState<Map<string, string>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Load models
  const loadModels = useCallback(async () => {
    try {
      const configs = await invoke<ModelConfig[]>('get_api_configurations');
      const chatModels = (configs || []).filter((c) => {
        const isEmbedding = c.isEmbedding === true || c.is_embedding === true;
        const isReranker = c.isReranker === true || c.is_reranker === true;
        const isEnabled = c.enabled !== false;
        return !isEmbedding && !isReranker && isEnabled;
      });
      setModels(chatModels);

      try {
        const vendorConfigs = await invoke<VendorConfigSlim[]>('get_vendor_configs');
        const orderMap = new Map<string, number>();
        const nameMap = new Map<string, string>();
        const sorted = [...(vendorConfigs || [])].sort((a, b) => {
          const aSilicon = (a.providerType ?? '').toLowerCase() === 'siliconflow';
          const bSilicon = (b.providerType ?? '').toLowerCase() === 'siliconflow';
          if (aSilicon !== bSilicon) return aSilicon ? -1 : 1;
          const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.name.localeCompare(b.name);
        });
        sorted.forEach((v, i) => {
          orderMap.set(v.id, i);
          nameMap.set(v.id, v.name);
        });
        setVendorOrderMap(orderMap);
        setVendorNameMap(nameMap);
      } catch {
        setVendorOrderMap(new Map());
        setVendorNameMap(new Map());
      }

      try {
        const assignments = await invoke<Record<string, string | null>>('get_model_assignments');
        setDefaultModelId(assignments?.['model2_config_id'] || null);
      } catch {
        setDefaultModelId(null);
      }

      setLoaded(true);
    } catch (error: unknown) {
      console.error('[RuntimeModelMenu] Failed to load models:', error);
      setModels([]);
      setLoaded(true);
    }
  }, []);

  // Load when opened
  useEffect(() => {
    if (open) {
      void loadModels();
    } else {
      setSearchTerm('');
    }
  }, [open, loadModels]);

  // Listen for config changes
  useEffect(() => {
    const reload = () => { void loadModels(); };
    window.addEventListener('api_configurations_changed', reload as EventListener);
    window.addEventListener('model_assignments_changed', reload as EventListener);
    return () => {
      window.removeEventListener('api_configurations_changed', reload as EventListener);
      window.removeEventListener('model_assignments_changed', reload as EventListener);
    };
  }, [loadModels]);

  // Filter & sort
  const normalizedModels = useMemo(
    () =>
      models.map((m) => ({
        ...m,
        vendorName: m.vendorName ?? (m.vendorId ? vendorNameMap.get(m.vendorId) : undefined),
        searchable: `${m.name ?? ''} ${m.model ?? ''} ${m.vendorName ?? ''} ${m.vendorId ? (vendorNameMap.get(m.vendorId) ?? '') : ''}`.toLowerCase(),
        isFavorite: m.isFavorite === true || m.is_favorite === true,
      })),
    [models, vendorNameMap]
  );

  const sortedAndFilteredModels = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const filtered = keyword
      ? normalizedModels.filter((m) => m.searchable.includes(keyword))
      : normalizedModels;
    return [...filtered].sort((a, b) => {
      const aVendorOrder = a.vendorId ? (vendorOrderMap.get(a.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bVendorOrder = b.vendorId ? (vendorOrderMap.get(b.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aVendorOrder !== bVendorOrder) return aVendorOrder - bVendorOrder;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [normalizedModels, searchTerm, vendorOrderMap]);

  // Group by vendor
  const vendorGroups = useMemo(() => {
    const groups: { vendorId: string; vendorName: string; models: typeof sortedAndFilteredModels }[] = [];
    const groupMap = new Map<string, typeof sortedAndFilteredModels>();
    const orderList: { vendorId: string; vendorName: string }[] = [];

    for (const model of sortedAndFilteredModels) {
      const vendorId = model.vendorId || '__unknown__';
      const vendorName = model.vendorName || t('chat_host:model_panel.unknown_vendor');
      if (!groupMap.has(vendorId)) {
        groupMap.set(vendorId, []);
        orderList.push({ vendorId, vendorName });
      }
      groupMap.get(vendorId)!.push(model);
    }

    for (const { vendorId, vendorName } of orderList) {
      groups.push({ vendorId, vendorName, models: groupMap.get(vendorId)! });
    }

    return groups;
  }, [sortedAndFilteredModels, t]);

  // Select model
  const handleSelectModel = useCallback(
    (model: ModelConfig | null) => {
      const state = store.getState();
      if (!model) {
        const baseModel = models.find((candidate) => candidate.id === state.chatParams.modelId);
        store.getState().setChatParams({
          model2OverrideId: null,
          modelDisplayName: baseModel?.model || baseModel?.name || state.chatParams.modelId || '',
        });
      } else {
        store.getState().setChatParams({
          model2OverrideId: model.id,
          modelDisplayName: model.model || model.name || model.id,
        });
      }
      onOpenChange(false);
    },
    [models, onOpenChange, store]
  );

  const selectedValue = selectedModelId ?? 'system-default';
  const followSystemLabel = t('chat_host:advanced.model.follow_system');
  const defaultModel = useMemo(() => {
    if (!defaultModelId) return null;
    return models.find((m) => m.id === defaultModelId) ?? null;
  }, [defaultModelId, models]);
  const defaultModelDisplay = useMemo(() => {
    if (!defaultModel) return null;
    const vendorName = defaultModel.vendorName ?? (defaultModel.vendorId ? vendorNameMap.get(defaultModel.vendorId) : undefined);
    return vendorName ? `${vendorName} - ${defaultModel.model || defaultModel.name}` : (defaultModel.model || defaultModel.name);
  }, [defaultModel, vendorNameMap]);

  return (
    <AppMenu open={open} onOpenChange={onOpenChange}>
      <AppMenuTrigger asChild>
        <span ref={anchorRef as React.RefObject<HTMLSpanElement>} className="inline-block w-0 h-0 overflow-hidden" aria-hidden />
      </AppMenuTrigger>
      <AppMenuContent
        align="start"
        width={260}
        showSearch
        searchPlaceholder={t('chat_host:model_panel.search_placeholder')}
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        style={{ maxWidth: 'none' }}
      >
        {/* System default */}
        <div style={{ flexShrink: 0 }}>
        <AppMenuGroup>
          <AppMenuItem
            checked={selectedValue === 'system-default'}
            onClick={() => handleSelectModel(null)}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{followSystemLabel}</span>
              {defaultModelDisplay && (
                <span className="text-[10.5px] text-muted-foreground">{defaultModelDisplay}</span>
              )}
            </span>
          </AppMenuItem>
        </AppMenuGroup>

        <AppMenuSeparator />
        </div>

        {/* Model list - scrollable */}
        <div className="max-h-[300px] overflow-y-auto">
        {!loaded ? (
          <AppMenuGroup>
            <AppMenuItem disabled>
              {t('common:loading')}
            </AppMenuItem>
          </AppMenuGroup>
        ) : vendorGroups.length > 0 ? (
          vendorGroups.map((group) => (
            <AppMenuGroup key={group.vendorId} label={group.vendorName}>
              {group.models.map((model) => (
                <AppMenuItem
                  key={model.id}
                  checked={selectedValue === model.id}
                  icon={<ProviderIcon modelId={model.model || model.name} size={16} showTooltip={false} />}
                  onClick={() => handleSelectModel(model)}
                  title={model.model || model.name}
                >
                  <span className="truncate">{model.name}</span>
                  {model.id === defaultModelId && (
                    <span className="ml-1 text-[10px] text-muted-foreground opacity-70">
                      {t('chat_host:model_panel.badges.system_default')}
                    </span>
                  )}
                </AppMenuItem>
              ))}
            </AppMenuGroup>
          ))
        ) : searchTerm ? (
          <AppMenuGroup>
            <AppMenuItem disabled>
              {t('chat_host:model_panel.no_matches')}
            </AppMenuItem>
          </AppMenuGroup>
        ) : (
          <AppMenuGroup>
            <AppMenuItem disabled>
              {t('chat_host:model_panel.empty')}
            </AppMenuItem>
          </AppMenuGroup>
        )}
        </div>
      </AppMenuContent>
    </AppMenu>
  );
};

export default RuntimeModelMenu;
