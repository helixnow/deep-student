// ============================================================================
// OpenChamber 活动流与工具呈现核心引擎
// 1. 运行中 7 行滑动窗口 + 96px 防抖地板 + 交互块强制提升（Hoisting）
// 2. 终态一行式多维语义摘要（Files +add/-del · Explored · Commands · Subagents）
// 3. 只读导航工具分流 + RTL 左截断路径拆分 + 1000ms/300ms 最小扫光时长锁
// 4. 子代理主动取消防误重试合成锚点
// ============================================================================

export const LIVE_ACTIVITY_VISIBLE_ROWS = 7;
export const LIVE_ACTIVITY_MIN_FLOOR_PX = 96;
export const STATIC_TOOL_MIN_SHINE_MS = 1000;
export const EXPANDABLE_TOOL_MIN_SHINE_MS = 300;
export const MAX_SHINE_LOCK_DURATION_MS = 5 * 60 * 1000;

// ============================================================================
// 类型定义
// ============================================================================

export type LiveActivityKind =
  | 'thinking'
  | 'reasoning'
  | 'tool'
  | 'ask_user'
  | 'secret_request'
  | 'approval'
  | 'generative_ui_await'
  | (string & {});

export interface LiveActivityFileDiff {
  path?: string;
  file?: string;
  filePath?: string;
  relativePath?: string;
  movePath?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  diff?: string;
  status?: string;
  type?: string;
}

export interface LiveActivityItem {
  id: string;
  kind: LiveActivityKind;
  toolName?: string;
  status?: 'pending' | 'running' | 'completed' | 'success' | 'error' | 'cancelled' | (string & {});
  requiresUserAction?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  filesChanged?: number | readonly string[];
  linesAdded?: number;
  linesDeleted?: number;
  subagentSessionId?: string;
  input?: Record<string, unknown>;
  metadata?: {
    files?: ReadonlyArray<LiveActivityFileDiff | null>;
    filediff?: LiveActivityFileDiff;
    patch?: string;
    diff?: string;
    sessionID?: string;
    sessionId?: string;
    exit?: number;
    [key: string]: unknown;
  };
}

export interface LiveActivityWindowSlice<T extends LiveActivityItem = LiveActivityItem> {
  visibleRows: T[];
  hiddenRows: T[];
  hiddenCount: number;
  hoistedInteractiveItems: T[];
  minFloorPx: number;
}

export interface TurnActivitySummary {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  exploredCount: number;
  commandsRun: number;
  researchedCount: number;
  subagentsUsed: number;
  segments: string[];
  summaryText: string;
}

export interface RtlTruncatedPathParts {
  dirPrefix: string;
  baseName: string;
  hasAbsoluteRoot: boolean;
  displayDir: string;
  normalizedPath: string;
}

export interface SubagentCancellationNote {
  subagentSessionId: string;
  taskDescription?: string;
  cancelledByUser: true;
  doNotRetry: true;
  role: 'synthetic';
  description: string;
  text: string;
  metadata: {
    openchamberSubagentCancellation: {
      sessionID: string;
      cancelledByUser: true;
      doNotRetry: true;
    };
  };
}

// ============================================================================
// 1. 运行中滑动窗口与交互块提升（Hoisting）+ 96px 防抖地板
// ============================================================================

const INTERACTIVE_ACTIVITY_KINDS = new Set<string>([
  'ask_user',
  'secret_request',
  'approval',
  'generative_ui_await',
]);

const SETTLED_ACTIVITY_STATUSES = new Set<string>([
  'completed',
  'success',
  'cancelled',
]);

/**
 * 判断时间线节点是否处于等待用户响应的交互状态。
 * 交互节点在折叠模式下必须被强制提升（Hoisting）至折叠区外常驻显示。
 */
export function isInteractiveActivityItem(item: LiveActivityItem): boolean {
  if (item.requiresUserAction === true) {
    return true;
  }
  if (item.requiresUserAction === false) {
    return false;
  }
  if (INTERACTIVE_ACTIVITY_KINDS.has(item.kind)) {
    const status = item.status?.trim().toLowerCase();
    return !status || !SETTLED_ACTIVITY_STATUSES.has(status);
  }
  return false;
}

/**
 * 切分运行中活动流滑动窗口：
 * - 任何等待用户响应的交互节点提升到 `hoistedInteractiveItems`，绝不被折叠隐藏；
 * - 当 `isCollapsed === true` 时，普通工具与思考节点仅保留最新 `maxVisibleRows`（默认 7）行，
 *   并统计被折叠隐藏的 `hiddenCount`；
 * - 当 `isCollapsed === false` 时，展示全部普通节点，`hiddenCount` 为 0。
 */
export function sliceLiveActivityWindow<T extends LiveActivityItem>(
  items: readonly T[],
  isCollapsed: boolean,
  maxVisibleRows: number = LIVE_ACTIVITY_VISIBLE_ROWS,
): LiveActivityWindowSlice<T> {
  const hoistedInteractiveItems: T[] = [];
  const regularItems: T[] = [];

  for (const item of items) {
    if (isInteractiveActivityItem(item)) {
      hoistedInteractiveItems.push(item);
    } else {
      regularItems.push(item);
    }
  }

  const safeLimit = Math.max(0, Math.trunc(maxVisibleRows));

  if (!isCollapsed) {
    return {
      visibleRows: regularItems,
      hiddenRows: [],
      hiddenCount: 0,
      hoistedInteractiveItems,
      minFloorPx: 0,
    };
  }

  if (regularItems.length <= safeLimit) {
    return {
      visibleRows: regularItems,
      hiddenRows: [],
      hiddenCount: 0,
      hoistedInteractiveItems,
      minFloorPx: LIVE_ACTIVITY_MIN_FLOOR_PX,
    };
  }

  const hiddenCount = regularItems.length - safeLimit;
  const hiddenRows = regularItems.slice(0, hiddenCount);
  const visibleRows = safeLimit === 0 ? [] : regularItems.slice(-safeLimit);

  return {
    visibleRows,
    hiddenRows,
    hiddenCount,
    hoistedInteractiveItems,
    minFloorPx: LIVE_ACTIVITY_MIN_FLOOR_PX,
  };
}

/**
 * 计算运行中滑动窗口的高度防抖地板（96px 阈值）：
 * - 当新旧行交替导致小幅收缩（<= 96px）时维持原最大高度，防止跟随视口上下抽动；
 * - 当容器宽度改变（重排）或大块退出窗口（收缩 > 96px）或内容继续长高时，更新地板高度。
 */
export function computeLiveRowsFloorPx(
  previousFloorPx: number,
  currentHeightPx: number,
  didWidthChange: boolean = false,
): number {
  const safePrev = Number.isFinite(previousFloorPx) ? Math.max(0, previousFloorPx) : 0;
  const safeCurr = Number.isFinite(currentHeightPx) ? Math.max(0, currentHeightPx) : 0;

  if (didWidthChange || safeCurr > safePrev || safePrev - safeCurr > LIVE_ACTIVITY_MIN_FLOOR_PX) {
    return safeCurr;
  }
  return safePrev;
}

// ============================================================================
// 2. 只读导航工具分流与左截断路径格式化
// ============================================================================

const STATIC_NAVIGATION_TOOLS = new Set<string>([
  'read',
  'read_file',
  'grep',
  'ripgrep',
  'glob',
  'find',
  'search',
  'webfetch',
  'fetch',
  'skill',
  'kb_search',
  'memory_read',
  'memory_search',
  'unified_search',
  'resource_read',
  'resource_search',
]);

const EXPLORATION_TOOLS = new Set<string>([
  ...STATIC_NAVIGATION_TOOLS,
  'list_dir',
  'file_search',
  'folder_list',
  'resource_list',
]);

const FILE_CHANGE_TOOLS = new Set<string>([
  'edit',
  'write',
  'patch',
  'apply_patch',
  'multiedit',
  'create_file',
  'replace_in_file',
  'write_file',
]);

const SHELL_COMMAND_TOOLS = new Set<string>([
  'shell',
  'bash',
  'exec_command',
  'execute_command',
  'run_command',
  'terminal',
]);

const RESEARCH_WEB_TOOLS = new Set<string>([
  'webfetch',
  'websearch',
  'web_search',
  'academic_search',
  'arxiv_search',
  'scholar_search',
  'fetch',
]);

const SUBAGENT_TOOLS = new Set<string>([
  'subagent',
  'task',
  'spawn_subagent',
  'delegate',
]);

/**
 * 归一化工具名称：
 * 去除 `builtin-`、`builtin:`、命名空间前缀及 `:index` 去重后缀并转为小写。
 */
export function normalizeActivityToolName(toolName: string | undefined | null): string {
  const trimmed = toolName?.trim().toLowerCase() ?? '';
  if (!trimmed) return '';
  const withoutIndex = trimmed.replace(/:\d+$/, '');
  const withoutBuiltin = withoutIndex.replace(/^builtin[-:]/, '');
  if (!withoutBuiltin.includes('.')) return withoutBuiltin;
  const segments = withoutBuiltin.split('.').filter(Boolean);
  return segments[segments.length - 1] ?? withoutBuiltin;
}

/**
 * 判断是否为只读导航类工具（默认走紧凑单行 StaticToolRow，无需展开抽屉）。
 */
export function isStaticNavigationTool(toolName: string | undefined | null): boolean {
  const normalized = normalizeActivityToolName(toolName);
  return normalized.length > 0 && STATIC_NAVIGATION_TOOLS.has(normalized);
}

/**
 * 拆分路径用于 RTL 左截断展示（保留高亮目标文件名 `baseName`，左侧目录前缀 `dirPrefix` 自动省略）。
 */
export function splitPathForRtlTruncation(rawPath: string | undefined | null): RtlTruncatedPathParts {
  const raw = (rawPath ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!raw) {
    return {
      dirPrefix: '',
      baseName: '',
      hasAbsoluteRoot: false,
      displayDir: '',
      normalizedPath: '',
    };
  }

  if (raw === '/') {
    return {
      dirPrefix: '/',
      baseName: '',
      hasAbsoluteRoot: true,
      displayDir: '',
      normalizedPath: '/',
    };
  }

  const normalizedPath = raw.replace(/\/+$/, '');
  const lastSlash = normalizedPath.lastIndexOf('/');

  if (lastSlash === -1) {
    return {
      dirPrefix: '',
      baseName: normalizedPath,
      hasAbsoluteRoot: false,
      displayDir: '',
      normalizedPath,
    };
  }

  if (lastSlash === 0) {
    const baseName = normalizedPath.slice(1);
    return {
      dirPrefix: '/',
      baseName,
      hasAbsoluteRoot: true,
      displayDir: '',
      normalizedPath,
    };
  }

  const dirPrefix = normalizedPath.slice(0, lastSlash);
  const baseName = normalizedPath.slice(lastSlash + 1);
  const hasAbsoluteRoot = dirPrefix.startsWith('/');
  const displayDir = hasAbsoluteRoot ? dirPrefix.slice(1) : dirPrefix;

  return {
    dirPrefix,
    baseName,
    hasAbsoluteRoot,
    displayDir,
    normalizedPath,
  };
}

// ============================================================================
// 3. 终态一行式多维语义摘要
// ============================================================================

function countPatchLines(patch: string | undefined): { additions: number; deletions: number } | undefined {
  if (!patch || typeof patch !== 'string') return undefined;
  let additions = 0;
  let deletions = 0;
  let sawDiffLine = false;

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
      sawDiffLine = true;
    } else if (line.startsWith('-')) {
      deletions += 1;
      sawDiffLine = true;
    }
  }

  return sawDiffLine ? { additions, deletions } : undefined;
}

/**
 * 统计整轮活动的终态多维语义摘要：
 * 返回 `{ filesChanged, linesAdded, linesDeleted, exploredCount, commandsRun, researchedCount, subagentsUsed }`
 * 以及高信噪比摘要片段数组 `segments`（如 `['3 files +48/-12', 'Explored', 'Ran 4 commands', 'Used 2 subagents']`）。
 */
export function summarizeTurnActivity(items: readonly LiveActivityItem[]): TurnActivitySummary {
  const touchedFilePaths = new Set<string>();
  let explicitFileCount = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  let exploredCount = 0;
  let commandsRun = 0;
  let researchedCount = 0;
  const subagentSessions = new Set<string>();
  let anonymousSubagentCount = 0;

  for (const item of items) {
    const status = item.status?.trim().toLowerCase();
    if (status === 'pending' || status === 'running' || status === 'cancelled') {
      continue;
    }

    const tool = normalizeActivityToolName(item.toolName);
    const isFailed = status === 'error' || status === 'failed' || status === 'aborted';

    if (SHELL_COMMAND_TOOLS.has(tool)) {
      if (!isFailed || item.metadata?.exit !== undefined) {
        commandsRun += 1;
      }
    }

    if (isFailed) {
      continue;
    }

    if (RESEARCH_WEB_TOOLS.has(tool)) {
      researchedCount += 1;
    } else if (EXPLORATION_TOOLS.has(tool)) {
      exploredCount += 1;
    }

    if (SUBAGENT_TOOLS.has(tool)) {
      const sessionId =
        item.subagentSessionId?.trim() ||
        (typeof item.metadata?.sessionID === 'string' ? item.metadata.sessionID.trim() : '') ||
        (typeof item.metadata?.sessionId === 'string' ? item.metadata.sessionId.trim() : '');
      if (sessionId) {
        subagentSessions.add(sessionId);
      } else {
        anonymousSubagentCount += 1;
      }
    }

    const hasExplicitFileStats =
      item.filesChanged !== undefined ||
      typeof item.linesAdded === 'number' ||
      typeof item.linesDeleted === 'number';

    if (!FILE_CHANGE_TOOLS.has(tool) && !hasExplicitFileStats) {
      continue;
    }

    if (typeof item.filesChanged === 'number' && Number.isFinite(item.filesChanged)) {
      explicitFileCount += Math.max(0, Math.trunc(item.filesChanged));
    } else if (Array.isArray(item.filesChanged)) {
      for (const file of item.filesChanged) {
        if (typeof file === 'string' && file.trim()) {
          touchedFilePaths.add(file.trim());
        }
      }
    }

    let itemAdded = typeof item.linesAdded === 'number' && Number.isFinite(item.linesAdded)
      ? Math.max(0, Math.trunc(item.linesAdded))
      : 0;
    let itemDeleted = typeof item.linesDeleted === 'number' && Number.isFinite(item.linesDeleted)
      ? Math.max(0, Math.trunc(item.linesDeleted))
      : 0;
    const countedFromMetadata = itemAdded > 0 || itemDeleted > 0;

    const metaFiles = Array.isArray(item.metadata?.files)
      ? item.metadata.files.filter((entry): entry is LiveActivityFileDiff => Boolean(entry))
      : item.metadata?.filediff
        ? [item.metadata.filediff]
        : [];

    for (const fileEntry of metaFiles) {
      const candidatePath =
        fileEntry.movePath ??
        fileEntry.file ??
        fileEntry.filePath ??
        fileEntry.path ??
        fileEntry.relativePath;
      if (typeof candidatePath === 'string' && candidatePath.trim()) {
        touchedFilePaths.add(candidatePath.trim());
      }
      if (!countedFromMetadata) {
        if (typeof fileEntry.additions === 'number' || typeof fileEntry.deletions === 'number') {
          itemAdded += Math.max(0, Math.trunc(fileEntry.additions ?? 0));
          itemDeleted += Math.max(0, Math.trunc(fileEntry.deletions ?? 0));
        } else {
          const patchStats = countPatchLines(fileEntry.patch ?? fileEntry.diff);
          if (patchStats) {
            itemAdded += patchStats.additions;
            itemDeleted += patchStats.deletions;
          }
        }
      }
    }

    const inputPath =
      (typeof item.input?.path === 'string' && item.input.path.trim()) ||
      (typeof item.input?.filePath === 'string' && item.input.filePath.trim()) ||
      (typeof item.input?.file_path === 'string' && item.input.file_path.trim()) ||
      '';
    if (inputPath) {
      touchedFilePaths.add(inputPath);
    }

    if (!countedFromMetadata && itemAdded === 0 && itemDeleted === 0) {
      const topPatchStats = countPatchLines(
        typeof item.metadata?.patch === 'string'
          ? item.metadata.patch
          : typeof item.metadata?.diff === 'string'
            ? item.metadata.diff
            : undefined,
      );
      if (topPatchStats) {
        itemAdded += topPatchStats.additions;
        itemDeleted += topPatchStats.deletions;
      }
    }

    linesAdded += itemAdded;
    linesDeleted += itemDeleted;
  }

  const filesChanged = touchedFilePaths.size + explicitFileCount;
  const subagentsUsed = subagentSessions.size + anonymousSubagentCount;

  const segments: string[] = [];
  if (filesChanged > 0) {
    const fileNoun = filesChanged === 1 ? '1 file' : `${filesChanged} files`;
    if (linesAdded > 0 || linesDeleted > 0) {
      segments.push(`${fileNoun} +${linesAdded}/-${linesDeleted}`);
    } else {
      segments.push(fileNoun);
    }
  }
  if (exploredCount > 0) {
    segments.push('Explored');
  }
  if (commandsRun > 0) {
    segments.push(commandsRun === 1 ? 'Ran 1 command' : `Ran ${commandsRun} commands`);
  }
  if (researchedCount > 0) {
    segments.push('Researched');
  }
  if (subagentsUsed > 0) {
    segments.push(subagentsUsed === 1 ? 'Used 1 subagent' : `Used ${subagentsUsed} subagents`);
  }

  return {
    filesChanged,
    linesAdded,
    linesDeleted,
    exploredCount,
    commandsRun,
    researchedCount,
    subagentsUsed,
    segments,
    summaryText: segments.join(' · '),
  };
}

// ============================================================================
// 4. 最小扫光时长锁（1000ms 静态导航工具 / 300ms 可展开工具）
// ============================================================================

/**
 * 计算工具极速完成后的剩余扫光锁时长（毫秒）：
 * - 只读导航工具（`isStaticTool === true`）默认最小扫光 `1000ms`；
 * - 可展开工具（`isStaticTool === false`）默认最小扫光 `300ms`；
 * - 若工具在 `40ms` 内完成，返回 `1000 - 40 = 960ms`，避免亚秒级状态闪变；
 * - 超过 5 分钟安全上限时返回 `0`。
 */
export function computeRemainingShineLockMs(
  startedAtMs: number | null | undefined,
  nowMs: number = Date.now(),
  isStaticTool: boolean = true,
  customMinDurationMs?: number,
): number {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) {
    return 0;
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return 0;
  }

  const targetMinDurationMs =
    typeof customMinDurationMs === 'number' && Number.isFinite(customMinDurationMs)
      ? Math.max(0, Math.trunc(customMinDurationMs))
      : isStaticTool
        ? STATIC_TOOL_MIN_SHINE_MS
        : EXPANDABLE_TOOL_MIN_SHINE_MS;

  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  if (elapsedMs >= MAX_SHINE_LOCK_DURATION_MS) {
    return 0;
  }

  return Math.max(0, targetMinDurationMs - elapsedMs);
}

// ============================================================================
// 5. 子代理主动停止防误重试合成锚点
// ============================================================================

/**
 * 当用户主动点击 Stop 取消子代理时，生成注入给父会话的合成锚点说明：
 * 明确标识 `cancelledByUser: true` 与 `doNotRetry: true`，告知父模型该取消由用户主动发起，
 * 并非子代理自身崩溃失败，防止父模型陷入自动重试死循环。
 */
export function buildSubagentCancellationNote(
  subagentSessionId: string,
  taskDescription?: string,
): SubagentCancellationNote {
  const normalizedSessionId = subagentSessionId.trim() || 'unknown-subagent-session';
  const normalizedDescription = taskDescription?.trim() || undefined;
  const named = normalizedDescription
    ? `the subagent "${normalizedDescription}"`
    : 'a subagent';

  const text = [
    `The user stopped ${named} (sessionID: ${normalizedSessionId}).`,
    'The result for it that follows reports that the subagent was cancelled.',
    'That is how the stop shows up: the subagent did not fail on its own, the user cancelled it.',
    'Do not start it again just because of that result. The same work is fine to delegate later when the task or the user needs it.',
  ].join(' ');

  return {
    subagentSessionId: normalizedSessionId,
    taskDescription: normalizedDescription,
    cancelledByUser: true,
    doNotRetry: true,
    role: 'synthetic',
    description: 'Subagent stopped by the user',
    text,
    metadata: {
      openchamberSubagentCancellation: {
        sessionID: normalizedSessionId,
        cancelledByUser: true,
        doNotRetry: true,
      },
    },
  };
}
