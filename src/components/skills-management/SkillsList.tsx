/**
 * Skills Management - 技能列表组件
 *
 * 卡片式列表，显示技能信息和操作按钮
 */

import React, { type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Lightning, Pencil, Trash, Check, ArrowCounterClockwise, Download, Star, DotsThree, Copy, CircleNotch } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24 } from '@/components/ui/coarseHit';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type { SkillDefinition } from '@/features/chat/skills/types';
import { useSkillFavorites } from '@/features/chat/skills/hooks/useSkillFavorites';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/features/chat/skills/utils';
import {
  isSkillDisabled,
  setSkillDisabled,
  SKILL_ENABLED_CHANGED_EVENT,
} from '@/features/chat/skills/skillEnableStorage';
import {
  resolveEffectiveTrustStatus,
  SKILL_TRUST_CHANGED_EVENT,
} from '@/features/chat/skills/skillTrustStorage';
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
  /** 是否正在加载技能列表 */
  isLoading?: boolean;
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
  isLoading = false,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const cardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  // 技能收藏
  const { isFavorite, toggleFavorite } = useSkillFavorites();
  // 触屏无 hover:收藏星标/「启用」标签需常显
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');

  // 停用/信任覆盖存在 localStorage，变更后靠 tick 强制重算 isSkillDisabled / resolveEffectiveTrustStatus
  const [, setEnableTick] = React.useState(0);
  React.useEffect(() => {
    const handleOverrideChanged = () => setEnableTick((v) => v + 1);
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, handleOverrideChanged);
    window.addEventListener(SKILL_TRUST_CHANGED_EVENT, handleOverrideChanged);
    return () => {
      window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, handleOverrideChanged);
      window.removeEventListener(SKILL_TRUST_CHANGED_EVENT, handleOverrideChanged);
    };
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
    if (isLoading) {
      return (
        <div className={cn('space-y-4', className)} role="status" data-testid="skills-list-loading">
          <div className="study-shell-empty-state">
            <div className="study-shell-empty-state__icon">
              <CircleNotch size={30} className="animate-spin text-muted-foreground/70" />
            </div>
            <p className="study-shell-empty-state__title">
              {t('skills:selector.loading')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="h-28 rounded-xl border border-border/50 bg-muted/30 animate-pulse p-4 space-y-2.5"
              >
                <div className="h-4 w-2/5 rounded bg-muted/60" />
                <div className="h-3 w-4/5 rounded bg-muted/50" />
                <div className="h-3 w-3/5 rounded bg-muted/40" />
              </div>
            ))}
          </div>
        </div>
      );
    }
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
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 lg:gap-5', className)}>
      {skills.map((skill) => {
        const isDefaultEnabled = defaultSkillIds.includes(skill.id);
        const isSelected = selectedSkillId === skill.id;
        const isBuiltin = skill.isBuiltin === true || skill.location === 'builtin';
        const isCustomized = skill.isCustomized === true;
        const isDisabledSkill = isSkillDisabled(skill.id);
        const trustStatus = resolveEffectiveTrustStatus(skill);
        const isUntrustedExternal = !isBuiltin && trustStatus === 'untrusted';

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
              'study-shell-secondary-card group relative flex flex-col rounded-2xl p-3.5 sm:p-4',
              // ui-press：触控按压反馈（独立 scale 属性，不干扰 framer layout transform）
              'ui-press transition-[border-color,box-shadow] duration-200',
              isSelected && 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)]',
              isEditing && 'opacity-0 pointer-events-none'
            )}
            style={{ willChange: isEditing ? 'transform' : 'auto' }}
            onClick={() => onSelectSkill?.(skill)}
            onKeyDown={(e) => {
              // 只消费卡片本体上的按键，不劫持卡片内部按钮/菜单的键盘事件
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectSkill?.(skill);
              } else if ((e.key === 'e' || e.key === 'E') && !isUntrustedExternal) {
                // 启用/停用快捷键：仅已信任或内置技能可直接切换启停
                e.preventDefault();
                setSkillDisabled(skill.id, !isDisabledSkill);
              } else if ((e.key === 'Delete' || e.key === 'Backspace') && !isBuiltin && !disabled) {
                // 删除仍走列表顶部行内确认横幅（风险操作二次确认）
                e.preventDefault();
                onDelete(skill);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={getLocalizedSkillName(skill.id, skill.name, t)}
            aria-keyshortcuts="Enter E Delete"
            layout
            transition={{
              layout: { type: 'spring', stiffness: 350, damping: 28 }
            }}
          >
            {/* 顶部区域：标题与操作 */}
            <div className="mb-1.5 flex items-start justify-between gap-2.5 sm:mb-2">
              <div className={cn('min-w-0 flex-1 flex flex-col gap-0.5', isDisabledSkill && 'opacity-60')}>
                <div className="flex items-center gap-1.5">
                  <h3 className="truncate text-base font-medium leading-snug text-foreground sm:text-sm sm:leading-tight">
                    {getLocalizedSkillName(skill.id, skill.name, t)}
                  </h3>
                  {/* 收藏按钮 - hover 或已收藏时显示;触屏常显（通过伪元素扩区保证 44px 触控命中而不撑高标题行） */}
                  <DsButton variant="ghost" size="icon" iconOnly
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(skill.id); }}
                    className={cn('!h-6 !w-6 !p-0 flex-shrink-0 transition-opacity duration-200', coarseHitClassFor24, isFavorite(skill.id) ? 'opacity-100 text-[color:hsl(var(--warning))]' : cn(isTouchPrimary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100', 'text-muted-foreground/40 hover:text-[color:hsl(var(--warning))]'))}
                    title={isFavorite(skill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                    aria-label={isFavorite(skill.id) ? t('skills:favorite.remove') : t('skills:favorite.add')}
                  >
                    <Star size={14} className={isFavorite(skill.id) ? 'fill-current' : ''} />
                  </DsButton>
                </div>
                
                {/* 元信息行：有版本或作者时才渲染，避免空行拉高卡片 */}
                {(skill.version || skill.author) && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground/65">
                    {skill.version && <span className="tabular-nums">v{skill.version}</span>}
                    {skill.version && skill.author && <span className="h-0.5 w-0.5 rounded-full bg-border" />}
                    {skill.author && (
                      <span className="max-w-[120px] truncate">{skill.author}</span>
                    )}
                  </div>
                )}
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
                      "flex items-center justify-center px-2 py-0.5 rounded-full text-2xs font-medium transition-colors cursor-pointer border select-none",
                      coarseHitClassFor24,
                      isDefaultEnabled 
                        ? "bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] border-transparent"
                        : "bg-transparent text-muted-foreground/50 border-transparent hover:bg-[color:var(--button-utility-hover)] hover:text-muted-foreground"
                    )}
                    title={isDefaultEnabled ? t('skills:management.is_default') : t('skills:management.set_default')}
                 >
                    {isDefaultEnabled ? t('skills:management.default_abbr') : <span className={cn('transition-opacity', isTouchPrimary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>{t('skills:management.set_default')}</span>}
                 </div>
              </div>
            </div>

            {/* 内容描述：移动端收敛为 2 行，提升一屏浏览效率 */}
            <div className={cn('flex-1 sm:min-h-[3rem]', isDisabledSkill && 'opacity-60')}>
              <p className="text-ui text-muted-foreground/80 leading-relaxed line-clamp-2 sm:text-xs sm:line-clamp-3">
                {getLocalizedSkillDescription(skill.id, skill.description, t) || t('skills:management.no_description')}
              </p>
            </div>

            {/* 底部标签栏 */}
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[color:var(--shell-workspace-border)] pt-2.5 sm:mt-3 sm:pt-3">
              <div className={cn('flex min-w-0 items-center gap-1.5 sm:gap-2', isDisabledSkill && 'opacity-60')}>
                {/* 位置标签 */}
                <SkillPackageSummary skill={skill} variant="card" />

                {/* 停用标记 */}
                {isDisabledSkill && (
                  <div
                    className="study-shell-badge study-shell-badge--borderless text-2xs"
                    title={t('skills:package.disabled_hint')}
                  >
                    {t('skills:package.disabled_badge')}
                  </div>
                )}

                {/* 自定义标记 */}
                {isBuiltin && isCustomized && (
                  <div className="study-shell-badge study-shell-badge--warning study-shell-badge--borderless text-2xs">
                    {t('skills:management.customized')}
                  </div>
                )}
              </div>

              {/* 右下角操作按钮 */}
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {/* 停用/启用开关（仅已信任/内置技能显示；未信任外部技能统一由左侧「信任此技能」主按钮接管，避免同时出现「待信任（未注入）」与「停用」的矛盾双态） */}
                {!isUntrustedExternal && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-testid={`skill-card-toggle-${skill.id}`}
                    className={cn(
                      '!h-auto !rounded-lg !px-2.5 !py-1 max-lg:!h-9 max-lg:!px-2.5 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!px-2.5 text-xs font-medium',
                      isDisabledSkill
                        ? 'border-primary/35 bg-primary/10 text-primary hover:bg-primary/20'
                        : 'border-border/60 bg-background/40 text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setSkillDisabled(skill.id, !isDisabledSkill)}
                    title={
                      isDisabledSkill
                        ? t('skills:package.enable')
                        : t('skills:package.disable')
                    }
                    aria-label={
                      isDisabledSkill
                        ? t('skills:package.enable')
                        : t('skills:package.disable')
                    }
                  >
                    {isDisabledSkill
                      ? t('skills:package.enable')
                      : t('skills:package.disable')}
                  </DsButton>
                )}
                <DsButton variant="ghost" size="icon" iconOnly className="!h-9 !w-9 !p-1.5 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 text-muted-foreground/70 hover:text-foreground" onClick={() => { const cardEl = cardRefs.current[skill.id]; const rect = cardEl?.getBoundingClientRect(); onEdit(skill, rect); }} title={t('common:actions.edit')} aria-label={t('common:actions.edit')}>
                  <Pencil size={15} />
                </DsButton>

                <AppMenu>
                  <AppMenuTrigger asChild>
                    <DsButton variant="ghost" size="icon" iconOnly data-testid={`skill-card-more-${skill.id}`} className="!h-9 !w-9 !p-1.5 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 text-muted-foreground/70 hover:text-foreground" title={t('common:more')} aria-label={t('common:more')}>
                      <DotsThree size={16} />
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
                      onClick={() => {
                        void (async () => {
                          try {
                            const copied = await copyTextToClipboard(skill.id);
                            if (copied) {
                              showGlobalNotification('success', t('common:copied'));
                            } else {
                              showGlobalNotification('error', t('common:copy_failed'));
                            }
                          } catch (error: unknown) {
                            showGlobalNotification('error', getErrorMessage(error));
                          }
                        })();
                      }}
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
                          disabled={disabled}
                          data-testid={`skill-card-delete-${skill.id}`}
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
