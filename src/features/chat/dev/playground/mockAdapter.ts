/**
 * LLM Output Playground - Mock Store Adapter
 *
 * 创建一个不连接后端的独立 ChatStore，
 * 通过直接操作 store 状态来模拟 LLM 输出。
 *
 * 节奏策略：通过 setMockRhythm() 注入 RhythmStrategy，
 * 影响 simulateStreaming 的喂数节奏（fixed/poisson/burst）。
 */

import { createChatStore, generateId } from '../../core/store/createChatStore';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types';
import type { BlockType, BlockStatus } from '../../core/types/block';
import type { AutoReplyScenario } from './mockData';
import { AUTO_REPLY_SCENARIOS, BLOCK_TEMPLATES, MOCK_MARKDOWN_CONTENT } from './mockData';
import { planChunks, DEFAULT_RHYTHM } from './eval/rhythm';
import type { RhythmStrategy } from './eval/types';
import {
  createPlaygroundAskUserInteraction,
  createPlaygroundToolApprovalInteraction,
  createPlaygroundToolLimitInteraction,
  type PlaygroundAskUserTemplate,
  type PlaygroundToolApprovalTemplate,
  type PlaygroundToolLimitTemplate,
} from './blockingRuntime';
import type { TodoListOutput } from '../../plugins/blocks/todoList';

// ============================================================================
// Mock Store 创建
// ============================================================================

/**
 * 创建一个用于 Playground 的独立 mock store
 * 不连接 Tauri 后端，所有操作在前端完成
 */
export function createPlaygroundStore(): StoreApi<ChatStore> {
  const sessionId = `playground_${Date.now().toString(36)}`;
  const store = createChatStore(sessionId);

  // 标记数据已加载（跳过后端加载）
  store.setState({ isDataLoaded: true });

  // 注入 mock send callback
  const mockSendCallback = async (
    content: string,
    _attachments: any,
    userMessageId: string,
    assistantMessageId: string
  ) => {
    // 用户消息已由 store 内部创建，我们只需要模拟助手回复
    // 延迟一小段时间模拟网络延迟
    await new Promise((r) => setTimeout(r, 150));

    // 创建助手消息
    store.setState((s) => {
      const newMessageMap = new Map(s.messageMap);
      newMessageMap.set(assistantMessageId, {
        id: assistantMessageId,
        role: 'assistant',
        blockIds: [],
        timestamp: Date.now(),
      });
      const newMessageOrder = [...s.messageOrder, assistantMessageId];
      return {
        messageMap: newMessageMap,
        messageOrder: newMessageOrder,
        sessionStatus: 'streaming',
        currentStreamingMessageId: assistantMessageId,
      };
    });

    // 执行默认的自动回复场景
    const scenario = AUTO_REPLY_SCENARIOS[0]; // 完整回复
    await executeScenario(store, assistantMessageId, scenario);
  };

  // 注入 mock abort callback
  const mockAbortCallback = async () => {
    store.getState().completeStream('cancelled');
  };

  store.setState({
    _sendCallback: mockSendCallback,
    _abortCallback: mockAbortCallback,
  } as any);

  return store;
}

// ============================================================================
// 场景执行引擎
// ============================================================================

/** 当前正在执行的场景的 abort controller */
let currentAbortController: AbortController | null = null;

/** 当前的 rhythm 策略（影响 simulateStreaming 喂数节奏） */
let currentRhythm: RhythmStrategy = DEFAULT_RHYTHM;

/**
 * 设置 mock rhythm 策略
 */
export function setMockRhythm(rhythm: RhythmStrategy): void {
  currentRhythm = rhythm;
}

/**
 * 获取当前 mock rhythm 策略
 */
export function getMockRhythm(): RhythmStrategy {
  return currentRhythm;
}

/**
 * 中断当前正在执行的场景
 */
export function abortCurrentScenario(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

/**
 * 执行一个自动回复场景
 */
export async function executeScenario(
  store: StoreApi<ChatStore>,
  messageId: string,
  scenario: AutoReplyScenario
): Promise<void> {
  // 中断之前的场景
  abortCurrentScenario();
  const controller = new AbortController();
  currentAbortController = controller;

  try {
    for (const blockDef of scenario.blocks) {
      if (controller.signal.aborted) break;

      // 延迟
      if (blockDef.delay && blockDef.delay > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, blockDef.delay);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }

      if (controller.signal.aborted) break;

      // 创建 block
      const blockId = generateId('blk');
      injectBlock(store, messageId, {
        id: blockId,
        type: blockDef.type,
        status: blockDef.streaming ? 'running' : blockDef.status,
        content: blockDef.content,
        toolName: blockDef.toolName,
        toolInput: blockDef.toolInput,
        toolOutput: blockDef.toolOutput,
      });

      // 模拟流式输出
      if (blockDef.streaming && blockDef.content) {
        await simulateStreaming(store, blockId, blockDef.content, controller.signal);
        // 流式完成后标记为最终状态
        updateBlockStatus(store, blockId, blockDef.status);
      }
    }

    // 场景执行完毕，标记流式完成
    if (!controller.signal.aborted) {
      store.getState().completeStream('success');
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      store.getState().completeStream('cancelled');
    } else {
      store.getState().completeStream('error');
    }
  } finally {
    if (currentAbortController === controller) {
      currentAbortController = null;
    }
  }
}

/**
 * 模拟流式输出（按 RhythmStrategy 喂数）。
 * 默认使用 fixed(8, 20)。可通过 setMockRhythm() 全局切换节奏。
 */
async function simulateStreaming(
  store: StoreApi<ChatStore>,
  blockId: string,
  fullContent: string,
  signal: AbortSignal,
): Promise<void> {
  const plan = planChunks(currentRhythm, fullContent.length);
  let pos = 0;

  for (const step of plan) {
    if (signal.aborted) break;

    if (step.chunkChars > 0) {
      pos = Math.min(fullContent.length, pos + step.chunkChars);
      const currentContent = fullContent.slice(0, pos);

      store.setState((s) => {
        const newBlocks = new Map(s.blocks);
        const block = newBlocks.get(blockId);
        if (block) {
          newBlocks.set(blockId, {
            ...block,
            content: currentContent,
            status: 'running',
            firstChunkAt: block.firstChunkAt ?? Date.now(),
          });
        }
        return { blocks: newBlocks };
      });
    }

    if (step.sleepMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.sleepMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    }
  }

  // 兜底：若 plan 因策略原因未能写到末尾，强制 flush
  if (!signal.aborted && pos < fullContent.length) {
    store.setState((s) => {
      const newBlocks = new Map(s.blocks);
      const block = newBlocks.get(blockId);
      if (block) {
        newBlocks.set(blockId, {
          ...block,
          content: fullContent,
          status: 'running',
          firstChunkAt: block.firstChunkAt ?? Date.now(),
        });
      }
      return { blocks: newBlocks };
    });
  }
}

// ============================================================================
// 手动注入 API
// ============================================================================

export interface InjectBlockOptions {
  id?: string;
  type: BlockType;
  status: BlockStatus;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  error?: string;
  citations?: any[];
}

/**
 * 手动注入一个 block 到指定消息
 */
export function injectBlock(
  store: StoreApi<ChatStore>,
  messageId: string,
  options: InjectBlockOptions
): string {
  const blockId = options.id || generateId('blk');
  const now = Date.now();

  store.setState((s) => {
    const newBlocks = new Map(s.blocks);
    newBlocks.set(blockId, {
      id: blockId,
      type: options.type,
      status: options.status,
      messageId,
      content: options.content,
      toolName: options.toolName,
      toolInput: options.toolInput,
      toolOutput: options.toolOutput,
      error: options.error || (options.status === 'error' ? 'Simulated error for debugging' : undefined),
      citations: options.citations,
      startedAt: now,
      firstChunkAt: options.status !== 'pending' ? now : undefined,
      endedAt: options.status === 'success' || options.status === 'error' ? now : undefined,
    });

    // 更新消息的 blockIds
    const newMessageMap = new Map(s.messageMap);
    const message = newMessageMap.get(messageId);
    if (message) {
      newMessageMap.set(messageId, {
        ...message,
        blockIds: [...message.blockIds, blockId],
      });
    }

    // 如果是 running 状态，添加到 activeBlockIds
    const newActiveBlockIds = new Set(s.activeBlockIds);
    if (options.status === 'running') {
      newActiveBlockIds.add(blockId);
    }

    return {
      blocks: newBlocks,
      messageMap: newMessageMap,
      activeBlockIds: newActiveBlockIds,
    };
  });

  return blockId;
}

/**
 * 更新 block 状态
 */
export function updateBlockStatus(
  store: StoreApi<ChatStore>,
  blockId: string,
  status: BlockStatus,
  error?: string
): void {
  store.setState((s) => {
    const newBlocks = new Map(s.blocks);
    const block = newBlocks.get(blockId);
    if (!block) return {};

    newBlocks.set(blockId, {
      ...block,
      status,
      error: error || (status === 'error' ? 'Simulated error' : undefined),
      endedAt: status === 'success' || status === 'error' ? Date.now() : block.endedAt,
    });

    const newActiveBlockIds = new Set(s.activeBlockIds);
    if (status === 'running') {
      newActiveBlockIds.add(blockId);
    } else {
      newActiveBlockIds.delete(blockId);
    }

    return { blocks: newBlocks, activeBlockIds: newActiveBlockIds };
  });
}

/**
 * 创建一条新的助手消息并返回其 ID
 */
export function createAssistantMessage(store: StoreApi<ChatStore>): string {
  const messageId = generateId('msg');

  store.setState((s) => {
    const newMessageMap = new Map(s.messageMap);
    newMessageMap.set(messageId, {
      id: messageId,
      role: 'assistant',
      blockIds: [],
      timestamp: Date.now(),
    });
    return {
      messageMap: newMessageMap,
      messageOrder: [...s.messageOrder, messageId],
    };
  });

  return messageId;
}

/**
 * 创建一条用户消息
 */
export function createUserMessage(store: StoreApi<ChatStore>, content: string): string {
  const messageId = generateId('msg');
  const blockId = generateId('blk');

  store.setState((s) => {
    const newBlocks = new Map(s.blocks);
    newBlocks.set(blockId, {
      id: blockId,
      type: 'content',
      status: 'success',
      messageId,
      content,
      startedAt: Date.now(),
      endedAt: Date.now(),
    });

    const newMessageMap = new Map(s.messageMap);
    newMessageMap.set(messageId, {
      id: messageId,
      role: 'user',
      blockIds: [blockId],
      timestamp: Date.now(),
    });

    return {
      blocks: newBlocks,
      messageMap: newMessageMap,
      messageOrder: [...s.messageOrder, messageId],
    };
  });

  return messageId;
}

/**
 * 清空所有消息
 */
export function clearAllMessages(store: StoreApi<ChatStore>): void {
  store.setState({
    messageMap: new Map(),
    messageOrder: [],
    blocks: new Map(),
    activeBlockIds: new Set(),
    currentStreamingMessageId: null,
    pendingBlockingInteraction: null,
    sessionStatus: 'idle',
  });
}

export function triggerBlockingAskUser(
  store: StoreApi<ChatStore>,
  template: PlaygroundAskUserTemplate,
): string {
  const messageId = createAssistantMessage(store);
  const blockId = injectBlock(store, messageId, {
    type: 'ask_user',
    status: 'running',
    toolName: 'builtin-ask_user',
    toolInput: {
      question: template.question,
      options: template.options,
      multiple: template.multiple ?? false,
      allowCustom: template.allowCustom ?? true,
      timeoutSeconds: template.timeoutSeconds ?? null,
      context: template.context,
    },
  });

  store.getState().setBlockingInteraction(
    createPlaygroundAskUserInteraction(store, blockId, template),
  );
  store.setState({ sessionStatus: 'idle' });
  return blockId;
}

export function triggerBlockingToolApproval(
  store: StoreApi<ChatStore>,
  template: PlaygroundToolApprovalTemplate,
): string {
  const messageId = createAssistantMessage(store);
  const blockId = injectBlock(store, messageId, {
    type: 'mcp_tool',
    status: 'running',
    toolName: template.toolName,
    toolInput: template.arguments,
    content: template.description,
  });

  store.getState().setBlockingInteraction(
    createPlaygroundToolApprovalInteraction(store, blockId, template),
  );
  store.setState({ sessionStatus: 'idle' });
  return blockId;
}

export function triggerBlockingToolLimit(
  store: StoreApi<ChatStore>,
  template: PlaygroundToolLimitTemplate,
): string {
  const messageId = createAssistantMessage(store);
  const blockId = injectBlock(store, messageId, {
    type: 'tool_limit',
    status: 'running',
    content: template.content,
  });

  store.getState().setBlockingInteraction(
    createPlaygroundToolLimitInteraction(store, blockId, template),
  );
  store.setState({ sessionStatus: 'idle' });
  return blockId;
}

export function triggerTodoSample(
  store: StoreApi<ChatStore>,
  sample: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput: TodoListOutput;
    content?: string;
  },
): string {
  const messageId = createAssistantMessage(store);
  const blockId = injectBlock(store, messageId, {
    type: 'mcp_tool',
    status: sample.toolOutput.currentRunning ? 'running' : 'success',
    toolName: sample.toolName,
    toolInput: sample.toolInput,
    toolOutput: sample.toolOutput,
    content: sample.content,
  });

  store.setState({ sessionStatus: 'idle' });
  return blockId;
}

/**
 * 手动触发一个完整场景（创建助手消息 + 执行场景）
 */
export async function triggerScenario(
  store: StoreApi<ChatStore>,
  scenarioId: string
): Promise<void> {
  const scenario = AUTO_REPLY_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return;

  const messageId = createAssistantMessage(store);

  // 设置流式状态
  store.setState({
    sessionStatus: 'streaming',
    currentStreamingMessageId: messageId,
  });

  await executeScenario(store, messageId, scenario);
}

/**
 * 手动注入单个 block（创建助手消息 + 注入 block）
 */
export function triggerSingleBlock(
  store: StoreApi<ChatStore>,
  templateIndex: number,
  statusOverride?: BlockStatus
): void {
  const template = BLOCK_TEMPLATES[templateIndex];
  if (!template) return;

  const messageId = createAssistantMessage(store);

  injectBlock(store, messageId, {
    type: template.type,
    status: statusOverride ?? template.defaultStatus,
    content: template.content,
    toolName: template.toolName,
    toolInput: template.toolInput,
    toolOutput: template.toolOutput,
    citations: template.citations,
  });

  // 如果不是 running 状态，确保 session 回到 idle
  if ((statusOverride ?? template.defaultStatus) !== 'running') {
    store.setState({ sessionStatus: 'idle' });
  }
}
