import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  FolderOpen,
  LinkSimple,
  Package,
  ShieldCheck,
  ShieldWarning,
  Terminal,
  TreeStructure,
  Wrench,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { SkillDefinition, SkillPackageFile, SkillPackageSource, SkillTrustStatus } from '@/features/chat/skills/types';
import { getSkillEmbeddedToolLabels, getSkillPermissionSummary } from '@/features/chat/skills/packageMetadata';
import { resolveEffectiveTrustStatus, setSkillTrustOverride } from '@/features/chat/skills/skillTrustStorage';

interface SkillPackageSummaryProps {
  skill: SkillDefinition;
  variant?: 'card' | 'editor';
  className?: string;
  /** 信任状态变更后回调（例如触发 reloadSkills） */
  onTrustChanged?: () => void;
}

function sourceLabel(source: SkillPackageSource | undefined, t: (key: string) => string): string {
  switch (source) {
    case 'builtin':
      return t('skills:package.source_builtin');
    case 'global':
      return t('skills:package.source_global');
    case 'project':
      return t('skills:package.source_project');
    case 'external':
      return t('skills:package.source_external');
    default:
      return t('skills:package.source_unknown');
  }
}

function trustLabel(status: SkillTrustStatus | undefined, t: (key: string) => string): string {
  switch (status) {
    case 'builtin':
      return t('skills:package.trust_builtin');
    case 'trusted':
      return t('skills:package.trust_trusted');
    case 'untrusted':
      return t('skills:package.trust_untrusted');
    default:
      return t('skills:package.trust_unknown');
  }
}

function fileKindLabel(kind: SkillPackageFile['kind'], t: (key: string) => string): string {
  switch (kind) {
    case 'entry':
      return t('skills:package.file_entry');
    case 'reference':
      return t('skills:package.file_reference');
    case 'script':
      return t('skills:package.file_script');
    case 'asset':
      return t('skills:package.file_asset');
    case 'config':
      return t('skills:package.file_config');
    default:
      return t('skills:package.file_other');
  }
}

function Chip({
  icon,
  children,
  tone = 'default',
  title,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'primary' | 'warning';
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'study-shell-badge study-shell-badge--borderless inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-[10px]',
        tone === 'primary' && 'study-shell-badge--primary',
        tone === 'warning' && 'study-shell-badge--warning',
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export const SkillPackageSummary: React.FC<SkillPackageSummaryProps> = ({
  skill,
  variant = 'card',
  className,
  onTrustChanged,
}) => {
  const { t } = useTranslation(['skills']);
  const [, setTrustTick] = useState(0);
  const summary = getSkillPermissionSummary(skill);
  const source = skill.packageSource ?? (skill.isBuiltin ? 'builtin' : skill.location);
  const trust = resolveEffectiveTrustStatus(skill);
  const files = skill.packageFiles ?? [];
  const visibleFiles = files.slice(0, 6);
  const remainingFiles = Math.max(0, files.length - visibleFiles.length);
  const canToggleTrust = !skill.isBuiltin && source !== 'builtin';
  const toolLabels = getSkillEmbeddedToolLabels(skill, 8);
  const requiresBins = skill.requires?.bins ?? [];
  const requiresEnv = skill.requires?.env ?? [];
  const hasRequires = requiresBins.length > 0 || requiresEnv.length > 0;

  const handleTrustToggle = useCallback(async () => {
    try {
      await setSkillTrustOverride(
        skill.id,
        trust === 'untrusted' ? 'trusted' : 'untrusted',
        skill,
      );
      setTrustTick((v) => v + 1);
      onTrustChanged?.();
    } catch (error) {
      console.error('[SkillTrust] Failed to update trust:', error);
    }
  }, [skill, trust, onTrustChanged]);

  if (variant === 'card') {
    return (
      <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
        <Chip icon={<Package size={10} />} tone={source === 'builtin' ? 'default' : 'primary'}>
          {sourceLabel(source, t)}
        </Chip>
        {trust === 'untrusted' && (
          <Chip
            icon={<ShieldWarning size={10} />}
            tone="warning"
            title={t('skills:package.trust_effect_untrusted')}
          >
            {trustLabel(trust, t)}
          </Chip>
        )}
        {summary.dependencies > 0 && (
          <Chip icon={<LinkSimple size={10} />}>
            {t('skills:package.dependencies_count', { count: summary.dependencies })}
          </Chip>
        )}
        {summary.embeddedTools > 0 && (
          <Chip icon={<Wrench size={10} />}>
            {summary.embeddedTools}
          </Chip>
        )}
        {summary.packageFiles > 1 && (
          <Chip icon={<TreeStructure size={10} />}>
            {summary.packageFiles}
          </Chip>
        )}
        {hasRequires && (
          <>
            {requiresBins.length > 0 && (
              <Chip icon={<Terminal size={10} />} title={requiresBins.join(', ')}>
                {t('skills:package.requires_bins', { list: requiresBins.join(', ') })}
              </Chip>
            )}
            {requiresEnv.length > 0 && (
              <Chip icon={<Terminal size={10} />} title={requiresEnv.join(', ')}>
                {t('skills:package.requires_env', { list: requiresEnv.join(', ') })}
              </Chip>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border border-border/40 bg-muted/20 p-3 space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip icon={<Package size={11} />} tone={source === 'builtin' ? 'default' : 'primary'}>
          {sourceLabel(source, t)}
        </Chip>
        <Chip
          icon={trust === 'untrusted' ? <ShieldWarning size={11} /> : <ShieldCheck size={11} />}
          tone={trust === 'untrusted' ? 'warning' : 'default'}
          title={trust === 'untrusted'
            ? t('skills:package.trust_effect_untrusted')
            : t('skills:package.trust_effect_trusted')}
        >
          {trustLabel(trust, t)}
        </Chip>
        {canToggleTrust && trust === 'untrusted' && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleTrustToggle}
            title={t('skills:package.trust_effect_trusted')}
            className="!h-auto !px-1.5 !py-0.5 max-lg:!h-9 max-lg:!px-2 text-[10px] text-primary hover:underline"
          >
            {t('skills:package.trust_enable')}
          </NotionButton>
        )}
        {canToggleTrust && trust === 'trusted' && source === 'external' && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleTrustToggle}
            title={t('skills:package.trust_effect_untrusted')}
            className="!h-auto !px-1.5 !py-0.5 max-lg:!h-9 max-lg:!px-2 text-[10px] text-muted-foreground hover:underline"
          >
            {t('skills:package.trust_revoke')}
          </NotionButton>
        )}
        <Chip icon={<Wrench size={11} />}>
          {t('skills:package.permission_tools', {
            count: summary.embeddedTools,
          })}
        </Chip>
        <Chip icon={<LinkSimple size={11} />}>
          {t('skills:package.permission_dependencies', {
            count: summary.dependencies,
          })}
        </Chip>
        <Chip icon={<TreeStructure size={11} />}>
          {t('skills:package.permission_files', {
            count: summary.packageFiles,
          })}
        </Chip>
        {summary.scripts > 0 && (
          <Chip icon={<FileText size={11} />} tone="warning">
            {t('skills:package.permission_scripts', { count: summary.scripts })}
          </Chip>
        )}
        {hasRequires && (
          <>
            {requiresBins.length > 0 && (
              <Chip icon={<Terminal size={11} />} title={requiresBins.join(', ')}>
                {t('skills:package.requires_bins', { list: requiresBins.join(', ') })}
              </Chip>
            )}
            {requiresEnv.length > 0 && (
              <Chip icon={<Terminal size={11} />} title={requiresEnv.join(', ')}>
                {t('skills:package.requires_env', { list: requiresEnv.join(', ') })}
              </Chip>
            )}
          </>
        )}
      </div>

      {toolLabels.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('skills:package.tools_heading')}
          </div>
          <div className="flex flex-wrap gap-1">
            {toolLabels.map((label) => (
              <span
                key={label}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {skill.packageRoot && (
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground/70">
          <FolderOpen size={12} className="flex-shrink-0" />
          <span className="truncate font-mono">{skill.packageRoot}</span>
        </div>
      )}

      {visibleFiles.length > 0 && (
        <div className="space-y-1.5">
          {visibleFiles.map((file) => (
            <div key={file.path} className="flex min-w-0 items-center gap-2 text-[11px]">
              <FileText size={12} className="flex-shrink-0 text-muted-foreground/60" />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/80">
                {file.path}
              </span>
              <span className="flex-shrink-0 text-muted-foreground/50">
                {fileKindLabel(file.kind, t)}
              </span>
            </div>
          ))}
          {remainingFiles > 0 && (
            <div className="text-[11px] text-muted-foreground/60">
              {t('skills:package.more_files', { count: remainingFiles })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SkillPackageSummary;
