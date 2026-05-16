/**
 * Chat V2 - 模型选择面板
 *
 * 复用原实现的 UI/UX，适配 V2 Store 架构。
 * 视觉骨架统一走 ComposerPanel.* primitives，行选中态使用 --button-primary-* 强调色。
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Star, PushPin, Sparkle } from '@phosphor-icons/react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { ModelCapabilityIcons } from '@/components/shared/ModelCapabilityIcons';
import { ComposerPanel } from '@/features/chat/components/input-bar/ComposerPanel';
import type { ChatStore } from '../../core/types';
import type { ModelAssignments } from '@/types';

// ============================================================================
// 类型
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

interface ModelPanelProps {
  store: StoreApi<ChatStore>;
  onClose: () => void;
  closeOnSelect?: boolean;
}

type NormalizedModel = ModelConfig & { searchable: string; isFavorite: boolean };

// ============================================================================
// 组件
// ============================================================================

export const ModelPanel: React.FC<ModelPanelProps> = ({ store, onClose, closeOnSelect = false }) => {
  const { t } = useTranslation(['chat_host', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 🚀 P0-2 性能优化：仅订阅实际使用的字段，避免其他 chatParams 字段变化时重渲染
  const selectedModelId = useStore(store, (s) => s.chatParams.model2OverrideId);

  const [models, setModels] = useState<ModelConfig[]>([]);
  const [vendorOrderMap, setVendorOrderMap] = useState<Map<string, number>>(new Map());
  const [vendorNameMap, setVendorNameMap] = useState<Map<string, string>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);
  const [collapsedVendors, setCollapsedVendors] = useState<Set<string>>(new Set());

  const isInitialLoad = useRef(true);
  const loadModels = useCallback(async () => {
    try {
      if (isInitialLoad.current) {
        setLoading(true);
        isInitialLoad.current = false;
      }
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
    } catch (error: unknown) {
      console.error('[ModelPanel] Failed to load models:', error);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    const reload = () => { void loadModels(); };
    try {
      window.addEventListener('api_configurations_changed', reload as EventListener);
      window.addEventListener('model_assignments_changed', reload as EventListener);
    } catch (error: unknown) {
      void error;
    }
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', reload as EventListener);
        window.removeEventListener('model_assignments_changed', reload as EventListener);
      } catch (error: unknown) {
        void error;
      }
    };
  }, [loadModels]);

  const normalizedModels = useMemo<NormalizedModel[]>(
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

  const vendorGroups = useMemo(() => {
    const groups: { vendorId: string; vendorName: string; models: NormalizedModel[] }[] = [];
    const groupMap = new Map<string, NormalizedModel[]>();
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

  useEffect(() => {
    if (searchTerm.trim()) setCollapsedVendors(new Set());
  }, [searchTerm]);

  const toggleVendorCollapse = useCallback((vendorId: string) => {
    setCollapsedVendors((previous) => {
      const next = new Set(previous);
      if (next.has(vendorId)) next.delete(vendorId);
      else next.add(vendorId);
      return next;
    });
  }, []);

  const defaultModelName = useMemo(() => {
    if (!defaultModelId) return null;
    const target = models.find((m) => m.id === defaultModelId);
    return target?.name ?? null;
  }, [defaultModelId, models]);

  const handleSelectModel = useCallback(
    (model: ModelConfig | null) => {
      const state = store.getState();
      if (!model) {
        const baseModel = models.find((candidate) => candidate.id === state.chatParams.modelId);
        store.getState().setChatParams({
          model2OverrideId: null,
          modelDisplayName: baseModel?.model || baseModel?.name || state.chatParams.modelId || '',
        });
        if (closeOnSelect) onClose();
        return;
      }
      store.getState().setChatParams({
        model2OverrideId: model.id,
        modelDisplayName: model.model || model.name || model.id,
      });
      if (closeOnSelect) onClose();
    },
    [closeOnSelect, models, onClose, store]
  );

  const handleSetAsDefault = useCallback(async () => {
    if (!selectedModelId || selectedModelId === defaultModelId) return;
    setSavingDefault(true);
    try {
      const currentAssignments = await invoke<ModelAssignments>('get_model_assignments');
      const newAssignments: ModelAssignments = {
        ...currentAssignments,
        model2_config_id: selectedModelId,
      };
      await invoke<void>('save_model_assignments', { assignments: newAssignments });
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('model_assignments_changed'));
        }
      } catch (error: unknown) {
        void error;
      }
      setDefaultModelId(selectedModelId);
      store.getState().setChatParams({ model2OverrideId: null });
      const modelName = models.find((m) => m.id === selectedModelId)?.name || selectedModelId;
      showGlobalNotification(
        'success',
        t('chat_host:model_panel.set_default_success', { model: modelName })
      );
    } catch (error: unknown) {
      console.error('[ModelPanel] Failed to set default model:', error);
      showGlobalNotification('error', t('chat_host:model_panel.set_default_error'));
    } finally {
      setSavingDefault(false);
    }
  }, [selectedModelId, defaultModelId, store, models, t]);

  const selectedValue = selectedModelId ?? 'system-default';
  const hasModels = sortedAndFilteredModels.length > 0;

  const followSystemLabel = t('chat_host:advanced.model.follow_system');
  const followSystemHint = t('chat_host:model_panel.follow_system_hint', {
    model: defaultModelName ?? t('chat_host:model_panel.unassigned_label'),
  });
  const subtitle = t('chat_host:model_panel.subtitle');

  const openModelSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('navigate-to-tab', { detail: { tabName: 'settings' } }));
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('SETTINGS_NAVIGATE_TAB', { detail: { tab: 'models' } }));
    }, 120);
    onClose();
  }, [onClose]);

  const systemBadge = t('chat_host:model_panel.badges.system_default');
  const systemBadgeTooltip = t('chat_host:model_panel.badges.system_default_tooltip');

  // 渲染默认选项（跟随系统默认）
  const renderDefaultOption = () => {
    const isSelected = selectedValue === 'system-default';
    return (
      <ComposerPanel.Row
        selected={isSelected}
        onClick={() => handleSelectModel(null)}
        leading={<ComposerPanel.SelectionIndicator variant="single" selected={isSelected} />}
        aria-label={followSystemLabel}
      >
        <span className="flex w-full items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{followSystemLabel}</span>
          <span className="shrink-0 text-xs text-[color:var(--composer-panel-muted-foreground)]">
            {followSystemHint}
          </span>
        </span>
      </ComposerPanel.Row>
    );
  };

  // 渲染模型选项
  const renderModelOption = (option: NormalizedModel) => {
    const isSelected = selectedValue === option.id;
    return (
      <ComposerPanel.Row
        key={option.id}
        selected={isSelected}
        onClick={() => handleSelectModel(option)}
        leading={<ComposerPanel.SelectionIndicator variant="single" selected={isSelected} />}
        aria-label={option.name}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <ProviderIcon
            modelId={option.model || option.name}
            size={16}
            showTooltip={false}
          />
          {option.isFavorite ? (
            <Star size={12} weight="fill" className="shrink-0 text-amber-500" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{option.name}</span>
              {option.id === defaultModelId ? (
                <CommonTooltip content={systemBadgeTooltip} position="top">
                  <Badge
                    variant="outline"
                    className="hidden h-4 px-1 py-0 text-[10px] font-medium shrink-0 cursor-help border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] sm:inline-flex"
                  >
                    {systemBadge}
                  </Badge>
                </CommonTooltip>
              ) : null}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 text-[color:var(--composer-panel-muted-foreground)]">
              <span className="max-w-[220px] truncate">{option.model}</span>
              <ModelCapabilityIcons
                isMultimodal={option.isMultimodal}
                isReasoning={option.isReasoning}
                supportsTools={option.supportsTools}
                showTextOnly
                size="xs"
              />
            </span>
          </span>
        </span>
      </ComposerPanel.Row>
    );
  };

  return (
    <ComposerPanel.Root>
      <ComposerPanel.Header
        icon={Sparkle}
        title={t('chat_host:model_panel.title')}
        subtitle={subtitle}
        onClose={onClose}
        closeAriaLabel={t('common:actions.cancel')}
      />

      <ComposerPanel.Search
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t('chat_host:model_panel.search_placeholder')}
        ariaLabel={t('chat_host:model_panel.search_placeholder')}
      />

      {!defaultModelId && !loading && (
        <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <div>{t('chat_host:model_panel.missing_default_hint')}</div>
          <NotionButton
            variant="ghost"
            size="sm"
            className="mt-2 h-7 px-2 text-xs"
            onClick={openModelSettings}
          >
            {t('chat_host:model_panel.go_config_model2')}
          </NotionButton>
        </div>
      )}

      <CustomScrollArea
        viewportClassName={cn('pr-2', isMobile ? 'h-full' : undefined)}
        className={isMobile ? 'flex-1 min-h-0' : undefined}
      >
        <div className="space-y-1 pb-2">
          {renderDefaultOption()}
          <div className="my-1 h-px bg-[color:var(--composer-panel-control-border)]" />
          {loading ? (
            <ComposerPanel.Loading label={t('common:loading')} />
          ) : hasModels ? (
            vendorGroups.map((group) => {
              const isCollapsed = collapsedVendors.has(group.vendorId);
              return (
                <ComposerPanel.Section
                  key={group.vendorId}
                  label={group.vendorName}
                  count={group.models.length}
                  collapsible
                  collapsed={isCollapsed}
                  onToggleCollapsed={() => toggleVendorCollapse(group.vendorId)}
                >
                  {group.models.map(renderModelOption)}
                </ComposerPanel.Section>
              );
            })
          ) : (
            <ComposerPanel.Empty
              icon={Sparkle}
              description={
                searchTerm
                  ? t('chat_host:model_panel.no_matches')
                  : t('chat_host:model_panel.empty')
              }
            />
          )}
        </div>
      </CustomScrollArea>

      {selectedModelId && selectedModelId !== defaultModelId && (
        <ComposerPanel.Footer divided>
          <NotionButton
            variant="ghost"
            size="sm"
            className="w-full justify-center gap-2 text-xs"
            onClick={handleSetAsDefault}
            disabled={savingDefault}
          >
            <PushPin size={14} />
            {savingDefault
              ? t('common:saving')
              : t('chat_host:model_panel.set_as_default')}
          </NotionButton>
        </ComposerPanel.Footer>
      )}
    </ComposerPanel.Root>
  );
};

export default ModelPanel;
