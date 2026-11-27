import React, { useCallback, useEffect, useState } from 'react';
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
import { isMobilePlatform, isWebUiShell } from '@/utils/platform';
import { getErrorMessage } from '@/utils/errorUtils';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24 } from '@/components/ui/coarseHit';
import { showGlobalNotification } from '../UnifiedNotification';
import type { SkillDefinition, SkillPackageFile, SkillPackageSource, SkillTrustStatus } from '@/features/chat/skills/types';
import { getSkillEmbeddedToolLabels, getSkillPermissionSummary } from '@/features/chat/skills/packageMetadata';
import {
  resolveEffectiveTrustStatus,
  setSkillTrustOverride,
  SKILL_TRUST_CHANGED_EVENT,
} from '@/features/chat/skills/skillTrustStorage';
import {
  isSkillDisabled,
  setSkillDisabled,
  SKILL_ENABLED_CHANGED_EVENT,
} from '@/features/chat/skills/skillEnableStorage';

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
        'study-shell-badge study-shell-badge--borderless inline-flex min-w-0 items-center gap-1 px-1.5 py-0.5 text-2xs',
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
  const [isTrustUpdating, setIsTrustUpdating] = useState(false);
  const trustBusyRef = React.useRef(false);
  useEffect(() => {
    const onOverrideChanged = () => setTrustTick((v) => v + 1);
    window.addEventListener(SKILL_ENABLED_CHANGED_EVENT, onOverrideChanged);
    window.addEventListener(SKILL_TRUST_CHANGED_EVENT, onOverrideChanged);
    return () => {
      window.removeEventListener(SKILL_ENABLED_CHANGED_EVENT, onOverrideChanged);
      window.removeEventListener(SKILL_TRUST_CHANGED_EVENT, onOverrideChanged);
    };
  }, []);

  const summary = getSkillPermissionSummary(skill);
  const source = skill.packageSource ?? (skill.isBuiltin ? 'builtin' : skill.location);
  const trust = resolveEffectiveTrustStatus(skill);
  const isEnabled = !isSkillDisabled(skill.id);
  const untrustedLabel =
    trust === 'untrusted' && isEnabled
      ? t('skills:package.trust_pending_injection')
      : trustLabel(trust, t);
  const files = skill.packageFiles ?? [];
  const visibleFiles = files.slice(0, 6);
  const remainingFiles = Math.max(0, files.length - visibleFiles.length);
  const canToggleTrust = !skill.isBuiltin && source !== 'builtin';
  const toolLabels = getSkillEmbeddedToolLabels(skill, 8);
  const requiresBins = skill.requires?.bins ?? [];
  const requiresEnv = skill.requires?.env ?? [];
  const hasRequires = requiresBins.length > 0 || requiresEnv.length > 0;

  const handleTrustToggle = useCallback(async () => {
    if (trustBusyRef.current) return;
    trustBusyRef.current = true;
    setIsTrustUpdating(true);
    const nextTrust = trust === 'untrusted' ? 'trusted' : 'untrusted';
    try {
      await setSkillTrustOverride(
        skill.id,
        nextTrust,
        skill,
      );
      if (nextTrust === 'trusted' && isSkillDisabled(skill.id)) {
        setSkillDisabled(skill.id, false);
      }
      setTrustTick((v) => v + 1);
      onTrustChanged?.();
      showGlobalNotification(
        'success',
        nextTrust === 'trusted'
          ? t('skills:package.trust_success')
          : t('skills:package.trust_revoked_toast'),
      );
    } catch (error) {
      console.error('[SkillTrust] Failed to update trust:', error);
      showGlobalNotification(
        'error',
        t('skills:package.trust_failed', { error: getErrorMessage(error) }),
      );
    } finally {
      trustBusyRef.current = false;
      setIsTrustUpdating(false);
    }
  }, [skill, trust, onTrustChanged, t]);

  if (variant === 'card') {
    return (
      <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
        <Chip icon={<Package size={10} />} tone={source === 'builtin' ? 'default' : 'primary'}>
          {sourceLabel(source, t)}
        </Chip>
        {trust === 'untrusted' && (
          <>
            <Chip
              icon={<ShieldWarning size={10} />}
              tone="warning"
              title={t('skills:package.trust_effect_untrusted')}
            >
              {untrustedLabel}
            </Chip>
            {canToggleTrust && (
              <DsButton
                type="button"
                variant="outline"
                size="sm"
                disabled={isTrustUpdating}
                data-testid={`skill-card-trust-${skill.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleTrustToggle();
                }}
                title={t('skills:package.trust_effect_trusted')}
                className={cn("!h-auto !rounded-full border-primary/40 bg-primary/10 !px-2 !py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20", coarseHitClassFor24)}
              >
                {t('skills:package.trust_enable')}
              </DsButton>
            )}
          </>
        )}
        {trust === 'trusted' && canToggleTrust && (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={isTrustUpdating}
            data-testid={`skill-card-revoke-trust-${skill.id}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleTrustToggle();
            }}
            title={t('skills:package.trust_effect_untrusted')}
            className={cn("!h-auto !rounded-full !px-2 !py-0.5 text-[10px] text-muted-foreground hover:text-foreground", coarseHitClassFor24)}
          >
            {t('skills:package.trust_trusted')}
          </DsButton>
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
          {untrustedLabel}
        </Chip>
        {canToggleTrust && trust === 'untrusted' && (
          <DsButton
            type="button"
            variant="primary"
            size="sm"
            disabled={isTrustUpdating}
            onClick={handleTrustToggle}
            title={t('skills:package.trust_effect_trusted')}
            className={cn("!h-auto !rounded-full border-primary/40 bg-primary/12 !px-2.5 !py-1 text-xs font-medium text-primary hover:bg-primary/20", coarseHitClassFor24)}
          >
            {t('skills:package.trust_enable')}
          </DsButton>
        )}
        {canToggleTrust && trust === 'trusted' && source === 'external' && (
          <DsButton
            type="button"
            variant="outline"
            size="sm"
            disabled={isTrustUpdating}
            onClick={handleTrustToggle}
            title={t('skills:package.trust_effect_untrusted')}
            className={cn("!h-auto !rounded-full border-border/60 bg-background/50 !px-2.5 !py-1 text-xs text-muted-foreground hover:text-foreground", coarseHitClassFor24)}
          >
            {t('skills:package.trust_revoke')}
          </DsButton>
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
          <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('skills:package.tools_heading')}
          </div>
          <div className="flex flex-wrap gap-1">
            {toolLabels.map((label) => (
              <span
                key={label}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      )}

      {skill.packageRoot && !isWebUiShell() && !isMobilePlatform() && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground/70">
          <FolderOpen size={12} className="flex-shrink-0" />
          <span className="truncate font-mono">{skill.packageRoot}</span>
        </div>
      )}

      {visibleFiles.length > 0 && (
        <div className="space-y-1.5">
          {visibleFiles.map((file) => (
            <div key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
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
            <div className="text-xs text-muted-foreground/60">
              {t('skills:package.more_files', { count: remainingFiles })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SkillPackageSummary;
