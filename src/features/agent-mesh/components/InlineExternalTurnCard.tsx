import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  HandPalm,
  LockKey,
  ShieldWarning,
  Sparkle,
  StopCircle,
  TerminalWindow,
  TreeStructure,
  WarningCircle,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import {
  formatCompactWorkspacePath,
  resolveAgentDisplayName,
  type MeshApprovalDecision,
  type MeshThreadState,
} from '../types';
import {
  interruptTurn,
  respondApproval,
  revertCheckpoint,
  setHumanControlled,
} from '../hostBridge';

export interface InlineExternalTurnCardProps {
  thread: MeshThreadState;
  className?: string;
}

interface TextSegment {
  kind: 'text' | 'code';
  lang?: string;
  content: string;
}

function splitStreamSegments(raw: string): TextSegment[] {
  if (!raw) return [];
  const segments: TextSegment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = fenceRegex.exec(raw);

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', content: raw.slice(lastIndex, match.index) });
    }
    segments.push({
      kind: 'code',
      lang: match[1] || undefined,
      content: match[2].replace(/\n$/, ''),
    });
    lastIndex = match.index + match[0].length;
    match = fenceRegex.exec(raw);
  }

  if (lastIndex < raw.length) {
    segments.push({ kind: 'text', content: raw.slice(lastIndex) });
  }

  return segments;
}

export const InlineExternalTurnCard: React.FC<InlineExternalTurnCardProps> = ({
  thread,
  className,
}) => {
  const { t } = useTranslation(['agentMesh']);

  const [subagentsExpanded, setSubagentsExpanded] = useState(false);
  const [diffFilesExpanded, setDiffFilesExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);

  const agentLabel = useMemo(
    () => resolveAgentDisplayName(thread.agentId, thread.agentName),
    [thread.agentId, thread.agentName],
  );

  const workspaceLabel = useMemo(
    () =>
      formatCompactWorkspacePath(thread.rootPath) ||
      t('agentMesh:inlineCard.defaultWorkspace', { defaultValue: '当前工作区' }),
    [thread.rootPath, t],
  );

  const segments = useMemo(
    () => splitStreamSegments(thread.assistantText),
    [thread.assistantText],
  );

  const isRunningLike =
    thread.status === 'running' ||
    thread.status === 'waiting_children' ||
    thread.status === 'waiting_approval';

  const checkpointId = thread.lastCheckpointId ?? thread.diffSummary?.checkpointId;
  const isReverted = Boolean(thread.revertedAt);

  const handleApprovalDecision = (decision: MeshApprovalDecision) => {
    if (!thread.pendingApproval) return;
    void respondApproval({
      threadId: thread.threadId,
      requestId: thread.pendingApproval.requestId,
      decision,
    });
  };

  const handleRevert = async () => {
    if (!checkpointId || reverting || isReverted) return;
    setReverting(true);
    try {
      await revertCheckpoint({
        chatSessionId: thread.chatSessionId,
        checkpointId,
        threadId: thread.threadId,
        rootPath: thread.rootPath,
      });
    } finally {
      setReverting(false);
    }
  };

  const handleToggleTakeover = () => {
    void setHumanControlled({
      threadId: thread.threadId,
      chatSessionId: thread.chatSessionId,
      humanControlled: !thread.humanControlled,
    });
  };

  const handleInterrupt = () => {
    void interruptTurn({
      threadId: thread.threadId,
      chatSessionId: thread.chatSessionId,
    });
  };

  const handleExplainChangesInChat = () => {
    const fileList =
      thread.diffSummary?.files
        ?.slice(0, 5)
        .map((f) => f.path)
        .join(', ') || workspaceLabel;
    const prompt = t('agentMesh:inlineCard.explainPrompt', {
      agent: agentLabel,
      files: fileList,
      defaultValue: `请结合刚才 ${agentLabel} 的代码改动（${fileList}），帮我总结核心实现原理，并指出值得记入笔记或制成闪卡的要点。`,
    });
    dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, {
      content: prompt,
    });
  };

  const subagentCount = thread.childSubagents.length;
  const showSubagentRow = subagentCount > 0 || thread.status === 'waiting_children';

  return (
    <article
      data-testid={`inline-external-turn-${thread.threadId}`}
      data-thread-status={thread.status}
      className={cn(
        'rounded-xl border border-border/35 bg-muted/20 px-4 py-3 transition-colors',
        className,
      )}
    >
      {/* Header: Native DeepStudent assistant turn signature */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <TerminalWindow size={13} weight="duotone" />
          </span>
          <span className="font-medium text-foreground">
            {agentLabel}
          </span>
          {thread.rosterName && thread.rosterName !== thread.agentId && (
            <span className="text-caption text-muted-foreground/80">
              @{thread.rosterName}
            </span>
          )}
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <span className="truncate text-caption text-muted-foreground/80" title={thread.rootPath}>
            {workspaceLabel}
          </span>
        </div>

        <div className="flex items-center gap-2 text-caption text-muted-foreground/80">
          {thread.humanControlled && (
            <span
              data-testid="external-turn-human-controlled-badge"
              className="inline-flex items-center gap-1 rounded-full border border-border/45 bg-muted/60 px-2 py-0.5 text-2xs text-foreground/85"
            >
              <LockKey size={11} weight="fill" />
              <span>
                {t('agentMesh:inlineCard.humanControlledBadge', { defaultValue: '已人工接管' })}
              </span>
            </span>
          )}

          {thread.status === 'running' && (
            <span className="inline-flex items-center gap-1 text-caption text-primary">
              <CircleNotch size={12} className="animate-spin motion-reduce:animate-none" />
              <span>{t('agentMesh:inlineCard.statusRunning', { defaultValue: '运行中…' })}</span>
            </span>
          )}

          {thread.status === 'failed' && (
            <span className="inline-flex items-center gap-1 text-caption text-destructive">
              <WarningCircle size={12} weight="fill" />
              <span>{t('agentMesh:inlineCard.statusFailed', { defaultValue: '执行异常' })}</span>
            </span>
          )}

          {thread.status === 'stopped' && (
            <span className="text-caption text-muted-foreground/70">
              {t('agentMesh:inlineCard.statusStopped', { defaultValue: '已停止' })}
            </span>
          )}
        </div>
      </div>

      {/* Optional compact user prompt echo when dispatched directly */}
      {thread.prompt && (
        <div className="mt-1.5 truncate text-caption text-muted-foreground/70">
          <span className="mr-1.5 text-2xs opacity-65">
            {t('agentMesh:inlineCard.promptPrefix', { defaultValue: '指令' })}
          </span>
          <span>{thread.prompt}</span>
        </div>
      )}

      {/* Collapsible nested Subagent tree & Quiescence gate indicator */}
      {showSubagentRow && (
        <div className="mt-2.5">
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="external-turn-subagents-toggle"
            aria-expanded={subagentsExpanded}
            onClick={() => setSubagentsExpanded((prev) => !prev)}
            className="!h-6 !px-2 !py-0.5 gap-1.5 rounded-md text-caption text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            {subagentsExpanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
            <TreeStructure size={12} className="shrink-0 text-muted-foreground" />
            <span>
              {thread.status === 'waiting_children'
                ? t('agentMesh:inlineCard.statusWaitingChildren', {
                    count: Math.max(1, subagentCount),
                    defaultValue: '派生 {{count}} 个子代理 · 等待完成…',
                  })
                : t('agentMesh:inlineCard.subagentsSummary', {
                    count: subagentCount,
                    defaultValue: '派生 {{count}} 个子代理',
                  })}
            </span>
            {thread.status === 'waiting_children' && (
              <CircleNotch
                size={11}
                className="ml-0.5 shrink-0 animate-spin text-warning motion-reduce:animate-none"
              />
            )}
          </DsButton>

          {subagentsExpanded && subagentCount > 0 && (
            <div
              data-testid="external-turn-subagents-tree"
              className="mt-1.5 ml-3 space-y-1 border-l border-border/40 pl-3"
            >
              {thread.childSubagents.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center justify-between gap-2 text-caption text-muted-foreground"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {child.status === 'running' ? (
                      <CircleNotch
                        size={11}
                        className="shrink-0 animate-spin text-primary motion-reduce:animate-none"
                      />
                    ) : child.status === 'failed' ? (
                      <WarningCircle size={11} className="shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle size={11} className="shrink-0 text-success" />
                    )}
                    <span className="truncate text-foreground/85">{child.title}</span>
                    {child.summary && (
                      <span className="truncate text-muted-foreground/70">· {child.summary}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-2xs text-muted-foreground/70">
                    {child.status === 'running'
                      ? t('agentMesh:inlineCard.subagentRunning', { defaultValue: '运行中' })
                      : child.status === 'failed'
                        ? t('agentMesh:inlineCard.subagentFailed', { defaultValue: '失败' })
                        : t('agentMesh:inlineCard.subagentCompleted', { defaultValue: '已完成' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Streaming assistant response body */}
      {segments.length > 0 && (
        <div
          data-testid="external-turn-assistant-body"
          className="mt-2.5 space-y-2 text-sm leading-relaxed text-foreground/95"
        >
          {segments.map((seg, idx) =>
            seg.kind === 'code' ? (
              <pre
                key={idx}
                className="overflow-x-auto rounded-lg border border-border/35 bg-muted/50 p-2.5 font-mono text-xs text-foreground/90"
              >
                <code>{seg.content}</code>
              </pre>
            ) : (
              <div key={idx} className="whitespace-pre-wrap break-words">
                {seg.content}
              </div>
            ),
          )}
        </div>
      )}

      {/* Error feedback */}
      {thread.errorMessage && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {thread.errorMessage}
        </div>
      )}

      {/* Inline Approval Prompt when status === 'waiting_approval' */}
      {thread.status === 'waiting_approval' && thread.pendingApproval && (
        <div
          data-testid="external-turn-approval-bar"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <ShieldWarning size={14} className="shrink-0 text-warning" weight="duotone" />
              <span>
                {t('agentMesh:inlineCard.approvalTitle', {
                  tool: thread.pendingApproval.toolName,
                  defaultValue: '请求执行 {{tool}}',
                })}
              </span>
            </div>
            {(thread.pendingApproval.targetPath || thread.pendingApproval.command) && (
              <div className="truncate font-mono text-2xs text-muted-foreground">
                {t('agentMesh:inlineCard.approvalTarget', {
                  target:
                    thread.pendingApproval.targetPath ||
                    thread.pendingApproval.command ||
                    '',
                  defaultValue: '目标：{{target}}',
                })}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <DsButton
              variant="primary"
              size="sm"
              data-testid="external-approval-allow-once"
              onClick={() => handleApprovalDecision('allow_once')}
              className="!h-7 !px-2.5 text-xs"
            >
              {t('agentMesh:inlineCard.allowOnce', { defaultValue: '允许一次' })}
            </DsButton>
            <DsButton
              variant="outline"
              size="sm"
              data-testid="external-approval-allow-session"
              onClick={() => handleApprovalDecision('allow_session')}
              className="!h-7 !px-2.5 text-xs"
            >
              {t('agentMesh:inlineCard.allowSession', { defaultValue: '本会话允许' })}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="external-approval-deny"
              onClick={() => handleApprovalDecision('deny')}
              className="!h-7 !px-2.5 text-xs text-destructive hover:bg-destructive/10"
            >
              {t('agentMesh:inlineCard.deny', { defaultValue: '拒绝' })}
            </DsButton>
          </div>
        </div>
      )}

      {/* Expandable file diff summary list */}
      {diffFilesExpanded && thread.diffSummary?.files && thread.diffSummary.files.length > 0 && (
        <div
          data-testid="external-turn-diff-files"
          className="mt-2.5 space-y-1 rounded-lg border border-border/35 bg-background/60 p-2.5"
        >
          {thread.diffSummary.files.map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between gap-2 font-mono text-2xs"
            >
              <span className="truncate text-foreground/85">{file.path}</span>
              <span className="shrink-0 text-muted-foreground">
                <span className="text-success">+{file.additions}</span>
                {' / '}
                <span className="text-destructive">-{file.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Subtle borderless metadata & control footer (0 separate modal triggers) */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 pt-1 text-caption text-muted-foreground/70">
        <div className="flex flex-wrap items-center gap-2">
          {thread.diffSummary && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="external-turn-diff-trigger"
              onClick={() => setDiffFilesExpanded((prev) => !prev)}
              className="!h-6 !px-1.5 !py-0 text-caption font-normal text-muted-foreground/75 hover:text-foreground"
            >
              <span>
                {thread.diffSummary.filesChanged > 0
                  ? t('agentMesh:inlineCard.diffStats', {
                      additions: thread.diffSummary.totalAdditions,
                      deletions: thread.diffSummary.totalDeletions,
                      files: thread.diffSummary.filesChanged,
                      defaultValue: '+{{additions}}/-{{deletions}} · {{files}} 文件变更',
                    })
                  : t('agentMesh:inlineCard.diffStatsShort', {
                      additions: thread.diffSummary.totalAdditions,
                      deletions: thread.diffSummary.totalDeletions,
                      defaultValue: '+{{additions}}/-{{deletions}} 文件变更',
                    })}
              </span>
            </DsButton>
          )}

          {checkpointId && !isReverted && (
            <DsButton
              variant="ghost"
              size="sm"
              disabled={reverting || isRunningLike}
              data-testid="external-turn-revert-btn"
              onClick={() => void handleRevert()}
              className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground/70 hover:text-foreground"
            >
              <ArrowCounterClockwise size={12} />
              <span>{t('agentMesh:inlineCard.revertTurn', { defaultValue: '回退此轮' })}</span>
            </DsButton>
          )}

          {thread.diffSummary && !isReverted && !isRunningLike && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="external-turn-explain-btn"
              onClick={handleExplainChangesInChat}
              className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground/70 hover:text-foreground"
            >
              <Sparkle size={12} />
              <span>{t('agentMesh:inlineCard.explainChanges', { defaultValue: '让主代理总结改动' })}</span>
            </DsButton>
          )}

          {isReverted && (
            <span
              data-testid="external-turn-reverted-label"
              className="text-caption text-muted-foreground/60"
            >
              {t('agentMesh:inlineCard.revertedBadge', { defaultValue: '已回退此轮改动' })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {isRunningLike && (
            <DsButton
              variant="ghost"
              size="sm"
              data-testid="external-turn-interrupt-btn"
              onClick={handleInterrupt}
              className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground/70 hover:text-destructive"
            >
              <StopCircle size={12} />
              <span>{t('agentMesh:inlineCard.interrupt', { defaultValue: '停止' })}</span>
            </DsButton>
          )}

          <DsButton
            variant="ghost"
            size="sm"
            data-testid="external-turn-takeover-btn"
            onClick={handleToggleTakeover}
            className={cn(
              '!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground/70 hover:text-foreground',
              thread.humanControlled && 'text-primary',
            )}
          >
            <HandPalm size={12} />
            <span>
              {thread.humanControlled
                ? t('agentMesh:inlineCard.releaseTakeover', { defaultValue: '恢复自动协同' })
                : t('agentMesh:inlineCard.takeover', { defaultValue: '接管' })}
            </span>
          </DsButton>
        </div>
      </div>
    </article>
  );
};

InlineExternalTurnCard.displayName = 'InlineExternalTurnCard';

export default InlineExternalTurnCard;
