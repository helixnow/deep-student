/**
 * RuntimeModelSubmenuBody - 输入栏「推理/模型」菜单里的紧凑模型选择子菜单内容
 *
 * 交互（参考 OpenChamber ModelPickerList 的分区与星标逻辑，仅借鉴交互）：
 *   - 分区顺序：收藏 → 最近（去掉已收藏）→ 按供应商分组；收藏/最近的模型在供应商分组中仍会出现
 *   - 每行右侧星标：已收藏常显实心星；未收藏的空心星在悬停/聚焦行时出现（触屏常显）
 *   - 搜索时：仍保留「收藏」分区（按关键词过滤），隐藏「最近」；供应商分组里的收藏行照样显示实心星
 *   - 键盘：↑/↓/Home/End 在行间移动（AppMenu 内置），Enter/空格选择或勾选，聚焦行上按 F 切换收藏
 *   - 多选模式：子菜单内开关切换；开启后每行变为勾选项、点击不关闭菜单，已选模型以 chips 呈现
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, Star, X } from '@phosphor-icons/react';
import {
  AppMenuCheckboxItem,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuSwitchItem,
} from '@/components/ui/app-menu/AppMenu';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { cn } from '@/lib/utils';
import { coarseHitClassForBadge16 } from '@/components/ui/coarseHit';
import { useFavoriteChatModels } from '../../hooks/useFavoriteChatModels';

export interface RuntimeModelOption {
  id: string;
  label: string;
  providerLabel?: string;
  iconId?: string;
  providerId?: string;
  isRecent?: boolean;
  /** 最近选择中的名次（0 = 最近一次），用于「最近」分区按时间排序 */
  recentRank?: number;
}

export interface RuntimeModelMultiSelectConfig {
  /** 当前是否处于多选模式 */
  active: boolean;
  /** 已勾选的模型 id（顺序即勾选顺序） */
  selectedIds: readonly string[];
  onActiveChange: (active: boolean) => void;
  onToggle: (modelId: string) => void;
}

export interface RuntimeModelSubmenuBodyProps {
  options: RuntimeModelOption[];
  currentModelId?: string | null;
  onSelect?: (modelId: string) => void;
  /** 不提供时隐藏多选开关（feature flag 关闭 / 宿主不支持） */
  multiSelect?: RuntimeModelMultiSelectConfig;
  disabled?: boolean;
}

interface Section {
  key: string;
  label: string;
  models: RuntimeModelOption[];
}

export const RuntimeModelSubmenuBody: React.FC<RuntimeModelSubmenuBodyProps> = ({
  options,
  currentModelId,
  onSelect,
  multiSelect,
  disabled = false,
}) => {
  const { t } = useTranslation(['chatV2']);
  const { favoriteIds, toggleFavorite } = useFavoriteChatModels();
  const [search, setSearch] = useState('');
  const keyword = search.trim().toLowerCase();
  const multiActive = Boolean(multiSelect?.active);
  const selectedIdSet = useMemo(() => new Set(multiSelect?.selectedIds ?? []), [multiSelect?.selectedIds]);
  const otherProviderLabel = t('chatV2:inputBar.runtimeModelOtherProvider');

  const optionById = useMemo(() => new Map(options.map((option) => [option.id, option])), [options]);

  const sections = useMemo<Section[]>(() => {
    const filtered = keyword
      ? options.filter((model) => [model.label, model.providerLabel, model.id]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' ')
        .toLowerCase()
        .includes(keyword))
      : options;

    const result: Section[] = [];
    // 收藏：只取仍可用的模型（已删除/失效模型的收藏静默忽略），保持列表原有顺序（供应商顺序）
    const favorites = filtered.filter((model) => favoriteIds.has(model.id));
    if (favorites.length > 0) {
      result.push({
        key: '__favorites__',
        label: t('chatV2:modelPicker.favorites'),
        models: favorites,
      });
    }
    if (!keyword) {
      const recent = filtered
        .filter((model) => model.isRecent && !favoriteIds.has(model.id))
        .sort((a, b) => (a.recentRank ?? Number.MAX_SAFE_INTEGER) - (b.recentRank ?? Number.MAX_SAFE_INTEGER));
      if (recent.length > 0) {
        result.push({ key: '__recent__', label: t('chatV2:inputBar.runtimeModelRecent'), models: recent });
      }
    }
    const providerGroups = new Map<string, Section>();
    filtered.forEach((model) => {
      const providerLabel = model.providerLabel?.trim() || otherProviderLabel;
      const providerKey = `provider:${model.providerId?.trim() || providerLabel}`;
      const existing = providerGroups.get(providerKey);
      if (existing) existing.models.push(model);
      else providerGroups.set(providerKey, { key: providerKey, label: providerLabel, models: [model] });
    });
    result.push(...providerGroups.values());
    return result;
  }, [favoriteIds, keyword, options, otherProviderLabel, t]);

  const handleToggleFavorite = useCallback((modelId: string) => {
    void toggleFavorite(modelId).then((result) => {
      if (result === 'failed') {
        showGlobalNotification('error', t('chatV2:modelPicker.favoriteFailed'));
      }
    });
  }, [t, toggleFavorite]);

  const handleRowKeyDown = useCallback((event: React.KeyboardEvent, modelId: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      event.stopPropagation();
      handleToggleFavorite(modelId);
    }
  }, [handleToggleFavorite]);

  const renderRowLabel = (model: RuntimeModelOption) => (
    <span className="flex min-w-0 max-w-full flex-col gap-0.5 leading-tight">
      <span className="block min-w-0 max-w-full truncate text-xs font-medium text-foreground">
        {model.label}
      </span>
      {model.providerLabel && (
        <span className="block min-w-0 max-w-full truncate text-2xs text-muted-foreground">
          {model.providerLabel}
        </span>
      )}
    </span>
  );

  const renderRow = (model: RuntimeModelOption, sectionKey: string) => {
    const favorite = favoriteIds.has(model.id);
    const favoriteLabel = favorite
      ? t('chatV2:modelPicker.unfavorite')
      : t('chatV2:modelPicker.favorite');
    const icon = model.iconId ? (
      <ProviderIcon modelId={model.iconId} size={14} showTooltip={false} variant="mono" />
    ) : undefined;

    const row = multiActive ? (
      <AppMenuCheckboxItem
        checked={selectedIdSet.has(model.id)}
        disabled={disabled}
        onCheckedChange={() => multiSelect?.onToggle(model.id)}
        onKeyDown={(event) => handleRowKeyDown(event, model.id)}
        className="min-w-0 flex-1"
        data-model-id={model.id}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon && <span className="app-menu-item-icon">{icon}</span>}
          {renderRowLabel(model)}
        </span>
      </AppMenuCheckboxItem>
    ) : (
      <AppMenuItem
        icon={icon}
        checked={model.id === currentModelId}
        disabled={disabled}
        onClick={() => onSelect?.(model.id)}
        onKeyDown={(event) => handleRowKeyDown(event, model.id)}
        className="min-w-0 flex-1"
        data-model-id={model.id}
      >
        {renderRowLabel(model)}
      </AppMenuItem>
    );

    return (
      <div key={`${sectionKey}:${model.id}`} className="group/model-row flex min-w-0 items-center" role="none">
        {row}
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          tabIndex={-1}
          aria-label={`${favoriteLabel}: ${model.label}`}
          aria-pressed={favorite}
          title={`${favoriteLabel} (F)`}
          data-testid="runtime-model-favorite-toggle"
          onMouseDown={(event) => {
            // 保持焦点在当前行/搜索框，避免菜单焦点跳动
            event.preventDefault();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleToggleFavorite(model.id);
          }}
          className={cn(
            'ml-0.5 !h-6 !w-6 shrink-0 rounded-[var(--menu-shell-row-radius)] [&_svg]:!h-[13px] [&_svg]:!w-[13px]',
            favorite
              ? 'text-warning opacity-100'
              : 'text-[color:var(--menu-shell-muted-foreground)] opacity-0 group-hover/model-row:opacity-100 group-focus-within/model-row:opacity-100 focus-visible:opacity-100',
            // 触屏无 hover：星标常显，否则收藏入口不可达
            '[@media(pointer:coarse)]:opacity-100'
          )}
        >
          <Star size={13} weight={favorite ? 'fill' : 'regular'} />
        </DsButton>
      </div>
    );
  };

  const selectedModels = (multiSelect?.selectedIds ?? [])
    .map((id) => optionById.get(id) ?? { id, label: id })
    .filter((model): model is RuntimeModelOption => Boolean(model));

  return (
    <>
      <div className="app-menu-search">
        <MagnifyingGlass className="app-menu-search-icon" />
        <input
          type="search"
          // 📱 触控目标 + 16px 输入契约：.ds-search-input 的 coarse 规则挂在
          // enhanced-pdf.css（仅 PDF 视图加载），此处内联补齐防 iOS 聚焦缩放
          className="app-menu-search-input ds-search-input [@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!text-base"
          placeholder={t('chatV2:modelPicker.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>

      {multiSelect && (
        <>
          <AppMenuSwitchItem
            checked={multiActive}
            disabled={disabled}
            onCheckedChange={(next) => multiSelect.onActiveChange(next)}
            data-testid="runtime-model-multi-select-switch"
          >
            <span className="flex min-w-0 flex-col gap-0.5 leading-tight">
              <span className="block truncate text-xs font-medium text-foreground">
                {t('chatV2:inputBar.runtimeModelCompareMode')}
              </span>
              <span className="block truncate text-2xs text-muted-foreground">
                {multiActive
                  ? selectedModels.length > 0
                    ? t('chatV2:modelPicker.multiSelectCount', { count: selectedModels.length })
                    : t('chatV2:modelPicker.multiSelectEmpty')
                  : t('chatV2:modelPicker.compareToggleHint')}
              </span>
            </span>
          </AppMenuSwitchItem>
          {multiActive && selectedModels.length > 0 && (
            <div
              className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5"
              data-testid="runtime-model-selected-chips"
            >
              {selectedModels.map((model) => (
                <span
                  key={model.id}
                  className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-[color:var(--menu-shell-border)] bg-[color:var(--menu-shell-row-hover)] py-0.5 pl-2 pr-0.5 text-2xs text-[color:var(--menu-shell-foreground)]"
                >
                  <span className="min-w-0 truncate">{model.label}</span>
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    tabIndex={-1}
                    disabled={disabled}
                    aria-label={t('chatV2:modelPicker.removeSelected', { model: model.label })}
                    title={t('chatV2:modelPicker.removeSelected', { model: model.label })}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      multiSelect.onToggle(model.id);
                    }}
                    className={cn(
                      '!h-4 !w-4 shrink-0 rounded-full [&_svg]:!h-2.5 [&_svg]:!w-2.5',
                      // 16px 视觉保持 chip 紧凑；触屏用伪元素把命中区扩到 ≥44px
                      'relative [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0',
                      coarseHitClassForBadge16
                    )}
                  >
                    <X size={10} weight="bold" />
                  </DsButton>
                </span>
              ))}
            </div>
          )}
          <AppMenuSeparator />
        </>
      )}

      <CustomScrollArea
        fullHeight={false}
        className="max-h-[min(280px,calc(var(--app-menu-available-height,100vh)-140px))]"
        viewportClassName="max-h-[min(280px,calc(var(--app-menu-available-height,100vh)-140px))]"
      >
        {sections.length > 0 ? (
          sections.map((section) => (
            <AppMenuGroup
              key={section.key}
              label={section.label}
              className="app-menu-group--natural-case"
              data-section={section.key}
            >
              {section.models.map((model) => renderRow(model, section.key))}
            </AppMenuGroup>
          ))
        ) : (
          <AppMenuItem disabled>
            {t('chatV2:inputBar.runtimeModelNoResults')}
          </AppMenuItem>
        )}
      </CustomScrollArea>
    </>
  );
};

export default RuntimeModelSubmenuBody;
