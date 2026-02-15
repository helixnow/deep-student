/**
 * Chat V2 - SkillSelector 组件
 *
 * 技能选择面板，支持搜索和激活技能
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Zap, RefreshCw, X, Check, User, Wrench, Star, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import type { SkillLocation, SkillDefinition } from '../types';
import { useLoadedSkills } from '../hooks/useLoadedSkills';
import { useSkillFavorites } from '../hooks/useSkillFavorites';
import { useSkillDefaults } from '../hooks/useSkillDefaults';
import { getLocalizedSkillDescription, getLocalizedSkillName, getLocationLabel, getLocationStyle } from '../utils';

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

/**
 * 技能选择器面板
 */

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

  // 订阅工具调用加载的技能状态
  const { loadedSkillIds, isSkillLoaded } = useLoadedSkills(sessionId ?? null);

  // 技能收藏
  const { isFavorite, toggleFavorite } = useSkillFavorites();

  // 默认技能管理
  const { defaultIds, isDefault, toggleDefault } = useSkillDefaults();

  // 本地状态
  const [searchTerm, setSearchTerm] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  // 用于触发重新获取的版本号
  const [registryVersion, setRegistryVersion] = useState(0);
  // 分栏模式：当前选中的技能（用于右侧详情面板）
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  // 订阅 registry 更新
  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  // 获取所有技能（带位置信息）- 响应 registry 更新
  const allSkills = useMemo(() => {
    return skillRegistry.getAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  // 过滤技能列表（搜索 + 收藏/默认排序）
  const filteredSkills = useMemo(() => {
    let result = allSkills;

    // 搜索过滤
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (skill) =>
          getLocalizedSkillName(skill.id, skill.name, t).toLowerCase().includes(term) ||
          getLocalizedSkillDescription(skill.id, skill.description, t).toLowerCase().includes(term) ||
          skill.id.toLowerCase().includes(term)
      );
    }

    // 排序优先级：收藏 > 默认 > 其他
    const favoriteSet = new Set(result.filter(s => isFavorite(s.id)).map(s => s.id));
    const defaultSet = new Set(defaultIds);
    
    return [...result].sort((a, b) => {
      // 收藏优先
      const aFav = favoriteSet.has(a.id) ? 0 : 1;
      const bFav = favoriteSet.has(b.id) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      
      // 默认其次
      const aDefault = defaultSet.has(a.id) ? 0 : 1;
      const bDefault = defaultSet.has(b.id) ? 0 : 1;
      return aDefault - bDefault;
    });
  }, [allSkills, searchTerm, isFavorite, defaultIds, t]);

  // 获取当前选中的技能详情
  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return filteredSkills.find((s) => s.id === selectedSkillId) || null;
  }, [selectedSkillId, filteredSkills]);

  const selectedSkillToolCount = useMemo(() => {
    if (!selectedSkill) return 0;
    if ((selectedSkill.embeddedTools?.length ?? 0) > 0) return selectedSkill.embeddedTools!.length;
    return (selectedSkill.allowedTools ?? selectedSkill.tools)?.length ?? 0;
  }, [selectedSkill]);

  // 处理技能选中（左侧列表点击）
  const handleSelect = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
  }, []);

  // 处理技能激活/取消激活（切换模式）
  const handleToggleActivate = useCallback(
    (skillId: string) => {
      if (disabled) return;
      onToggleSkill(skillId);
    },
    [disabled, onToggleSkill]
  );

  // 检查技能是否已激活
  const isSkillActive = useCallback(
    (skillId: string) => activeSkillIds.includes(skillId),
    [activeSkillIds]
  );

  // 处理刷新
  const handleRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) return;

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, isRefreshing]);

  // 移动端检测
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  return (
    <div className={cn('flex flex-col h-full min-h-0 overflow-hidden', className)}>
      {/* 头部 - 移动端隐藏（使用统一的 MobileSheetHeader） */}
      {!isMobile && (
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-primary" />
          <span className="font-medium text-foreground">
            {t('skills:selector.title')}
          </span>
          <span className="text-xs text-muted-foreground">
            ({allSkills.length})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* 刷新按钮 */}
          {onRefresh && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRefresh} disabled={isRefreshing} aria-label={t('skills:selector.refresh')} title={t('skills:selector.refresh')} className={cn(isRefreshing && 'animate-spin')}>
              <RefreshCw size={16} />
            </NotionButton>
          )}

          {/* 关闭按钮 */}
          {onClose && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.close')} title={t('common:actions.close')}>
              <X size={16} />
            </NotionButton>
          )}
        </div>
      </div>
      )}

      {/* 搜索框 */}
      <div className="relative mb-3 flex-shrink-0">
        <Search
          size={12}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder={t('skills:selector.searchPlaceholder')}
          className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        {searchTerm && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setSearchTerm('')} aria-label="clear" className="absolute right-2 top-1/2 -translate-y-1/2 !h-5 !w-5">
            <X size={12} />
          </NotionButton>
        )}
      </div>

      {/* 分栏布局：左侧技能列表 + 右侧详情面板 */}
      {/* 🔧 设置固定高度确保 CustomScrollArea 可以正确滚动（参考 MultiSelectModelPanel 的实现） */}
      {/* 📱 移动端：列表和详情切换显示，非移动端：并排显示 */}
      <div className="h-[240px] flex gap-3 min-h-0 overflow-hidden">
        {/* 左侧：技能列表（紧凑模式） */}
        {/* 📱 移动端：选中技能后隐藏列表，显示详情 */}
        <CustomScrollArea 
          className={cn(
            'h-full',
            isMobile 
              ? selectedSkillId ? 'hidden' : 'w-full' 
              : 'w-1/2'
          )} 
          viewportClassName="space-y-1.5 pr-1"
        >
          {filteredSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-8">
              <Zap size={24} className="text-muted-foreground/50 mb-2" />
              <p className="text-xs text-muted-foreground">
                {searchTerm
                  ? t('skills:selector.noResults')
                  : t('skills:selector.empty')}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredSkills.map((skill) => {
                const isSelected = skill.id === selectedSkillId;
                const isActiveSkill = isSkillActive(skill.id);
                const isToolLoaded = isSkillLoaded(skill.id);
                const isDefaultSkill = isDefault(skill.id);
                return (
                  <div
                    key={skill.id}
                    className={cn(
                      'w-full rounded-lg border p-2.5 transition-all duration-150',
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-sm'
                        : isToolLoaded
                          ? 'border-amber-500/50 bg-amber-500/5'
                          : isDefaultSkill
                            ? 'border-emerald-500/30 bg-emerald-500/5'
                            : 'border-border bg-card hover:border-primary/30 hover:bg-accent/30',
                      disabled && 'opacity-50'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Checkbox 多选框 */}
                      {isToolLoaded ? (
                        // 工具加载的技能：显示闪电图标，不可手动操作
                        <span 
                          className="flex-shrink-0 text-amber-500" 
                          title={t('skills:status.toolLoaded')}
                        >
                          <Zap size={14} />
                        </span>
                      ) : (
                        // 手动激活的技能：显示 checkbox
                        <NotionButton
                          variant={isActiveSkill ? 'primary' : 'ghost'}
                          size="icon"
                          iconOnly
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!disabled) handleToggleActivate(skill.id);
                          }}
                          disabled={disabled}
                          className={cn(
                            'flex-shrink-0 !w-4 !h-4 !rounded border',
                            isActiveSkill
                              ? 'border-primary'
                              : 'border-muted-foreground/40 hover:border-primary/60',
                            disabled && 'cursor-not-allowed'
                          )}
                          aria-label={isActiveSkill 
                            ? t('skills:card.clickToDeactivate') 
                            : t('skills:card.clickToActivate')
                          }
                          title={isActiveSkill 
                            ? t('skills:card.clickToDeactivate') 
                            : t('skills:card.clickToActivate')
                          }
                        >
                          {isActiveSkill && <Check size={10} strokeWidth={3} />}
                        </NotionButton>
                      )}
                      {/* 技能名称（可点击选中查看详情） */}
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelect(skill.id)}
                        disabled={disabled}
                        className={cn(
                          'font-medium text-sm truncate flex-1 !justify-start !px-0',
                          isActiveSkill ? 'text-primary' : isToolLoaded ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
                          !disabled && 'hover:underline cursor-pointer'
                        )}
                      >
                        {getLocalizedSkillName(skill.id, skill.name, t)}
                      </NotionButton>
                      {/* 默认标记 - 使用绿色系以区分蓝色的"全局"位置标签 */}
                      {isDefaultSkill && (
                        <span
                          className="flex-shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                          title={t('skills:default.isDefault')}
                        >
                          <Check size={9} />
                          {t('skills:default.label')}
                        </span>
                      )}
                      {/* 收藏按钮 */}
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(skill.id);
                        }}
                        className={cn(
                          'flex-shrink-0 !w-5 !h-5',
                          isFavorite(skill.id)
                            ? 'text-amber-500 hover:text-amber-600'
                            : 'text-muted-foreground/40 hover:text-amber-500'
                        )}
                        aria-label={isFavorite(skill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                        title={isFavorite(skill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                      >
                        <Star size={12} className={isFavorite(skill.id) ? 'fill-current' : ''} />
                      </NotionButton>
                      {/* 位置标签 */}
                      <span
                        className={cn(
                          'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded',
                          getLocationStyle(skill.location)
                        )}
                      >
                        {getLocationLabel(skill.location, t)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CustomScrollArea>

        {/* 右侧：技能详情面板 */}
        {/* 📱 移动端：只有选中技能时才显示，且全宽显示 */}
        <div 
          className={cn(
            'h-full flex flex-col',
            isMobile 
              ? selectedSkillId ? 'w-full' : 'hidden'
              : 'w-1/2 pl-1 border-l border-border'
          )}
        >
          {selectedSkill ? (
            <>
              {/* 📱 移动端：返回按钮 */}
              {isMobile && (
                <NotionButton variant="ghost" size="sm" onClick={() => setSelectedSkillId(null)} className="mb-2 flex-shrink-0">
                  <ChevronLeft size={14} />
                  <span>{t('common:actions.back')}</span>
                </NotionButton>
              )}
              {/* 内容区域（可滚动） */}
              <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pr-1">
                {/* 技能名称和版本 */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-medium text-foreground text-base truncate">
                        {getLocalizedSkillName(selectedSkill.id, selectedSkill.name, t)}
                      </h3>
                      {/* 收藏按钮 */}
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={() => toggleFavorite(selectedSkill.id)}
                        className={cn(
                          'flex-shrink-0 !w-6 !h-6',
                          isFavorite(selectedSkill.id)
                            ? 'text-amber-500 hover:text-amber-600'
                            : 'text-muted-foreground/40 hover:text-amber-500'
                        )}
                        aria-label={isFavorite(selectedSkill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                        title={isFavorite(selectedSkill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                      >
                        <Star size={14} className={isFavorite(selectedSkill.id) ? 'fill-current' : ''} />
                      </NotionButton>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {selectedSkill.version && (
                        <span className="text-xs text-muted-foreground">
                          v{selectedSkill.version}
                        </span>
                      )}
                      {/* 详情面板中的默认状态标记 */}
                      {isDefault(selectedSkill.id) && (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                          <Check size={9} />
                          {t('skills:default.isDefault')}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded',
                      getLocationStyle(selectedSkill.location)
                    )}
                  >
                    {getLocationLabel(selectedSkill.location, t)}
                  </span>
                </div>

                {/* 技能描述 */}
                <p className="text-xs text-muted-foreground mb-3">
                  {getLocalizedSkillDescription(selectedSkill.id, selectedSkill.description, t)}
                </p>

                {/* 工具和作者信息 */}
                {(selectedSkillToolCount > 0 || selectedSkill.author) && (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    {selectedSkillToolCount > 0 && (
                      <div className="flex items-center gap-1">
                        <Wrench size={12} />
                        <span>{t('skills:card.toolsCount', { count: selectedSkillToolCount })}</span>
                      </div>
                    )}
                    {selectedSkill.author && (
                      <div className="flex items-center gap-1">
                        <User size={12} />
                        <span className="truncate max-w-[100px]">{selectedSkill.author}</span>
                      </div>
                    )}
                  </div>
                )}
              </CustomScrollArea>

              {/* 底部操作按钮（固定在底部） */}
              <div className="flex-shrink-0 pt-3 border-t border-border/50 space-y-2">
                {/* 默认状态切换按钮 - 使用绿色系与激活按钮区分 */}
                <NotionButton
                  variant={isDefault(selectedSkill.id) ? 'success' : 'default'}
                  size="md"
                  onClick={() => toggleDefault(selectedSkill.id)}
                  className="w-full"
                >
                  <Check size={14} className={cn('transition-opacity', !isDefault(selectedSkill.id) && 'opacity-50')} />
                  <span>
                    {isDefault(selectedSkill.id) 
                      ? t('skills:default.removeDefault') 
                      : t('skills:default.setDefault')
                    }
                  </span>
                </NotionButton>

                {/* 工具加载的技能：显示状态提示，禁止手动操作 */}
                {isSkillLoaded(selectedSkill.id) ? (
                  <div className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                    <Zap size={16} />
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
                        <Zap size={16} />
                        <span>{t('skills:card.activateSkill')}</span>
                      </>
                    )}
                  </NotionButton>
                )}
              </div>
            </>
          ) : (
            // 📱 移动端不会显示这个状态（因为没选中时会显示列表）
            <div className="flex flex-col items-center justify-center h-full text-center py-8">
              <Zap size={24} className="text-muted-foreground/30 mb-2" />
              <p className="text-xs text-muted-foreground">
                {t('skills:card.selectSkillToViewDetails')}
              </p>
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default SkillSelector;
