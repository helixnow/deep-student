/**
 * Chat V2 - 多选模型面板
 *
 * 用于多变体并行执行时选择多个模型
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { X, Check, ArrowCounterClockwise, MagnifyingGlass, Star, PushPin, CaretDown, CaretRight } from '@phosphor-icons/react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Badge } from '@/components/ui/shad/Badge';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import DsAnalysisIconMuted from '@/components/icons/DsAnalysisIconMuted';
import { NotionButton } from '@/components/ui/NotionButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { ModelCapabilityIcons } from '@/components/shared/ModelCapabilityIcons';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ModelInfo } from '../../utils/parseModelMentions';
import type { ModelAssignments } from '@/types';

// ============================================================================
// 类型
// ============================================================================

/**
 * 模型配置接口（与后端 ApiConfig 对应）
 * 🔧 扩展：添加模型能力字段，便于前端根据模型能力显示不同 UI
 */
interface ModelConfig {
  id: string;
  name: string;
  model: string;
  /** 所属供应商 ID */
  vendorId?: string;
  /** 所属供应商名称 */
  vendorName?: string;
  isMultimodal?: boolean;
  /** 是否为推理模型（支持 thinking/reasoning） */
  isReasoning?: boolean;
  /** 是否支持工具调用 */
  supportsTools?: boolean;
  /** 是否启用 */
  enabled?: boolean;
  /** 是否为嵌入模型 */
  isEmbedding?: boolean;
  is_embedding?: boolean;
  /** 是否为重排序模型 */
  isReranker?: boolean;
  is_reranker?: boolean;
  /** 是否收藏 */
  isFavorite?: boolean;
  is_favorite?: boolean;
}

interface MultiSelectModelPanelProps {
  /** 已选中的模型列表 */
  selectedModels: ModelInfo[];
  /** 选中模型回调 */
  onSelectModel: (model: ModelInfo) => void;
  /** 取消选中模型回调 */
  onDeselectModel: (modelId: string) => void;
  /** 关闭面板回调 */
  onClose: () => void;
  /** 是否禁用（流式生成中） */
  disabled?: boolean;
  // ========== 重试模式支持 ==========
  /** 待重试的消息 ID（存在时进入重试模式） */
  retryMessageId?: string | null;
  /** 重试回调（重试模式下点击重试按钮时调用） */
  onRetry?: (modelIds: string[]) => void;
  /** 是否隐藏头部（移动端底部抽屉模式使用） */
  hideHeader?: boolean;
}

// ============================================================================
// 组件
// ============================================================================

export const MultiSelectModelPanel: React.FC<MultiSelectModelPanelProps> = ({
  selectedModels,
  onSelectModel,
  onDeselectModel,
  onClose,
  disabled = false,
  retryMessageId,
  onRetry,
  hideHeader = false,
}) => {
  // 是否处于重试模式
  const isRetryMode = Boolean(retryMessageId);
  const { t } = useTranslation(['chatV2', 'chat_host', 'common']);
  // 移动端自动隐藏头部（如果未显式指定）
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;
  const shouldHideHeader = hideHeader ?? mobileLayout?.isMobile ?? false;

  // 本地状态
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [vendorOrderMap, setVendorOrderMap] = useState<Map<string, number>>(new Map());
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [collapsedVendors, setCollapsedVendors] = useState<Set<string>>(new Set());

  // 已选中的模型 ID 集合
  const selectedIds = useMemo(
    () => new Set(selectedModels.map((m) => m.id)),
    [selectedModels]
  );

  // 加载模型列表和默认模型
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

      // 加载供应商配置以获取排序信息
      try {
        const vendorConfigs = await invoke<Array<{ id: string; providerType?: string; sortOrder?: number; name: string }>>('get_vendor_configs');
        const orderMap = new Map<string, number>();
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

      try {
        const assignments = await invoke<Record<string, string | null>>('get_model_assignments');
        setDefaultModelId(assignments?.['model2_config_id'] || null);
      } catch {
        setDefaultModelId(null);
      }
    } catch (error: unknown) {
      console.error('[MultiSelectModelPanel] Failed to load models:', error);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // 监听配置变更，及时刷新模型列表
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

  // 搜索过滤
  type NormalizedModel = ModelConfig & { searchable: string; isFavorite: boolean };
  const normalizedModels = useMemo(
    () =>
      models.map((m) => ({
        ...m,
        searchable: `${m.name ?? ''} ${m.model ?? ''} ${m.vendorName ?? ''}`.toLowerCase(),
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
      const aVendorOrder = a.vendorId ? (vendorOrderMap.get(a.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bVendorOrder = b.vendorId ? (vendorOrderMap.get(b.vendorId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (aVendorOrder !== bVendorOrder) return aVendorOrder - bVendorOrder;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [normalizedModels, searchTerm, vendorOrderMap]);

  // 按供应商分组
  const vendorGroups = useMemo(() => {
    const groups: { vendorId: string; vendorName: string; models: NormalizedModel[] }[] = [];
    const groupMap = new Map<string, NormalizedModel[]>();
    const orderList: { vendorId: string; vendorName: string }[] = [];
    for (const m of sortedAndFilteredModels) {
      const vid = m.vendorId || '__unknown__';
      const vname = m.vendorName || t('chat_host:model_panel.unknown_vendor');
      if (!groupMap.has(vid)) {
        groupMap.set(vid, []);
        orderList.push({ vendorId: vid, vendorName: vname });
      }
      groupMap.get(vid)!.push(m);
    }
    for (const { vendorId, vendorName } of orderList) {
      groups.push({ vendorId, vendorName, models: groupMap.get(vendorId)! });
    }
    return groups;
  }, [sortedAndFilteredModels, t]);

  // 搜索时自动展开所有分组
  useEffect(() => {
    if (searchTerm.trim()) {
      setCollapsedVendors(new Set());
    }
  }, [searchTerm]);

  const toggleVendorCollapse = useCallback((vendorId: string) => {
    setCollapsedVendors(prev => {
      const next = new Set(prev);
      if (next.has(vendorId)) next.delete(vendorId);
      else next.add(vendorId);
      return next;
    });
  }, []);

  // 切换选中状态
  const handleToggleModel = useCallback(
    (model: ModelConfig) => {
      if (disabled) return;

      const isSelected = selectedIds.has(model.id);
      if (isSelected) {
        onDeselectModel(model.id);
      } else {
        // 转换为 ModelInfo 格式
        const modelInfo: ModelInfo = {
          id: model.id,
          name: model.name,
          model: model.model,
        };
        onSelectModel(modelInfo);
      }
    },
    [disabled, selectedIds, onSelectModel, onDeselectModel]
  );

  const hasModels = sortedAndFilteredModels.length > 0;
  const systemBadge = t('chat_host:model_panel.badges.system_default');
  const systemBadgeTooltip = t('chat_host:model_panel.badges.system_default_tooltip');

  // 设为默认模型
  const handleSetAsDefault = useCallback(async (modelId: string) => {
    if (!modelId || modelId === defaultModelId) return;
    
    setSavingDefault(true);
    try {
      const currentAssignments = await invoke<ModelAssignments>('get_model_assignments');
      const newAssignments: ModelAssignments = {
        ...currentAssignments,
        model2_config_id: modelId,
      };
      await invoke<void>('save_model_assignments', { assignments: newAssignments });

      // 广播：模型分配已变更（用于刷新其他依赖组件）
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('model_assignments_changed'));
        }
      } catch (error: unknown) {
        void error;
      }

      setDefaultModelId(modelId);
      
      const modelName = models.find(m => m.id === modelId)?.name || modelId;
      showGlobalNotification(
        'success',
        t('chat_host:model_panel.set_default_success', { model: modelName })
      );
    } catch (error: unknown) {
      console.error('[MultiSelectModelPanel] Failed to set default model:', error);
      showGlobalNotification(
        'error',
        t('chat_host:model_panel.set_default_error')
      );
    } finally {
      setSavingDefault(false);
    }
  }, [defaultModelId, models, t]);

  // 渲染模型选项
  const renderModelOption = (option: ModelConfig & { searchable: string; isFavorite: boolean }) => {
    const isSelected = selectedIds.has(option.id);
    const isDefault = option.id === defaultModelId;
    const indicatorClass = cn(
      'flex shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold transition',
      isMobile ? 'h-[18px] w-[18px]' : 'h-5 w-5',
      isSelected
        ? 'border-primary bg-primary text-primary-foreground shadow-sm'
        : 'border-muted-foreground/30 text-transparent'
    );

    return (
      <div
        key={option.id}
        className={cn(
          'flex w-full items-start gap-2 rounded-lg border px-2 text-left transition group',
          isMobile ? 'py-1.5' : 'py-2',
          isSelected
            ? 'border-primary/60 bg-primary/5'
            : 'border-transparent bg-card/80',
          disabled && 'opacity-60'
        )}
      >
        <button
          type="button"
          onClick={() => handleToggleModel(option)}
          disabled={disabled}
          className={cn(indicatorClass, 'mt-0.5', disabled && 'cursor-not-allowed')}
        >
          {isSelected && <Check size={12} />}
        </button>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => handleToggleModel(option)}
          disabled={disabled}
          className={cn(
            'min-w-0 flex-1 !h-auto !flex-col !items-start !justify-start !gap-0.5 !whitespace-normal !px-0 !py-0 text-left',
            '!bg-transparent dark:!bg-transparent !hover:bg-transparent dark:!hover:bg-transparent !active:bg-transparent',
            '!text-inherit hover:!text-inherit dark:hover:!text-inherit active:!text-inherit',
            isMobile && '!gap-0',
            disabled && 'cursor-not-allowed'
          )}
        >
          <div className={cn('flex w-full min-w-0 items-center overflow-hidden', isMobile ? 'gap-1' : 'gap-1.5')}>
            <ProviderIcon
              modelId={option.model || option.name}
              size={14}
              showTooltip={false}
            />
            {option.isFavorite && (
              <Star size={12} className="text-warning fill-warning" />
            )}
            <ModelCapabilityIcons
              isMultimodal={option.isMultimodal}
              isReasoning={option.isReasoning}
              supportsTools={option.supportsTools}
              showTextOnly
              size="xs"
              className={isMobile ? 'gap-1' : undefined}
            />
            {isDefault && (
              <CommonTooltip content={systemBadgeTooltip} position="top">
                <Badge 
                  variant="outline" 
                  className="hidden h-4 px-1 py-0 text-[10px] font-medium shrink-0 border-primary/50 bg-primary/10 text-primary cursor-help sm:inline-flex"
                >
                  {systemBadge}
                </Badge>
              </CommonTooltip>
            )}
          </div>
          <div className={cn('w-full text-foreground break-all', isMobile ? 'text-[13px] leading-4' : 'text-xs leading-4')}>
            {option.model || option.name}
          </div>
        </NotionButton>
        {/* 设为默认按钮 - 仅对非默认模型显示，hover 时显示 */}
        {!isDefault && (
          <CommonTooltip content={t('chat_host:model_panel.set_as_default')} position="left">
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={(e) => {
                e.stopPropagation();
                handleSetAsDefault(option.id);
              }}
              disabled={disabled || savingDefault}
              className={cn(
                'mt-0.5 !h-6 !w-6 opacity-60',
                'text-muted-foreground !hover:bg-transparent !active:bg-transparent hover:!text-muted-foreground',
                (disabled || savingDefault) && 'cursor-not-allowed opacity-40'
              )}
              aria-label={t('chat_host:model_panel.set_as_default')}
            >
              <PushPin size={12} />
            </NotionButton>
          </CommonTooltip>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {/* 面板头部 - 移动端底部抽屉模式隐藏 */}
      {!shouldHideHeader && (
        <div className="space-y-2">
          {/* 标题行 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <div className="flex items-center gap-2 text-sm text-foreground flex-wrap">
                {isRetryMode ? (
                  <ArrowCounterClockwise size={16} className="shrink-0 text-primary" />
                ) : (
                  <DsAnalysisIconMuted className="h-4 w-4 shrink-0 text-primary" />
                )}
                <span className="whitespace-nowrap">
                  {isRetryMode
                    ? t('chatV2:modelRetry.dialogTitle')
                    : t('chatV2:modelMention.multiSelectTitle')}
                </span>
                {/* 提示文字（与标题同行，空间不足时换行） */}
                {selectedModels.length === 0 && (
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    · {isRetryMode
                      ? t('chatV2:modelRetry.hint')
                      : t('chatV2:modelMention.multiSelectHint')}
                  </span>
                )}
              </div>
              {selectedModels.length > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 py-0 text-[10px]">
                  {t('chatV2:modelMention.selectedCount', {
                    count: selectedModels.length,
                  })}
                </Badge>
              )}
              {selectedModels.length >= 2 && !isRetryMode && (
                <Badge
                  variant="default"
                  className="h-5 px-1.5 py-0 text-[10px] bg-primary/20 text-primary border-primary/30"
                >
                  {t('chatV2:modelMention.parallelMode')}
                </Badge>
              )}
            </div>
            {/* 右侧：图标按钮 */}
            <div className="flex items-center gap-1">
              {isRetryMode && onRetry && (
                <NotionButton
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const modelIds = selectedModels.map((m) => m.id);
                    onRetry(modelIds);
                  }}
                  disabled={disabled || selectedModels.length === 0}
                  title={t('chatV2:modelMention.retry')}
                >
                  <ArrowCounterClockwise size={14} />
                  {t('chatV2:modelRetry.retry')}
                </NotionButton>
              )}
              <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')} title={t('common:actions.cancel')}>
                <X size={16} />
              </NotionButton>
            </div>
          </div>

        </div>
      )}

      {/* 搜索框 */}
      <div className="relative">
        <MagnifyingGlass
          size={12}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('chat_host:model_panel.search_placeholder')}
          className="w-full pl-7 pr-2 text-xs"
          disabled={disabled}
        />
      </div>

      {/* 模型列表 - 可滚动区域 */}
      {/* 🔧 修复移动端滚动问题：使用固定高度而非 flex-1，确保 CustomScrollArea 有明确的高度约束 */}
      <div className={cn('h-[240px]', mobileLayout?.isMobile && 'h-[280px]')}>
        <CustomScrollArea
          className="h-full"
          viewportClassName="space-y-1 pr-1"
          trackOffsetTop={8}
          trackOffsetBottom={8}
        >
        <div className="space-y-0.5">
          {loading ? (
            <div className="px-2 py-4 text-sm text-muted-foreground text-center">
              {t('common:loading')}
            </div>
          ) : hasModels ? (
            vendorGroups.map((group) => {
              const isCollapsed = collapsedVendors.has(group.vendorId);
              const groupSelectedCount = group.models.filter(m => selectedIds.has(m.id)).length;
              return (
                <div key={group.vendorId}>
                  {/* 供应商分组头 */}
                  <button
                    type="button"
                    onClick={() => toggleVendorCollapse(group.vendorId)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      'hover:bg-[var(--interactive-hover)] active:bg-muted/80',
                      'select-none cursor-pointer'
                    )}
                  >
                    {isCollapsed ? (
                      <CaretRight size={14} className="shrink-0 text-muted-foreground" />
                    ) : (
                      <CaretDown size={14} className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="text-xs font-semibold text-muted-foreground truncate">
                      {group.vendorName}
                    </span>
                    <span className="text-[11px] text-muted-foreground/50 tabular-nums">
                      {group.models.length}
                    </span>
                    {groupSelectedCount > 0 && (
                      <Badge
                        variant="default"
                        className="ml-auto h-4 px-1 py-0 text-[9px] font-medium bg-primary/20 text-primary border-primary/30"
                      >
                        {groupSelectedCount}
                      </Badge>
                    )}
                  </button>
                  {/* 供应商下的模型列表 */}
                  {!isCollapsed && (
                    <div className="space-y-0.5 pl-1">
                      {group.models.map(renderModelOption)}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="px-2 py-4 text-sm text-muted-foreground text-center">
              {searchTerm
                ? t('chat_host:model_panel.no_matches')
                : t('chat_host:model_panel.empty')}
            </div>
          )}
        </div>
        </CustomScrollArea>
      </div>
    </div>
  );
};

export default MultiSelectModelPanel;
