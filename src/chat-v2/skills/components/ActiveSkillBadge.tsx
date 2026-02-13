/**
 * Chat V2 - ActiveSkillBadge 组件
 *
 * 显示当前激活的技能，支持多选模式
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import { getLocalizedSkillName } from '../utils';
import type { SkillDefinition } from '../types';

// ============================================================================
// 类型定义
// ============================================================================

export interface ActiveSkillBadgeProps {
  /** 当前激活的技能 ID（单选，向后兼容） */
  activeSkillId?: string | null;

  /** 当前激活的技能 ID 列表（多选模式） */
  activeSkillIds?: string[];

  /** 取消激活回调（单选模式：取消当前；多选模式用 onDeactivateSkill） */
  onDeactivate?: () => void;

  /** 取消激活指定技能（多选模式） */
  onDeactivateSkill?: (skillId: string) => void;

  /** 点击徽章回调（可用于打开技能选择器） */
  onClick?: () => void;

  /** 是否禁用操作 */
  disabled?: boolean;

  /** 是否显示取消按钮 */
  showCloseButton?: boolean;

  /** 尺寸 */
  size?: 'sm' | 'md';

  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 内部单个徽章
// ============================================================================

interface SingleBadgeProps {
  skill: SkillDefinition;
  onClose?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  disabled: boolean;
  showCloseButton: boolean;
  size: 'sm' | 'md';
  className?: string;
}

const SingleBadge: React.FC<SingleBadgeProps> = ({
  skill,
  onClose,
  onClick,
  disabled,
  showCloseButton,
  size,
  className,
}) => {
  const { t } = useTranslation(['skills']);

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-sm gap-1.5',
  };
  const iconSize = size === 'sm' ? 12 : 14;

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md',
        'bg-muted/80 text-primary',
        'transition-all duration-200',
        !disabled && onClick && 'cursor-pointer hover:bg-muted',
        disabled && 'opacity-50 cursor-not-allowed',
        sizeClasses[size],
        className
      )}
      onClick={!disabled ? onClick : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && !disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <Zap size={iconSize} className="flex-shrink-0" />
      <span className="font-medium truncate max-w-[120px]">
        {getLocalizedSkillName(skill.id, skill.name, t)}
      </span>
      {showCloseButton && onClose && (
        <button
          type="button"
          onClick={onClose}
          disabled={disabled}
          className={cn(
            'flex-shrink-0 rounded p-0.5 ml-0.5',
            'hover:bg-foreground/10 transition-colors',
            'focus:outline-none',
            disabled && 'pointer-events-none'
          )}
          aria-label={t('skills:deactivate')}
        >
          <X size={iconSize - 2} />
        </button>
      )}
    </div>
  );
};

// ============================================================================
// 主组件（支持多选）
// ============================================================================

/**
 * 激活技能徽章组件
 *
 * 支持单选（activeSkillId）和多选（activeSkillIds）模式。
 * 多选时渲染多个并排的徽章。
 */
export const ActiveSkillBadge: React.FC<ActiveSkillBadgeProps> = ({
  activeSkillId,
  activeSkillIds,
  onDeactivate,
  onDeactivateSkill,
  onClick,
  disabled = false,
  showCloseButton = true,
  size = 'md',
  className,
}) => {
  // 合并单选和多选 ID
  const effectiveIds = useMemo(() => {
    if (activeSkillIds && activeSkillIds.length > 0) return activeSkillIds;
    if (activeSkillId) return [activeSkillId];
    return [];
  }, [activeSkillId, activeSkillIds]);

  const [skills, setSkills] = useState<SkillDefinition[]>([]);

  useEffect(() => {
    const updateSkills = () => {
      const resolved = effectiveIds
        .map((id) => skillRegistry.get(id))
        .filter((s): s is SkillDefinition => !!s);
      setSkills(resolved);
    };
    updateSkills();
    const unsubscribe = subscribeToSkillRegistry(updateSkills);
    return unsubscribe;
  }, [effectiveIds]);

  if (skills.length === 0) {
    return null;
  }

  return (
    <div className={cn('inline-flex items-center gap-1 flex-wrap', className)}>
      {skills.map((skill) => (
        <SingleBadge
          key={skill.id}
          skill={skill}
          onClick={onClick}
          disabled={disabled}
          showCloseButton={showCloseButton}
          size={size}
          onClose={
            (onDeactivateSkill || onDeactivate)
              ? (e: React.MouseEvent) => {
                  e.stopPropagation();
                  if (disabled) return;
                  if (onDeactivateSkill) {
                    onDeactivateSkill(skill.id);
                  } else if (onDeactivate) {
                    onDeactivate();
                  }
                }
              : undefined
          }
        />
      ))}
    </div>
  );
};

// ============================================================================
// 变体组件
// ============================================================================

/**
 * 紧凑版激活技能徽章
 *
 * 用于空间有限的场景
 */
export const ActiveSkillBadgeCompact: React.FC<
  Omit<ActiveSkillBadgeProps, 'size' | 'showCloseButton'>
> = (props) => {
  return (
    <ActiveSkillBadge
      {...props}
      size="sm"
      showCloseButton={false}
    />
  );
};

// ============================================================================
// 辅助组件：无技能时的占位提示
// ============================================================================

export interface NoActiveSkillProps {
  /** 点击回调（打开技能选择器） */
  onClick?: () => void;

  /** 是否禁用 */
  disabled?: boolean;

  /** 尺寸 */
  size?: 'sm' | 'md';

  /** 自定义类名 */
  className?: string;
}

/**
 * 无激活技能时的占位按钮
 */
export const NoActiveSkillButton: React.FC<NoActiveSkillProps> = ({
  onClick,
  disabled = false,
  size = 'md',
  className,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-sm gap-1.5',
  };

  const iconSize = size === 'sm' ? 12 : 14;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center rounded-full',
        'bg-muted text-muted-foreground border border-border',
        'transition-all duration-200',
        'hover:bg-accent hover:text-accent-foreground hover:border-primary/30',
        'focus:outline-none focus:ring-2 focus:ring-primary/20',
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        sizeClasses[size],
        className
      )}
      aria-label={t('skills:selectSkill')}
    >
      <Zap size={iconSize} className="flex-shrink-0" />
      <span className="font-medium">
        {t('skills:selectSkill')}
      </span>
    </button>
  );
};

export default ActiveSkillBadge;
