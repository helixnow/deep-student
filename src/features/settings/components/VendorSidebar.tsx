/**
 * VendorSidebar - 供应商列表侧边栏
 * 从 ApisTab 拆分，负责渲染供应商列表（含拖拽排序）
 * 
 * Phase 2 改进：
 * - 拖拽 handle 分离（DotsSixVertical 图标）
 * - 连接状态圆点（绿=已配置 / 灰=未配置）
 * - 加载 skeleton
 * - 推荐/自定义分组分隔线
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { DotsSixVertical, Plus } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { cn } from '@/lib/utils';
import { ProviderIcon, getProviderBadgeChromeStyle } from '@/components/ui/ProviderIcon';
import {
  settingsQuietIdleRowClassName,
  settingsQuietInteractiveRowClassName,
  settingsQuietSelectedRowClassName,
} from './SettingsCommon';
import { useVendorSettings } from './VendorSettingsContext';
import type { VendorConfig } from '@/types';

// --- Helpers ---

const hasConfiguredApiKey = (apiKey?: string | null): boolean => {
  const trimmed = apiKey?.trim() ?? '';
  return Boolean(trimmed);
};

const getVendorIconStyle = (vendor: VendorConfig): React.CSSProperties => {
  if (hasConfiguredApiKey(vendor.apiKey)) {
    return {};
  }
  return {
    filter: 'grayscale(1)',
    opacity: 0.46,
  };
};

const getVendorIconTone = (vendor: VendorConfig): 'color' | 'muted' => (
  hasConfiguredApiKey(vendor.apiKey) ? 'color' : 'muted'
);

const getVendorIconBadgeStyle = (vendor: VendorConfig): React.CSSProperties => {
  const modelId = vendor.providerType || vendor.name || '';
  return {
    ...getProviderBadgeChromeStyle(modelId),
    ...getVendorIconStyle(vendor),
    alignItems: 'center',
    borderRadius: 9999,
    boxSizing: 'border-box',
    display: 'inline-flex',
    flexShrink: 0,
    height: 20,
    justifyContent: 'center',
    padding: 2,
    width: 20,
  };
};

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

const getProviderDisplayName = (providerType?: string | null, t?: TranslateFn) => {
  if (!providerType) return 'OpenAI';
  const normalizedProviderType = providerType.toLowerCase();
  const map: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    siliconflow: 'SiliconFlow',
    deepseek: 'DeepSeek',
    ollama: 'Ollama',
    nvidia: 'NVIDIA',
    mimo: 'Xiaomi MiMo',
  };
  const fallback = map[normalizedProviderType] || providerType;
  return t?.(`settings:vendor_modal.providers.${normalizedProviderType}`, { defaultValue: fallback }) ?? fallback;
};

const getVendorDisplayName = (vendor: VendorConfig, providerLabel: string) => {
  if ((vendor.providerType ?? '').toLowerCase() === 'siliconflow') {
    return providerLabel;
  }
  return vendor.name || providerLabel;
};

// --- Skeleton Loading ---

const VendorSidebarSkeleton: React.FC = () => (
  <div className="flex flex-col gap-1">
    {[1, 2, 3].map(i => (
      <div key={i} className="flex items-center gap-2 px-3 py-2">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-4 flex-1" />
      </div>
    ))}
  </div>
);

// --- Component ---

export const VendorSidebar: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const {
    sortedVendors,
    selectedVendor,
    setSelectedVendorId,
    profileCountByVendor,
    vendorBusy,
    handleOpenVendorModal,
    onReorderVendors,
  } = useVendorSettings();

  // 乐观更新：本地维护拖拽顺序，避免等待持久化导致闪烁
  const [localOrder, setLocalOrder] = useState<VendorConfig[] | null>(null);
  const displayVendors = localOrder ?? sortedVendors;

  // 当外部 sortedVendors 变化时（非拖拽触发），同步清除本地覆盖
  useEffect(() => {
    setLocalOrder(null);
  }, [sortedVendors]);

  const handleDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const sourceIndex = result.source.index;
    const destIndex = result.destination.index;
    if (sourceIndex === destIndex) return;

    const reordered = [...displayVendors];
    const [removed] = reordered.splice(sourceIndex, 1);
    reordered.splice(destIndex, 0, removed);

    // 立即更新本地顺序（乐观）
    setLocalOrder(reordered);
    // 后台持久化
    onReorderVendors(reordered);
  }, [displayVendors, onReorderVendors]);

  // 渲染可拖拽供应商行（统一处理所有供应商）
  const renderVendorRow = (vendor: VendorConfig, provided: any, snapshot: any) => {
    const isActive = selectedVendor?.id === vendor.id;
    const modelCount = profileCountByVendor.get(vendor.id) ?? 0;
    const providerLabel = getProviderDisplayName(vendor.providerType, t);
    const vendorDisplayName = getVendorDisplayName(vendor, providerLabel);

    return (
      <div
        ref={provided.innerRef}
        {...provided.draggableProps}
        {...provided.dragHandleProps}
        style={provided.draggableProps.style}
        onClick={() => setSelectedVendorId(vendor.id)}
        className={cn(
          'px-3 py-2 text-left w-full flex items-center gap-2 cursor-grab active:cursor-grabbing group',
          isActive
            ? settingsQuietSelectedRowClassName
            : cn(settingsQuietInteractiveRowClassName, settingsQuietIdleRowClassName),
          snapshot.isDragging && 'shadow-lg ring-1 ring-border bg-card z-50'
        )}
      >
        <span
          data-testid={`vendor-icon-${vendor.id}`}
          data-icon-tone={getVendorIconTone(vendor)}
          data-icon-chrome="badge"
          className="inline-flex shrink-0 items-center justify-center transition-[filter,opacity,color,background-color,border-color] duration-150"
          style={getVendorIconBadgeStyle(vendor)}
        >
          <ProviderIcon
            modelId={vendor.providerType || vendor.name || ''}
            size={14}
            showTooltip={false}
            variant="color"
            renderMode="glyph"
          />
        </span>
        <div className="flex-1 min-w-0 text-left">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate">{vendorDisplayName}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {modelCount > 0 && (
                <span className="text-[10px] text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded-full">
                  {modelCount}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* 拖拽指示：hover 时显示，放最右边 */}
        <span className="shrink-0 text-muted-foreground/30 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <DotsSixVertical size={12} />
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-3 w-full min-w-0 pr-0 md:border-r md:border-border/40 md:pr-6 md:sticky md:top-4 md:self-start">
      <div className="w-full">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-foreground">
            {t('settings:vendor_panel.list_title')}
          </div>
          <NotionButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => handleOpenVendorModal(null)}
            title={t('settings:vendor_panel.add_vendor_button')}
            aria-label={t('settings:vendor_panel.add_vendor_button')}
          >
            <Plus className="h-3.5 w-3.5" />
          </NotionButton>
        </div>

        {/* 加载态 skeleton */}
        {vendorBusy && sortedVendors.length === 0 ? (
          <VendorSidebarSkeleton />
        ) : sortedVendors.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground bg-muted/10">
            <div>{t('settings:vendor_panel.empty_vendors')}</div>
            <div className="mt-1 text-xs">{t('settings:vendor_panel.empty_vendors_desc')}</div>
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable
              droppableId="vendor-list"
              renderClone={(provided, snapshot, rubric) => {
                const vendor = displayVendors[rubric.source.index];
                return renderVendorRow(vendor, provided, snapshot);
              }}
            >
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-0.5">
                  {displayVendors.map((vendor, index) => (
                    <Draggable key={vendor.id} draggableId={vendor.id} index={index}>
                      {(provided, snapshot) => renderVendorRow(vendor, provided, snapshot)}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>
    </div>
  );
};
