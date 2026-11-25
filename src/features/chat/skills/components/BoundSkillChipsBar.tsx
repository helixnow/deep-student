/**
 * BoundSkillChipsBar - Chat 侧已绑定技能芯片条
 *
 * 在对话输入栏上方展示当前会话手动绑定/激活的技能，提供清晰的可见状态与一键解绑（×）入口。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassForBadge16 } from '@/components/ui/coarseHit';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import { getLocalizedSkillName } from '../utils';

export interface BoundSkillChipsBarProps {
  /** 当前绑定的技能 ID 列表 */
  skillIds: string[];
  /** 一键解绑单个技能回调 */
  onUnbindSkill: (skillId: string) => void;
  /** 清空全部已绑定技能（可选，2 个及以上技能时显示） */
  onClearAll?: () => void;
  /** 点击技能标签主体（可选，用于打开技能选择面板） */
  onOpenSelector?: () => void;
  /** 是否禁用交互（如流式生成中） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

export const BoundSkillChipsBar: React.FC<BoundSkillChipsBarProps> = ({
  skillIds,
  onUnbindSkill,
  onClearAll,
  onOpenSelector,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const [registryVersion, setRegistryVersion] = useState(0);

  useEffect(() => {
    return subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
  }, []);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const resolved: Array<{ id: string; name: string }> = [];
    for (const rawId of skillIds) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const skill = skillRegistry.get(id);
      const name = skill
        ? getLocalizedSkillName(skill.id, skill.name, t)
        : getLocalizedSkillName(id, id, t);
      resolved.push({ id, name });
    }
    return resolved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillIds, registryVersion, t]);

  if (items.length === 0) return null;

  return (
    <div
      data-testid="bound-skill-chips-bar"
      role="region"
      aria-label={t('skills:active', { defaultValue: '已绑定技能' })}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`bound-skill-chip-${item.id}`}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary transition-colors',
            disabled && 'opacity-60',
          )}
        >
          {onOpenSelector ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onOpenSelector}
              className="inline-flex min-w-0 items-center gap-1 text-left hover:opacity-80 disabled:pointer-events-none"
              title={`${item.name} (/${item.id})`}
            >
              <Lightning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
              <span className="max-w-[160px] truncate">{item.name}</span>
            </button>
          ) : (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={`${item.name} (/${item.id})`}
            >
              <Lightning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
              <span className="max-w-[160px] truncate">{item.name}</span>
            </span>
          )}

          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            disabled={disabled}
            data-testid={`unbind-skill-${item.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onUnbindSkill(item.id);
            }}
            aria-label={t('skills:badge.unbindNamed', {
              defaultValue: '解绑技能：{{name}}',
              name: item.name,
            })}
            title={t('skills:deactivate', { defaultValue: '取消激活' })}
            className={cn(
              '!h-4 !w-4 !rounded-full !p-0 text-primary/75 hover:bg-primary/15 hover:text-primary relative',
              coarseHitClassForBadge16,
            )}
          >
            <X size={10} weight="bold" aria-hidden="true" />
          </DsButton>
        </div>
      ))}

      {items.length > 1 && onClearAll && !disabled && (
        <DsButton
          variant="ghost"
          size="sm"
          data-testid="unbind-all-skills"
          onClick={onClearAll}
          className="!h-6 !px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
          title={t('common:actions.clear_all', { defaultValue: '清空全部' })}
        >
          {t('common:actions.clear_all', { defaultValue: '清空全部' })}
        </DsButton>
      )}
    </div>
  );
};

export default BoundSkillChipsBar;
