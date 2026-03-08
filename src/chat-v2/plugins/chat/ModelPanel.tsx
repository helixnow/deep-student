/**
 * Chat V2 - 模型选择面板
 *
 * 复用原实现的 UI/UX，适配 V2 Store 架构
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { X, Star, Pin } from 'lucide-react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import DsAnalysisIconMuted from '@/components/icons/DsAnalysisIconMuted';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import type { ChatStore } from '../../core/types';
import type { ModelAssignments } from '@/types';

// ============================================================================
// 类型
// ============================================================================

interface ModelConfig {
  id: string;
  name: string;
  model: string;
  /** 所属供应商 ID */
  vendorId?: string;
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
}

// ============================================================================
// 组件
// ============================================================================

export const ModelPanel: React.FC<ModelPanelProps> = ({ store, onClose }) => {
  const { t } = useTranslation(['chat_host', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 从 Store 获取状态
  // 🚀 P0-2 性能优化：仅订阅实际使用的字段，避免其他 chatParams 字段变化时重渲染
  const selectedModelId = useStore(store, (s) => s.chatParams.model2OverrideId);

  // 本地状态
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [vendorOrderMap, setVendorOrderMap] = useState<Map<string, number>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);

  // 加载模型列表
  const isInitialLoad = useRef(true);
  const loadModels = useCallback(async () => {
    try {
      // 仅首次加载时显示 loading 状态，事件触发的刷新静默更新
      if (isInitialLoad.current) {
        setLoading(true);
        isInitialLoad.current = false;
      }
      // 尝试加载模型配置
      const configs = await invoke<ModelConfig[]>('get_api_configurations');
      // 过滤掉嵌入模型、重排序模型和未启用的模型（供应商没有 API Key 的模型 enabled=false）
      const chatModels = (configs || []).filter((c) => {
        const isEmbedding = c.isEmbedding === true || c.is_embedding === true;
        const isReranker = c.isReranker === true || c.is_reranker === true;
        const isEnabled = c.enabled !== false;
        return !isEmbedding && !isReranker && isEnabled;
      });
      setModels(chatModels);

      // 加载供应商配置以获取排序信息
      try {
        const vendorConfigs = await invoke<VendorConfigSlim[]>('get_vendor_configs');
        const orderMap = new Map<string, number>();
        // 与设置页面排序逻辑一致：SiliconFlow 置顶 → sortOrder → name
        const sorted = [...(vendorConfigs || [])].sort((a, b) => {
          const aSilicon = (a.providerType ?? '').toLowerCase() === 'siliconflow';
          const bSilicon = (b.providerType ?? '').toLowerCase() === 'siliconflow';
          if (aSilicon !== bSilicon) return aSilicon ? -1 : 1;
          const aOrder = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
          const bOrder = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.name.localeCompare(b.name);
        });
        sorted.forEach((v, i) => orderMap.set(v.id, i));
        setVendorOrderMap(orderMap);
      } catch {
        setVendorOrderMap(new Map());
      }

      // 尝试获取默认模型
      // 🔧 修复：使用正确的字段名 model2_config_id 而非 analysis
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

  // 初次加载
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // 监听配置变更，及时刷新模型列表
  useEffect(() => {
    const reload = () => { void loadModels(); };
    try {
      window.addEventListener('api_configurations_changed', reload as EventListener);
      window.addEventListener('model_assignments_changed', reload as EventListener);
    } catch {}
    return () => {
      try {
        window.removeEventListener('api_configurations_changed', reload as EventListener);
        window.removeEventListener('model_assignments_changed', reload as EventListener);
      } catch {}
    };
  }, [loadModels]);

  // 搜索过滤
  const normalizedModels = useMemo(
    () =>
      models.map((m) => ({
        ...m,
        searchable: `${m.name ?? ''} ${m.model ?? ''}`.toLowerCase(),
        isFavorite: m.isFavorite === true || m.is_favorite === true,
      })),
    [models]
  );

  const sortedAndFilteredModels = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const filtered = keyword
      ? normalizedModels.filter((m) => m.searchable.includes(keyword))
      : normalizedModels;
    return [...filtered].sort((a, b) => {
      // 按供应商顺序排序（与设置页面一致）
      const aVendorOrder = a.vendorId ? (vendorOrderMap.get(a.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bVendorOrder = b.vendorId ? (vendorOrderMap.get(b.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aVendorOrder !== bVendorOrder) return aVendorOrder - bVendorOrder;
      // 同一供应商内，收藏优先
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [normalizedModels, searchTerm, vendorOrderMap]);

  // 默认模型名称
  const defaultModelName = useMemo(() => {
    if (!defaultModelId) return null;
    const target = models.find((m) => m.id === defaultModelId);
    return target?.name ?? null;
  }, [defaultModelId, models]);

  // 选择模型
  const handleSelectModel = useCallback(
    (modelId: string | null) => {
      store.getState().setChatParams({ model2OverrideId: modelId });
    },
    [store]
  );

  // 设为默认模型
  const handleSetAsDefault = useCallback(async () => {
    if (!selectedModelId || selectedModelId === defaultModelId) return;
    
    setSavingDefault(true);
    try {
      // 获取当前的模型分配
      const currentAssignments = await invoke<ModelAssignments>('get_model_assignments');
      
      // 更新对话模型配置
      const newAssignments: ModelAssignments = {
        ...currentAssignments,
        model2_config_id: selectedModelId,
      };
      
      // 保存模型分配
      await invoke<void>('save_model_assignments', { assignments: newAssignments });

      // 广播：模型分配已变更（用于刷新其他依赖组件）
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('model_assignments_changed'));
        }
      } catch (error: unknown) {
        void error;
      }
      
      // 更新本地状态
      setDefaultModelId(selectedModelId);
      
      // 清除临时覆盖（因为已经设为默认了）
      store.getState().setChatParams({ model2OverrideId: null });
      
      // 显示成功通知
      const modelName = models.find(m => m.id === selectedModelId)?.name || selectedModelId;
      showGlobalNotification(
        'success',
        t('chat_host:model_panel.set_default_success', { model: modelName })
      );
    } catch (error: unknown) {
      console.error('[ModelPanel] Failed to set default model:', error);
      showGlobalNotification(
        'error',
        t('chat_host:model_panel.set_default_error')
      );
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

  const multBadge = t('chat_host:advanced.model.tag_multimodal');
  const textBadge = t('chat_host:advanced.model.tag_text');
  const systemBadge = t('chat_host:model_panel.badges.system_default');
  const systemBadgeTooltip = t('chat_host:model_panel.badges.system_default_tooltip');

  // 渲染默认选项
  const renderDefaultOption = () => {
    const isSelected = selectedValue === 'system-default';
    const indicatorClass = cn(
      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition',
      isSelected ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border text-muted-foreground'
    );
    return (
      <NotionButton
        key="system-default"
        variant="ghost"
        size="sm"
        onClick={() => handleSelectModel(null)}
        className={cn(
          'w-full !justify-start gap-3 !rounded-xl border !px-3 !py-2 text-left',
          isSelected
            ? 'border-primary/80 bg-primary/5 shadow-sm'
            : 'border-transparent bg-card/80 hover:border hover:bg-muted/70'
        )}
      >
        <span className={indicatorClass}>{isSelected ? '✓' : ''}</span>
        <div className="min-w-0 flex-1 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">{followSystemLabel}</span>
          <span className="text-xs text-muted-foreground shrink-0">{followSystemHint}</span>
        </div>
      </NotionButton>
    );
  };

  // 渲染模型选项
  const renderModelOption = (option: ModelConfig & { searchable: string; isFavorite: boolean }) => {
    const isSelected = selectedValue === option.id;
    const indicatorClass = cn(
      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition',
      isSelected ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border text-muted-foreground'
    );
    return (
      <NotionButton
        key={option.id}
        variant="ghost"
        size="sm"
        onClick={() => handleSelectModel(option.id)}
        className={cn(
          'w-full !justify-start gap-3 !rounded-xl border !px-3 !py-2 text-left',
          isSelected
            ? 'border-primary/80 bg-primary/5 shadow-sm'
            : 'border-transparent bg-card/80 hover:border hover:bg-muted/70'
        )}
      >
        <span className={indicatorClass}>{isSelected ? '✓' : ''}</span>
        <ProviderIcon modelId={option.model || option.name} size={20} showTooltip={false} />
        {option.isFavorite && (
          <Star size={14} className="text-warning fill-warning shrink-0" />
        )}
        <div className="min-w-0 flex-1 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span>{option.name}</span>
            {option.id === defaultModelId && (
              <CommonTooltip content={systemBadgeTooltip} position="top">
                <Badge 
                  variant="outline" 
                  className="h-5 px-1.5 py-0 text-[10px] font-normal shrink-0 border-primary/50 bg-primary/10 text-primary cursor-help"
                >
                  {systemBadge}
                </Badge>
              </CommonTooltip>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            <span className="max-w-[200px] truncate">{option.model}</span>
            <Badge variant="secondary" className="h-5 px-1.5 py-0 text-[10px] font-medium shrink-0">
              {option.isMultimodal ? multBadge : textBadge}
            </Badge>
          </div>
        </div>
      </NotionButton>
    );
  };

  return (
    <div className="space-y-3">
      {/* 面板头部 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <DsAnalysisIconMuted className="h-4 w-4 shrink-0" />
            <span>{t('chat_host:model_panel.title')}</span>
          </div>
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </div>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')}>
          <X size={16} />
        </NotionButton>
      </div>

      {/* 搜索框 */}
      <Input
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder={t('chat_host:model_panel.search_placeholder')}
        className="h-8 text-sm"
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

      {/* 模型列表 */}
      <CustomScrollArea viewportClassName={cn('pr-2', isMobile ? 'h-full' : 'max-h-[150px]')} className={isMobile ? 'flex-1 min-h-0' : undefined}>
        <div className="space-y-2 pb-2">
          {renderDefaultOption()}
          <div className="h-px bg-border/70" />
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('common:loading')}
            </div>
          ) : hasModels ? (
            sortedAndFilteredModels.map(renderModelOption)
          ) : (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {searchTerm
                ? t('chat_host:model_panel.no_matches')
                : t('chat_host:model_panel.empty')}
            </div>
          )}
        </div>
      </CustomScrollArea>

      {/* 设为默认按钮 - 仅当选择了非默认模型时显示 */}
      {selectedModelId && selectedModelId !== defaultModelId && (
        <div className="pt-2 border-t border-border/50">
          <NotionButton
            variant="ghost"
            size="sm"
            className="w-full justify-center gap-2 text-xs"
            onClick={handleSetAsDefault}
            disabled={savingDefault}
          >
            <Pin size={14} />
            {savingDefault 
              ? t('common:saving') 
              : t('chat_host:model_panel.set_as_default')}
          </NotionButton>
        </div>
      )}
    </div>
  );
};

export default ModelPanel;
