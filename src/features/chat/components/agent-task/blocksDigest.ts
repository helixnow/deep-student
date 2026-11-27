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
import {
  asRecord,
  firstString,
  isRuntimeTool,
  isTodoTool,
  normalizeToolName,
  unwrapToolData,
} from './extractors';

export interface BrowserScreenshotDigest {
  kind: 'browser_screenshot';
  blockId: string;
  status: Block['status'];
  available: boolean;
  url?: string;
  width?: number;
  height?: number;
  annotated: boolean;
  locator?: string;
  artifactPath?: string;
  artifactHandle?: string;
}

export interface BrowserExtractContentDigest {
  kind: 'browser_extract_content';
  blockId: string;
  status: Block['status'];
  url?: string;
  title?: string;
  charCount?: number;
  truncated: boolean;
}

export interface BrowserTabsDigest {
  kind: 'browser_tabs';
  blockId: string;
  status: Block['status'];
  tabAction?: string;
  tabCount?: number;
}

export interface BrowserObserveDigest {
  kind: 'browser_observe';
  blockId: string;
  status: Block['status'];
  observeKind?: string;
  url?: string;
  consoleCount?: number;
  networkCount?: number;
}

export type BrowserToolDigestEntry =
  | BrowserScreenshotDigest
  | BrowserExtractContentDigest
  | BrowserTabsDigest
  | BrowserObserveDigest;

export interface BlocksDigest {
  /** blocks Map 规模（O(1)） */
  size: number;
  /** 是否出现过 runtime/browser 工具块（面板「本地」区出现条件） */
  runtimeActivity: boolean;
  /** 已落终态（success/error）的工具块数（产物 registry 增量补齐触发器） */
  terminalToolCount: number;
  /** todo 工具块数组；与上一份 digest 逐元素身份相同则复用同一引用 */
  todoBlocks: Block[];
  /** 浏览器专项工具块摘要（screenshot / extract_content / tabs / observe） */
  browserActivity: BrowserToolDigestEntry[];
}

const EMPTY_TODO_BLOCKS: Block[] = [];
const EMPTY_BROWSER_ACTIVITY: BrowserToolDigestEntry[] = [];

const EMPTY_DIGEST: BlocksDigest = {
  size: 0,
  runtimeActivity: false,
  terminalToolCount: 0,
  todoBlocks: EMPTY_TODO_BLOCKS,
  browserActivity: EMPTY_BROWSER_ACTIVITY,
};

interface TodoSequenceNode {
  children: WeakMap<Block, TodoSequenceNode>;
  todoBlocks?: Block[];
}

interface BrowserSequenceNode {
  children: WeakMap<Block, BrowserSequenceNode>;
  entries?: BrowserToolDigestEntry[];
}

/**
 * 按 todo 块对象序列驻留数组引用。
 *
 * 每一级都以 Block 为 WeakMap key；缓存不会像模块级 lastTodoBlocks 那样
 * 强引用某个会话最后一批 todo 块，也不会因 A → B → A 调用顺序而抖动。
 */
const todoSequenceRoot: TodoSequenceNode = { children: new WeakMap() };
const browserSequenceRoot: BrowserSequenceNode = { children: new WeakMap() };

const digestCache = new WeakMap<Map<string, Block>, BlocksDigest>();

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractObserveJsonBody(raw: string): string | null {
  const unwrapped = raw
    .trim()
    .replace(/^<untrusted_web_content\b[^>]*>\s*/i, '')
    .replace(/\s*<\/untrusted_web_content>$/i, '')
    .trim();
  if (!unwrapped) return null;
  if (unwrapped.startsWith('{') && unwrapped.endsWith('}')) {
    return unwrapped;
  }
  const openSep = unwrapped.search(/(?:^|\n)---\r?\n/);
  if (openSep >= 0) {
    const bodyStart = unwrapped.indexOf('\n', openSep + (unwrapped[openSep] === '\n' ? 1 : 0)) + 1;
    const closeMatch = /\r?\n---\s*$/.exec(unwrapped);
    if (closeMatch && closeMatch.index >= bodyStart) {
      const candidate = unwrapped.slice(bodyStart, closeMatch.index).trim();
      if (candidate.startsWith('{')) return candidate;
    }
  }
  const firstBrace = unwrapped.indexOf('{');
  const lastBrace = unwrapped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return unwrapped.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function parseObservePayloadCounts(observations: unknown): {
  consoleCount?: number;
  networkCount?: number;
} {
  if (typeof observations !== 'string' || !observations.trim()) return {};
  const jsonBody = extractObserveJsonBody(observations);
  if (!jsonBody) return {};
  try {
    const parsed = asRecord(JSON.parse(jsonBody));
    if (!parsed) return {};
    return {
      consoleCount: Array.isArray(parsed.console) ? parsed.console.length : undefined,
      networkCount: Array.isArray(parsed.network) ? parsed.network.length : undefined,
    };
  } catch {
    return {};
  }
}

export function summarizeBrowserToolBlock(block: Block): BrowserToolDigestEntry | null {
  const toolName = block?.toolName;
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  const short = normalizeToolName(toolName);
  if (
    short !== 'browser_screenshot'
    && short !== 'browser_extract_content'
    && short !== 'browser_tabs'
    && short !== 'browser_observe'
  ) {
    return null;
  }

  const data = unwrapToolData(block.toolOutput);
  const input = asRecord(block.toolInput);

  if (short === 'browser_screenshot') {
    const handle = asRecord(data.object_handle);
    const locator = firstString(data.locator, handle?.locator);
    const artifactPath = firstString(data.artifact_path, data.artifactPath);
    const artifactHandle = firstString(
      handle?.handle_id,
      handle?.handleId,
      handle?.id,
      locator,
      artifactPath,
    );
    return {
      kind: 'browser_screenshot',
      blockId: block.id,
      status: block.status,
      available: data.available !== false,
      url: firstString(data.url),
      width: finiteNumber(data.width),
      height: finiteNumber(data.height),
      annotated: data.annotated === true,
      locator,
      artifactPath,
      artifactHandle,
    };
  }

  if (short === 'browser_extract_content') {
    const totalChars = finiteNumber(data.total_chars) ?? finiteNumber(data.totalChars);
    const fallbackChars = typeof data.content === 'string' ? data.content.length : undefined;
    return {
      kind: 'browser_extract_content',
      blockId: block.id,
      status: block.status,
      url: firstString(data.url),
      title: firstString(data.title),
      charCount: totalChars ?? fallbackChars,
      truncated: data.truncated === true,
    };
  }

  if (short === 'browser_tabs') {
    const tabAction = firstString(data.tab_action, data.tabAction, input?.action);
    const nestedResult = asRecord(data.result);
    const tabCount = Array.isArray(data.tabs)
      ? data.tabs.length
      : Array.isArray(nestedResult?.tabs)
        ? nestedResult.tabs.length
        : finiteNumber(data.tab_count) ?? finiteNumber(data.tabCount);
    return {
      kind: 'browser_tabs',
      blockId: block.id,
      status: block.status,
      tabAction,
      tabCount,
    };
  }

  const observeKind = firstString(data.kind, input?.kind);
  const parsedFromObservations = parseObservePayloadCounts(data.observations);
  const consoleCount = Array.isArray(data.console)
    ? data.console.length
    : finiteNumber(data.console_count)
      ?? finiteNumber(data.consoleCount)
      ?? parsedFromObservations.consoleCount;
  const networkCount = Array.isArray(data.network)
    ? data.network.length
    : finiteNumber(data.network_count)
      ?? finiteNumber(data.networkCount)
      ?? parsedFromObservations.networkCount;
  return {
    kind: 'browser_observe',
    blockId: block.id,
    status: block.status,
    observeKind,
    url: firstString(data.url),
    consoleCount,
    networkCount,
  };
}

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

function internBrowserActivity(
  browserBlocks: Block[],
  entries: BrowserToolDigestEntry[],
): BrowserToolDigestEntry[] {
  if (browserBlocks.length === 0) return EMPTY_BROWSER_ACTIVITY;

  let node = browserSequenceRoot;
  for (const block of browserBlocks) {
    let child = node.children.get(block);
    if (!child) {
      child = { children: new WeakMap() };
      node.children.set(block, child);
    }
    node = child;
  }

  if (!node.entries) node.entries = entries;
  return node.entries;
}

function computeDigest(blocks: Map<string, Block>): BlocksDigest {
  let runtimeActivity = false;
  let terminalToolCount = 0;
  const todo: Block[] = [];
  const browserBlocks: Block[] = [];
  const browserEntries: BrowserToolDigestEntry[] = [];

  for (const block of blocks.values()) {
    const toolName = block?.toolName;
    if (typeof toolName !== 'string' || toolName.length === 0) continue;
    const short = normalizeToolName(toolName);
    if (!runtimeActivity) {
      if (
        isRuntimeTool(toolName)
        || short === 'browser_downloads'
        || short === 'browser_file_upload'
        || short === 'browser_screenshot'
      ) {
        runtimeActivity = true;
      }
    }
    if (block.status === 'success' || block.status === 'error') terminalToolCount += 1;
    if (isTodoTool(block)) todo.push(block);
    const browserEntry = summarizeBrowserToolBlock(block);
    if (browserEntry) {
      browserBlocks.push(block);
      browserEntries.push(browserEntry);
    }
  }

  const todoBlocks = internTodoBlocks(todo);
  const browserActivity = internBrowserActivity(browserBlocks, browserEntries);

  return { size: blocks.size, runtimeActivity, terminalToolCount, todoBlocks, browserActivity };
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
