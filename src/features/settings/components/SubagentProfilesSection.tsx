import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsClockwise,
  Check,
  Copy,
  FolderOpen,
  Robot,
  UsersThree,
  WarningCircle,
} from '@phosphor-icons/react';

import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/utils/cn';
import { showGlobalNotification } from '@/components/UnifiedNotification';

/** 后端 workspace_list_agent_profiles 返回的单个档案摘要（camelCase）。 */
interface AgentProfileSummary {
  id: string;
  description: string | null;
  /** 自定义档案的 base 档案 id；后端当前恒为 null（AgentProfile 未存 base）。 */
  base: string | null;
  model: string | null;
  toolCount: number;
  isBuiltin: boolean;
}

interface ListAgentProfilesResponse {
  profiles: AgentProfileSummary[];
  agentsDir: string;
}

const isTauri =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

const BUILTIN_PROFILE_IDS = ['default', 'worker', 'explorer'] as const;

type BuiltinProfileId = (typeof BUILTIN_PROFILE_IDS)[number];

const isBuiltinProfileId = (id: string): id is BuiltinProfileId =>
  (BUILTIN_PROFILE_IDS as readonly string[]).includes(id);

const COPY_FEEDBACK_TIMEOUT_MS = 2_000;

export const SubagentProfilesSection: React.FC = () => {
  const { t } = useTranslation(['settings']);
  const [loading, setLoading] = useState<boolean>(isTauri);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [agentsDir, setAgentsDir] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!isTauri) return;
    setLoading(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const response = await invoke<ListAgentProfilesResponse>('workspace_list_agent_profiles');
      setProfiles(response.profiles);
      setAgentsDir(response.agentsDir);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [load]);

  const handleOpenDir = useCallback(async () => {
    if (!agentsDir) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(agentsDir);
    } catch (e) {
      console.error('[SubagentProfilesSection] Failed to reveal agents dir:', e);
      showGlobalNotification('error', t('settings:subagentProfiles.errors.reveal_failed'));
    }
  }, [agentsDir, t]);

  const template = t('settings:subagentProfiles.empty.template');

  const handleCopyTemplate = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
    } catch (e) {
      console.error('[SubagentProfilesSection] Failed to copy template:', e);
      showGlobalNotification('error', t('settings:subagentProfiles.errors.copy_failed'));
    }
  }, [template, t]);

  const builtinDisplayName = (id: string): string =>
    isBuiltinProfileId(id) ? t(`settings:subagentProfiles.builtin_names.${id}`) : id;

  const customProfiles = profiles.filter((profile) => !profile.isBuiltin);

  const renderRow = (profile: AgentProfileSummary) => (
    <div
      key={profile.id}
      className={cn(
        'flex items-start justify-between gap-3 rounded-[var(--radius-shell-row,0.5rem)] border px-3 py-2.5',
        profile.isBuiltin
          ? 'border-[color:var(--border-soft)]'
          : 'border-primary/25 bg-primary/[0.03]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {profile.isBuiltin ? builtinDisplayName(profile.id) : profile.id}
          </span>
          {profile.isBuiltin ? (
            <>
              <code className="text-xs text-muted-foreground/70">{profile.id}</code>
              <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                {t('settings:subagentProfiles.builtin_badge')}
              </span>
            </>
          ) : (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
              {t('settings:subagentProfiles.custom_badge')}
            </span>
          )}
        </div>
        {profile.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
            {profile.description}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
          {profile.model && (
            <span>{t('settings:subagentProfiles.model', { model: profile.model })}</span>
          )}
          <span>{t('settings:subagentProfiles.tool_count', { count: profile.toolCount })}</span>
        </p>
      </div>
    </div>
  );

  return (
    <section
      aria-labelledby="subagent-profiles-title"
      className="space-y-4 rounded-2xl border border-border/40 bg-background px-3 py-3 sm:px-4"
    >
      <header className="flex flex-col gap-3 px-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <UsersThree className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <h2 id="subagent-profiles-title" className="text-base font-semibold text-foreground">
              {t('settings:subagentProfiles.title')}
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground/80">
            {t('settings:subagentProfiles.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('settings:subagentProfiles.actions.refresh')}
            title={t('settings:subagentProfiles.actions.refresh')}
            disabled={loading}
            onClick={() => void load()}
          >
            <ArrowsClockwise className={cn('h-4 w-4', loading && 'animate-spin')} />
          </NotionButton>
          <NotionButton
            variant="secondary"
            size="sm"
            disabled={!agentsDir}
            onClick={() => void handleOpenDir()}
          >
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
            {t('settings:subagentProfiles.actions.open_dir')}
          </NotionButton>
        </div>
      </header>

      {!isTauri ? (
        <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {t('settings:subagentProfiles.errors.desktop_only')}
        </p>
      ) : error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
        >
          <span className="flex min-w-0 items-start gap-2">
            <WarningCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-words">{error}</span>
          </span>
          <NotionButton variant="ghost" size="sm" onClick={() => void load()}>
            {t('settings:subagentProfiles.actions.retry')}
          </NotionButton>
        </div>
      ) : loading && profiles.length === 0 ? (
        <div aria-label={t('settings:subagentProfiles.loading')} className="space-y-1">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="flex min-h-14 animate-pulse items-center gap-4 rounded-[var(--radius-shell-row,0.5rem)] px-3 py-3"
            >
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 max-w-full rounded bg-muted" />
                <div className="h-3 w-64 max-w-full rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="space-y-1">{profiles.map(renderRow)}</div>

          {customProfiles.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-4 py-6">
              <div className="text-center">
                <Robot className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
                <h3 className="mt-3 text-sm font-medium text-foreground">
                  {t('settings:subagentProfiles.empty.title')}
                </h3>
                <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                  {t('settings:subagentProfiles.empty.description')}
                </p>
              </div>
              <div className="mx-auto mt-4 max-w-xl">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('settings:subagentProfiles.empty.template_hint')}
                  </span>
                  <NotionButton variant="ghost" size="sm" onClick={() => void handleCopyTemplate()}>
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {copied
                      ? t('settings:subagentProfiles.actions.copied')
                      : t('settings:subagentProfiles.actions.copy_template')}
                  </NotionButton>
                </div>
                <pre className="mt-1 overflow-x-auto rounded-md border border-[color:var(--border-soft)] bg-muted/30 px-3 py-2.5 text-xs leading-relaxed text-foreground">
                  {template}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default SubagentProfilesSection;
