/**
 * 聊天相关事件常量与类型定义
 * 
 * 集中管理所有聊天事件名称和载荷类型，确保编译期类型安全
 */

/**
 * 聊天事件名称常量
 */
export const CHAT_EVENTS = {
  /** 流式完成事件 */
  STREAM_COMPLETE: 'CHAT_STREAM_COMPLETE',
  /** 保存完成事件 */
  SAVE_COMPLETE: 'CHAT_SAVE_COMPLETE',
  /** 测试：删除消息 */
  TEST_DELETE_MESSAGE: 'TEST_DELETE_MESSAGE',
  /** 测试：删除完成 */
  TEST_DELETE_COMPLETE: 'TEST_DELETE_COMPLETE',
  /** 测试：触发手动保存 */
  TEST_TRIGGER_MANUAL_SAVE: 'TEST_TRIGGER_MANUAL_SAVE',
  /** 测试：手动保存完成 */
  TEST_MANUAL_SAVE_COMPLETE: 'TEST_MANUAL_SAVE_COMPLETE',
} as const;

/**
 * 流式完成事件载荷
 */
export interface StreamCompletePayload {
  /** 业务ID（错题ID） */
  businessId?: string;
  /** 流ID */
  streamId?: string;
  /** 消息数量 */
  messageCount?: number;
  /** 完成时间戳 */
  timestamp?: number;
}

/**
 * 保存完成事件载荷
 */
export interface SaveCompletePayload {
  /** 业务ID（错题ID） */
  businessId?: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 保存的消息数量 */
  messageCount?: number;
  /** 操作类型 */
  operation?: 'create' | 'update' | 'delete';
  /** 时间戳 */
  timestamp?: number;
}

/**
 * 删除消息事件载荷
 */
export interface DeleteMessagePayload {
  /** 业务ID（错题ID） */
  businessId: string;
  /** 要删除的消息stableId */
  stableId: string;
}

/**
 * 删除完成事件载荷
 */
export interface DeleteCompletePayload {
  /** 业务ID（错题ID） */
  businessId: string;
  /** 是否成功 */
  success: boolean;
  /** 删除的stableId */
  stableId: string;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 触发手动保存事件载荷
 */
export interface TriggerManualSavePayload {
  /** 业务ID（错题ID） */
  businessId: string;
  /** 保存原因 */
  reason: string;
}

/**
 * 手动保存完成事件载荷
 */
export interface ManualSaveCompletePayload {
  /** 业务ID（错题ID） */
  businessId: string;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时） */
  error?: string;
  /** 保存的消息数量 */
  messageCount?: number;
}

/**
 * 类型化的事件映射
 */
export interface ChatEventMap {
  [CHAT_EVENTS.STREAM_COMPLETE]: CustomEvent<StreamCompletePayload>;
  [CHAT_EVENTS.SAVE_COMPLETE]: CustomEvent<SaveCompletePayload>;
  [CHAT_EVENTS.TEST_DELETE_MESSAGE]: CustomEvent<DeleteMessagePayload>;
  [CHAT_EVENTS.TEST_DELETE_COMPLETE]: CustomEvent<DeleteCompletePayload>;
  [CHAT_EVENTS.TEST_TRIGGER_MANUAL_SAVE]: CustomEvent<TriggerManualSavePayload>;
  [CHAT_EVENTS.TEST_MANUAL_SAVE_COMPLETE]: CustomEvent<ManualSaveCompletePayload>;
}

/**
 * 类型安全的事件派发
 */
export function dispatchChatEvent<K extends keyof ChatEventMap>(
  eventName: K,
  detail: ChatEventMap[K]['detail']
): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

/**
 * 类型安全的事件监听
 */
export function addChatEventListener<K extends keyof ChatEventMap>(
  eventName: K,
  handler: (event: ChatEventMap[K]) => void,
  options?: AddEventListenerOptions
): () => void {
  const typedHandler = handler as EventListener;
  window.addEventListener(eventName, typedHandler, options);
  return () => window.removeEventListener(eventName, typedHandler);
}

/**
 * 带超时的事件等待
 */
export function waitForChatEvent<K extends keyof ChatEventMap>(
  eventName: K,
  options: {
    timeout?: number;
    filter?: (detail: ChatEventMap[K]['detail']) => boolean;
  } = {}
): Promise<ChatEventMap[K]['detail']> {
  const { timeout = 10000, filter } = options;
  
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`事件超时: ${eventName} (${timeout}ms)`));
    }, timeout);
    
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (filter && !filter(detail)) {
        return; // 不匹配过滤条件，继续等待
      }
      cleanup();
      resolve(detail);
    };
    
    const cleanup = () => {
      clearTimeout(timeoutId);
      window.removeEventListener(eventName, handler as EventListener);
    };
    
    window.addEventListener(eventName, handler as EventListener);
  });
}

