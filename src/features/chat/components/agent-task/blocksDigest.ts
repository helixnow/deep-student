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
 * - todoBlocks：todo 工具块数组，按块对象身份序列复用引用（immer 结构
 *   共享保证未变块身份不变），extractSteps 只在 todo 块真正变化时重跑。
 *
 * WeakMap 以 Map / Block 实例为键：旧对象被淘汰后缓存条目随之回收，
 * 无需手动清理。todo 序列缓存不依赖“上一次调用”，因此不同 store
 * 交错计算不会破坏各自引用稳定性。
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

interface TodoSequenceNode {
  children: WeakMap<Block, TodoSequenceNode>;
  todoBlocks?: Block[];
}

/**
 * 按 todo 块对象序列驻留数组引用。
 *
 * 每一级都以 Block 为 WeakMap key；缓存不会像模块级 lastTodoBlocks 那样
 * 强引用某个会话最后一批 todo 块，也不会因 A → B → A 调用顺序而抖动。
 */
const todoSequenceRoot: TodoSequenceNode = { children: new WeakMap() };

const digestCache = new WeakMap<Map<string, Block>, BlocksDigest>();

function internTodoBlocks(todoBlocks: Block[]): Block[] {
  if (todoBlocks.length === 0) return EMPTY_TODO_BLOCKS;

  let node = todoSequenceRoot;
  for (const block of todoBlocks) {
    let child = node.children.get(block);
    if (!child) {
      child = { children: new WeakMap() };
      node.children.set(block, child);
    }
    node = child;
  }

  if (!node.todoBlocks) node.todoBlocks = todoBlocks;
  return node.todoBlocks;
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

  const todoBlocks = internTodoBlocks(todo);

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
