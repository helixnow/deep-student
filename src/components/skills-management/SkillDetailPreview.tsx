/**
 * SkillDetailPreview - 技能只读详情预览抽屉/弹层
 *
 * 点击技能卡片时默认进入只读详情视图（展示名称、描述、触发方式、权限/来源、正文指令），
 * 不直接进入可写表单；用户需显式点击「编辑」按钮才会进入编辑模式。
 */

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Lightning,
  Pencil,
  Terminal,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { SkillDefinition } from '@/features/chat/skills/types';
import {
  getLocalizedSkillDescription,
  getLocalizedSkillName,
  getLocationLabel,
  getLocationStyle,
} from '@/features/chat/skills/utils';
import { isSkillDisabled } from '@/features/chat/skills/skillEnableStorage';
import { SkillPackageSummary } from './SkillPackageSummary';

export interface SkillDetailPreviewProps {
  skill: SkillDefinition | null;
  open: boolean;
  isDefault?: boolean;
  onClose: () => void;
  onEdit: (skill: SkillDefinition) => void;
  onToggleDefault?: (skill: SkillDefinition) => void;
  onTrustChanged?: () => void;
}

export const SkillDetailPreview: React.FC<SkillDetailPreviewProps> = ({
  skill,
  open,
  isDefault = false,
  onClose,
  onEdit,
  onToggleDefault,
  onTrustChanged,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  useEffect(() => {
    if (!open || !skill) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    const unregisterBack = registerBackHandler(() => {
      onClose();
      return true;
    }, BACK_PRIORITY.overlay);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unregisterBack();
    };
  }, [open, skill, onClose]);

  if (!open || !skill) return null;

  const localizedName = getLocalizedSkillName(skill.id, skill.name, t);
  const localizedDescription = getLocalizedSkillDescription(skill.id, skill.description, t);
  const isDisabledSkill = isSkillDisabled(skill.id);
  const isPluginReadOnly = skill.sourcePath.startsWith('plugin://');
  const slashTrigger =
    skill.userInvocable === false
      ? null
      : `/${skill.id}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`;
  const allowedTools = skill.allowedTools ?? skill.tools ?? [];
  const dependencies = skill.dependencies ?? [];
  const relatedSkills = skill.relatedSkills ?? [];

  return (
    <div
      className="absolute inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-[1px]"
      data-testid="skill-detail-preview-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-detail-preview-title"
        data-testid="skill-detail-preview"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col border-l border-border/60 bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/50 px-5 py-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Lightning size={16} className="shrink-0 text-primary" aria-hidden="true" />
              <h2
                id="skill-detail-preview-title"
                data-testid="skill-detail-name"
                className="truncate text-base font-semibold text-foreground"
              >
                {localizedName}
              </h2>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-2xs font-medium',
                  getLocationStyle(skill.location),
                )}
              >
                {getLocationLabel(skill.location, t)}
              </span>
              {isDefault && (
                <span className="inline-flex items-center gap-0.5 rounded bg-success/10 px-1.5 py-0.5 text-2xs font-medium text-success">
                  <Check size={10} />
                  {t('skills:default.isDefault', { defaultValue: '默认开启' })}
                </span>
              )}
              {isDisabledSkill && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                  {t('skills:package.disabled_badge', { defaultValue: '已停用' })}
                </span>
              )}
              {skill.isBuiltin && skill.isCustomized && (
                <span className="study-shell-badge study-shell-badge--warning study-shell-badge--borderless text-2xs">
                  {t('skills:management.customized', { defaultValue: '已修改' })}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                {skill.id}
              </code>
              {skill.version && <span className="tabular-nums">v{skill.version}</span>}
              {skill.author && <span>· {skill.author}</span>}
              {skill.skillType && (
                <span>
                  ·{' '}
                  {skill.skillType === 'composite'
                    ? t('skills:skillType.composite', { defaultValue: '整合型' })
                    : t('skills:skillType.standalone', { defaultValue: '独立型' })}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {onToggleDefault && (
              <DsButton
                variant="outline"
                size="sm"
                onClick={() => onToggleDefault(skill)}
                className="!h-8 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {isDefault
                  ? t('skills:management.unset_default', { defaultValue: '取消默认' })
                  : t('skills:management.set_default', { defaultValue: '设为默认' })}
              </DsButton>
            )}
            {!isPluginReadOnly && (
              <DsButton
                variant="primary"
                size="sm"
                data-testid="skill-detail-edit-button"
                onClick={() => onEdit(skill)}
                className="!h-8 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                <Pencil size={13} className="mr-1" aria-hidden="true" />
                {t('common:actions.edit', { defaultValue: '编辑' })}
              </DsButton>
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              data-testid="skill-detail-close-button"
              onClick={onClose}
              aria-label={t('common:actions.close', { defaultValue: '关闭' })}
              title={t('common:actions.close', { defaultValue: '关闭' })}
              className="!h-8 !w-8 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            >
              <X size={16} />
            </DsButton>
          </div>
        </div>

        {/* Read-only body */}
        <CustomScrollArea className="flex-1 min-h-0" viewportClassName="px-5 py-4 space-y-5">
          {/* Description */}
          <section className="space-y-1.5" data-testid="skill-detail-description">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('skills:editor.description', { defaultValue: '描述' })}
            </h3>
            <p className="text-sm leading-relaxed text-foreground/90">
              {localizedDescription || t('skills:management.no_description', { defaultValue: '暂无描述' })}
            </p>
          </section>

          {/* Trigger & Invocation */}
          <section className="space-y-2" data-testid="skill-detail-trigger">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('skills:preview.triggerHeading', { defaultValue: '触发方式与调用条件' })}
            </h3>
            <div className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t('skills:preview.slashTrigger', { defaultValue: '斜杠触发命令' })}
                </span>
                {slashTrigger ? (
                  <code className="inline-flex items-center gap-1 rounded bg-background px-2 py-0.5 font-mono text-xs text-primary border border-border/50">
                    <Terminal size={12} aria-hidden="true" />
                    {slashTrigger}
                  </code>
                ) : (
                  <span className="text-muted-foreground">
                    {t('skills:preview.slashDisabled', { defaultValue: '已禁用斜杠触发' })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t('skills:preview.autoInvoke', { defaultValue: '自动触发策略' })}
                </span>
                <span className="font-medium text-foreground/90">
                  {skill.disableAutoInvoke
                    ? t('skills:editor.disable_auto_invoke_hint', { defaultValue: '开启后需手动激活此技能' })
                    : t('skills:preview.autoInvokeEnabled', { defaultValue: '允许自动发现与手动绑定' })}
                </span>
              </div>

              {dependencies.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/30">
                  <span className="text-muted-foreground">
                    {t('skills:editor.dependencies', { defaultValue: '依赖技能' })}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {dependencies.map((dep) => (
                      <code key={dep} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {dep}
                      </code>
                    ))}
                  </div>
                </div>
              )}

              {relatedSkills.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/30">
                  <span className="text-muted-foreground">
                    {t('skills:editor.related_skills', { defaultValue: '关联技能' })}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {relatedSkills.map((rel) => (
                      <code key={rel} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {rel}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Permissions & Source */}
          <section className="space-y-2" data-testid="skill-detail-permissions">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('skills:preview.permissionsHeading', { defaultValue: '来源与权限摘要' })}
            </h3>
            <SkillPackageSummary
              skill={skill}
              variant="editor"
              onTrustChanged={onTrustChanged}
            />
            {allowedTools.length > 0 && (
              <div className="rounded-xl border border-border/40 bg-muted/20 p-3 space-y-1.5">
                <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {t('skills:preview.allowedTools', { defaultValue: '声明工具权限 (allowed-tools)' })}
                </div>
                <div className="flex flex-wrap gap-1">
                  {allowedTools.map((tool) => (
                    <span
                      key={tool}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground/80"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Instructions / Body (strictly read-only) */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('skills:editor.content', { defaultValue: '指令内容' })}
              </h3>
              <span className="text-[11px] text-muted-foreground/70">
                {t('skills:preview.readOnlyBadge', { defaultValue: '只读预览' })}
              </span>
            </div>
            <pre
              data-testid="skill-detail-body"
              className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/40 bg-muted/25 p-3.5 font-mono text-xs leading-relaxed text-foreground/90 select-text"
            >
              {skill.content?.trim()
                ? skill.content
                : t('skills:parser.emptyContent', { defaultValue: '暂无指令内容' })}
            </pre>
          </section>
        </CustomScrollArea>
      </div>
    </div>
  );
};

export default SkillDetailPreview;
