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
import type { DemoPaneNote } from './ChatWithSourcePane';
import { createDemoIpcHandler } from '../../../mockIpc';
import { DEMO_SESSIONS, type DemoBlocks } from '../../../fixtures';
import { playNextReplyInstantly, playReplyScript } from '../../../scriptPlayer';
import { getPlayedHistory } from '../../../playedHistory';

/** 访客追问：prompt 命中任一关键词即播这段剧本 */
export interface ChatSceneReply {
  keywords: string[];
  /** 固定剧本，或按访客原话生成（比如把「记住：……」的内容写进回复） */
  reply: DemoBlocks | ((content: string) => DemoBlocks);
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
  /** 点 PDF 页码徽章 / 附件时在右侧打开原文（见 ./ChatWithSourcePane） */
  sourcePane?: boolean;
  /** 右侧窗格可打开的笔记（报告、记忆条目、知识库来源），id → 内容；给了就自动启用 sourcePane */
  notes?: Record<string, DemoPaneNote>;
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

const apiConfig = (id: string, name: string, vendorId: string, vendorName: string, model: string, extra: Record<string, unknown>) => ({
  id, name, vendorId, vendorName, providerType: 'openai', apiKey: 'demo-key-not-real', baseUrl: '', model,
  isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false, enabled: true, modelAdapter: 'openai', ...extra,
});

const EXTRA_API_CONFIGS = [
  apiConfig('demo-config-kimi', 'Kimi', 'moonshot', 'Moonshot', 'kimi-k3', { isReasoning: true }),
  apiConfig('demo-config-qwen-vl', 'Qwen VL', 'qwen', '通义千问', 'qwen3-vl-plus', { isMultimodal: true }),
];

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
    if (!hit) return options.fallback;
    return typeof hit.reply === 'function' ? hit.reply(content) : hit.reply;
  };

  const handle = (cmd: string, args: DemoArgs): unknown => {
    // 设置表交给通用 mock（对话演示后端的设置表是经典布局那套）
    if (cmd === 'get_setting' || cmd === 'save_setting') return undefined;
    // 空会话页的「薄弱知识点」：演示里没有作答记录
    // 原文窗格里的 PDF 阅读进度：演示不落盘
    if (cmd === 'dstu_set_metadata') return null;
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
    const result = backend(cmd, args);
    // 模型选择器：对话演示只配了一家，这里再补两家，让「模型」子菜单有得选
    if (cmd === 'get_api_configurations' && Array.isArray(result)) return [...result, ...EXTRA_API_CONFIGS];
    return result;
  };

  return {
    title: options.title,
    instanceKey: sessionId,
    load: () =>
      options.sourcePane || options.notes
        ? import('./ChatWithSourcePane').then((m) => {
            m.setDemoPaneNotes(options.notes ?? {});
            return m.default;
          })
        : import('@/features/workbench/apps/chat/ChatSessionWindowFrame').then((m) => m.default),
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
      // 检索类事件（rag / web_search / academic_search）的 start 不带工具名与入参，实时播放后块上没有；
      // 从历史加载的块有（后端落库时写入）。首屏按「打开一条已有会话」的样子补上，
      // 学术搜索块才会显示检索词、时间线才分得清 arXiv 与学术搜索。
      const state = store.getState();
      const lastId = state.messageOrder[state.messageOrder.length - 1];
      const answer = lastId ? state.messageMap.get(lastId) : undefined;
      for (const blockId of answer?.blockIds ?? []) {
        const index = Number(/-sb(\d+)$/.exec(blockId)?.[1] ?? NaN);
        const def = firstReply[index];
        const block = state.blocks.get(blockId);
        if (!def || !block || block.type !== def.type || block.toolName || !def.toolName) continue;
        state.updateBlock(blockId, {
          toolName: def.toolName.startsWith('builtin-') ? def.toolName : `builtin-${def.toolName}`,
          ...(def.toolInput ? { toolInput: def.toolInput } : {}),
        });
      }
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

/** 消息区滚到最底 */
export function scrollToConversationEnd(root: HTMLElement): void {
  const scroller = findMessageScroller(root);
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

/** 展开回答下方的来源卡片（「N 个结果」） */
export async function expandSources(root: HTMLElement): Promise<void> {
  const toggle = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    /^\d+\s*(个结果|results?)$/i.test((b.textContent ?? '').trim()),
  );
  if (!toggle) return;
  toggle.click();
  await sleep(300);
}

/** 对话窗口用到的文案命名空间（输入栏、块渲染、设置里的模型与 MCP 名称、空态的今日待复习） */
export const CHAT_NAMESPACES = ['chatV2', 'workbench', 'learningHub', 'anki', 'mindmap', 'skills', 'sandbox', 'settings', 'analysis', 'app_menu', 'data', 'mcp'];

/** 纯文本回复块 */
export const textReply = (content: string): DemoBlocks => [{ type: 'content', status: 'success', streaming: true, content }];
