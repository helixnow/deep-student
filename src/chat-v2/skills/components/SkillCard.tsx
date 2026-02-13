/**
 * Chat V2 - SkillCard 组件
 *
 * 单个技能卡片，显示技能信息和激活操作
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Zap, Check, MapPin, User, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SkillMetadata, SkillLocation } from '../types';
import { getLocalizedSkillDescription, getLocalizedSkillName, getLocationLabel, getLocationStyle } from '../utils';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillCardProps {
  /** 技能元数据 */
  skill: SkillMetadata;

  /** 是否激活状态 */
  isActive?: boolean;

  /** 来源位置（可选，用于显示位置标签） */
  location?: SkillLocation;

  /** 激活/取消激活回调 */
  onToggle?: (skillId: string) => void;

  /** 是否禁用操作 */
  disabled?: boolean;

  /** 紧凑模式 */
  compact?: boolean;

  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件
// ============================================================================

/**
 * 技能卡片组件
 */
export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  isActive = false,
  location,
  onToggle,
  disabled = false,
  compact = false,
  className,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  const handleClick = () => {
    if (!disabled && onToggle) {
      onToggle(skill.id);
    }
  };

  const toolCount =
    (skill.embeddedTools?.length ?? 0) > 0
      ? skill.embeddedTools!.length
      : (skill.allowedTools ?? skill.tools)?.length ?? 0;

  return (
    <div
      className={cn(
        'group relative rounded-lg border transition-all duration-200',
        isActive
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-card hover:border-primary/50 hover:shadow-sm',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && 'cursor-pointer',
        compact ? 'p-2' : 'p-3',
        // 为右侧激活按钮预留空间，避免内容溢出
        !disabled && !compact && 'pr-16',
        className
      )}
      onClick={handleClick}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      aria-pressed={isActive}
      aria-disabled={disabled}
    >
      {/* 头部：名称和版本 */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {/* 激活状态指示 */}
          {isActive && (
            <span className="flex-shrink-0 text-primary">
              <Check size={14} />
            </span>
          )}

          {/* 技能名称 */}
          <span
            className={cn(
              'font-medium truncate',
              compact ? 'text-sm' : 'text-base',
              isActive ? 'text-primary' : 'text-foreground'
            )}
          >
            {getLocalizedSkillName(skill.id, skill.name, t)}
          </span>

          {/* 版本号 */}
          {skill.version && !compact && (
            <span className="flex-shrink-0 text-xs text-muted-foreground">
              v{skill.version}
            </span>
          )}
        </div>

        {/* 位置标签 */}
        {location && (
          <span
            className={cn(
              'flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded',
              getLocationStyle(location)
            )}
          >
            {getLocationLabel(location, t)}
          </span>
        )}
      </div>

      {/* 描述 */}
      {!compact && (
        <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
          {getLocalizedSkillDescription(skill.id, skill.description, t)}
        </p>
      )}

      {/* 底部：工具和作者信息 */}
      {!compact && (toolCount > 0 || skill.author) && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {/* 关联工具 */}
          {toolCount > 0 && (
            <div className="flex items-center gap-1">
              <Wrench size={12} />
              <span>{t('skills:card.toolsCount', { count: toolCount })}</span>
            </div>
          )}

          {/* 作者 */}
          {skill.author && (
            <div className="flex items-center gap-1">
              <User size={12} />
              <span className="truncate max-w-[100px]">{skill.author}</span>
            </div>
          )}
        </div>
      )}

      {/* 激活按钮（hover 时显示） */}
      {!disabled && !compact && (
        <div
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 transition-opacity duration-200',
            'opacity-0 group-hover:opacity-100',
            isActive && 'opacity-100'
          )}
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary'
            )}
          >
            {isActive ? (
              <>
                <Check size={12} />
                {t('skills:card.activated')}
              </>
            ) : (
              <>
                <Zap size={12} />
                {t('skills:card.activate')}
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
};

export default SkillCard;
