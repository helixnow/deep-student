/**
 * blocksDigest — blocks Map 的工具面摘要（流式长会话性能）
 *
 * 背景：AgentTaskPanel / 产物 registry 同步都只关心「工具块构成」，
 * 但此前各自订阅整个 blocks Map 或在 subscribe 回调里全量扫描。
 * 流式期间每次 flush immer 都产出新 Map（身份变化），这些订阅者
 * 每 120ms 重渲染 / 全量 forEach 一轮，成本随会话总块数线性增长。
 *
 * 方案：把一次 flush 内需要的派生量收敛为单一 digest，按 Map 身份
 * 用 WeakMap 缓存——同一 flush 内所有消费者共享一次扫描：
 * - runtimeActivity / terminalToolCount：O(1) 标量，订阅方按标量比较，
 *   纯正文流式（无新工具块、状态不翻转）时不再触发重渲染。
 * - todoBlocks：todo 工具块数组，与上一份 digest 逐元素做身份比较，
 *   全部相同时复用上一份引用（immer 结构共享保证未变块身份不变），
 *   extractSteps 只在 todo 块真正变化时重跑。
 *
 * WeakMap 以 Map 实例为键：旧 Map 被新 flush 淘汰后缓存条目随之回收，
 * 无需手动清理。不同 store 实例交替计算时折叠链仍按元素身份比较，
 * 语义与稳定性均不受影响。
 */

import type { Block } from '../../core/types/block';
import { isRuntimeTool, isTodoTool, normalizeToolName } from './extractors';

export interface BlocksDigest {
  /** blocks Map 规模（O(1)） */
  size: number;
  /** 是否出现过 runtime/browser 工具块（面板「本地」区出现条件） */
  runtimeActivity: boolean;
  /** 已落终态（success/error）的工具块数（产物 registry 增量补齐触发器） */
  terminalToolCount: number;
  /** todo 工具块数组；与上一份 digest 逐元素身份相同则复用同一引用 */
  todoBlocks: Block[];
}

const EMPTY_DIGEST: BlocksDigest = {
  size: 0,
  runtimeActivity: false,
  terminalToolCount: 0,
  todoBlocks: [],
};

const EMPTY_TODO_BLOCKS: Block[] = [];

/** 折叠链：跨 flush 复用 todoBlocks 数组引用 */
let lastTodoBlocks: Block[] = EMPTY_TODO_BLOCKS;

const digestCache = new WeakMap<Map<string, Block>, BlocksDigest>();

function sameElements(next: Block[], prev: Block[]): boolean {
  if (next.length !== prev.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== prev[i]) return false;
  }
  return true;
}

function computeDigest(blocks: Map<string, Block>): BlocksDigest {
  let runtimeActivity = false;
  let terminalToolCount = 0;
  const todo: Block[] = [];

  for (const block of blocks.values()) {
    const toolName = block?.toolName;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;
    if (!runtimeActivity) {
      const short = normalizeToolName(toolName);
      if (isRuntimeTool(toolName) || short === 'browser_downloads' || short === 'browser_file_upload') {
        runtimeActivity = true;
      }
    }
    if (block.status === 'success' || block.status === 'error') terminalToolCount += 1;
    if (isTodoTool(block)) todo.push(block);
  }

  const todoBlocks =
    todo.length === 0
      ? EMPTY_TODO_BLOCKS
      : sameElements(todo, lastTodoBlocks)
        ? lastTodoBlocks
        : todo;
  lastTodoBlocks = todoBlocks;

  return { size: blocks.size, runtimeActivity, terminalToolCount, todoBlocks };
}

/**
 * 取 blocks Map 的工具面摘要；同一 Map 实例（同一 flush）只计算一次，
 * 后续调用 O(1) 命中缓存。
 */
export function getBlocksDigest(blocks: Map<string, Block> | undefined | null): BlocksDigest {
  if (!blocks) return EMPTY_DIGEST;
  const cached = digestCache.get(blocks);
  if (cached) return cached;
  const digest = computeDigest(blocks);
  digestCache.set(blocks, digest);
  return digest;
}
