/**
 * Chat V2 - useChatStore Hooks
 *
 * 细粒度选择器，避免不必要的重渲染
 */

import { useCallback, useRef } from 'react';
import { useStore, type StoreApi } from 'zustand';
import type { ChatStore, Message, Block, SessionStatus } from '../core/types';

/** Store 参数类型 */
type ChatStoreApi = StoreApi<ChatStore>;

/**
 * 🚀 长会话性能：零分配身份快路径。
 *
 * 先逐 id 把 `blocks.get(id)` 与上一份结果做块对象身份比较（immer 结构共享
 * 保证未变化的块对象身份不变），全部相同时直接复用上一份数组——不构建任何
 * 中间数组；有任何变化才重建。流式期间每个 flush，直渲染模式下全部挂载
 * 消息合计从「O(全部块) 的 map/filter 分配」降为「O(全部块) 的 O(1) 哈希
 * 查找比较」，历史消息零分配，只有活动消息按其自身块数重建。
 */
function lookupBlocksIfChanged(
  blocks: Map<string, Block>,
  blockIds: readonly string[],
  prev: Block[],
): { blocks: Block[]; changed: boolean } {
  if (blockIds.length === prev.length) {
    let same = true;
    for (let i = 0; i < blockIds.length; i++) {
      if (blocks.get(blockIds[i]) !== prev[i]) {
        same = false;
        break;
      }
    }
    if (same) return { blocks: prev, changed: false };
  }
  const next: Block[] = [];
  for (const id of blockIds) {
    const block = blocks.get(id);
    if (block !== undefined) next.push(block);
  }
  // 长度不等路径（缺失块过滤、消息刚追加）重建后仍需与上一份逐元素比较：
  // selector 必须对同一状态幂等（重复调用返回同一引用），否则缺失块持续
  // 存在时每次调用都产出新数组，zustand 会判定变化并无限重渲染
  if (
    next.length === prev.length &&
    next.every((block, i) => block === prev[i])
  ) {
    return { blocks: prev, changed: false };
  }
  return { blocks: next, changed: true };
}

// ============================================================================
// 消息选择器
// ============================================================================

/**
 * 订阅单条消息
 */
export function useMessage(store: ChatStoreApi, messageId: string): Message | undefined {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.messageMap.get(messageId), [messageId])
  );
}

/**
 * 🚀 P1 性能优化：只订阅消息的 blockIds 数组
 * 
 * 使用 ref 缓存避免数组引用变化导致的不必要重渲染
 * 当 blockIds 内容相同但引用不同时，返回缓存的引用
 */
export function useMessageBlockIds(store: ChatStoreApi, messageId: string): string[] {
  const prevRef = useRef<string[]>([]);
  
  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const message = s.messageMap.get(messageId);
      const newBlockIds = message?.blockIds ?? [];
      
      // 如果长度相同且内容相同，返回缓存的引用
      if (
        newBlockIds.length === prevRef.current.length &&
        newBlockIds.every((id, i) => id === prevRef.current[i])
      ) {
        return prevRef.current;
      }
      
      // 内容变化，更新缓存
      prevRef.current = newBlockIds;
      return newBlockIds;
    }, [messageId])
  );
}

/**
 * 订阅消息顺序
 * 
 * 🚀 性能优化：使用 ref 缓存避免数组引用变化导致的不必要重渲染
 * 当 messageOrder 数组内容相同但引用不同时，返回缓存的引用
 */
export function useMessageOrder(store: ChatStoreApi): string[] {
  // 缓存上次结果
  const prevRef = useRef<string[]>([]);
  
  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const newOrder = s.messageOrder;
      
      // 如果长度相同且内容相同，返回缓存的引用
      if (
        newOrder.length === prevRef.current.length &&
        newOrder.every((id, i) => id === prevRef.current[i])
      ) {
        return prevRef.current;
      }
      
      // 内容变化，更新缓存
      prevRef.current = newOrder;
      return newOrder;
    }, [])
  );
}

/**
 * 订阅消息的所有块
 * 
 * 性能优化：使用 shallow 比较避免不必要的重渲染
 */
export function useMessageBlocks(store: ChatStoreApi, messageId: string): Block[] {
  // 缓存上次结果，作为身份快路径的比较基准
  const prevBlocksRef = useRef<Block[]>([]);

  return useStore(
    store,
    useCallback(
      (s: ChatStore) => {
        const message = s.messageMap.get(messageId);
        if (!message) {
          // 缓存空数组引用：直接返回新 [] 会让 useStore 在消息缺失期间
          // 每次 store 更新都判定为变化，导致组件持续重渲染
          if (prevBlocksRef.current.length !== 0) {
            prevBlocksRef.current = [];
          }
          return prevBlocksRef.current;
        }

        const { blocks: nextBlocks, changed } = lookupBlocksIfChanged(
          s.blocks,
          message.blockIds,
          prevBlocksRef.current,
        );
        if (!changed) return prevBlocksRef.current;

        prevBlocksRef.current = nextBlocks;
        return nextBlocks;
      },
      [messageId]
    )
  );
}

/**
 * 订阅指定 blockIds 对应的块列表
 *
 * 用于消息级渲染场景：只在当前显示的块内容变化时重渲染，
 * 避免依赖 getState() 读取瞬时快照导致的漏渲染。
 *
 * 🚀 P1：按内容（而非数组引用）稳定 blockIds 依赖。
 * 调用方每次 render 传入新建数组时，旧实现会不断重建 selector 并
 * 触发 useStore 重新订阅；此处先用 ref 把「内容相同」的数组折叠为
 * 同一引用，selector 仅在 id 集合真正变化时重建。
 */
export function useBlocksByIds(store: ChatStoreApi, blockIds: string[]): Block[] {
  const prevBlocksRef = useRef<Block[]>([]);

  // render 期间的引用折叠缓存（幂等，StrictMode 双渲染安全）
  const stableIdsRef = useRef<string[]>(blockIds);
  if (
    stableIdsRef.current !== blockIds &&
    (stableIdsRef.current.length !== blockIds.length ||
      blockIds.some((id, i) => id !== stableIdsRef.current[i]))
  ) {
    stableIdsRef.current = blockIds;
  }
  const stableBlockIds = stableIdsRef.current;

  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const { blocks: nextBlocks, changed } = lookupBlocksIfChanged(
        s.blocks,
        stableBlockIds,
        prevBlocksRef.current,
      );
      if (!changed) return prevBlocksRef.current;

      prevBlocksRef.current = nextBlocks;
      return nextBlocks;
    }, [stableBlockIds])
  );
}

// ============================================================================
// 分段结构指纹订阅（流式性能）
// ============================================================================

/**
 * 决定消息「渲染分段结构」的块元信息。
 *
 * MessageItem 的分段归组（时间线 vs 普通段）与多个布尔派生
 * （hasSources / hasConsumableAssistantContent / 空内容折叠等）
 * 只依赖这些字段，**不依赖流式正文的具体字符**。流式块每次 flush
 * 都会更换块对象身份（content 字符串增长），若按对象身份订阅，
 * 整条 MessageItem 每 120ms 全量重渲染（分段归组 + 数十个派生）。
 *
 * 注意刻意不含 contentLength/content：正文长度每 flush 都变，
 * 会把本 hook 退化成与按身份订阅等价。正文由消费方在事件回调里
 * 通过 store.getState() 按需读取（extractMessageContent 等），
 * 可见正文的渲染由 BlockRendererWithStore 的单块订阅负责。
 */
export interface BlockSegmentMeta {
  id: string;
  type: Block['type'];
  status: Block['status'];
  toolName?: string;
  /** content 是否为空/纯空白（流式期间可能翻转：空→非空，会改变分段） */
  isEmpty: boolean;
  /** 是否存在 citations（hasSources 判定用；仅布尔，不看具体来源） */
  hasCitations: boolean;
  /** 是否存在 toolOutput（hasSources 判定用） */
  hasToolOutput: boolean;
  /** 可见错误详情；文案更新也必须通知消息组件 */
  error?: string;
}

// store 通过不可变更新替换变化的块。复用未变块的元信息，避免每次
// token 更新都重新读取、trim 所有历史块的正文；弱引用随块释放。
const segmentMetaCache = new WeakMap<Block, BlockSegmentMeta>();

function blockToSegmentMeta(block: Block): BlockSegmentMeta {
  const cached = segmentMetaCache.get(block);
  if (cached) return cached;
  const content = block.content ?? '';
  const meta: BlockSegmentMeta = {
    id: block.id,
    type: block.type,
    status: block.status,
    toolName: block.toolName,
    isEmpty: content.trim() === '',
    hasCitations: !!(block.citations && block.citations.length > 0),
    hasToolOutput: !!block.toolOutput,
    error: block.error?.trim() || undefined,
  };
  segmentMetaCache.set(block, meta);
  return meta;
}

function segmentMetaEquals(a: BlockSegmentMeta, b: BlockSegmentMeta): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.status === b.status &&
    a.toolName === b.toolName &&
    a.isEmpty === b.isEmpty &&
    a.hasCitations === b.hasCitations &&
    a.hasToolOutput === b.hasToolOutput &&
    a.error === b.error
  );
}

/**
 * 🚀 流式性能：订阅「分段结构指纹」而非块对象身份。
 *
 * 流式期间纯文本追加只增长 content——分段结构（type/status/isEmpty/
 * toolName/citations/toolOutput）不变，本 hook 的返回值保持稳定引用，
 * MessageItem 因此**不再每 flush 重渲染**。结构真正变化时（新块插入、
 * 块状态翻转、空 content 变为非空、citations 落地）才触发重渲染，
 * 这通常一个流式周期只发生个位数次，而非每 120ms 一次。
 *
 * 可见正文不经过本 hook：BlockRendererWithStore 按单块订阅渲染，
 * 正文增长只重渲染那一个块。
 *
 * 与 useBlocksByIds 的差异：那里返回块对象数组（身份比较，流式噪声
 * 全量传导），这里返回扁平元信息数组（逐字段标量比较，正文增长被
 * 完全屏蔽）。
 */
export function useBlocksSegmentMeta(store: ChatStoreApi, blockIds: string[]): BlockSegmentMeta[] {
  const prevRef = useRef<BlockSegmentMeta[]>([]);
  // 上一次结果的源块数组：身份快路径的比较基准（元信息是块对象的纯函数，
  // 全部块对象身份未变 ⇒ 元信息必然相同，可直接复用上次结果，零分配）
  const prevSourceRef = useRef<Block[]>([]);

  const stableIdsRef = useRef<string[]>(blockIds);
  if (
    stableIdsRef.current !== blockIds &&
    (stableIdsRef.current.length !== blockIds.length ||
      blockIds.some((id, i) => id !== stableIdsRef.current[i]))
  ) {
    stableIdsRef.current = blockIds;
  }
  const stableBlockIds = stableIdsRef.current;

  return useStore(
    store,
    useCallback((s: ChatStore) => {
      const { blocks: sourceBlocks, changed } = lookupBlocksIfChanged(
        s.blocks,
        stableBlockIds,
        prevSourceRef.current,
      );
      if (!changed) return prevRef.current;

      const next = sourceBlocks.map(blockToSegmentMeta);
      if (
        next.length === prevRef.current.length &&
        next.every((meta, i) => segmentMetaEquals(meta, prevRef.current[i]))
      ) {
        // 指纹未变（典型：活动块正文增长但结构字段不变）：
        // 结果复用旧引用，但源块身份已变化，必须前移比较基准
        prevSourceRef.current = sourceBlocks;
        return prevRef.current;
      }
      prevSourceRef.current = sourceBlocks;
      prevRef.current = next;
      return next;
    }, [stableBlockIds])
  );
}

// ============================================================================
// 块选择器
// ============================================================================

/**
 * 订阅单个块
 */
export function useBlock(store: ChatStoreApi, blockId: string): Block | undefined {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.blocks.get(blockId), [blockId])
  );
}

// ============================================================================
// 会话状态选择器
// ============================================================================

/**
 * 订阅会话状态
 */
export function useSessionStatus(store: ChatStoreApi): SessionStatus {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.sessionStatus, [])
  );
}

/**
 * 订阅数据是否已加载
 */
export function useIsDataLoaded(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.isDataLoaded, [])
  );
}

/**
 * 订阅是否可以发送
 */
export function useCanSend(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.canSend(), [])
  );
}

/**
 * 订阅是否可以中断
 */
export function useCanAbort(store: ChatStoreApi): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.canAbort(), [])
  );
}

// ============================================================================
// 会话元信息选择器
// ============================================================================

/**
 * 订阅会话标题
 */
export function useTitle(store: ChatStoreApi): string {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.title, [])
  );
}

// ============================================================================
// 输入框状态选择器
// ============================================================================

/**
 * 订阅输入框内容
 */
export function useInputValue(store: ChatStoreApi): string {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.inputValue, [])
  );
}

/**
 * 订阅附件列表
 */
export function useAttachments(store: ChatStoreApi): ChatStore['attachments'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.attachments, [])
  );
}

/**
 * 订阅面板状态
 */
export function usePanelStates(store: ChatStoreApi): ChatStore['panelStates'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.panelStates, [])
  );
}

// ============================================================================
// 配置选择器
// ============================================================================

/**
 * 订阅对话参数
 */
export function useChatParams(store: ChatStoreApi): ChatStore['chatParams'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.chatParams, [])
  );
}

/**
 * 订阅功能开关
 */
export function useFeature(store: ChatStoreApi, key: string): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.features.get(key) ?? false, [key])
  );
}

/**
 * 订阅模式状态
 */
export function useModeState(store: ChatStoreApi): ChatStore['modeState'] {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.modeState, [])
  );
}

// ============================================================================
// 流式状态选择器
// ============================================================================

/**
 * 订阅当前流式消息 ID
 */
export function useCurrentStreamingMessageId(store: ChatStoreApi): string | null {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.currentStreamingMessageId, [])
  );
}

/**
 * 订阅活跃块 ID 集合
 */
export function useActiveBlockIds(store: ChatStoreApi): Set<string> {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.activeBlockIds, [])
  );
}

/**
 * 检查块是否活跃（正在流式）
 */
export function useIsBlockActive(store: ChatStoreApi, blockId: string): boolean {
  return useStore(
    store,
    useCallback((s: ChatStore) => s.activeBlockIds.has(blockId), [blockId])
  );
}
