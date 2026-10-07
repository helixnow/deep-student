/**
 * 对话类章节（chat / research-memory / paper-search）共用的剧本包骨架。
 *
 * 渲染一扇单会话窗口（学习桌面里「对话」开出的同一份 ChatSessionWindowFrame，instanceKey = 会话 id），
 * 会话数据与流式回放全部走 ../../../mockIpc 的对话演示后端（createDemoIpcHandler）+ scriptPlayer：
 *   - 首屏（也是海报）就是首答播完的样子：挂载后经真实 store.sendMessage 发出第一问，
 *     剧本瞬时回放（playNextReplyInstantly），消息、块、引用徽章全部是生产渲染；
 *   - 之后访客自己输入：命中关键词的走本章的续答剧本，其余走本章的兜底回复。
 *
 * 只依赖演示数据模块；app 代码（sessionManager）在 afterMount 里动态 import（见 ../../types.ts）。
 */
import type { SessionInfo } from '@/features/chat/adapters/types';
import type { ContextRef } from '@/features/chat/context/types';
import type { DemoAppPack, DemoArgs } from '../../types';
import { createDemoIpcHandler } from '../../../mockIpc';
import { DEMO_SESSIONS, type DemoBlocks } from '../../../fixtures';
import { playNextReplyInstantly, playReplyScript } from '../../../scriptPlayer';
import { getPlayedHistory } from '../../../playedHistory';

/** 访客追问：prompt 命中任一关键词即播这段剧本 */
export interface ChatSceneReply {
  keywords: string[];
  reply: DemoBlocks;
}

export interface ChatSceneOptions {
  title: string;
  /** 会话 id：fixtures 里的剧本会话，或下面 custom 给出的本章专属会话 */
  sessionId: string;
  /** 本章专属会话（不在 DEMO_SESSIONS 里）：元数据、第一问与第一答 */
  custom?: {
    title: string;
    description?: string;
    prompt: string;
    reply: DemoBlocks;
    attachmentRefs?: ContextRef[];
  };
  /** 访客追问的剧本（按顺序匹配关键词） */
  replies?: ChatSceneReply[];
  /** 都没命中时的回复 */
  fallback: DemoBlocks;
  /** 首答播完后、海报前调整滚动位置等 */
  arrange?(root: HTMLElement): Promise<void> | void;
  namespaces?: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs: number, stepMs = 50): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

/**
 * 对话演示后端遇到不认识的命令会打一行 warn 并回 null；单应用演示要让它落到通用 mock，
 * 由通用 mock 记进 __DEMO_UNMOCKED__（烟测据此报漏）。这里把那条 warn 截下来，改回 undefined。
 */
function passUnknownThrough(handler: (cmd: string, payload?: unknown) => unknown) {
  return (cmd: string, args: DemoArgs): unknown => {
    let unknown = false;
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => {
      if (parts[0] === '[demo-ipc] unmocked cmd:') {
        unknown = true;
        return;
      }
      warn(...parts);
    };
    try {
      const result = handler(cmd, args);
      return unknown ? undefined : result;
    } finally {
      console.warn = warn;
    }
  };
}

function withLatency<T>(value: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function createChatScenePack(options: ChatSceneOptions): DemoAppPack {
  const { sessionId, custom } = options;
  const fixture = DEMO_SESSIONS.find((f) => f.meta.id === sessionId);
  const prompt = custom?.prompt ?? fixture?.autoPrompt ?? '';
  const firstReply = custom?.reply ?? fixture?.followUp ?? options.fallback;
  const attachmentRefs = custom?.attachmentRefs ?? fixture?.attachmentRefs ?? [];

  const now = Date.now();
  const customMeta: SessionInfo | null = custom
    ? {
        id: sessionId,
        mode: 'chat',
        title: custom.title,
        description: custom.description,
        persistStatus: 'active',
        createdAt: new Date(now - 12 * 60_000).toISOString(),
        updatedAt: new Date(now - 2 * 60_000).toISOString(),
      }
    : null;

  let backend: ((cmd: string, args: DemoArgs) => unknown) | null = null;
  let firstPlayed = false;

  const pickReply = (content: string): DemoBlocks => {
    if (!firstPlayed) {
      firstPlayed = true;
      return firstReply;
    }
    const continuation = fixture?.continuations?.find((c) => c.prompt === content);
    if (continuation) return continuation.reply;
    const text = content.toLowerCase();
    const hit = options.replies?.find((r) => r.keywords.some((k) => text.includes(k.toLowerCase())));
    return hit?.reply ?? options.fallback;
  };

  const handle = (cmd: string, args: DemoArgs): unknown => {
    // 设置表交给通用 mock（对话演示后端的设置表是经典布局那套）
    if (cmd === 'get_setting' || cmd === 'save_setting') return undefined;
    // 空会话页的「薄弱知识点」：演示里没有作答记录
    if (cmd === 'mastery_get_overview') return { conceptCount: 0, weakCount: 0, avgScore: 0, weakest: [] };
    const target = String(args.sessionId ?? (args.request as { sessionId?: string } | undefined)?.sessionId ?? '');

    if (target === sessionId) {
      if (cmd === 'chat_v2_send_message') {
        const request = args.request as { content: string; assistantMessageId: string };
        void playReplyScript({ sessionId, assistantMessageId: request.assistantMessageId, blocks: pickReply(request.content) });
        return request.assistantMessageId;
      }
      if (customMeta) {
        if (cmd === 'chat_v2_get_session') return customMeta;
        if (cmd === 'chat_v2_load_session') {
          const played = getPlayedHistory(sessionId);
          return withLatency({ session: customMeta, messages: played?.messages ?? [], blocks: played?.blocks ?? [] });
        }
      }
    }
    backend ??= passUnknownThrough(createDemoIpcHandler());
    return backend(cmd, args);
  };

  return {
    title: options.title,
    instanceKey: sessionId,
    load: () => import('@/features/workbench/apps/chat/ChatSessionWindowFrame').then((m) => m.default),
    handle,
    namespaces: options.namespaces,
    async prepare() {
      // 来源面板的分组名写成 t(common 键, { defaultValue: t(chatV2 键) })：内层那次查找总会落空，
      // 界面显示正常（common 里有），但会被烟测当成缺失文案。把 common 那组复制到 chatV2 键下。
      const { default: i18n } = await import('@/i18n');
      const labels = i18n.getResource(i18n.language, 'common', 'chat.sources.groupLabels');
      if (labels && typeof labels === 'object') {
        i18n.addResourceBundle(i18n.language, 'chatV2', { sourcePanel: { groupLabels: labels } }, true, false);
      }
    },
    async afterMount(root) {
      const { sessionManager } = await import('@/features/chat/core/session/sessionManager');
      const store = await waitFor(() => {
        const s = sessionManager.peek(sessionId);
        return s && s.getState().isDataLoaded ? s : null;
      }, 8000);
      if (!store || store.getState().messageOrder.length > 0) return;

      // 第一问：附件先进输入栏（等价于访客先「添加附件」），再经真实 sendMessage 发出；剧本瞬时回放
      for (const ref of attachmentRefs) store.getState().addContextRef(ref);
      playNextReplyInstantly(sessionId);
      await store.getState().sendMessage(prompt, []).catch((error) => {
        console.warn('[demo-app] first prompt failed:', error);
      });
      await waitFor(() => {
        const state = store.getState();
        if (state.sessionStatus !== 'idle') return false;
        const lastId = state.messageOrder[state.messageOrder.length - 1];
        const last = lastId ? state.messageMap.get(lastId) : undefined;
        if (!last || last.role !== 'assistant' || last.blockIds.length === 0) return false;
        return last.blockIds.every((id) => {
          const status = state.blocks.get(id)?.status;
          return status === 'success' || status === 'error';
        });
      }, 9000);
      // 让列表把最后几个块排完版
      await sleep(250);
      await options.arrange?.(root);
    },
  };
}

/** 消息流的滚动容器（ChatContainer 里唯一一个可滚的纵向区域） */
export function findMessageScroller(root: HTMLElement): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => {
    const style = getComputedStyle(el);
    return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4;
  });
  return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null;
}

/** 把某个元素滚到消息区上沿下方 offset 处（只滚消息区自己） */
export function scrollIntoMessageView(root: HTMLElement, target: Element | null, offset = 16): void {
  if (!target) return;
  const scroller = findMessageScroller(root);
  if (!scroller) return;
  scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
}

/** 消息区滚回最上方（首答播完时停在末尾） */
export function scrollToConversationTop(root: HTMLElement): void {
  const scroller = findMessageScroller(root);
  if (scroller) scroller.scrollTop = 0;
}

/** 对话窗口用到的文案命名空间（输入栏、块渲染、设置里的模型与 MCP 名称、空态的今日待复习） */
export const CHAT_NAMESPACES = ['chatV2', 'workbench', 'learningHub', 'anki', 'mindmap', 'skills', 'sandbox', 'settings', 'analysis', 'app_menu', 'data', 'mcp'];

/** 纯文本回复块 */
export const textReply = (content: string): DemoBlocks => [{ type: 'content', status: 'success', streaming: true, content }];
