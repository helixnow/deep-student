import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  FolderOpen,
  Sparkle,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import {
  formatCompactWorkspacePath,
  resolveAgentDisplayName,
  type MeshDiffSummary,
  type MeshThreadState,
  type PeerExchangeRecord,
} from '../types';
import { getCheckpointDiff, revertCheckpoint } from '../hostBridge';
import { useAgentMeshStore } from '../store/useAgentMeshStore';

const LazyInlineExternalTurnCard = React.lazy(() =>
  import('./InlineExternalTurnCard').then((m) => ({
    default: m.InlineExternalTurnCard,
  })),
);

const LazyPeerExchangeStrip = React.lazy(() =>
  import('./PeerExchangeStrip').then((m) => ({
    default: m.PeerExchangeStrip,
  })),
);

export interface SessionMeshStreamSectionProps {
  sessionId?: string | null;
  className?: string;
}

type TimelineItem =
  | { kind: 'thread'; createdAt: number; key: string; thread: MeshThreadState }
  | { kind: 'native_diff'; createdAt: number; key: string; thread: MeshThreadState }
  | { kind: 'exchange'; createdAt: number; key: string; exchange: PeerExchangeRecord };

const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_EXCHANGES: readonly PeerExchangeRecord[] = Object.freeze([]);

interface NativeTurnDiffStripProps {
  thread: MeshThreadState;
}

const NativeTurnDiffStrip: React.FC<NativeTurnDiffStripProps> = React.memo(({ thread }) => {
  const { t } = useTranslation(['agentMesh']);
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [loadedDiff, setLoadedDiff] = useState<MeshDiffSummary | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

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

  const effectiveDiff = loadedDiff ?? thread.diffSummary;
  const filesChanged = effectiveDiff?.filesChanged ?? effectiveDiff?.files?.length ?? 0;
  const additions = effectiveDiff?.totalAdditions ?? 0;
  const deletions = effectiveDiff?.totalDeletions ?? 0;
  const files = useMemo(() => effectiveDiff?.files ?? [], [effectiveDiff?.files]);

  const checkpointId = thread.lastCheckpointId ?? effectiveDiff?.checkpointId;
  const isReverted = Boolean(thread.revertedAt);
  const isRunningLike =
    thread.status === 'running' ||
    thread.status === 'waiting_children' ||
    thread.status === 'waiting_approval';

  const handleToggleExpand = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (
      next &&
      files.length === 0 &&
      checkpointId &&
      !loadingDiff
    ) {
      setLoadingDiff(true);
      try {
        const fetched = await getCheckpointDiff({
          chatSessionId: thread.chatSessionId,
          checkpointId,
          rootPath: thread.rootPath,
        });
        if (fetched) {
          setLoadedDiff(fetched);
        }
      } finally {
        setLoadingDiff(false);
      }
    }
  }, [checkpointId, expanded, files.length, loadingDiff, thread.chatSessionId, thread.rootPath]);

  const handleRevert = useCallback(async () => {
    if (!checkpointId || reverting || isReverted || isRunningLike) return;
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
  }, [
    checkpointId,
    isReverted,
    isRunningLike,
    reverting,
    thread.chatSessionId,
    thread.rootPath,
    thread.threadId,
  ]);

  const handleSummarize = useCallback(() => {
    const fileList =
      files
        .slice(0, 5)
        .map((f) => f.path)
        .join(', ') || workspaceLabel;
    const prompt = t('agentMesh:diffStrip.summarizePrompt', {
      agent: agentLabel,
      files: fileList,
      defaultValue: `请结合刚才 ${agentLabel} 的代码改动（${fileList}），帮我总结核心实现原理，并指出值得记入笔记或制成闪卡的要点。`,
    });
    dispatchAppEvent(APP_EVENTS.CHAT_V2_SET_INPUT, {
      content: prompt,
    });
  }, [agentLabel, files, t, workspaceLabel]);

  return (
    <div
      data-testid={`mesh-turn-diff-strip-${thread.threadId}`}
      className="rounded-lg border border-border/35 bg-foreground/[0.015] px-3 py-1.5 text-caption text-muted-foreground transition-colors"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <FolderOpen
            size={13}
            weight="duotone"
            className="shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="truncate text-foreground/85">
            {t('agentMesh:diffStrip.summary', {
              agent: agentLabel,
              count: filesChanged,
              defaultValue: '{{agent}} 修改了 {{count}} 个文件',
            })}
          </span>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
            (
            <span className="text-success">+{additions}</span>
            {' / '}
            <span className="text-destructive">-{deletions}</span>
            )
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="mesh-turn-diff-toggle"
            aria-expanded={expanded}
            onClick={() => void handleToggleExpand()}
            className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground hover:text-foreground"
          >
            {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
            <span>
              {expanded
                ? t('agentMesh:diffStrip.hideChanges', { defaultValue: '收起改动' })
                : t('agentMesh:diffStrip.viewChanges', { defaultValue: '查看改动' })}
            </span>
          </DsButton>

          {isReverted ? (
            <span
              data-testid="mesh-turn-diff-reverted"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-caption text-muted-foreground/60"
            >
              <CheckCircle size={11} />
              <span>{t('agentMesh:diffStrip.reverted', { defaultValue: '已回退' })}</span>
            </span>
          ) : (
            <DsButton
              variant="ghost"
              size="sm"
              disabled={!checkpointId || reverting || isRunningLike}
              data-testid="mesh-turn-diff-revert-btn"
              onClick={() => void handleRevert()}
              className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground hover:text-foreground"
            >
              <ArrowCounterClockwise size={11} />
              <span>{t('agentMesh:diffStrip.revertTurn', { defaultValue: '回退此轮' })}</span>
            </DsButton>
          )}

          <DsButton
            variant="ghost"
            size="sm"
            data-testid="mesh-turn-diff-explain-btn"
            onClick={handleSummarize}
            className="!h-6 !px-1.5 !py-0 gap-1 text-caption font-normal text-muted-foreground hover:text-foreground"
          >
            <Sparkle size={11} />
            <span>{t('agentMesh:diffStrip.summarize', { defaultValue: '让主代理总结' })}</span>
          </DsButton>
        </div>
      </div>

      {expanded && (
        <div
          data-testid="mesh-turn-diff-files"
          className="mt-2 space-y-2 border-t border-border/30 pt-2"
        >
          {loadingDiff ? (
            <div className="text-2xs text-muted-foreground">
              {t('agentMesh:diffStrip.loadingDiff', { defaultValue: '正在读取差异…' })}
            </div>
          ) : files.length > 0 ? (
            files.map((file) => (
              <div key={file.path} className="space-y-1">
                <div className="flex items-center justify-between gap-2 font-mono text-2xs">
                  <span className="truncate text-foreground/85">{file.path}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    <span className="text-success">+{file.additions}</span>
                    {' / '}
                    <span className="text-destructive">-{file.deletions}</span>
                  </span>
                </div>
                {file.patch && (
                  <pre
                    data-testid="mesh-turn-diff-patch"
                    className="max-h-48 overflow-auto rounded-md border border-border/30 bg-muted/40 p-2 font-mono text-2xs leading-relaxed text-foreground/85"
                  >
                    <code>{file.patch}</code>
                  </pre>
                )}
              </div>
            ))
          ) : (
            <div className="text-2xs text-muted-foreground">
              {t('agentMesh:diffStrip.noPatch', { defaultValue: '暂无补丁详情' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

NativeTurnDiffStrip.displayName = 'NativeTurnDiffStrip';

export const SessionMeshStreamSection: React.FC<SessionMeshStreamSectionProps> = React.memo(
  ({ sessionId, className }) => {
    const threadOrder = useAgentMeshStore((state) =>
      sessionId ? (state.sessionThreadOrder[sessionId] ?? EMPTY_IDS) : EMPTY_IDS,
    );
    const threadsMap = useAgentMeshStore((state) => state.threads);
    const exchanges = useAgentMeshStore((state) =>
      sessionId ? (state.peerExchanges[sessionId] ?? EMPTY_EXCHANGES) : EMPTY_EXCHANGES,
    );

    const items = useMemo<TimelineItem[]>(() => {
      if (threadOrder.length === 0 && exchanges.length === 0) return [];
      const merged: TimelineItem[] = [];
      for (const id of threadOrder) {
        const thread = threadsMap[id];
        if (!thread) continue;
        if (thread.timelineMode === 'native_chat') {
          const hasDiffOrReverted =
            (thread.diffSummary?.filesChanged ?? 0) > 0 || Boolean(thread.revertedAt);
          if (hasDiffOrReverted) {
            merged.push({
              kind: 'native_diff',
              createdAt: thread.createdAt,
              key: `diff:${thread.threadId}`,
              thread,
            });
          }
        } else {
          merged.push({
            kind: 'thread',
            createdAt: thread.createdAt,
            key: `thread:${thread.threadId}`,
            thread,
          });
        }
      }
      for (const exchange of exchanges) {
        merged.push({
          kind: 'exchange',
          createdAt: exchange.createdAt,
          key: `exchange:${exchange.id}`,
          exchange,
        });
      }
      merged.sort((a, b) => a.createdAt - b.createdAt);
      return merged;
    }, [exchanges, threadOrder, threadsMap]);

    if (items.length === 0) {
      return null;
    }

    return (
      <section
        data-testid="session-mesh-stream-section"
        className={cn(
          'mx-auto w-full max-w-thread space-y-3 px-4 py-2 md:px-8',
          className,
        )}
      >
        <React.Suspense fallback={null}>
          {items.map((item) => {
            if (item.kind === 'native_diff') {
              return <NativeTurnDiffStrip key={item.key} thread={item.thread} />;
            }
            if (item.kind === 'thread') {
              return <LazyInlineExternalTurnCard key={item.key} thread={item.thread} />;
            }
            return <LazyPeerExchangeStrip key={item.key} exchange={item.exchange} />;
          })}
        </React.Suspense>
      </section>
    );
  },
);

SessionMeshStreamSection.displayName = 'SessionMeshStreamSection';

export default SessionMeshStreamSection;
