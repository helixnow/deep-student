/**
 * Chat V2 - TauriAdapter 拆分模块 —— 会话加载：尾部分块首屏 + 反向历史窗口回填/滚动补页/全量 fallback
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { clearAdapterErrorFlag } from '../errors/adapterErrorChannel';
import type { LoadSessionResponseType, SessionRestoreBaseline } from '../../core/types';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import {
  AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY,
  hydrateSessionAvailableSkillsSnapshot,
} from '../../skills/progressiveDisclosure';
import { LOG_PREFIX, adapterConsole as console } from './diagnostics';
import {
  LOAD_SESSION_TAIL_LIMIT,
  FULL_HISTORY_IDLE_TIMEOUT_MS,
  FULL_HISTORY_MAX_RETRIES,
  FULL_HISTORY_RETRY_BASE_MS,
  HISTORY_BACKFILL_PAGE_SIZE,
  HISTORY_BACKFILL_MAX_PAGES,
} from './requestHelpers';
import type { TauriAdapterHost, LoadMessagesPageResponseType } from './adapterHost';
import {
  persistedAvailableSkillsSnapshotGenerations,
  readAvailableSkillsSnapshotGeneration,
  readAvailableSkillsSnapshotPendingGeneration,
} from './availableSkillsSnapshot';

export function captureRestoreBaseline(host: TauriAdapterHost): SessionRestoreBaseline {
  const state = host.getCurrentState();
  let oldestMessageTimestamp: number | undefined;
  for (const message of state.messageMap.values()) {
    if (
      oldestMessageTimestamp === undefined
      || message.timestamp < oldestMessageTimestamp
    ) {
      oldestMessageTimestamp = message.timestamp;
    }
  }
  return {
    messageIds: new Set(state.messageMap.keys()),
    blockIds: new Set(state.blocks.keys()),
    oldestMessageTimestamp,
    sessionStatus: state.sessionStatus,
    currentStreamingMessageId: state.currentStreamingMessageId,
  };
}

export async function loadSession(host: TauriAdapterHost): Promise<void> {
  console.log(LOG_PREFIX, 'Loading session:', host.sessionId);

  // 📊 性能打点：backend_load_start
  sessionSwitchPerf.mark('backend_load_start');
  const t0 = performance.now();
  const restoreBaseline = host.captureRestoreBaseline();

  try {
    // 📊 细粒度打点：invoke 开始
    sessionSwitchPerf.mark('load_invoke_start');
    
    const response = await invoke<LoadSessionResponseType>('chat_v2_load_session', {
      sessionId: host.sessionId,
      tailLimit: LOAD_SESSION_TAIL_LIMIT,
    });
    const invokeMs = performance.now() - t0;

    // 📊 细粒度打点：invoke 返回
    // 估算 response 体量（避免 JSON.stringify 阻塞主线程）
    const msgCount = response.messages?.length || 0;
    const blkCount = response.blocks?.length || 0;
    const responseSizeEstimate = msgCount * 500 + blkCount * 1000;
    sessionSwitchPerf.mark('load_invoke_end', {
      messageCount: msgCount,
      blockCount: blkCount,
      invokeMs,
      responseSizeKB: Math.round(responseSizeEstimate / 1024),
    });
    
    // 📊 性能打点：backend_load_end
    sessionSwitchPerf.mark('backend_load_end', {
      messageCount: msgCount,
      blockCount: blkCount,
      invokeMs,
    });

    console.log(LOG_PREFIX, 'Session loaded:', {
      messageCount: msgCount,
      blockCount: blkCount,
      invokeMs,
    });

    // 🆕 P37 调试：记录会话加载中的 workspace_status 块
    const logDebug = (window as any).__multiAgentDebug?.log;
    if (logDebug) {
      const blocks = response.blocks || [];
      const workspaceStatusBlocks = blocks.filter((b: any) => b.type === 'workspace_status');
      const messages = response.messages || [];
      
      // 检查消息是否关联了 workspace_status 块
      const messagesWithWsBlocks = messages.filter((m: any) => 
        m.blockIds?.some((id: string) => workspaceStatusBlocks.some((b: any) => b.id === id))
      );

      logDebug('block', 'LOAD_SESSION_RESULT', {
        sessionId: host.sessionId,
        totalBlocks: blocks.length,
        workspaceStatusBlocks: workspaceStatusBlocks.length,
        workspaceStatusBlockIds: workspaceStatusBlocks.map((b: any) => b.id),
        messagesWithWsBlocks: messagesWithWsBlocks.length,
        blockDetails: workspaceStatusBlocks.map((b: any) => ({
          id: b.id,
          messageId: b.messageId,
          type: b.type,
          hasToolOutput: !!b.toolOutput,
          snapshotAgents: b.toolOutput?.snapshotAgents?.length || 0,
        })),
      }, workspaceStatusBlocks.length > 0 ? 'success' : 'warning');
    }

    // 📊 性能打点：restore_start
    sessionSwitchPerf.mark('restore_start');

    if (!host.isSessionRuntimeOwner()) {
      console.warn(LOG_PREFIX, 'Discarding session load from stale adapter generation:', host.sessionId);
      return;
    }

    // 记录会话信息供第二阶段分页补页构造合并响应
    host.lastLoadedSessionInfo = response.session;

    // P0 available_skills 快照跨进程：应用重启后 provider prompt cache
    // 可能仍存活，优先用 session.metadata 中冻结的目录快照回灌内存，
    // 禁止按当时 live registry 重算（重启前中途装过技能会让 system 从
    // 第 0 字节变）。缺键 = 该会话从未冻结，首次构建 system 时按 live
    // 生成并持久化（见 buildSystemPromptWithSkills）。
    const loadedSessionMetadata = response.session?.metadata;
    const persistedSkillsSnapshot =
      loadedSessionMetadata?.[AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY];
    if (typeof persistedSkillsSnapshot === 'string') {
      hydrateSessionAvailableSkillsSnapshot(host.sessionId, persistedSkillsSnapshot);
      // 回灌值来自持久化权威，发送前无需再走冻结 RPC——除非 metadata 带回
      // 有效待换代标记（compaction 落盘事务写入）：记录 pendingGeneration，
      // 下次发送按 live registry 重新生成目录并经 freeze 兑现换代。回灌的
      // 旧代字节在兑现前仍是持久化权威（后端尚未覆盖），照常入内存快照。
      const snapshotGeneration =
        readAvailableSkillsSnapshotGeneration(loadedSessionMetadata);
      persistedAvailableSkillsSnapshotGenerations.set(host.sessionId, {
        generation: snapshotGeneration,
        pendingGeneration: readAvailableSkillsSnapshotPendingGeneration(
          loadedSessionMetadata,
          snapshotGeneration
        ),
      });
    }

    // 使用 Store 的 restoreFromBackend 方法恢复状态
    host.store.restoreFromBackend(response, restoreBaseline);
    clearAdapterErrorFlag(host.sessionId, host.getErrorStoreApi(), ['session_load_failed']);

    host.reconcileLoadedAnkiBlocks();

    await host.hydrateDefaultChatModelIfMissing();

    // 📊 性能打点：restore_end
    const totalMs = performance.now() - t0;
    sessionSwitchPerf.mark('restore_end', { totalMs });
    console.log(LOG_PREFIX, 'Session restore finished', { totalMs });
    
    // 🚀 性能优化：在 restoreFromBackend 后立即触发回调，不等待 await
    // 这允许 AdapterManager 立即标记 isReady，避免 React 渲染阻塞微任务队列
    if (host.onDataRestored) {
      host.onDataRestored();
    }

    // 第二阶段：还有更早历史时，首帧后空闲期分批回填并合并到头部。
    // 🚀 长会话内存窗口化：回填有页数上限（HISTORY_BACKFILL_MAX_PAGES），
    // 先初始化连续窗口起点（backend offset 语义），触顶后由滚动向上补页
    // 按窗口起点续拉；≤500 条消息的会话回填行为与全量加载完全一致。
    const totalCount = response.totalMessageCount;
    const initialLoadedCount = response.messages?.length ?? 0;
    if (typeof totalCount === 'number' && totalCount > initialLoadedCount) {
      host.historyWindowStartOffset = totalCount - initialLoadedCount;
      host.scheduleFullHistoryLoad();
    } else {
      host.historyWindowStartOffset = 0;
    }
  } catch (error) {
    console.error(LOG_PREFIX, 'Load session failed:', getErrorMessage(error));
    throw error;
  }
}

export async function loadEarlierMessages(host: TauriAdapterHost): Promise<void> {
  const generation = host.setupGeneration;
  const session = host.lastLoadedSessionInfo;
  if (!session || !host.isSessionRuntimeOwner()) return;
  if (host.fullHistoryLoadComplete) return;
  if (host.historyWindowStartOffset <= 0) return;

  // 手动滚动可能发生在 idle 回填已排队、尚未进入 in-flight 的窗口内。
  // 先取消排队任务，再同步占有同一个 in-flight 门；若 idle 回填已开始，
  // 则直接让在途任务完成，避免两个请求读取同一个窗口起点。
  const resumeAutomaticBackfill = host.cancelScheduledFullHistoryLoad !== null;
  host.cancelScheduledFullHistoryLoad?.();
  if (host.fullHistoryLoadInFlight) return;
  host.fullHistoryLoadInFlight = true;

  try {
    const requestWindowStart = host.historyWindowStartOffset;
    const offset = Math.max(0, requestWindowStart - HISTORY_BACKFILL_PAGE_SIZE);
    const expectedCount = requestWindowStart - offset;
    const baseline = host.captureRestoreBaseline();
    const page = await invoke<LoadMessagesPageResponseType>('chat_v2_load_messages_page', {
      sessionId: host.sessionId,
      offset,
      limit: HISTORY_BACKFILL_PAGE_SIZE,
    });
    if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) return;
    // 请求期间窗口已被其他路径推进时，响应已经过期，不能按共享当前值盲减。
    if (host.historyWindowStartOffset !== requestWindowStart) return;

    if (page.messages.length !== expectedCount) {
      // 非连续短页/空页不能直接拼到当前尾窗，否则会制造中间空洞；直接走
      // 全量 fallback 一次性重建连续历史，也避免用户反复滚顶请求同一坏页。
      console.warn(LOG_PREFIX, 'Manual history page was not contiguous, falling back to full load:', {
        sessionId: host.sessionId,
        offset,
        expected: expectedCount,
        returned: page.messages.length,
      });
      await host.loadFullHistoryFallback(generation);
      return;
    }

    host.store.prependHistoryFromBackend(
      {
        session,
        messages: page.messages,
        blocks: page.blocks,
        totalMessageCount: page.totalMessageCount,
      },
      baseline,
    );
    host.historyWindowStartOffset = offset;
    if (offset === 0) host.fullHistoryLoadComplete = true;
  } finally {
    host.fullHistoryLoadInFlight = false;
    if (
      resumeAutomaticBackfill
      && !host.fullHistoryLoadComplete
      && host.historyWindowStartOffset > 0
      && generation === host.setupGeneration
      && host.isSessionRuntimeOwner()
    ) {
      host.scheduleFullHistoryLoad();
    }
  }
}

/** 分页不可保证连续时，以一次全量读取重建连续历史窗口。 */
export async function loadFullHistoryFallback(host: TauriAdapterHost, generation: number): Promise<boolean> {
  const t0 = performance.now();
  const restoreBaseline = host.captureRestoreBaseline();
  const fullResponse = await invoke<LoadSessionResponseType>('chat_v2_load_session', {
    sessionId: host.sessionId,
  });
  if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) return false;
  host.store.prependHistoryFromBackend(fullResponse, restoreBaseline);
  host.historyWindowStartOffset = 0;
  host.fullHistoryLoadComplete = true;
  console.log(LOG_PREFIX, 'Full history merged (fallback path):', {
    sessionId: host.sessionId,
    totalMessages: fullResponse.messages?.length ?? 0,
    invokeMs: Math.round(performance.now() - t0),
  });
  return true;
}

/**
 * 尾部分块加载第二阶段：空闲期分批向前补页（chat_v2_load_messages_page），
 * 把缺失历史合并到正确位置；分页命令不可用时退回全量二次拉取 fallback。
 * 失败静默降级（首屏尾部数据已可用；下次进入会话会重试）。
 */
export function scheduleFullHistoryLoad(host: TauriAdapterHost, attempt = 0): void {
  if (
    host.fullHistoryLoadComplete
    || host.fullHistoryLoadInFlight
    || host.cancelScheduledFullHistoryLoad
  ) {
    return;
  }
  const generation = host.setupGeneration;
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  let started = false;
  let cancelled = false;
  let idleId: number | null = null;
  let watchdogId: number | null = null;
  const clearSchedule = () => {
    if (idleId !== null) {
      if (win.cancelIdleCallback) win.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
      idleId = null;
    }
    if (watchdogId !== null) {
      window.clearTimeout(watchdogId);
      watchdogId = null;
    }
    if (host.cancelScheduledFullHistoryLoad === cancelSchedule) {
      host.cancelScheduledFullHistoryLoad = null;
    }
  };
  const cancelSchedule = () => {
    cancelled = true;
    clearSchedule();
  };

  const run = async () => {
    if (started || cancelled) return;
    started = true;
    clearSchedule();
    // cleanup()/重新 setup 会推进 setupGeneration，此时放弃过期的补齐任务
    if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) return;
    host.fullHistoryLoadInFlight = true;
    try {
      // 首选：分批回填页（chat_v2_load_messages_page，每批 ~100 条，倒序推进）
      const pagedResult = await host.backfillHistoryByPages(generation);
      if (pagedResult === 'done') {
        host.fullHistoryLoadComplete = true;
        return;
      }
      if (pagedResult === 'capped') {
        // 页数上限收尾：fullHistoryLoadComplete 不置位，
        // 更早历史由滚动向上补页（loadEarlierMessages）按窗口起点续拉
        return;
      }
      if (pagedResult === 'stale') return;

      // fallback：分页命令 invoke 失败（旧后端/异常）时退回全量二次拉取
      await host.loadFullHistoryFallback(generation);
    } catch (error) {
      console.warn(LOG_PREFIX, 'Full history load failed (tail view remains):', getErrorMessage(error));
      if (
        attempt < FULL_HISTORY_MAX_RETRIES
        && generation === host.setupGeneration
        && host.isSessionRuntimeOwner()
      ) {
        const retryDelay = FULL_HISTORY_RETRY_BASE_MS * (2 ** attempt);
        const retryTimer = window.setTimeout(() => {
          if (host.cancelScheduledFullHistoryLoad === cancelRetry) {
            host.cancelScheduledFullHistoryLoad = null;
          }
          host.scheduleFullHistoryLoad(attempt + 1);
        }, retryDelay);
        const cancelRetry = () => {
          window.clearTimeout(retryTimer);
          if (host.cancelScheduledFullHistoryLoad === cancelRetry) {
            host.cancelScheduledFullHistoryLoad = null;
          }
        };
        host.cancelScheduledFullHistoryLoad = cancelRetry;
      }
    } finally {
      host.fullHistoryLoadInFlight = false;
    }
  };

  if (win.requestIdleCallback) {
    idleId = win.requestIdleCallback(() => { void run(); }, {
      timeout: FULL_HISTORY_IDLE_TIMEOUT_MS,
    });
    // Some WebView/test implementations ignore requestIdleCallback timeout.
    watchdogId = window.setTimeout(() => { void run(); }, FULL_HISTORY_IDLE_TIMEOUT_MS + 100);
  } else {
    idleId = window.setTimeout(() => { void run(); }, 120);
  }
  host.cancelScheduledFullHistoryLoad = cancelSchedule;
}

/**
 * 分批回填历史（🚀 2026-09-25 反向窗口化）：从连续窗口起点向更早历史
 * 倒序拉取 `chat_v2_load_messages_page`（页 offset 按最老消息计），
 * 每页立即合并进 store——mergeHistoryMessageOrder 按 timestamp 重排 +
 * 锚点合并，与页面到达顺序无关。窗口始终连续（无中间空洞），每页合并
 * 后 historyWindowStartOffset 向 0 推进；触顶（页数上限）后停止自动
 * 回填，更早历史由滚动补页按窗口起点续拉。
 *
 * 返回值：
 * - `'done'`：窗口抵达最老端（全量在内存）
 * - `'capped'`：达到页数上限后主动收尾（fullHistoryLoadComplete 不置位，
 *   滚动补页接续）
 * - `'stale'`：会话已切换/adapter 已过期，放弃
 * - `'unsupported'`：分页命令 invoke 失败或页序竞态无法保证窗口连续，
 *   调用方应退回全量加载 fallback
 */
export async function backfillHistoryByPages(
  host: TauriAdapterHost,
  generation: number,
): Promise<'done' | 'capped' | 'stale' | 'unsupported'> {
  const session = host.lastLoadedSessionInfo;
  if (!session || session.id !== host.sessionId) {
    // 没有可用的会话信息（理论上 loadSession 已写入），退回全量路径
    return 'unsupported';
  }

  const t0 = performance.now();
  let pagesFetched = 0;
  let mergedMessages = 0;

  while (host.historyWindowStartOffset > 0 && pagesFetched < HISTORY_BACKFILL_MAX_PAGES) {
    if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) {
      return 'stale';
    }

    const requestWindowStart = host.historyWindowStartOffset;
    const restoreBaseline = host.captureRestoreBaseline();
    const offset = Math.max(0, requestWindowStart - HISTORY_BACKFILL_PAGE_SIZE);
    const expectedCount = requestWindowStart - offset;
    let page: LoadMessagesPageResponseType;
    try {
      page = await invoke<LoadMessagesPageResponseType>('chat_v2_load_messages_page', {
        sessionId: host.sessionId,
        offset,
        limit: HISTORY_BACKFILL_PAGE_SIZE,
      });
    } catch (error) {
      console.warn(
        LOG_PREFIX,
        'Paged history load failed, will fall back to full load:',
        getErrorMessage(error),
      );
      return 'unsupported';
    }

    if (generation !== host.setupGeneration || !host.isSessionRuntimeOwner()) {
      return 'stale';
    }
    if (host.historyWindowStartOffset !== requestWindowStart) {
      return 'stale';
    }

    if (page.messages.length === 0) {
      // 服务端返回空页（total 与实际行数竞态，如压缩收缩）：防御死循环，
      // 按抵达最老端收尾（store 分页标志由 prepend 按最新 total 重算）
      host.historyWindowStartOffset = 0;
      break;
    }
    if (page.messages.length !== expectedCount && offset > 0) {
      // 未抵达最老端却拿到短页：页序竞态下无法保证窗口连续（会留中间
      // 空洞），退回全量加载 fallback 兜底
      console.warn(LOG_PREFIX, 'Short history page mid-window, will fall back to full load:', {
        sessionId: host.sessionId,
        offset,
        returned: page.messages.length,
      });
      return 'unsupported';
    }

    host.store.prependHistoryFromBackend(
      {
        session,
        messages: page.messages,
        blocks: page.blocks,
        totalMessageCount: page.totalMessageCount,
      },
      restoreBaseline,
    );
    mergedMessages += page.messages.length;
    host.historyWindowStartOffset = offset;
    pagesFetched += 1;
  }

  const capped = host.historyWindowStartOffset > 0;
  if (capped) {
    console.log(LOG_PREFIX, 'History backfill hit page cap, deferring older history to scroll-up paging:', {
      sessionId: host.sessionId,
      pagesFetched,
      mergedMessages,
      windowStartOffset: host.historyWindowStartOffset,
      elapsedMs: Math.round(performance.now() - t0),
    });
  } else {
    console.log(LOG_PREFIX, 'History backfilled by pages:', {
      sessionId: host.sessionId,
      pagesFetched,
      mergedMessages,
      elapsedMs: Math.round(performance.now() - t0),
    });
  }
  return capped ? 'capped' : 'done';
}
