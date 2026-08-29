/**
 * ChatSessionSurface — 单会话完整渲染面（P7，O16 打磨）
 *
 * 给定 sessionId，渲染一个完整的 ChatV2 会话（消息流 + 输入栏 + 审批栏 + blocks）。
 * 只做 UI 层组合复用：核心渲染完全复用 `ChatContainer`
 * （其内部已组合 useConnectedSession / MessageList / InputBarV2(含阻塞审批栏) /
 * AgentTaskPanel / ChatErrorBoundary），不触碰 chat 管线 / store / adapter。
 *
 * 多窗并存安全性：
 * - store 按 sessionId 隔离（sessionManager），两个 surface 不同 sessionId 互不干扰；
 * - TauriAdapter 由 AdapterManager 按 sessionId 引用计数管理，卸载只减引用不销毁；
 * - StreamPreferencesProvider 为 React Context，逐窗独立。
 *
 * O16 窗口内体验（全部在适配层，零 legacy 改动）：
 * - 流式降频平滑：不可见降档经 useDeferredStreamPreset 延迟下档（瞬时遮挡不骤停），
 *   可见性回归立即回 balanced 全速补渲；
 * - 缩放稳定锚点：useResizeScrollAnchor 在窗口几何变化时保持消息流距底距离，
 *   吸底不被顶飞、翻阅位置不漂移；
 * - 窄窗紧凑布局 + 焦点/输入隔离视觉：wb-chat-surface 容器查询与
 *   data-wb-chat-active 状态见 ChatSessionSurface.css。
 */
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SidebarSimple } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { ChatContainer } from '@/features/chat/components/ChatContainer';
import { StreamPreferencesProvider } from '@/features/chat/components/renderers/StreamPreferencesContext';
import { SandboxWorkbenchSurface } from '@/features/sandbox/components/SandboxWorkbenchSurface';
import {
  createChatSandboxOwnerKey,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { useDeferredStreamPreset } from './useDeferredStreamPreset';
import { useResizeScrollAnchor } from './useResizeScrollAnchor';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import './ChatSessionSurface.css';

export interface ChatSessionSurfaceProps {
  /** 会话 ID（sess_xxx） */
  sessionId: string;
  /** 窗口是否为焦点（lifecycle === 'focused'）；驱动输入区焦点确认视觉 */
  isActive?: boolean;
  /** 窗口是否可见（focused | visible）；false 时流式渲染降频 */
  isVisible?: boolean;
  /** scheduler 节流建议；>0 时可见窗也降 silky（拖拽/非焦点让帧） */
  renderThrottleMs?: number;
  className?: string;
}

/**
 * data-wb-chat-session 属性用于窗口级 DOM 定位（onActivation 的 scrollToMessage
 * 需要把查询范围限定在本窗口内，避免多窗同 DOM 结构互相误中）。
 */
export const ChatSessionSurface: React.FC<ChatSessionSurfaceProps> = ({
  sessionId,
  isActive = false,
  isVisible = true,
  renderThrottleMs = 0,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const rootRef = useRef<HTMLDivElement>(null);
  const sandboxOwnerKey = createChatSandboxOwnerKey(sessionId);
  const sandboxActiveSession = useSandboxWorkbenchStore(
    (state) => selectSandboxWorkbenchOwnerState(state, sandboxOwnerKey).activeSession,
  );
  const sandboxWorkbenchOpen = useSandboxWorkbenchStore(
    (state) => selectSandboxWorkbenchOwnerState(state, sandboxOwnerKey).isOpen,
  );
  const activateSandboxOwner = useSandboxWorkbenchStore((state) => state.activateOwner);
  const openSandboxWorkbench = useSandboxWorkbenchStore((state) => state.openWorkbench);
  const handleSandboxOwnerActivation = useCallback(() => {
    activateSandboxOwner(sandboxOwnerKey);
  }, [activateSandboxOwner, sandboxOwnerKey]);

  // 与 ChatV2Page 的 StreamPreferencesProvider preset="balanced" mode="blocked"
  // 保持一致；不可见窗口延迟降档为 silky（commitIntervalMs 48ms），
  // token 缓冲不丢，可见性回归立即切回 balanced 全速补渲。
  // renderThrottleMs>0（拖拽活动 / 非焦点可见）立即 silky，让帧给跟手。
  const preset = useDeferredStreamPreset(isVisible, renderThrottleMs);

  // 壳层拖/缩：同步挂 data-wb-render-paused（CSS 停动画）；流式另走 imperative 检查
  useDragRenderPause(rootRef, renderThrottleMs);

  // 窗口缩放/平铺落位时保持消息流的距底距离（稳定滚动锚点）
  useResizeScrollAnchor(rootRef);

  return (
    <StreamPreferencesProvider preset={preset} mode="blocked">
      <div
        ref={rootRef}
        data-wb-chat-session={sessionId}
        data-wb-chat-active={isActive ? 'true' : 'false'}
        data-sandbox-owner-key={sandboxOwnerKey}
        onPointerDownCapture={handleSandboxOwnerActivation}
        onFocusCapture={handleSandboxOwnerActivation}
        className={cn('wb-chat-surface relative h-full min-h-0 w-full overflow-hidden', className)}
      >
        <ChatContainer sessionId={sessionId} className="h-full" />
        {/* Keep the preview inside this window's DOM and owner scope. */}
        {sandboxWorkbenchOpen && sandboxActiveSession ? (
          <div
            data-wb-chat-sandbox-owner={sandboxOwnerKey}
            className="wb-chat-sandbox-panel absolute inset-y-0 right-0 w-[min(100%,720px)] overflow-hidden"
          >
            <SandboxWorkbenchSurface
              embedded
              ownerKey={sandboxOwnerKey}
              className="h-full"
            />
          </div>
        ) : sandboxActiveSession ? (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="wb-chat-sandbox-expand absolute right-2 top-2 !h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            onClick={() => openSandboxWorkbench(sandboxOwnerKey)}
            aria-label={t('page.expandSandboxWorkbench')}
            title={t('page.expandSandboxWorkbench')}
          >
            <SidebarSimple size={18} />
          </DsButton>
        ) : null}
      </div>
    </StreamPreferencesProvider>
  );
};

export default ChatSessionSurface;
