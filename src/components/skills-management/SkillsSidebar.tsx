/**
 * SkillsSidebar - 技能管理侧边栏组件（使用 UnifiedSidebar）
 *
 * 提供技能列表、搜索、位置筛选等功能
 */

import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
  UnifiedSidebarFooter,
  useUnifiedSidebar,
} from '@/components/ui/unified-sidebar';
import { NotionButton } from '@/components/ui/NotionButton';
import { Zap, Globe, FolderOpen, Package, Pencil, Trash2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SkillDefinition, SkillLocation } from '@/chat-v2/skills/types';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/chat-v2/skills/utils';

// ============================================================================
// 类型定义
// ============================================================================

type LocationFilter = 'all' | SkillLocation;

interface SkillsSidebarProps {
  /** 技能列表 */
  skills: SkillDefinition[];
  /** 当前选中的技能 ID（用于高亮） */
  selectedSkillId?: string | null;
  /** 当前默认启用的技能 ID 列表（支持多选） */
  defaultSkillIds: string[];
  /** 切换技能默认状态回调 */
  onToggleSkill: (skillId: string | null) => void;
  /** 选中技能回调（区分与默认状态） */
  onSelectSkill?: (skillId: string) => void;
  /** 是否加载中 */
  isLoading?: boolean;
  /** 创建技能回调 */
  onCreateSkill: () => void;
  /** 编辑技能回调 */
  onEditSkill: (skill: SkillDefinition) => void;
  /** 删除技能回调 */
  onDeleteSkill: (skill: SkillDefinition) => void;
  /** 刷新技能列表回调 */
  onRefresh?: () => Promise<void>;
  /** 技能总数摘要 */
  skillSummary?: {
    total: number;
    global: number;
    project: number;
    builtin: number;
  };
  className?: string;
  /** 是否启用自动响应式，默认 true */
  autoResponsive?: boolean;
  /** 显示模式：panel 或 drawer，默认 drawer */
  displayMode?: 'panel' | 'drawer';
  /** 移动端是否打开 */
  mobileOpen?: boolean;
  /** 移动端打开状态变化回调 */
  onMobileOpenChange?: (open: boolean) => void;
  /** 侧边栏宽度 */
  width?: number | 'full';
  /** 关闭回调 */
  onClose?: () => void;
}

// ============================================================================
// 位置图标和标签
// ============================================================================

const LocationIcon: React.FC<{ location: SkillLocation; size?: number }> = ({ location, size = 14 }) => {
  switch (location) {
    case 'global':
      return <Globe size={size} />;
    case 'project':
      return <FolderOpen size={size} />;
    case 'builtin':
      return <Package size={size} />;
    default:
      return <Zap size={size} />;
  }
};

// ============================================================================
// 侧边栏内容组件（提取到外部避免重复创建导致闪烁）
// ============================================================================

interface SidebarContentProps {
  skills: SkillDefinition[];
  locationFilter: LocationFilter;
  setLocationFilter: (filter: LocationFilter) => void;
  locationTabs: Array<{ id: LocationFilter; label: string; icon: React.ReactNode }>;
  locationCounts: Record<LocationFilter, number>;
  isLoading: boolean;
  defaultSkillIds: string[];
  selectedSkillId?: string | null;
  onSelectSkill?: (skillId: string) => void;
  onEditSkill: (skill: SkillDefinition) => void;
  onDeleteSkill: (skill: SkillDefinition) => void;
  onCreateSkill: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}

const SidebarContentComponent: React.FC<SidebarContentProps> = React.memo(({
  skills,
  locationFilter,
  setLocationFilter,
  locationTabs,
  locationCounts,
  isLoading,
  defaultSkillIds,
  selectedSkillId,
  onSelectSkill,
  onEditSkill,
  onDeleteSkill,
  onCreateSkill,
  t,
}) => {
  const { searchQuery } = useUnifiedSidebar();

  // 过滤技能列表
  const filteredSkills = useMemo(() => {
    let result = skills;

    // 按位置过滤
    if (locationFilter !== 'all') {
      result = result.filter(skill => skill.location === locationFilter);
    }

    // 按搜索词过滤
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(skill =>
        getLocalizedSkillName(skill.id, skill.name, t).toLowerCase().includes(query) ||
        getLocalizedSkillDescription(skill.id, skill.description, t).toLowerCase().includes(query) ||
        skill.id.toLowerCase().includes(query)
      );
    }

    return result;
  }, [skills, locationFilter, searchQuery, t]);

  return (
    <>
      {/* 位置过滤标签 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border/20">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {locationTabs.map(tab => {
            const count = locationCounts[tab.id];
            const isActiveTab = locationFilter === tab.id;

            // 跳过没有技能的位置（除了 all）
            if (tab.id !== 'all' && count === 0) {
              return null;
            }

            return (
              <NotionButton
                key={tab.id}
                variant="ghost" size="sm"
                onClick={() => setLocationFilter(tab.id)}
                className={cn(
                  '!px-2.5 !py-1 !h-auto text-[11px] font-medium whitespace-nowrap',
                  isActiveTab
                    ? 'bg-secondary text-secondary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <span className={cn("opacity-70", isActiveTab && "opacity-100")}>{tab.icon}</span>
                <span>{tab.label}</span>
                <span className={cn(
                  'ml-0.5 text-[10px] opacity-60',
                  isActiveTab && 'opacity-100 font-bold'
                )}>
                  {count}
                </span>
              </NotionButton>
            );
          })}
        </div>
      </div>

      {/* 技能列表 */}
      <UnifiedSidebarContent
        isLoading={isLoading}
        isEmpty={filteredSkills.length === 0}
        emptyIcon={Zap}
        emptyTitle={searchQuery
          ? t('skills:selector.noResults', '未找到匹配的技能')
          : t('skills:selector.empty', '暂无可用技能')
        }
        emptyDescription={!searchQuery
          ? t('skills:selector.emptyHint', '点击"新建"按钮创建第一个技能')
          : undefined
        }
        emptyActionText={!searchQuery ? t('skills:management.create', '新建技能') : undefined}
        onEmptyAction={onCreateSkill}
      >
        {filteredSkills.map(skill => {
          // 选中状态仅由 selectedSkillId 决定，与默认状态分离
          const isSelected = selectedSkillId === skill.id;
          // 默认启用状态
          const isDefault = defaultSkillIds.includes(skill.id);
          // 内置技能：可编辑，不可删除
          const isBuiltin = skill.isBuiltin === true;
          return (
            <UnifiedSidebarItem
              key={skill.id}
              id={skill.id}
              isSelected={isSelected}
              onClick={() => onSelectSkill?.(skill.id)}
              icon={
                <div className="relative">
                  <LocationIcon location={skill.location} size={16} />
                  {/* 默认启用状态指示器 */}
                  {isDefault && (
                    <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full border border-background flex items-center justify-center">
                      <Check size={6} className="text-white" strokeWidth={3} />
                    </div>
                  )}
                </div>
              }
              title={getLocalizedSkillName(skill.id, skill.name, t)}
              description={getLocalizedSkillDescription(skill.id, skill.description, t)}
              badge={skill.version ? `v${skill.version}` : undefined}
              showEdit={true}
              showDelete={!isBuiltin}
              onEditClick={(e) => {
                e.stopPropagation();
                onEditSkill(skill);
              }}
              onDeleteClick={isBuiltin ? undefined : (e) => {
                e.stopPropagation();
                onDeleteSkill(skill);
              }}
            />
          );
        })}
      </UnifiedSidebarContent>
    </>
  );
});

// ============================================================================
// 主组件
// ============================================================================

export const SkillsSidebar: React.FC<SkillsSidebarProps> = ({
  skills,
  selectedSkillId,
  defaultSkillIds,
  onToggleSkill,
  onSelectSkill,
  isLoading = false,
  onCreateSkill,
  onEditSkill,
  onDeleteSkill,
  onRefresh,
  skillSummary,
  className,
  autoResponsive = true,
  displayMode = 'drawer',
  mobileOpen,
  onMobileOpenChange,
  width,
  onClose,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  // 本地状态：位置过滤
  const [locationFilter, setLocationFilter] = useState<LocationFilter>('all');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 处理刷新
  const handleRefresh = async () => {
    if (!onRefresh || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  // 位置过滤标签
  const locationTabs = useMemo(() => [
    { id: 'all' as LocationFilter, label: t('skills:location.all', '全部'), icon: <Zap size={12} /> },
    { id: 'global' as LocationFilter, label: t('skills:location.global', '全局'), icon: <Globe size={12} /> },
    { id: 'project' as LocationFilter, label: t('skills:location.project', '项目'), icon: <FolderOpen size={12} /> },
    { id: 'builtin' as LocationFilter, label: t('skills:location.builtin', '内置'), icon: <Package size={12} /> },
  ], [t]);

  // 位置统计
  const locationCounts = useMemo(() => ({
    all: skills.length,
    global: skills.filter(s => s.location === 'global').length,
    project: skills.filter(s => s.location === 'project').length,
    builtin: skills.filter(s => s.location === 'builtin').length,
  }), [skills]);

  // 稳定的点击回调，避免每次渲染创建新函数
  const handleSkillClick = useCallback((skillId: string) => {
    onSelectSkill?.(skillId);
  }, [onSelectSkill]);

  const handleEditClick = useCallback((skill: SkillDefinition, e: React.MouseEvent) => {
    e.stopPropagation();
    onEditSkill(skill);
  }, [onEditSkill]);

  const handleDeleteClick = useCallback((skill: SkillDefinition, e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteSkill(skill);
  }, [onDeleteSkill]);

  return (
    <UnifiedSidebar
      className={className}
      autoResponsive={autoResponsive}
      displayMode={displayMode}
      drawerSide="left"
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      width={width}
      onClose={onClose}
    >
      <UnifiedSidebarHeader
        title={t('skills:management.title', '技能管理')}
        icon={Zap}
        showSearch
        searchPlaceholder={t('skills:selector.searchPlaceholder', '搜索技能...')}
        showCreate
        createTitle={t('skills:management.create', '新建技能')}
        onCreateClick={onCreateSkill}
        showCollapse
        showRefresh={!!onRefresh}
        onRefreshClick={handleRefresh}
        isRefreshing={isRefreshing}
      />

      <SidebarContentComponent
        skills={skills}
        locationFilter={locationFilter}
        setLocationFilter={setLocationFilter}
        locationTabs={locationTabs}
        locationCounts={locationCounts}
        isLoading={isLoading}
        defaultSkillIds={defaultSkillIds}
        selectedSkillId={selectedSkillId}
        onSelectSkill={handleSkillClick}
        onEditSkill={onEditSkill}
        onDeleteSkill={onDeleteSkill}
        onCreateSkill={onCreateSkill}
        t={t}
      />

      <UnifiedSidebarFooter>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="flex flex-col">
            <span className="text-muted-foreground">{t('skills:location.global', '全局')}</span>
            <span className="font-semibold">{skillSummary?.global ?? locationCounts.global}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">{t('skills:location.project', '项目')}</span>
            <span className="font-semibold">{skillSummary?.project ?? locationCounts.project}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">{t('skills:management.default_enabled', '默认')}</span>
            <span className="font-semibold text-primary">{defaultSkillIds.length}</span>
          </div>
        </div>
      </UnifiedSidebarFooter>
    </UnifiedSidebar>
  );
};

export default SkillsSidebar;
