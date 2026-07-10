/**
 * ChatAppWindow — Chat 应用的 AppWindowProps 适配层（P7）
 *
 * - instanceKey = sessionId（multi 实例）；
 * - 兜底：Dock 直接 launch 无 instanceKey 时自动创建新会话（按 windowId 记忆，
 *   frozen→唤醒重建时不会重复建会话）；
 * - onTitleChange = 会话标题（订阅 store.title，后端自动生成标题后同步窗口标题）；
 * - isVisible=false 时经 ChatSessionSurface 切换流式降频档；
 * - 关闭窗口 ≠ 删除会话：壳销毁只是卸载视图，会话数据由 autoSave / 后端持久化，
 *   adapter 仅减引用计数（AdapterManager），重开窗口即恢复。
 * - 多窗隔离适配：窗口聚焦时把 sessionManager 的全局“当前会话”指针指向本窗会话
 *   （上下文注入 / pdf-ref 解析等全局消费方以最近聚焦的 chat 窗口为目标，
 *   与 legacy 页面“当前显示会话”语义对齐）；卸载时若指针仍指向本窗则清空。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Warning } from '@phosphor-icons/react';
import type { AppWindowProps } from '../../core/types';
import { ChatSessionSurface } from './ChatSessionSurface';
import { ChatWindowSkeleton } from './ChatWindowSkeleton';
import { sessionManager } from '@/features/chat/core/session/sessionManager';
import { createSessionWithDefaults } from '@/features/chat/core/session/createSessionWithDefaults';
import { getErrorMessage } from '@/utils/errorUtils';

/**
 * 无 instanceKey 启动时自动创建的会话，按 windowId 记忆。
 * frozen 档会卸载整棵子树，唤醒重建时靠这张表找回原会话，避免每次唤醒都建新会话。
 * 注意：应用重启后该表为空，快照恢复出的 instanceKey=null 窗口会再建新会话（记录在 P7 进度文件遗留）。
 */
const autoCreatedSessionByWindow = new Map<string, string>();

interface ChatLaunchPayload {
  sessionId?: string;
}

function readPayloadSessionId(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const sid = (payload as ChatLaunchPayload).sessionId;
    if (typeof sid === 'string' && sid.trim()) return sid;
  }
  return null;
}

export const ChatAppWindow: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  launchPayload,
  isActive,
  isVisible,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');

  const payloadSessionId = useMemo(() => readPayloadSessionId(launchPayload), [launchPayload]);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(
    () => autoCreatedSessionByWindow.get(windowId) ?? null,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [createAttempt, setCreateAttempt] = useState(0);
  const creationInFlightRef = useRef(false);

  const sessionId = instanceKey ?? payloadSessionId ?? createdSessionId;

  // 兜底自动建会话（Dock 无 instanceKey 直接 launch 的场景）
  // 注意：不用 effect-cleanup 的 disposed 标记 gate setState——StrictMode 双跑 effect 时
  // 首轮 promise 的 setState 会被误吞导致永久 loading；React 18 对已卸载组件的
  // setState 本身是安全 no-op，靠 creationInFlightRef 防重复创建即可。
  useEffect(() => {
    if (sessionId) return;
    const remembered = autoCreatedSessionByWindow.get(windowId);
    if (remembered) {
      setCreatedSessionId(remembered);
      return;
    }
    if (creationInFlightRef.current) return;
    creationInFlightRef.current = true;
    setCreateError(null);

    createSessionWithDefaults({ mode: 'chat', title: null })
      .then((session) => {
        autoCreatedSessionByWindow.set(windowId, session.id);
        window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
        setCreatedSessionId(session.id);
      })
      .catch((error: unknown) => {
        setCreateError(getErrorMessage(error));
      })
      .finally(() => {
        creationInFlightRef.current = false;
      });
  }, [sessionId, windowId, createAttempt]);

  // 标题同步：订阅会话 store 的 title（后端自动生成标题后更新窗口标题）
  useEffect(() => {
    if (!sessionId) return;
    const store = sessionManager.get(sessionId);
    const fallbackTitle = t('apps.chat.untitledSession', '新对话');

    const applyTitle = (title: string | null | undefined) => {
      const trimmed = typeof title === 'string' ? title.trim() : '';
      onTitleChange(trimmed || fallbackTitle);
    };

    const subscribeToTitle = (target: NonNullable<typeof store>) => {
      applyTitle(target.getState().title);
      return target.subscribe((state, prevState) => {
        if (state.title !== prevState.title) {
          applyTitle(state.title);
        }
      });
    };

    if (!store) {
      // store 尚未创建（surface 挂载中会创建）；先给兜底标题，下一帧再取。
      // 注意：迟到的 store 也必须订阅，否则后端自动生成标题后窗口标题不再更新
      applyTitle(null);
      let unsubscribeLate: (() => void) | undefined;
      const timer = window.setTimeout(() => {
        const late = sessionManager.get(sessionId);
        if (late) {
          unsubscribeLate = subscribeToTitle(late);
        }
      }, 0);
      return () => {
        window.clearTimeout(timer);
        unsubscribeLate?.();
      };
    }

    return subscribeToTitle(store);
  }, [sessionId, onTitleChange, t]);

  // 多窗隔离适配：聚焦窗口拥有全局“当前会话”指针
  useEffect(() => {
    if (!isActive || !sessionId) return;
    sessionManager.setCurrentSessionId(sessionId);
  }, [isActive, sessionId]);

  // 卸载（关窗或冻结）时，若全局指针仍指向本窗会话则清空，避免悬挂指针
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      if (sessionManager.getCurrentSessionId() === sessionId) {
        sessionManager.setCurrentSessionId(null);
      }
    };
  }, [sessionId]);

  if (createError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Warning size={28} className="text-destructive" aria-hidden="true" />
        <div className="text-sm font-medium text-foreground">
          {t('apps.chat.createFailed', '创建会话失败')}
        </div>
        <div className="max-w-[320px] text-xs text-muted-foreground break-words">{createError}</div>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted"
          onClick={() => {
            setCreateError(null);
            setCreateAttempt((n) => n + 1);
          }}
        >
          {t('apps.chat.retry', '重试')}
        </button>
      </div>
    );
  }

  if (!sessionId) {
    // O16：自动建会话等待态用消息气泡骨架屏占位（替代转圈），
    // 与 ChatWindowFrame 的 chunk 加载骨架 / legacy 冷启动骨架视觉连续
    return <ChatWindowSkeleton statusText={t('apps.chat.preparing', '正在准备会话…')} />;
  }

  return (
    <ChatSessionSurface
      sessionId={sessionId}
      isActive={isActive}
      isVisible={isVisible}
      renderThrottleMs={renderThrottleMs}
      className="h-full"
    />
  );
};

export default ChatAppWindow;
