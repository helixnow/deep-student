/**
 * Web 演示壳 - 自动播放驱动
 *
 * 点进剧本会话后自动播放一轮追问：经真实 store.sendMessage 链路发送
 * 该会话的 autoPrompt（用户气泡照常上屏），mock 的 chat_v2_send_message
 * 随即把 followUp 剧本（思维链 + 流式输出）推给真实 adapter 渲染。
 *
 * 触发时机：sessionManager 的 current-session-changed 事件（含初次自动导航）。
 * 重进同一会话会重新播放——历史在 load_session 时重置为静态剧本，
 * 自动播放的上一轮本就不会残留，重播恰好与之一致。
 */

import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { SessionManagerEvent } from '@/features/chat/core/session/types';
import { DEMO_SESSIONS } from './fixtures';
import { abortScript } from './scriptPlayer';

const LOG = '[demo-autoplay]';

/** 进入<|sep|>后留出看清<|sep|>内容的节拍，再自动发问 */
const ENTRY_DELAY_MS = 1000;

const isDemoSession = (sessionId: string) =>
  DEMO_SESSIONS.some((s) => s.meta.id === sessionId);

/**
 * 清扫启动时应用自建的空草稿会话（ensureActiveChatSession 在首轮加载时
 * 创建，列表里显示为"未命名会话"的杂物）。删除后派发 sessions-updated
 * 让侧栏刷新。当前会话永不删除（守卫 s.id !== currentId）。
 */
const sweepDraftSessions = async (currentId: string): Promise<void> => {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const list = await invoke<Array<{ id: string }>>('chat_v2_list_sessions', {
      status: 'active',
    });
    const drafts = list.filter(
      (s) => s.id.startsWith('demo-draft-') && s.id !== currentId,
    );
    if (drafts.length === 0) return;
    await Promise.all(
      drafts.map((s) =>
        invoke('chat_v2_delete_session', { sessionId: s.id }),
      ),
    );
    window.dispatchEvent(new CustomEvent('chat-v2:sessions-updated'));
    console.info(LOG, `swept ${drafts.length} draft session(s)`);
  } catch (e) {
    console.warn(LOG, 'draft sweep failed:', e);
  }
};

export function installDemoAutoPlay(): void {
  /** 单调递增令牌：切换<|sep|>时使上一个等待中的播放作废 */
  let ticket = 0;
  /** 上一个当前<|sep|>：离开时销毁其缓存 store（见下） */
  let previousId: string | null = null;

  const maybePlay = (sessionId: string) => {
    const fixture = DEMO_SESSIONS.find((s) => s.meta.id === sessionId);
    if (!fixture?.autoPrompt) return;

    const myTicket = ++ticket;
    window.setTimeout(() => {
      if (myTicket !== ticket) return;
      if (sessionManager.getCurrentSessionId() !== sessionId) return;

      const store = sessionManager.peek(sessionId);
      if (!store) return;
      const status = store.getState().sessionStatus;
      if (status === 'streaming' || status === 'sending') return;

      console.info(LOG, `auto-play ${sessionId}: ${fixture.autoPrompt}`);
      store.getState().sendMessage(fixture.autoPrompt, []).catch((e) => {
        console.warn(LOG, 'auto-play send failed:', e);
      });
    }, ENTRY_DELAY_MS);
  };

  sessionManager.subscribe((event: SessionManagerEvent) => {
    if (event.type !== 'current-session-changed') return;

    // 离开剧本<|sep|>时销毁其缓存 store：mock 后端是冻结的静态剧本，
    // 缓存 store 里已流完的内容会在下次进入时先闪现"最终态"，
    // 随后才被 chat_v2_load_session 拉回初始剧本重置，观感断裂。
    // 销毁后下次进入重建空 store → 恢复静态历史 → 重新自动播放。
    if (
      previousId &&
      previousId !== event.sessionId &&
      isDemoSession(previousId)
    ) {
      abortScript(previousId);
      void sessionManager.destroy(previousId);
    }
    previousId = event.sessionId || null;

    if (event.sessionId) {
      if (isDemoSession(event.sessionId)) {
        void sweepDraftSessions(event.sessionId);
      }
      maybePlay(event.sessionId);
    }
  });
}
