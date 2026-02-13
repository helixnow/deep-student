/**
 * Skills Management - 技能列表组件
 *
 * 卡片式列表，显示技能信息和操作按钮
 */

import React, { type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Zap, Pencil, Trash2, Globe, FolderOpen, Package, Check, RotateCcw, Wrench, Download, Star, MoreHorizontal, Copy } from 'lucide-react';
import { Badge } from '../ui/shad/Badge';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuLabel
} from '@/components/ui/app-menu';
import { cn } from '@/lib/utils';
import type { SkillDefinition, SkillLocation } from '@/chat-v2/skills/types';
import { useSkillFavorites } from '@/chat-v2/skills/hooks/useSkillFavorites';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/chat-v2/skills/utils';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillsListProps {
  /** 技能列表 */
  skills: SkillDefinition[];
  /** 当前选中的技能 ID（用于列表高亮） */
  selectedSkillId?: string | null;
  /** 当前默认启用的技能 ID 列表（支持多选） */
  defaultSkillIds: string[];
  /** 编辑回调 */
  onEdit: (skill: SkillDefinition, cardRect?: DOMRect) => void;
  /** 删除回调 */
  onDelete: (skill: SkillDefinition) => void;
  /** 切换默认启用状态回调 */
  onToggleDefault: (skill: SkillDefinition) => void;
  /** 恢复默认设置回调（仅内置技能） */
  onResetToOriginal?: (skill: SkillDefinition) => void;
  /** 导出回调 */
  onExport?: (skill: SkillDefinition) => void;
  /** 选中技能回调（点击卡片时触发） */
  onSelectSkill?: (skill: SkillDefinition) => void;
  /** 是否禁用操作 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 卡片 refs Map（用于全屏编辑器动画） */
  cardRefsMap?: MutableRefObject<Map<string, HTMLDivElement>>;
  /** 当前正在编辑的技能 ID（用于隐藏卡片） */
  editingSkillId?: string | null;
}

// ============================================================================
// 辅助组件
// ============================================================================

// ============================================================================
// 辅助函数
// ============================================================================

/** 位置图标映射 */
const LocationIcon: React.FC<{ location: SkillLocation }> = ({ location }) => {
  switch (location) {
    case 'global':
      return <Globe size={12} />;
    case 'project':
      return <FolderOpen size={12} />;
    case 'builtin':
      return <Package size={12} />;
    default:
      return <Zap size={12} />;
  }
};

/** 位置标签颜色 */
const getLocationVariant = (location: SkillLocation): 'default' | 'secondary' | 'outline' => {
  switch (location) {
    case 'global':
      return 'default';
    case 'project':
      return 'secondary';
    case 'builtin':
      return 'outline';
    default:
      return 'outline';
  }
};

// ============================================================================
// 组件
// ============================================================================

export const SkillsList: React.FC<SkillsListProps> = ({
  skills,
  selectedSkillId,
  defaultSkillIds,
  onEdit,
  onDelete,
  onToggleDefault,
  onResetToOriginal,
  onExport,
  onSelectSkill,
  disabled = false,
  className,
  cardRefsMap,
  editingSkillId,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const cardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  // 技能收藏
  const { isFavorite, toggleFavorite } = useSkillFavorites();

  // 选中卡片时自动滚动到可视区域
  React.useEffect(() => {
    if (!selectedSkillId) return;
    const el = cardRefs.current[selectedSkillId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedSkillId]);

  if (skills.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
        <div className="p-4 rounded-full bg-muted/50 mb-4">
          <Zap size={32} className="text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('skills:selector.empty', '暂无可用技能')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t('skills:selector.emptyHint', '点击"新建"按钮创建第一个技能')}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {skills.map((skill) => {
        const isDefaultEnabled = defaultSkillIds.includes(skill.id);
        const isSelected = selectedSkillId === skill.id;
        const isBuiltin = skill.isBuiltin === true;
        const isCustomized = skill.isCustomized === true;

        // 当前卡片是否正在编辑（用于隐藏）
        const isEditing = editingSkillId === skill.id;

        return (
          <motion.div
            key={skill.id}
            layoutId={`skill-card-${skill.id}`}
            ref={(el) => {
              cardRefs.current[skill.id] = el;
              // 同步到外部 cardRefsMap
              if (cardRefsMap && el) {
                cardRefsMap.current.set(skill.id, el);
              }
            }}
            className={cn(
              'group relative flex flex-col p-4 rounded-xl border',
              'bg-card border-border/40 hover:border-border/80 hover:shadow-sm',
              'transition-[border-color,box-shadow] duration-200',
              isSelected && 'ring-1 ring-primary/20 border-primary/20 bg-primary/5',
              isEditing && 'opacity-0 pointer-events-none'
            )}
            style={{ willChange: isEditing ? 'transform' : 'auto' }}
            onClick={() => onSelectSkill?.(skill)}
            role="button"
            tabIndex={0}
            layout
            transition={{
              layout: { type: 'spring', stiffness: 350, damping: 28 }
            }}
          >
            {/* 顶部区域：标题与操作 */}
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <h3 className="font-medium text-sm text-foreground truncate leading-tight">
                    {getLocalizedSkillName(skill.id, skill.name, t)}
                  </h3>
                  {/* 收藏按钮 - 仅在 hover 或已收藏时显示 */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(skill.id);
                    }}
                    className={cn(
                      'flex-shrink-0 transition-opacity duration-200',
                      'focus:outline-none',
                      isFavorite(skill.id)
                        ? 'opacity-100 text-amber-500 hover:text-amber-600'
                        : 'opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-amber-500'
                    )}
                  >
                    <Star
                      size={14}
                      className={isFavorite(skill.id) ? 'fill-current' : ''}
                    />
                  </button>
                </div>
                
                {/* 元信息行：版本与作者 */}
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 h-4">
                  {skill.version && <span>v{skill.version}</span>}
                  {skill.author && (
                     <>
                       <span className="w-0.5 h-0.5 rounded-full bg-border" />
                       <span className="truncate max-w-[80px]">{skill.author}</span>
                     </>
                  )}
                </div>
              </div>

              {/* 右上角操作区 */}
              <div className="flex items-center gap-1 -mr-1">
                 {/* 默认状态指示/切换 */}
                 <div
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDefault(skill);
                    }}
                    className={cn(
                      "flex items-center justify-center px-2 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer border select-none",
                      isDefaultEnabled 
                        ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                        : "bg-transparent text-muted-foreground/50 border-transparent hover:bg-muted hover:text-muted-foreground"
                    )}
                    title={isDefaultEnabled ? t('skills:management.is_default', '默认启用') : t('skills:management.set_default', '设为默认')}
                 >
                    {isDefaultEnabled ? t('skills:management.default_abbr', '默认') : <span className="opacity-0 group-hover:opacity-100 transition-opacity">{t('skills:management.enable', '启用')}</span>}
                 </div>
              </div>
            </div>

            {/* 内容描述 */}
            <div className="flex-1 min-h-[3rem]">
              <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3">
                {getLocalizedSkillDescription(skill.id, skill.description, t) || t('skills:management.no_description', '暂无描述')}
              </p>
            </div>

            {/* 底部标签栏 */}
            <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-border/20">
              <div className="flex items-center gap-2">
                {/* 位置标签 */}
                <div className={cn(
                  "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border select-none",
                  skill.location === 'builtin' 
                    ? "bg-muted/30 text-muted-foreground border-transparent"
                    : "bg-secondary/30 text-secondary-foreground border-transparent"
                )}>
                  <LocationIcon location={skill.location} />
                  <span>{t(`skills:location.${skill.location}`, skill.location)}</span>
                </div>

                {/* 工具数量 */}
                {skill.embeddedTools && skill.embeddedTools.length > 0 && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 px-1.5 py-0.5">
                    <Wrench size={10} />
                    <span>{skill.embeddedTools.length}</span>
                  </div>
                )}
                
                {/* 自定义标记 */}
                {isBuiltin && isCustomized && (
                  <div className="text-[10px] text-amber-600/80 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    {t('skills:management.customized', '已修改')}
                  </div>
                )}
              </div>

              {/* 右下角操作按钮 */}
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <button
                  className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
                  onClick={() => {
                    const cardEl = cardRefs.current[skill.id];
                    const rect = cardEl?.getBoundingClientRect();
                    onEdit(skill, rect);
                  }}
                  title={t('common:actions.edit', '编辑')}
                >
                  <Pencil size={14} />
                </button>
                
                <button
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    isDefaultEnabled 
                      ? "text-primary hover:bg-primary/10" 
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-muted"
                  )}
                  onClick={() => onToggleDefault(skill)}
                  title={isDefaultEnabled ? t('skills:management.unset_default', '取消默认') : t('skills:management.set_default', '设为默认')}
                >
                  <Check size={14} />
                </button>

                <button
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    isFavorite(skill.id)
                      ? "text-amber-500 hover:bg-amber-500/10"
                      : "text-muted-foreground/60 hover:text-amber-500 hover:bg-muted"
                  )}
                  onClick={() => toggleFavorite(skill.id)}
                  title={isFavorite(skill.id) ? t('skills:favorite.remove', '取消收藏') : t('skills:favorite.add', '收藏')}
                >
                  <Star size={14} className={isFavorite(skill.id) ? 'fill-current' : ''} />
                </button>

                {onExport && (
                  <button
                    className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
                    onClick={() => onExport(skill)}
                    title={t('skills:management.export', '导出')}
                  >
                    <Download size={14} />
                  </button>
                )}
              </div>
            </div>
          </motion.div>

        );
      })}
    </div>
  );
};

export default SkillsList;
