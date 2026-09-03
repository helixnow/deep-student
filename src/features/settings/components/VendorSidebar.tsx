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
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useTouchFriendlyDndSensors, SHELL_SAFE_AUTO_SCROLL } from '@/hooks/useTouchFriendlyDndSensors';
import { CaretRight, DotsSixVertical, Plus } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
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
import { isVendorConfiguredForSidebar } from '@/utils/vendorAuth';

// --- Helpers ---

const getVendorIconStyle = (
  vendor: VendorConfig,
  openAICodexAuthenticated: boolean,
): React.CSSProperties => {
  if (isVendorConfiguredForSidebar(vendor, openAICodexAuthenticated)) {
    return {};
  }
  return {
    filter: 'grayscale(1)',
    opacity: 0.46,
  };
};

const getVendorIconTone = (
  vendor: VendorConfig,
  openAICodexAuthenticated: boolean,
): 'color' | 'muted' => (
  isVendorConfiguredForSidebar(vendor, openAICodexAuthenticated) ? 'color' : 'muted'
);

const getVendorIconBadgeStyle = (
  vendor: VendorConfig,
  openAICodexAuthenticated: boolean,
): React.CSSProperties => {
  const modelId = vendor.providerType || vendor.name || '';
  return {
    ...getProviderBadgeChromeStyle(modelId),
    ...getVendorIconStyle(vendor, openAICodexAuthenticated),
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
    openai_codex: 'OpenAI Codex',
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

// --- Sortable Row ---

interface SortableVendorRowProps {
  vendor: VendorConfig;
  isActive: boolean;
  modelCount: number;
  vendorDisplayName: string;
  isSmallScreen: boolean;
  openAICodexAuthenticated: boolean;
  onSelect: () => void;
}

/** 可拖拽供应商行：整行既是点击目标也是拖拽 handle（与迁移前 hello-pangea 行为一致） */
const SortableVendorRow: React.FC<SortableVendorRowProps> = ({
  vendor,
  isActive,
  modelCount,
  vendorDisplayName,
  isSmallScreen,
  openAICodexAuthenticated,
  onSelect,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: vendor.id,
    // P1-8 触屏禁拖：整行拖拽在触屏上与滚动/点按冲突，小屏直接关闭拖拽排序
    disabled: isSmallScreen,
  });

  // P2-9 键盘激活：桌面端 Space/方向键被 dnd 拖拽占用（先转发给 dnd 监听器），仅补 Enter；
  // 移动端拖拽关闭（无 attributes/listeners，需补 role/tabIndex），Enter/Space 都可激活
  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || (isSmallScreen && e.key === ' ')) {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...(isSmallScreen
        ? { role: 'button' as const, tabIndex: 0, onKeyDown: onRowKeyDown }
        : {
            ...attributes,
            ...listeners,
            onKeyDown: (e: React.KeyboardEvent) => {
              (listeners?.onKeyDown as ((ev: React.KeyboardEvent) => void) | undefined)?.(e);
              onRowKeyDown(e);
            },
          })}
      onClick={onSelect}
      className={cn(
        'px-3 py-2 text-left w-full flex items-center gap-2 group',
        // P1-8 触屏禁拖：小屏不显示抓取光标（拖拽已通过 disabled 关闭）
        isSmallScreen ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        isActive
          ? settingsQuietSelectedRowClassName
          : cn(settingsQuietInteractiveRowClassName, settingsQuietIdleRowClassName),
        // 侧栏统一契约：行圆角/高度/字号对齐对话标准（desktop-shell-nav-row 配方）
        // P1-8 触控目标：小屏行高提升到 44px、字号同步放大到 16px（可读性）；触屏平板按 coarse pointer 兜底
        isSmallScreen ? 'min-h-11 text-base' : 'min-h-[32px] text-sm [@media(pointer:coarse)]:min-h-11',
        'rounded-[var(--shell-nav-row-radius,14px)]',
        isDragging && 'relative shadow-lg ring-1 ring-border bg-card z-50'
      )}
    >
      <span
        data-testid={`vendor-icon-${vendor.id}`}
        data-icon-tone={getVendorIconTone(vendor, openAICodexAuthenticated)}
        data-icon-chrome="badge"
        className="inline-flex shrink-0 items-center justify-center transition-[filter,opacity,color,background-color,border-color] duration-150"
        style={getVendorIconBadgeStyle(vendor, openAICodexAuthenticated)}
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
              <span className="text-2xs text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded-full">
                {modelCount}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* 移动端：chevron 暗示可进入详情；桌面端：hover 显示拖拽指示 */}
      {isSmallScreen ? (
        <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
          <CaretRight size={14} />
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground/30 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-150">
          <DotsSixVertical size={12} />
        </span>
      )}
    </div>
  );
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
    openAICodexAuthenticated = false,
    vendorBusy,
    handleOpenVendorModal,
    onReorderVendors,
    isSmallScreen,
    openMobileVendorDetail,
  } = useVendorSettings();

  // 乐观更新：本地维护拖拽顺序，避免等待持久化导致闪烁
  const [localOrder, setLocalOrder] = useState<VendorConfig[] | null>(null);
  const displayVendors = localOrder ?? sortedVendors;

  // 当外部 sortedVendors 变化时（非拖拽触发），同步清除本地覆盖
  useEffect(() => {
    setLocalOrder(null);
  }, [sortedVendors]);

  // DND-1 统一传感器：鼠标 8px 起拖（保留行点击）、触屏长按、键盘可访问排序
  const sensors = useTouchFriendlyDndSensors();

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const sourceIndex = displayVendors.findIndex((vendor) => vendor.id === active.id);
    const destIndex = displayVendors.findIndex((vendor) => vendor.id === over.id);
    if (sourceIndex < 0 || destIndex < 0 || sourceIndex === destIndex) return;

    const reordered = arrayMove(displayVendors, sourceIndex, destIndex);

    // 立即更新本地顺序（乐观）
    setLocalOrder(reordered);
    // 后台持久化
    onReorderVendors(reordered);
  }, [displayVendors, onReorderVendors]);

  const handleSelectVendor = useCallback((vendorId: string) => {
    setSelectedVendorId(vendorId);
    // P1-6 移动端两级导航：点击行即进入供应商详情屏
    if (isSmallScreen) openMobileVendorDetail?.();
  }, [isSmallScreen, openMobileVendorDetail, setSelectedVendorId]);

  return (
    <div className="space-y-3 w-full min-w-0 pr-0 md:border-r md:border-border/40 md:pr-6 md:sticky md:top-4 md:self-start">
      <div className="w-full">
        {/* 移动端：标题与新建按钮已收进统一顶栏（Settings.tsx rightActions），页内不再重复 */}
        {!isSmallScreen && (
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">
              {t('settings:vendor_panel.list_title')}
            </div>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={() => handleOpenVendorModal(null)}
              title={t('settings:vendor_panel.add_vendor_button')}
              aria-label={t('settings:vendor_panel.add_vendor_button')}
            >
              <Plus className="h-3.5 w-3.5" />
            </DsButton>
          </div>
        )}

        {/* 加载态 skeleton */}
        {vendorBusy && sortedVendors.length === 0 ? (
          <VendorSidebarSkeleton />
        ) : sortedVendors.length === 0 ? (
          <div className="rounded-2xl bg-muted p-4 text-sm text-muted-foreground">
            <div>{t('settings:vendor_panel.empty_vendors')}</div>
            <div className="mt-1 text-xs">{t('settings:vendor_panel.empty_vendors_desc')}</div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            autoScroll={SHELL_SAFE_AUTO_SCROLL}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={displayVendors.map((vendor) => vendor.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-0.5 rounded-2xl bg-muted p-1.5">
                {displayVendors.map((vendor) => {
                  const providerLabel = getProviderDisplayName(vendor.providerType, t);
                  return (
                    <SortableVendorRow
                      key={vendor.id}
                      vendor={vendor}
                      isActive={selectedVendor?.id === vendor.id}
                      modelCount={profileCountByVendor.get(vendor.id) ?? 0}
                      vendorDisplayName={getVendorDisplayName(vendor, providerLabel)}
                      isSmallScreen={isSmallScreen}
                      openAICodexAuthenticated={openAICodexAuthenticated}
                      onSelect={() => handleSelectVendor(vendor.id)}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
};
