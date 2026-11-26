import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDown,
  HandPalm,
  Pause,
  Play,
  Sparkle,
  StopCircle,
  WarningCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { useAgentMeshWorkbenchStore } from '../workbenchBridge';
import type {
  MeshBoardMessage,
  MeshCheckpointRecord,
  MeshExternalThread,
  MeshFileLease,
  MeshMemberStatus,
  MeshSwarmMember,
} from '../workbench-types';

const EMPTY_MEMBERS: readonly MeshSwarmMember[] = [];
const EMPTY_BOARD: readonly MeshBoardMessage[] = [];
const EMPTY_THREADS: readonly MeshExternalThread[] = [];
const EMPTY_CHECKPOINTS: readonly MeshCheckpointRecord[] = [];
const EMPTY_LEASES: readonly MeshFileLease[] = [];

export interface SwarmCapsuleBarProps {
  sessionId?: string | null;
  className?: string;
}

function formatAgentDisplayName(idOrRoster: string): string {
  const clean = idOrRoster.replace(/^@/, '');
  switch (clean.toLowerCase()) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'pi':
      return 'Pi';
    case 'deepstudent':
      return 'DeepStudent';
    case 'agy':
      return 'AGY';
    case 'dsh':
      return 'DSH';
    default:
      return clean;
  }
}

function formatMemberStateShort(
  member: MeshSwarmMember,
  tr: (key: string, fallback: string, vars?: Record<string, string | number>) => string,
): string {
  if (member.humanControlled) {
    return tr('capsule.stateHumanControlled', '已接管');
  }
  const status: MeshMemberStatus = member.status;
  if (status === 'waiting_children') {
    const count = Math.max(1, member.activeChildCount + member.activeBgTaskCount);
    return tr('capsule.stateWaitingChildren', '等待 {{count}} 子代理', { count });
  }
  if (status === 'waiting_approval') {
    return tr('capsule.stateWaitingApproval', '待审批');
  }
  if (status === 'working') {
    return member.currentActivity?.trim() || tr('capsule.stateWorking', '运行中');
  }
  if (status === 'failed') {
    return tr('capsule.stateFailed', '异常');
  }
  if (status === 'stopped') {
    return tr('capsule.stateStopped', '已停止');
  }
  return tr('capsule.stateParked', '待命');
}

/**
 * Quiet composer-attached status bar inside `AgentTaskPanel` (zero standalone modal).
 * Expands inline to show active member status, file leases, and pause/stop/takeover controls.
 */
export const SwarmCapsuleBar: React.FC<SwarmCapsuleBarProps> = ({ sessionId, className }) => {
  const { t } = useTranslation(['agentMesh', 'common']);
  const [expanded, setExpanded] = useState(false);

  const tr = useCallback(
    (key: string, defaultValue: string, vars?: Record<string, string | number>) => {
      const res = t(key, { defaultValue, ...vars });
      if (res && res !== key && !res.startsWith('agentMesh:')) return res;
      if (!vars) return defaultValue;
      return defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
        vars[k] !== undefined ? String(vars[k]) : '',
      );
    },
    [t],
  );

  const sid = sessionId ?? '';
  const swarm = useAgentMeshWorkbenchStore((s) => (sid ? s.swarmBySession[sid] : undefined));
  const members = useAgentMeshWorkbenchStore((s) => (sid ? s.membersBySession[sid] ?? EMPTY_MEMBERS : EMPTY_MEMBERS));
  const board = useAgentMeshWorkbenchStore((s) => (sid ? s.boardBySession[sid] ?? EMPTY_BOARD : EMPTY_BOARD));
  const threads = useAgentMeshWorkbenchStore((s) => (sid ? s.threadsBySession[sid] ?? EMPTY_THREADS : EMPTY_THREADS));
  const checkpoints = useAgentMeshWorkbenchStore((s) => (sid ? s.checkpointsBySession[sid] ?? EMPTY_CHECKPOINTS : EMPTY_CHECKPOINTS));
  const leases = useAgentMeshWorkbenchStore((s) => (sid ? s.leasesBySession[sid] ?? EMPTY_LEASES : EMPTY_LEASES));

  const toggleSwarmPause = useAgentMeshWorkbenchStore((s) => s.toggleSwarmPause);
  const resumeCircuitBreaker = useAgentMeshWorkbenchStore((s) => s.resumeCircuitBreaker);
  const interruptMember = useAgentMeshWorkbenchStore((s) => s.interruptMember);
  const toggleHumanTakeover = useAgentMeshWorkbenchStore((s) => s.toggleHumanTakeover);

  const activeThreads = useMemo(
    () =>
      threads.filter(
        (th) =>
          th.status === 'running' ||
          th.status === 'waiting_children' ||
          th.status === 'waiting_approval',
      ),
    [threads],
  );

  const isActive = Boolean(sid) && Boolean(swarm && swarm.status !== 'completed');

  const diffTotals = useMemo(() => {
    if (checkpoints.length > 0) {
      return checkpoints.reduce(
        (acc, cp) => ({
          additions: acc.additions + cp.additions,
          deletions: acc.deletions + cp.deletions,
        }),
        { additions: 0, deletions: 0 },
      );
    }
    return threads.reduce(
      (acc, th) => ({
        additions: acc.additions + (th.diffSummary?.additions ?? 0),
        deletions: acc.deletions + (th.diffSummary?.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 },
    );
  }, [checkpoints, threads]);

  const memberSegments = useMemo(() => {
    if (members.length > 0) {
      return members.slice(0, 4).map((m) => `${formatAgentDisplayName(m.rosterName)}(${formatMemberStateShort(m, tr)})`);
    }
    return activeThreads.slice(0, 3).map((th) => {
      const label = formatAgentDisplayName(th.rosterName || th.agentId);
      if (th.humanControlled) return `${label}(${tr('capsule.stateHumanControlled', '已接管')})`;
      if (th.status === 'waiting_children') {
        const count = Math.max(1, th.childSubagents.filter((c) => c.status === 'running').length + th.activeBgTasks.length);
        return `${label}(${tr('capsule.stateWaitingChildren', '等待 {{count}} 子代理', { count })})`;
      }
      if (th.status === 'waiting_approval') {
        return `${label}(${tr('capsule.stateWaitingApproval', '待审批')})`;
      }
      return `${label}(${th.currentActivity?.trim() || tr('capsule.stateWorking', '运行中')})`;
    });
  }, [members, activeThreads, tr]);

  if (!isActive || !sid) return null;

  const isPaused = swarm?.status === 'paused';
  const isTripped = Boolean(swarm?.circuitBreakerTripped);
  const boardCount = Math.max(board.length, swarm?.headSeq ?? 0);
  const hasDiff = diffTotals.additions > 0 || diffTotals.deletions > 0;
  const hasExpandableDetails = members.length > 0 || leases.length > 0;

  const headline = isTripped
    ? tr('capsule.circuitBreaker', '已达自动接力上限')
    : isPaused
      ? tr('capsule.swarmPaused', '蜂群已暂停')
      : swarm
        ? tr('capsule.swarmActive', '蜂群协作中')
        : tr('capsule.externalActive', '外部 CLI 运行中');

  return (
    <div
      data-testid="swarm-capsule-bar"
      className={cn(
        'mb-1 w-full overflow-hidden rounded-[var(--radius-shell-control)]',
        'border border-[color:var(--composer-panel-border)] bg-[color:var(--composer-panel-surface)]',
        'text-xs text-[color:var(--text-secondary)] transition-colors',
        className,
      )}
    >
      <div className="flex min-h-7 w-full items-center justify-between gap-2 px-2.5 py-1">
        <DsButton
          variant="ghost"
          size="sm"
          data-testid="swarm-capsule-summary-toggle"
          onClick={() => {
            if (hasExpandableDetails) setExpanded((prev) => !prev);
          }}
          aria-expanded={hasExpandableDetails ? expanded : undefined}
          className={cn(
            '!h-auto !p-0 flex min-w-0 flex-1 items-center !justify-start gap-1.5 overflow-hidden text-left font-normal !bg-transparent hover:!bg-transparent',
            hasExpandableDetails && 'cursor-pointer hover:text-[color:var(--text-primary)]',
          )}
        >
          {isTripped ? (
            <WarningCircle size={13} weight="fill" className="shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <Sparkle
              size={13}
              weight="duotone"
              className={cn(
                'shrink-0',
                isPaused ? 'text-muted-foreground' : 'text-[color:hsl(var(--primary))]',
              )}
              aria-hidden="true"
            />
          )}
          <span className="shrink-0 font-medium text-[color:var(--text-primary)]">
            {headline}
          </span>

          {memberSegments.map((seg) => (
            <React.Fragment key={seg}>
              <span aria-hidden="true" className="shrink-0 text-[color:var(--text-muted)]">·</span>
              <span className="truncate text-2xs text-[color:var(--text-secondary)]">{seg}</span>
            </React.Fragment>
          ))}

          {boardCount > 0 && (
            <>
              <span aria-hidden="true" className="shrink-0 text-[color:var(--text-muted)]">·</span>
              <span className="shrink-0 text-2xs tabular-nums text-[color:var(--text-muted)]">
                {tr('capsule.boardCount', '公告板 {{count}} 条', { count: boardCount })}
              </span>
            </>
          )}

          {hasDiff && (
            <>
              <span aria-hidden="true" className="shrink-0 text-[color:var(--text-muted)]">·</span>
              <span className="shrink-0 font-mono text-2xs tabular-nums">
                <span className="text-success">+{diffTotals.additions}</span>
                <span className="text-[color:var(--text-muted)]">/</span>
                <span className="text-destructive">-{diffTotals.deletions}</span>
              </span>
            </>
          )}

          {hasExpandableDetails && (
            <CaretDown
              size={11}
              className={cn(
                'ml-0.5 shrink-0 text-[color:var(--text-muted)] transition-transform',
                expanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
          )}
        </DsButton>

        <div className="flex shrink-0 items-center gap-1">
          {isTripped && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="swarm-capsule-reset-breaker"
              onClick={() => void resumeCircuitBreaker(sid)}
              className="h-6 px-2 text-2xs font-medium text-warning hover:text-foreground"
            >
              {tr('capsule.continueHops', '继续推进')}
            </DsButton>
          )}

          {swarm && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="swarm-capsule-toggle-pause"
              onClick={() => void toggleSwarmPause(sid)}
              className="h-6 px-2 text-2xs"
            >
              {isPaused ? (
                <>
                  <Play size={11} weight="fill" aria-hidden="true" />
                  <span>{tr('capsule.resume', '恢复')}</span>
                </>
              ) : (
                <>
                  <Pause size={11} weight="fill" aria-hidden="true" />
                  <span>{tr('capsule.pause', '暂停')}</span>
                </>
              )}
            </DsButton>
          )}
        </div>
      </div>

      {expanded && hasExpandableDetails && (
        <div
          data-testid="swarm-capsule-inline-details"
          className="space-y-1 border-t border-[color:var(--composer-panel-border)] px-2.5 py-2"
        >
          {members.map((member) => {
            const memberLeases = leases.filter(
              (l) => l.holderAgentId === member.rosterName || l.holderAgentId === member.agentId,
            );
            const isWorkingLike =
              member.status === 'working' ||
              member.status === 'waiting_children' ||
              member.status === 'waiting_approval';

            return (
              <div
                key={member.rosterName}
                className="flex items-center justify-between gap-2 rounded-[5px] px-1.5 py-1 text-2xs hover:bg-[color:var(--interactive-hover)]"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      isWorkingLike ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="font-mono font-medium text-[color:var(--text-primary)]">
                    @{member.rosterName}
                  </span>
                  <span className="truncate text-[color:var(--text-muted)]">
                    {formatMemberStateShort(member, tr)}
                  </span>
                  {memberLeases.length > 0 && (
                    <span className="truncate font-mono text-[color:var(--text-muted)]">
                      · {memberLeases.flatMap((l) => l.patterns).slice(0, 2).join(', ')}
                    </span>
                  )}
                </div>

                {member.agentId !== 'deepstudent' && (
                  <div className="flex shrink-0 items-center gap-1">
                    {isWorkingLike && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void interruptMember({
                            chatSessionId: sid,
                            rosterName: member.rosterName,
                            threadId: member.threadId ?? undefined,
                          })
                        }
                        className="!h-5 !px-1.5 text-2xs text-muted-foreground hover:text-destructive"
                      >
                        <StopCircle size={11} />
                        <span>{tr('capsule.stopMember', '停止')}</span>
                      </DsButton>
                    )}
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void toggleHumanTakeover({
                          chatSessionId: sid,
                          rosterName: member.rosterName,
                          threadId: member.threadId ?? undefined,
                          humanControlled: !member.humanControlled,
                        })
                      }
                      className={cn(
                        '!h-5 !px-1.5 text-2xs text-muted-foreground hover:text-foreground',
                        member.humanControlled && 'text-primary',
                      )}
                    >
                      <HandPalm size={11} />
                      <span>
                        {member.humanControlled
                          ? tr('capsule.releaseMember', '取消接管')
                          : tr('capsule.takeoverMember', '接管')}
                      </span>
                    </DsButton>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SwarmCapsuleBar;
