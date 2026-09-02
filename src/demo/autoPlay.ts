/**
 * Web 演示壳 - 自动播放驱动
 *
 * 点进剧本<|sep|>后自动播放首轮问答：先把该<|sep|>的 autoPrompt 逐字"打"进
 * 空态的真实输入框（打字机动画，观感像真人在操作），停顿一拍后点击真实
 * 发送按钮；mock 的 chat_v2_send_message 随即把第一答剧本（思维链 +
 * 流式输出）推给真实 adapter 渲染——全程 100% 生产链路。
 *
 * 触发时机：sessionManager 的 current-session-changed 事件（含初次自动导航）。
 * 2026-09 行为变更：播放完成的会话会把最终 消息+块 快照进 playedHistory；
 * 同一次访问内切走再切回时 load_session 返回快照、显示完成态，不再重播。
 * 页面刷新（新一次访问）后首轮播放照旧。
 */

import { sessionManager } from '@/features/chat/core/session/sessionManager';
import type { SessionManagerEvent } from '@/features/chat/core/session/types';
import { DEMO_SESSIONS } from './fixtures';
import { abortScript } from './scriptPlayer';
import { capturePlayedSnapshot } from './playedHistory';

const LOG = '[demo-autoplay]';

/** 进入<|sep|>后先让空态输入框亮相的节拍，再开始打字 */
const PRE_TYPE_DELAY_MS = 600;
/** 逐字打字间隔（带轻微抖动更像真人） */
const typeCharMs = () => 35 + Math.random() * 45;
/** 打完字到点击发送之间的"看一眼"停顿 */
const POST_TYPE_PAUSE_MS = 450;

const isDemoSession = (sessionId: string) =>
  DEMO_SESSIONS.some((s) => s.meta.id === sessionId);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const findComposer = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="请输入"]') ??
  document.querySelector<HTMLTextAreaElement>('textarea');

/** 经原生 setter + input 事件写入，React 受控组件可正常感知 */
const setComposerValue = (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const clearComposer = () => {
  const el = findComposer();
  if (el && el.value) setComposerValue(el, '');
};

/**
 * 清扫启动时应用自建的空草稿<|sep|>（ensureActiveChatSession 在首轮加载时
 * 创建，列表里显示为"未命名<|sep|>"的杂物）。删除后派发 sessions-updated
 * 让侧栏刷新。当前<|sep|>永不删除（守卫 s.id !== currentId）。
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
  /** 单调递增令牌：切换<|sep|>时使等待中/打字中的播放作废 */
  let ticket = 0;
  /** 上一个当前<|sep|>：离开时销毁其缓存 store（见下） */
  let previousId: string | null = null;

  /** 逐字打字 → 点击真实发送按钮；任何时刻切走都会作废并清理残字 */
  const typeAndSend = async (
    sessionId: string,
    prompt: string,
    isStale: () => boolean,
  ): Promise<void> => {
    const store = sessionManager.peek(sessionId);
    const directSend = () => {
      clearComposer();
      store?.getState().sendMessage(prompt, []).catch((e) => {
        console.warn(LOG, 'auto-play send failed:', e);
      });
    };

    // 等空态输入框挂载（<|sep|>切换后空态渲染需要一拍）
    let ta = findComposer();
    for (let i = 0; i < 20 && !ta; i += 1) {
      await sleep(100);
      ta = findComposer();
    }
    if (!ta || isStale()) {
      if (!isStale()) directSend();
      return;
    }

    ta.focus({ preventScroll: true });
    for (let i = 1; i <= prompt.length; i += 1) {
      if (isStale()) {
        clearComposer();
        return;
      }
      setComposerValue(ta, prompt.slice(0, i));
      await sleep(typeCharMs());
    }
    await sleep(POST_TYPE_PAUSE_MS);
    if (isStale()) {
      clearComposer();
      return;
    }

    const sendBtn = [...document.querySelectorAll('button')].find(
      (b) =>
        b.getAttribute('aria-label') === '发送消息' &&
        !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement | undefined;
    if (sendBtn) {
      sendBtn.click();
      console.info(LOG, `auto-play ${sessionId}: ${prompt}`);
    } else {
      directSend();
    }
  };

  const maybePlay = (sessionId: string) => {
    const fixture = DEMO_SESSIONS.find((s) => s.meta.id === sessionId);
    if (!fixture?.autoPrompt) return;

    const myTicket = ++ticket;
    const isStale = () =>
      myTicket !== ticket ||
      sessionManager.getCurrentSessionId() !== sessionId;

    window.setTimeout(() => {
      if (isStale()) return;
      void (async () => {
        const store = sessionManager.peek(sessionId);
        if (!store) return;
        // 等历史加载落定：已播放过的会话会从快照恢复出消息，
        // 此时直接显示完成态，不再打字重播
        for (let i = 0; i < 30; i += 1) {
          const state = store.getState();
          if (state.isDataLoaded) {
            if (state.messageOrder.length > 0) {
              console.info(LOG, `skip auto-play ${sessionId}: history restored`);
              return;
            }
            break;
          }
          if (isStale()) return;
          await sleep(100);
        }
        if (isStale()) return;
        const status = store.getState().sessionStatus;
        if (status === 'streaming' || status === 'sending') return;
        void typeAndSend(sessionId, fixture.autoPrompt!, isStale);
      })();
    }, PRE_TYPE_DELAY_MS);
  };

  sessionManager.subscribe((event: SessionManagerEvent) => {
    if (event.type !== 'current-session-changed') return;

    // 离开剧本<|sep|>时兜底快照当前内容（播放中途切走时保存已流出的部分；
    // 正常播完的路径由 scriptPlayer 在 stream_complete 后快照）。
    // 不销毁缓存 store——isDataLoaded 语义下切回会话直接复用缓存，
    // 避免"先空态再加载"的闪烁；store 万一被回收，load_session 也有快照兜底。
    if (
      previousId &&
      previousId !== event.sessionId &&
      isDemoSession(previousId)
    ) {
      abortScript(previousId);
      try {
        capturePlayedSnapshot(previousId);
      } catch (e) {
        console.warn(LOG, 'leave-snapshot failed:', e);
      }
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
