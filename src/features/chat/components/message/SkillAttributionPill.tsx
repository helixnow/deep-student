import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, X } from '@phosphor-icons/react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { cn } from '@/lib/utils';
import { skillRegistry } from '../../skills/registry';
import { getLocalizedSkillName } from '../../skills/utils';
import {
  buildSkillSnapshotKey,
  clearPersistedMessageSkillSnapshots,
  extractBoundSkillIdsFromSession,
  extractMessageSkillSnapshotFromMeta,
  getPersistedMessageSkillSnapshot,
  savePersistedMessageSkillSnapshot,
  snapshotFromSkillIds,
  type MessageSkillAttributionSnapshot,
  type SkillAttributionSource,
} from './skillAttributionSnapshot';

export { clearPersistedMessageSkillSnapshots };
export type { MessageSkillAttributionSnapshot };

export interface SkillAttributionPillProps {
  className?: string;
  /** Compact icon-only presentation for narrow mobile footers (keeps accessible sr-only summary). */
  compact?: boolean;
  messageId?: string;
  sessionId?: string | null;
  variantId?: string | null;
  messageMeta?: Record<string, unknown> | null;
  variantMeta?: Record<string, unknown> | null;
  /** Session-level active skill IDs (used only once to capture snapshot if metadata lacks one). */
  sessionActiveSkillIds?: string[];
  /** Session-level structured skillStateJson (preferred over sessionActiveSkillIds for initial capture). */
  sessionSkillStateJson?: string | null;
  /** Explicit per-message snapshot override (immutable). */
  messageSnapshot?: MessageSkillAttributionSnapshot | null;
}

export const SkillAttributionPill: React.FC<SkillAttributionPillProps> = ({
  className,
  compact = false,
  messageId,
  sessionId,
  variantId,
  messageMeta,
  variantMeta,
  sessionActiveSkillIds,
  sessionSkillStateJson,
  messageSnapshot,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const [open, setOpen] = useState(false);

  const resolveLocalizedName = useCallback(
    (skillId: string): string => {
      const skill = skillRegistry.get(skillId);
      if (skill) {
        return getLocalizedSkillName(skill.id, skill.name, t);
      }
      return getLocalizedSkillName(skillId, skillId, t);
    },
    [t],
  );

  const snapshotKey = useMemo(
    () => buildSkillSnapshotKey({ sessionId, messageId, variantId }),
    [sessionId, messageId, variantId],
  );

  const metaSnapshot = useMemo(
    () =>
      messageSnapshot ??
      extractMessageSkillSnapshotFromMeta(messageMeta, variantMeta, resolveLocalizedName),
    [messageSnapshot, messageMeta, variantMeta, resolveLocalizedName],
  );

  const [persistedSnapshot, setPersistedSnapshot] = useState<MessageSkillAttributionSnapshot | null>(
    () => (snapshotKey ? getPersistedMessageSkillSnapshot(snapshotKey) : null),
  );

  useEffect(() => {
    setPersistedSnapshot(snapshotKey ? getPersistedMessageSkillSnapshot(snapshotKey) : null);
  }, [snapshotKey]);

  const initialBoundIds = useMemo(
    () => extractBoundSkillIdsFromSession(sessionSkillStateJson, sessionActiveSkillIds),
    [sessionSkillStateJson, sessionActiveSkillIds],
  );

  // Capture & freeze write-once snapshot on settle so later composer unbind/rebind never mutates old turns.
  useEffect(() => {
    if (!snapshotKey || persistedSnapshot) return;
    if (metaSnapshot) {
      const saved = savePersistedMessageSkillSnapshot(snapshotKey, metaSnapshot);
      setPersistedSnapshot(saved);
      return;
    }
    const captured = snapshotFromSkillIds(initialBoundIds, resolveLocalizedName, 'pinned');
    const saved = savePersistedMessageSkillSnapshot(snapshotKey, captured);
    setPersistedSnapshot(saved);
  }, [snapshotKey, persistedSnapshot, metaSnapshot, initialBoundIds, resolveLocalizedName]);

  const effectiveSnapshot: MessageSkillAttributionSnapshot | null = useMemo(() => {
    if (metaSnapshot) return metaSnapshot;
    if (persistedSnapshot) return persistedSnapshot;
    if (initialBoundIds.length > 0) {
      return snapshotFromSkillIds(initialBoundIds, resolveLocalizedName, 'pinned');
    }
    return null;
  }, [metaSnapshot, persistedSnapshot, initialBoundIds, resolveLocalizedName]);

  const skills = effectiveSnapshot?.skills ?? [];
  if (skills.length === 0) return null;

  const primarySkill = skills[0];
  const pillSummary =
    skills.length === 1
      ? primarySkill.name
      : `${primarySkill.name} +${skills.length - 1}`;

  const sourceLabel = (source: SkillAttributionSource): string => {
    if (source === 'agentic') {
      return t('skills:status.toolLoadedBadge', { defaultValue: '工具已加载' });
    }
    if (source === 'runtime') {
      return t('skills:attribution.runtimeSource', { defaultValue: '本轮注入' });
    }
    return t('skills:status.manualActivated', { defaultValue: '手动激活' });
  };

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="skill-attribution-pill"
            aria-haspopup="dialog"
            className={cn(
              'pointer-events-auto inline-flex items-center gap-1 rounded-md py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground',
              compact ? 'px-1' : 'px-1.5',
              open && 'bg-muted/70 text-foreground',
            )}
            title={t('skills:attribution.pillTitle', {
              defaultValue: '查看生成本条回复时使用的技能快照',
            })}
          >
            <Lightning className="h-3 w-3 shrink-0 opacity-75" />
            <span className={compact ? 'sr-only' : 'max-w-[160px] truncate'}>
              {t('skills:title', { defaultValue: '技能' })} · {pillSummary}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          data-testid="skill-attribution-popover"
          side="top"
          align="start"
          sideOffset={6}
          className="w-72 max-w-[90vw] p-3 text-xs text-popover-foreground"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 font-medium">
                <Lightning className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span>
                  {t('skills:attribution.panelTitle', { defaultValue: '本轮已使用技能' })}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t('skills:attribution.panelSubtitle', {
                  defaultValue: '此快照固定记录本条回复生效的技能，后续解绑或切换不会改变历史记录。',
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('common:actions.close', { defaultValue: '关闭' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-1.5">
            {skills.map((skill) => (
              <div
                key={skill.id}
                data-testid={`skill-attribution-item-${skill.id}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground/90">{skill.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    /{skill.id}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {sourceLabel(skill.source)}
                </span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
