/**
 * Skills Management - 技能列表组件
 *
 * 卡片式列表，显示技能信息和操作按钮
 */

import React, { type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Lightning, Pencil, Trash, Check, ArrowCounterClockwise, Download, Star, DotsThree, Copy } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { SkillDefinition } from '@/features/chat/skills/types';
import { useSkillFavorites } from '@/features/chat/skills/hooks/useSkillFavorites';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/features/chat/skills/utils';
import {
  isSkillDisabled,
  setSkillDisabled,
  SKILL_ENABLED_CHANGED_EVENT,
} from '@/features/chat/skills/skillEnableStorage';
import { SkillPackageSummary } from './SkillPackageSummary';

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
  // 触屏无 hover:收藏星标/「启用」标签需常显
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  // 停用覆盖存在 localStorage，变更后靠 tick 强制重算 isSkillDisabled（仿 trustTick 模式）
  const [, setEnableTick] = React.useState(0);
  React.useEffect(() => {
    const handleEnabledChanged = () => setEnableTick((v) => v + 1);
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, handleEnabledChanged);
    return () => window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, handleEnabledChanged);
  }, []);

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
      <div className={cn('study-shell-empty-state', className)}>
        <div className="study-shell-empty-state__icon">
          <Lightning size={32} className="text-muted-foreground/50" />
        </div>
        <p className="study-shell-empty-state__title">
          {t('skills:selector.empty')}
        </p>
        <p className="study-shell-empty-state__description">
          {t('skills:selector.emptyHint')}
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
        const isDisabledSkill = isSkillDisabled(skill.id);

        // 当前卡片是否正在编辑（用于隐藏）
        const isEditing = editingSkillId === skill.id;

        return (
          <motion.div
            key={skill.id}
            data-agent-entity={`skills:${skill.id}`}
            layoutId={`skill-card-${skill.id}`}
            ref={(el) => {
              cardRefs.current[skill.id] = el;
              // 同步到外部 cardRefsMap
              if (cardRefsMap && el) {
                cardRefsMap.current.set(skill.id, el);
              }
            }}
            className={cn(
              'study-shell-secondary-card group relative flex flex-col p-4',
              // ui-press：触控按压反馈（独立 scale 属性，不干扰 framer layout transform）
              'ui-press transition-[border-color,box-shadow] duration-200',
              isSelected && 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)]',
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
              <div className={cn('min-w-0 flex-1 flex flex-col gap-1', isDisabledSkill && 'opacity-60')}>
                <div className="flex items-center gap-1.5">
                  <h3 className="font-medium text-sm text-foreground truncate leading-tight">
                    {getLocalizedSkillName(skill.id, skill.name, t)}
                  </h3>
                  {/* 收藏按钮 - hover 或已收藏时显示;触屏常显（触控目标经负 margin 扩大且不撑高行） */}
                  <DsButton variant="ghost" size="icon" iconOnly
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(skill.id); }}
                    className={cn('!h-auto !w-auto !p-0 max-lg:!h-10 max-lg:!w-10 max-lg:-my-3 max-lg:-mx-1.5 flex-shrink-0 transition-opacity duration-200', isFavorite(skill.id) ? 'opacity-100 text-[color:hsl(var(--warning))]' : cn(isTouchPrimary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100', 'text-muted-foreground/40 hover:text-[color:hsl(var(--warning))]'))}
                    aria-label="favorite"
                  >
                    <Star size={14} className={isFavorite(skill.id) ? 'fill-current' : ''} />
                  </DsButton>
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
                      "flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer border select-none",
                      // 移动端触控目标：加高 + 负 margin 抵消行高膨胀
                      "max-lg:min-h-9 max-lg:px-2.5 max-lg:-my-1.5",
                      isDefaultEnabled 
                        ? "bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] border-transparent"
                        : "bg-transparent text-muted-foreground/50 border-transparent hover:bg-[color:var(--button-utility-hover)] hover:text-muted-foreground"
                    )}
                    title={isDefaultEnabled ? t('skills:management.is_default') : t('skills:management.set_default')}
                 >
                    {isDefaultEnabled ? t('skills:management.default_abbr') : <span className={cn('transition-opacity', isTouchPrimary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>{t('skills:management.enable')}</span>}
                 </div>
              </div>
            </div>

            {/* 内容描述 */}
            <div className={cn('flex-1 min-h-[3rem]', isDisabledSkill && 'opacity-60')}>
              <p className="text-xs text-muted-foreground/80 leading-relaxed line-clamp-3">
                {getLocalizedSkillDescription(skill.id, skill.description, t) || t('skills:management.no_description')}
              </p>
            </div>

            {/* 底部标签栏 */}
            <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-[color:var(--shell-workspace-border)]">
              <div className={cn('flex min-w-0 items-center gap-2', isDisabledSkill && 'opacity-60')}>
                {/* 位置标签 */}
                <SkillPackageSummary skill={skill} variant="card" />

                {/* 停用标记 */}
                {isDisabledSkill && (
                  <div
                    className="study-shell-badge study-shell-badge--borderless text-[10px]"
                    title={t('skills:package.disabled_hint')}
                  >
                    {t('skills:package.disabled_badge')}
                  </div>
                )}

                {/* 自定义标记 */}
                {isBuiltin && isCustomized && (
                  <div className="study-shell-badge study-shell-badge--warning study-shell-badge--borderless text-[10px]">
                    {t('skills:management.customized')}
                  </div>
                )}
              </div>

              {/* 右下角操作按钮 */}
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {/* 停用/启用开关（即时生效，无确认框） */}
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="!h-auto !px-1.5 !py-1 max-lg:!h-11 max-lg:!px-2.5 text-[11px] text-muted-foreground/60 hover:text-foreground"
                  onClick={() => setSkillDisabled(skill.id, !isDisabledSkill)}
                  title={
                    isDisabledSkill
                      ? t('skills:package.enable')
                      : t('skills:package.disable')
                  }
                  aria-label={isDisabledSkill ? 'enable-skill' : 'disable-skill'}
                >
                  {isDisabledSkill
                    ? t('skills:package.enable')
                    : t('skills:package.disable')}
                </DsButton>
                <DsButton variant="ghost" size="icon" iconOnly className="!p-1.5 text-muted-foreground/60 hover:text-foreground" onClick={() => { const cardEl = cardRefs.current[skill.id]; const rect = cardEl?.getBoundingClientRect(); onEdit(skill, rect); }} title={t('common:actions.edit')} aria-label="edit">
                  <Pencil size={14} />
                </DsButton>

                <AppMenu>
                  <AppMenuTrigger asChild>
                    <DsButton variant="ghost" size="icon" iconOnly className="!p-1.5 text-muted-foreground/60 hover:text-foreground" aria-label="more">
                      <DotsThree size={14} />
                    </DsButton>
                  </AppMenuTrigger>
                  <AppMenuContent align="end" width={180}>
                    <AppMenuItem
                      icon={<Check size={16} />}
                      onClick={() => onToggleDefault(skill)}
                    >
                      {isDefaultEnabled ? t('skills:management.unset_default') : t('skills:management.set_default')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={
                        <Star
                          size={16}
                          className={cn(isFavorite(skill.id) && 'fill-current text-[color:hsl(var(--warning))]')}
                        />
                      }
                      onClick={() => toggleFavorite(skill.id)}
                    >
                      {isFavorite(skill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                    </AppMenuItem>
                    {onExport && (
                      <AppMenuItem
                        icon={<Download size={16} />}
                        onClick={() => onExport(skill)}
                      >
                        {t('skills:management.export')}
                      </AppMenuItem>
                    )}
                    <AppMenuItem
                      icon={<Copy size={16} />}
                      onClick={() => { void navigator.clipboard.writeText(skill.id); }}
                    >
                      {t('skills:management.copy_id')}
                    </AppMenuItem>
                    {isBuiltin && isCustomized && onResetToOriginal && (
                      <>
                        <AppMenuSeparator />
                        <AppMenuItem
                          icon={<ArrowCounterClockwise size={16} />}
                          onClick={() => onResetToOriginal(skill)}
                        >
                          {t('skills:management.reset_to_default')}
                        </AppMenuItem>
                      </>
                    )}
                    {!isBuiltin && (
                      <>
                        <AppMenuSeparator />
                        <AppMenuItem
                          icon={<Trash size={16} />}
                          destructive
                          onClick={() => onDelete(skill)}
                        >
                          {t('common:actions.delete')}
                        </AppMenuItem>
                      </>
                    )}
                  </AppMenuContent>
                </AppMenu>
              </div>
            </div>
          </motion.div>

        );
      })}
    </div>
  );
};

export default SkillsList;
