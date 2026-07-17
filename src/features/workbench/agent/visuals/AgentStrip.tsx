/**
 * ACR AgentStrip — R1-10 / R3-03
 * 窗口标题栏下方细条：状态点 + label + 暂停 / 停止 / 撤销。
 * 见 docs/dev/acr/DESIGN.md §4.2；文案 workbench:agent.core.*。
 *
 * R3-03 a11y：
 * - 按钮可键盘操作（原生 button + focus-visible）
 * - aria-live 经 announceWorkbench 通告开始/暂停/完成
 * - 状态点 aria-hidden；文案本身区分 acting/paused（不唯颜色）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { announceWorkbench } from '@/features/workbench/hooks/useWorkbenchA11y';
import { useWindowPresence } from '../presenceStore';
import { stageManager } from '../stageManager';
import type { AcrRunStatus } from '../types';
import './agent-visuals.css';

export interface AgentStripProps {
  windowId: string;
}

/**
 * 阻止条内交互冒泡到 WindowShell 内容区的用户输入探测，
 * 避免点「暂停/停止」被误判为用户接管。
 */
function stopStripPropagation(e: React.SyntheticEvent): void {
  e.stopPropagation();
}

export const AgentStrip: React.FC<AgentStripProps> = ({ windowId }) => {
  const { t } = useTranslation('workbench');
  const presence = useWindowPresence(windowId);
  const prevAnnounceKey = useRef<string | null>(null);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    if (!presence) {
      // presence 清除：仅当上一态仍是进行中才通告完成（done/aborted 已播过）
      if (prevAnnounceKey.current) {
        const prevStatus = prevAnnounceKey.current.split(':')[0];
        if (
          prevStatus === 'acting' ||
          prevStatus === 'pausedByUser' ||
          prevStatus === 'reviewing'
        ) {
          announceWorkbench(
            t('agent.core.announceDone'),
            'polite',
          );
        }
      }
      prevAnnounceKey.current = null;
      return;
    }

    const key = `${presence.status}:${presence.runId}`;
    if (prevAnnounceKey.current === key) return;

    const prev = prevAnnounceKey.current;
    prevAnnounceKey.current = key;

    if (presence.status === 'acting' || presence.status === 'reviewing') {
      // 首次出现或从暂停续放
      if (!prev || prev.startsWith('pausedByUser:')) {
        announceWorkbench(
          t('agent.core.announceStarted', { label: presence.label }),
          'polite',
        );
      }
    } else if (presence.status === 'pausedByUser') {
      announceWorkbench(
        t('agent.core.announcePaused', { label: presence.label }),
        'polite',
      );
    } else if (presence.status === 'done' || presence.status === 'aborted') {
      announceWorkbench(
        presence.status === 'done'
          ? t('agent.core.announceDone')
          : t('agent.core.announceStopped'),
        'polite',
      );
    }
  }, [presence, t]);

  const handlePause = useCallback(() => {
    if (!presence || presence.status === 'pausedByUser') return;
    stageManager.pauseRun(presence.runKey);
  }, [presence]);

  const handleStop = useCallback(() => {
    if (!presence) return;
    stageManager.stopRun(presence.runKey);
  }, [presence]);

  const handleRevert = useCallback(async () => {
    if (!presence || reverting) return;
    setReverting(true);
    try {
      await stageManager.revertRun(presence.runId, presence.sessionId);
    } finally {
      setReverting(false);
    }
  }, [presence, reverting]);

  if (!presence) return null;

  const isPaused = presence.status === 'pausedByUser';
  // S-REV-02：done/aborted 短时保留 presence（stageManager DONE_PRESENCE_HOLD）；账本仍在则可撤
  const canRevert =
    (presence.status === 'done' || presence.status === 'aborted') &&
    stageManager.hasReversibleRun(presence.runId, presence.sessionId);
  const canPause = presence.status === 'acting' || presence.status === 'reviewing';
  const canStop =
    presence.status === 'acting' ||
    presence.status === 'pausedByUser' ||
    presence.status === 'reviewing';

  // 状态点五态语义：进行中呼吸 / 待确认空心 / 暂停方点 / 完成绿点 / 停止灰点
  const dotState =
    presence.status === 'pausedByUser'
      ? 'paused'
      : presence.status === 'reviewing'
        ? 'reviewing'
        : presence.status === 'done'
          ? 'done'
          : presence.status === 'aborted'
            ? 'aborted'
            : 'acting';
  // 文案不唯颜色：终态（done/aborted 短暂保留供撤销）复用 announce 文案，不再显示「正在操作」
  const labelText = isPaused
    ? t('agent.core.pausedLabel', { label: presence.label })
    : presence.status === 'done'
      ? t('agent.core.announceDone')
      : presence.status === 'aborted'
        ? t('agent.core.announceStopped')
        : t('agent.core.operating', { label: presence.label });

  const statusForAria = (status: AcrRunStatus): string => {
    switch (status) {
      case 'pausedByUser':
        return t('agent.core.paused');
      case 'reviewing':
        return t('agent.core.reviewing');
      case 'done':
        return t('agent.core.done');
      case 'aborted':
        return t('agent.core.stopped');
      default:
        return t('agent.core.acting');
    }
  };

  // bubble 阶段拦截：勿用 capture，否则会挡住条内按钮命中
  return (
    <div
      className="acr-agent-strip"
      role="region"
      aria-label={t('agent.core.stripRegion')}
      data-acr-agent-strip
      data-status={presence.status}
      data-run-id={presence.runId}
      onPointerDown={stopStripPropagation}
      onKeyDown={stopStripPropagation}
      onClick={stopStripPropagation}
    >
      <span className="acr-agent-strip-label" aria-live="polite" aria-atomic="true">
        <span
          className="acr-agent-strip-dot"
          data-state={dotState}
          aria-hidden
        />
        {/* 截断时悬停可读全文 */}
        <span className="truncate" title={labelText}>
          <span className="sr-only">{statusForAria(presence.status)}：</span>
          {labelText}
        </span>
      </span>
      <span className="acr-agent-strip-actions" role="group" aria-label={t('agent.core.actions')}>
        <NotionButton
          type="button"
          size="sm"
          variant="ghost"
          className="acr-agent-strip-btn"
          disabled={isPaused || !canPause}
          onClick={handlePause}
          aria-label={t('agent.core.pause')}
        >
          {isPaused
            ? t('agent.core.paused')
            : t('agent.core.pause')}
        </NotionButton>
        <NotionButton
          type="button"
          size="sm"
          variant="ghost"
          className="acr-agent-strip-btn"
          disabled={!canStop}
          onClick={handleStop}
          aria-label={t('agent.core.stop')}
        >
          {t('agent.core.stop')}
        </NotionButton>
        <NotionButton
          type="button"
          size="sm"
          variant="ghost"
          className="acr-agent-strip-btn"
          disabled={!canRevert || reverting}
          onClick={() => void handleRevert()}
          aria-label={t('agent.core.revert')}
        >
          {reverting
            ? t('agent.core.reverting')
            : t('agent.core.revert')}
        </NotionButton>
      </span>
    </div>
  );
};

export default AgentStrip;
