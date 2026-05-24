/**
 * Chat V2 - SkillSelector 组件
 *
 * 技能选择面板，支持搜索和激活技能。
 * 视觉骨架统一走 ComposerPanel.* primitives，列表行选中态走 --button-primary-* 强调色。
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, ArrowClockwise, Check, User, Wrench, Star, CaretLeft } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { ComposerPanel } from '@/features/chat/components/input-bar/ComposerPanel';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import { useLoadedSkills } from '../hooks/useLoadedSkills';
import { useSkillFavorites } from '../hooks/useSkillFavorites';
import { useSkillDefaults } from '../hooks/useSkillDefaults';
import {
  getLocalizedSkillDescription,
  getLocalizedSkillName,
  getLocationLabel,
  getLocationStyle,
} from '../utils';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillSelectorProps {
  /** 当前激活的技能 ID 列表（支持多选） */
  activeSkillIds: string[];
  /** 激活/取消激活技能回调（切换模式） */
  onToggleSkill: (skillId: string) => void;
  /** 关闭面板回调 */
  onClose?: () => void;
  /** 刷新技能列表回调 */
  onRefresh?: () => Promise<void>;
  /** 是否禁用操作 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 会话 ID（用于显示工具调用加载的技能状态） */
  sessionId?: string | null;
}

// ============================================================================
// 组件
// ============================================================================

export const SkillSelector: React.FC<SkillSelectorProps> = ({
  activeSkillIds,
  onToggleSkill,
  onClose,
  onRefresh,
  disabled = false,
  className,
  sessionId,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  const { isSkillLoaded } = useLoadedSkills(sessionId ?? null);
  const { isFavorite, toggleFavorite } = useSkillFavorites();
  const { defaultIds, isDefault, toggleDefault } = useSkillDefaults();

  const [searchTerm, setSearchTerm] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const allSkills = useMemo(() => {
    return skillRegistry.getAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  const filteredSkills = useMemo(() => {
    let result = allSkills;

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (skill) =>
          getLocalizedSkillName(skill.id, skill.name, t).toLowerCase().includes(term) ||
          getLocalizedSkillDescription(skill.id, skill.description, t).toLowerCase().includes(term) ||
          skill.id.toLowerCase().includes(term)
      );
    }

    const favoriteSet = new Set(result.filter((s) => isFavorite(s.id)).map((s) => s.id));
    const defaultSet = new Set(defaultIds);

    return [...result].sort((a, b) => {
      const aFav = favoriteSet.has(a.id) ? 0 : 1;
      const bFav = favoriteSet.has(b.id) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      const aDefault = defaultSet.has(a.id) ? 0 : 1;
      const bDefault = defaultSet.has(b.id) ? 0 : 1;
      return aDefault - bDefault;
    });
  }, [allSkills, searchTerm, isFavorite, defaultIds, t]);

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return filteredSkills.find((s) => s.id === selectedSkillId) || null;
  }, [selectedSkillId, filteredSkills]);

  const selectedSkillToolCount = useMemo(() => {
    if (!selectedSkill) return 0;
    if ((selectedSkill.embeddedTools?.length ?? 0) > 0) return selectedSkill.embeddedTools!.length;
    return (selectedSkill.allowedTools ?? selectedSkill.tools)?.length ?? 0;
  }, [selectedSkill]);

  const handleSelect = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
  }, []);

  const handleToggleActivate = useCallback(
    (skillId: string) => {
      if (disabled) return;
      onToggleSkill(skillId);
    },
    [disabled, onToggleSkill]
  );

  const isSkillActive = useCallback(
    (skillId: string) => activeSkillIds.includes(skillId),
    [activeSkillIds]
  );

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, isRefreshing]);

  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  const headerActions = onRefresh ? (
    <NotionButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={handleRefresh}
      disabled={isRefreshing}
      aria-label={t('skills:selector.refresh')}
      title={t('skills:selector.refresh')}
      className={cn(isRefreshing && 'animate-spin')}
    >
      <ArrowClockwise size={16} />
    </NotionButton>
  ) : null;

  return (
    <ComposerPanel.Root fillHeight className={cn('overflow-hidden', className)}>
      {!isMobile && (
        <ComposerPanel.Header
          icon={Lightning}
          title={t('skills:selector.title')}
          subtitle={t('skills:selector.count', { count: allSkills.length, defaultValue: '{{count}} 项' })}
          actions={headerActions}
          onClose={onClose}
          closeAriaLabel={t('common:actions.close')}
        />
      )}

      <ComposerPanel.Search
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t('skills:selector.searchPlaceholder')}
        ariaLabel={t('skills:selector.searchPlaceholder')}
      />

      {/* 分栏布局：左侧技能列表 + 右侧详情面板 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {/* 左侧：技能列表 */}
        <CustomScrollArea
          className={cn(
            'h-full',
            isMobile ? (selectedSkillId ? 'hidden' : 'w-full') : 'w-1/2'
          )}
          viewportClassName="space-y-1 pr-1"
        >
          {filteredSkills.length === 0 ? (
            <ComposerPanel.Empty
              icon={Lightning}
              description={searchTerm ? t('skills:selector.noResults') : t('skills:selector.empty')}
            />
          ) : (
            <div className="space-y-1">
              {filteredSkills.map((skill) => {
                const isSelected = skill.id === selectedSkillId;
                const isActiveSkill = isSkillActive(skill.id);
                const isToolLoaded = isSkillLoaded(skill.id);
                const isDefaultSkill = isDefault(skill.id);
                const skillName = getLocalizedSkillName(skill.id, skill.name, t);

                return (
                  <ComposerPanel.Row
                    key={skill.id}
                    selected={isSelected}
                    selectedAccent="tinted"
                    onClick={() => handleSelect(skill.id)}
                    aria-label={skillName}
                    leading={
                      !isActiveSkill && isToolLoaded ? (
                        <span
                          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center text-amber-500"
                          title={t('skills:status.toolLoaded')}
                          aria-hidden="true"
                        >
                          <Lightning size={14} />
                        </span>
                      ) : (
                        // eslint-disable-next-line ds-components/no-native-button -- 此处需精确控制 --button-primary-* token 的 16px 方块复选框，NotionButton 的 size/variant 体系不适配
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!disabled) handleToggleActivate(skill.id);
                          }}
                          disabled={disabled}
                          aria-pressed={isActiveSkill}
                          aria-label={
                            isActiveSkill
                              ? t('skills:card.clickToDeactivate')
                              : t('skills:card.clickToActivate')
                          }
                          title={
                            isActiveSkill
                              ? t('skills:card.clickToDeactivate')
                              : t('skills:card.clickToActivate')
                          }
                          className={cn(
                            'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold transition-colors',
                            isActiveSkill
                              ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]'
                              : 'border-[color:var(--composer-panel-control-border)] text-transparent hover:border-[color:var(--button-primary-border)]',
                            disabled && 'cursor-not-allowed opacity-60'
                          )}
                        >
                          {isActiveSkill ? <Check size={12} weight="bold" /> : null}
                        </button>
                      )
                    }
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(skill.id);
                          }}
                          aria-label={
                            isFavorite(skill.id)
                              ? t('skills:favorite.remove')
                              : t('skills:favorite.add')
                          }
                          title={
                            isFavorite(skill.id)
                              ? t('skills:favorite.remove')
                              : t('skills:favorite.add')
                          }
                          className={cn(
                            '!h-5 !w-5',
                            isFavorite(skill.id)
                              ? 'text-amber-500 hover:text-amber-600'
                              : 'text-[color:var(--composer-panel-muted-foreground)] opacity-60 hover:text-amber-500 hover:opacity-100'
                          )}
                        >
                          <Star size={12} weight={isFavorite(skill.id) ? 'fill' : 'regular'} />
                        </NotionButton>
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            getLocationStyle(skill.location)
                          )}
                        >
                          {getLocationLabel(skill.location, t)}
                        </span>
                      </span>
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          isToolLoaded && 'text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {skillName}
                      </span>
                      {isDefaultSkill ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                          title={t('skills:default.isDefault')}
                        >
                          <Check size={9} />
                          {t('skills:default.label')}
                        </span>
                      ) : null}
                    </span>
                  </ComposerPanel.Row>
                );
              })}
            </div>
          )}
        </CustomScrollArea>

        {/* 右侧：技能详情面板 */}
        <div
          className={cn(
            'flex h-full flex-col',
            isMobile ? (selectedSkillId ? 'w-full' : 'hidden') : 'w-1/2 border-l border-[color:var(--composer-panel-control-border)] pl-3'
          )}
        >
          {selectedSkill ? (
            <>
              {isMobile && (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedSkillId(null)}
                  className="mb-2 shrink-0"
                >
                  <CaretLeft size={14} />
                  <span>{t('common:actions.back')}</span>
                </NotionButton>
              )}
              <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pr-1">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="truncate text-base font-medium text-[color:var(--composer-panel-foreground)]">
                        {getLocalizedSkillName(selectedSkill.id, selectedSkill.name, t)}
                      </h3>
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={() => toggleFavorite(selectedSkill.id)}
                        className={cn(
                          '!h-6 !w-6',
                          isFavorite(selectedSkill.id)
                            ? 'text-amber-500 hover:text-amber-600'
                            : 'text-[color:var(--composer-panel-muted-foreground)] opacity-60 hover:text-amber-500 hover:opacity-100'
                        )}
                        aria-label={
                          isFavorite(selectedSkill.id)
                            ? t('skills:favorite.remove')
                            : t('skills:favorite.add')
                        }
                        title={
                          isFavorite(selectedSkill.id)
                            ? t('skills:favorite.remove')
                            : t('skills:favorite.add')
                        }
                      >
                        <Star size={14} weight={isFavorite(selectedSkill.id) ? 'fill' : 'regular'} />
                      </NotionButton>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      {selectedSkill.version ? (
                        <span className="text-xs text-[color:var(--composer-panel-muted-foreground)]">
                          v{selectedSkill.version}
                        </span>
                      ) : null}
                      {isDefault(selectedSkill.id) ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                          <Check size={9} />
                          {t('skills:default.isDefault')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      getLocationStyle(selectedSkill.location)
                    )}
                  >
                    {getLocationLabel(selectedSkill.location, t)}
                  </span>
                </div>

                <p className="mb-3 text-xs text-[color:var(--composer-panel-muted-foreground)]">
                  {getLocalizedSkillDescription(selectedSkill.id, selectedSkill.description, t)}
                </p>

                {(selectedSkillToolCount > 0 || selectedSkill.author) && (
                  <div className="mb-3 flex items-center gap-3 text-xs text-[color:var(--composer-panel-muted-foreground)]">
                    {selectedSkillToolCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Wrench size={12} />
                        {t('skills:card.toolsCount', { count: selectedSkillToolCount })}
                      </span>
                    )}
                    {selectedSkill.author && (
                      <span className="flex items-center gap-1">
                        <User size={12} />
                        <span className="max-w-[100px] truncate">{selectedSkill.author}</span>
                      </span>
                    )}
                  </div>
                )}
              </CustomScrollArea>

              <ComposerPanel.Footer divided className="!justify-stretch flex-col gap-2">
                <NotionButton
                  variant={isDefault(selectedSkill.id) ? 'success' : 'default'}
                  size="md"
                  onClick={() => toggleDefault(selectedSkill.id)}
                  className="w-full"
                >
                  <Check
                    size={14}
                    className={cn(
                      'transition-opacity',
                      !isDefault(selectedSkill.id) && 'opacity-50'
                    )}
                  />
                  <span>
                    {isDefault(selectedSkill.id)
                      ? t('skills:default.removeDefault')
                      : t('skills:default.setDefault')}
                  </span>
                </NotionButton>

                {isSkillLoaded(selectedSkill.id) && !isSkillActive(selectedSkill.id) ? (
                  <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                    <Lightning size={16} />
                    <span>{t('skills:card.loadedByTool')}</span>
                  </div>
                ) : (
                  <NotionButton
                    variant={isSkillActive(selectedSkill.id) ? 'primary' : 'default'}
                    size="md"
                    onClick={() => handleToggleActivate(selectedSkill.id)}
                    disabled={disabled}
                    className="w-full"
                  >
                    {isSkillActive(selectedSkill.id) ? (
                      <>
                        <Check size={16} />
                        <span>{t('skills:card.activatedClickToCancel')}</span>
                      </>
                    ) : (
                      <>
                        <Lightning size={16} />
                        <span>{t('skills:card.activateSkill')}</span>
                      </>
                    )}
                  </NotionButton>
                )}
              </ComposerPanel.Footer>
            </>
          ) : (
            // 移动端不会显示这个状态（因为没选中时会显示列表）
            <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
              <Lightning
                size={22}
                className="text-[color:var(--composer-panel-muted-foreground)] opacity-60"
                aria-hidden="true"
              />
              <p className="text-xs text-[color:var(--composer-panel-muted-foreground)]">
                {t('skills:card.selectSkillToViewDetails')}
              </p>
            </div>
          )}
        </div>
      </div>
    </ComposerPanel.Root>
  );
};

export default SkillSelector;
