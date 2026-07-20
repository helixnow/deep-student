/**
 * ACR AgentStrip — R1-10 / R3-03 / ACR 4.0（A5）
 * 窗口标题栏下方细条：状态点 + label + 暂停 / 继续 / 停止 / 撤销。
 * 见 docs/dev/acr/DESIGN.md §4.2；文案 workbench:agent.core.*。
 *
 * R3-03 a11y：
 * - 按钮可键盘操作（原生 button + focus-visible）
 * - aria-live 经 announceWorkbench 通告开始/暂停/完成
 * - 状态点 aria-hidden；文案本身区分 acting/paused（不唯颜色）
 *
 * ACR 4.0 a11y：
 * - 自动中止倒计时放在 aria-live 区域**之外**且 aria-hidden，避免逐秒轰炸读屏；
 *   进入暂停时的一次性 announcePaused 已覆盖播报。
 * - placementHint 括注放在 label 内（随 announceStarted 一次性播报）。
 *
 * 演出优化轮：presence 出现/清除时条不再瞬间插拔（内容区硬跳 28px）——
 * host 用 grid rows 0fr↔1fr 过渡高度；退场期用最后一次 presence 快照
 * 保持渲染（按钮全部禁用，条只读收拢），过渡结束后真正卸载。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { readCssTimeMs } from '@/shared/utils/cssTime';
import { announceWorkbench } from '@/features/workbench/hooks/useWorkbenchA11y';
import { useWindowPresence } from '../presenceStore';
import { stageManager } from '../stageManager';
import type { AcrPlacementHint, AcrRunStatus, PresenceState } from '../types';
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

/** placementHint → i18n key（括注文案本身含括号，随 locale 走全/半角） */
function placementHintKey(hint: AcrPlacementHint): string {
  switch (hint) {
    case 'stage-full':
      return 'agent.core.placementStageFull';
    case 'frozen':
      return 'agent.core.placementFrozen';
    default:
      return 'agent.core.placementBackground';
  }
}

/**
 * ACR 4.0：pausedByUser 自动中止倒计时（秒）。
 * 每秒 tick；deadline 变化 / 卸载时清理；≤0 时返回 null（不显示负数）。
 */
function useAbortCountdown(abortDeadline: number | undefined): number | null {
  const [seconds, setSeconds] = useState<number | null>(() =>
    abortDeadline ? Math.ceil((abortDeadline - Date.now()) / 1000) : null,
  );

  useEffect(() => {
    if (!abortDeadline) {
      setSeconds(null);
      return undefined;
    }
    const compute = () => Math.ceil((abortDeadline - Date.now()) / 1000);
    setSeconds(compute());
    const timer = window.setInterval(() => setSeconds(compute()), 1000);
    return () => window.clearInterval(timer);
  }, [abortDeadline]);

  return seconds != null && seconds > 0 ? seconds : null;
}

/** 退场收拢时长：CSS --acr-strip-collapse-ms 单源 + 少量缓冲 */
function stripCollapseMs(): number {
  return readCssTimeMs('--acr-strip-collapse-ms', 200) + 40;
}

/**
 * presence 清除后的退场保持：返回 { view, closing }。
 * view = 当前 presence 或退场期的最后快照；closing 期间条只读收拢。
 *
 * held 必须在**渲染期**同步派生（React 合法的 setState-during-render 模式）：
 * 若放到 effect 里，presence 清空的那次提交 view 已是 null，条会先整体
 * 卸载一帧再以收拢态重挂——退场过渡永远播不出来，还多一次闪烁。
 */
function usePresenceExitHold(presence: PresenceState | undefined): {
  view: PresenceState | null;
  closing: boolean;
} {
  const lastRef = useRef<PresenceState | null>(null);
  const prevRef = useRef<PresenceState | undefined>(presence);
  const [held, setHeld] = useState(false);

  if (presence) lastRef.current = presence;

  if (prevRef.current !== presence) {
    prevRef.current = presence;
    if (!presence && lastRef.current && !held) {
      // presence 刚消失：本次渲染立即进入退场保持，DOM 节点不卸载
      setHeld(true);
    } else if (presence && held) {
      // 收拢期内新 run 开始：立即恢复常态
      setHeld(false);
    }
  }

  useEffect(() => {
    if (!held || presence) return undefined;
    const timer = window.setTimeout(() => {
      setHeld(false);
      lastRef.current = null;
    }, stripCollapseMs());
    return () => window.clearTimeout(timer);
  }, [held, presence]);

  if (presence) return { view: presence, closing: false };
  if (held && lastRef.current) return { view: lastRef.current, closing: true };
  return { view: null, closing: false };
}

export const AgentStrip: React.FC<AgentStripProps> = ({ windowId }) => {
  const { t } = useTranslation('workbench');
  const presence = useWindowPresence(windowId);
  const { view, closing } = usePresenceExitHold(presence);
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

  // ACR 4.0：显式暂停可续放（resumeRun 清除 abortDeadline/resumable，
  // presence 回到 acting 后由上方 effect 走 announceStarted「从暂停续放」通告）
  const handleResume = useCallback(() => {
    if (!presence || presence.status !== 'pausedByUser' || !presence.resumable) return;
    stageManager.resumeRun(presence.runKey);
  }, [presence]);

  // 倒计时只在 pausedByUser 期间有意义；其余状态传 undefined 让 interval 立即清理
  const countdownSeconds = useAbortCountdown(
    presence?.status === 'pausedByUser' ? presence.abortDeadline : undefined,
  );

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

  if (!view) return null;

  const isPaused = view.status === 'pausedByUser';
  // S-REV-02：done/aborted 短时保留 presence（stageManager DONE_PRESENCE_HOLD）；账本仍在则可撤
  // closing（退场收拢期）一律禁用动作：presence 已清除，run 交互无意义
  const canRevert =
    !closing &&
    (view.status === 'done' || view.status === 'aborted') &&
    stageManager.hasReversibleRun(view.runId, view.sessionId);
  // ACR 4.0（A8 裁决）：reviewing 通常是 run 已结束、仅建议挂起（AIDiffPanel），
  // pauseRun/stopRun 对它是静默 no-op——按 run 活性禁用，避免假可用按钮。
  const reviewingRunAlive =
    !closing &&
    view.status === 'reviewing' &&
    typeof stageManager.isRunActive === 'function' &&
    stageManager.isRunActive(view.runKey);
  const canPause = !closing && (view.status === 'acting' || reviewingRunAlive);
  const canStop =
    !closing &&
    (view.status === 'acting' ||
      view.status === 'pausedByUser' ||
      reviewingRunAlive);

  // 状态点五态语义：进行中呼吸 / 待确认空心 / 暂停方点 / 完成绿点 / 停止灰点
  const dotState =
    view.status === 'pausedByUser'
      ? 'paused'
      : view.status === 'reviewing'
        ? 'reviewing'
        : view.status === 'done'
          ? 'done'
          : view.status === 'aborted'
            ? 'aborted'
            : 'acting';
  // 文案不唯颜色：终态（done/aborted 短暂保留供撤销）复用 announce 文案，不再显示「正在操作」
  // reviewing 直接展示数据层 label（如「等待确认：…」），避免「AI 正在操作：等待确认：…」双前缀
  const labelText = isPaused
    ? t('agent.core.pausedLabel', { label: view.label })
    : view.status === 'done'
      ? t('agent.core.announceDone')
      : view.status === 'aborted'
        ? t('agent.core.announceStopped')
        : view.status === 'reviewing'
          ? view.label
          : t('agent.core.operating', { label: view.label });

  // ACR 4.0：直落原因括注（结构化 placementHint → i18n；替代旧 label 中文后缀）
  const placementText = view.placementHint
    ? t(placementHintKey(view.placementHint))
    : null;
  const canResume = !closing && isPaused && view.resumable === true;

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
      className="acr-agent-strip-host"
      data-closing={closing ? '' : undefined}
    >
      <div className="acr-agent-strip-clip">
        <div
          className="acr-agent-strip"
          role="region"
          aria-label={t('agent.core.stripRegion')}
          data-acr-agent-strip
          data-status={view.status}
          data-run-id={view.runId}
          onPointerDown={stopStripPropagation}
          onKeyDown={stopStripPropagation}
          onClick={stopStripPropagation}
        >
          <span className="acr-agent-strip-labelarea">
            {/* ACR 4.1：点移出 overflow:hidden 的 label，ping 扩散环不被裁剪 */}
            <span
              className="acr-agent-strip-dot"
              data-state={dotState}
              aria-hidden
            />
            <span className="acr-agent-strip-label" aria-live="polite" aria-atomic="true">
              {/* 截断时悬停可读全文 */}
              <span className="truncate" title={labelText}>
                <span className="sr-only">{statusForAria(view.status)}：</span>
                {labelText}
                {placementText ? (
                  <span className="acr-agent-strip-placement" data-acr-placement={view.placementHint}>
                    {placementText}
                  </span>
                ) : null}
              </span>
            </span>
            {/* 倒计时在 aria-live 区域之外且 aria-hidden：不逐秒轰炸读屏（announcePaused 已一次性播报） */}
            {isPaused && countdownSeconds != null ? (
              <span className="acr-agent-strip-countdown" aria-hidden data-acr-countdown>
                {t('agent.core.autoStopCountdown', { seconds: countdownSeconds })}
              </span>
            ) : null}
          </span>
          <span className="acr-agent-strip-actions" role="group" aria-label={t('agent.core.actions')}>
            {canResume ? (
              // ACR 4.0：显式暂停可续放 → 「继续」占用暂停按钮位（同尺寸，不引起布局跳动）
              <NotionButton
                type="button"
                size="sm"
                variant="ghost"
                className="acr-agent-strip-btn"
                onClick={handleResume}
                aria-label={t('agent.core.resume')}
              >
                {t('agent.core.resume')}
              </NotionButton>
            ) : (
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
            )}
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
      </div>
    </div>
  );
};

export default AgentStrip;
