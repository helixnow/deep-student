/**
 * 定时任务（自动化）全局 Zustand Store
 *
 * 统一 TodoAutomationWorkspace 与 AutomationSettingsSection 的数据源：
 * - refresh 并发去重 + requestVersion 防竞态；in-flight 期间再次请求会排队一次
 *   trailing refresh，避免 mutation 后复用到旧快照导致 UI 短暂回退
 * - mutation 走 busyKey + 后端快照局部 patch（拿不到快照才全量 refresh）
 * - setEnabled / setBackgroundEnabled 乐观更新，失败只回滚被改字段
 *   （不整体恢复快照，避免覆盖并发 refresh 带回的新数据）
 * - startAutomationSync 幂等单例订阅 chat_v2://automations_changed（listen 不可用则 30s 轮询兜底）
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type {
  AutomationCreateInput,
  AutomationListItem,
  AutomationRun,
  AutomationSummary,
  AutomationUpdateInput,
} from '../../settings/components/automationSettingsApi';
import {
  cancelAutomationRun,
  createAutomation,
  deleteAutomation,
  getAutomationSummary,
  isAutomationVersionConflictError,
  listAutomationRuns,
  listAutomations,
  retryAutomationRun,
  runAutomationNow,
  setAutomationBackgroundEnabled,
  setAutomationEnabled,
  updateAutomation,
} from '../../settings/components/automationSettingsApi';

const RUNS_LIMIT = 50;
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const isTauriEnvironment = (): boolean =>
  typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

interface AutomationStoreState {
  automations: AutomationListItem[];
  count: number;
  max: number;
  summary: AutomationSummary | null;
  runs: AutomationRun[];
  /** 首次加载中（已有数据后的刷新不置 true） */
  loading: boolean;
  /**
   * 最近一次失败的原始错误串（可能是后端 `{"code","message"}` JSON）。
   * 展示层必须经 `parseAutomationCommandError` 提取 message 兜底，
   * 不得把该字段直接渲染到 UI（否则会出现裸 JSON）。
   */
  error: string | null;
  /** 形如 `enable:{id}` / `run:{id}` / `delete:{id}` / `create` / `update:{id}` / `retry:{runId}` / `cancel:{runId}` / `background` */
  busyKey: string | null;

  refresh: () => Promise<void>;
  setEnabled: (id: string, version: number, enabled: boolean) => Promise<void>;
  create: (input: AutomationCreateInput) => Promise<void>;
  update: (input: AutomationUpdateInput) => Promise<void>;
  remove: (id: string, version: number) => Promise<void>;
  runNow: (id: string, version: number) => Promise<void>;
  retryRun: (runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  setBackgroundEnabled: (enabled: boolean) => Promise<void>;
}

// 模块级单例状态（store 本身为单例）
let refreshInFlight: Promise<void> | null = null;
/**
 * 刷新进行中又收到新的 refresh 请求（如 automations_changed 事件在拉取途中到达）时置位：
 * 直接复用 in-flight promise 会拿到「变更前」的旧快照，这里在其完成后自动补一轮，
 * 保证最终状态收敛到最新数据。
 */
let refreshQueued = false;
let requestVersion = 0;
let hasLoadedOnce = false;

export const useAutomationStore = create<AutomationStoreState>((set, get) => {
  /**
   * 从 automations 列表推导 summary 中可同步派生的字段（enabledCount / nextRunAt），
   * 避免 create/setEnabled/remove 局部 patch 后概览统计卡短暂失真。
   * runningCount / failedCount 依赖 runs 统计，保持原值，等 automations_changed
   * 触发的下一次 refresh 校准。
   */
  const deriveSummaryPatch = (
    automations: AutomationListItem[],
    summary: AutomationSummary | null,
  ): { summary: AutomationSummary } | Record<string, never> => {
    if (!summary) return {};
    let enabledCount = 0;
    let nextRunAt: string | undefined;
    let nextRunTs = Number.POSITIVE_INFINITY;
    for (const item of automations) {
      if (!item.enabled) continue;
      enabledCount += 1;
      if (!item.nextTriggerAt) continue;
      const ts = Date.parse(item.nextTriggerAt);
      if (!Number.isNaN(ts) && ts < nextRunTs) {
        nextRunTs = ts;
        nextRunAt = item.nextTriggerAt;
      }
    }
    return { summary: { ...summary, enabledCount, nextRunAt } };
  };

  /** 用后端返回的最新快照局部 patch 列表；条目不存在时追加。同步派生 summary。 */
  const patchAutomation = (snapshot: AutomationListItem) => {
    set((state) => {
      const index = state.automations.findIndex((item) => item.id === snapshot.id);
      let automations: AutomationListItem[];
      let count = state.count;
      if (index === -1) {
        automations = [...state.automations, snapshot];
        count = state.count + 1;
      } else {
        automations = state.automations.slice();
        automations[index] = snapshot;
      }
      return { automations, count, ...deriveSummaryPatch(automations, state.summary) };
    });
  };

  /**
   * mutation 通用管线：设置 busyKey → 执行 → 清 busyKey。
   * 错误写入 error 并抛出（组件可 catch 做行内提示）；
   * 版本冲突（AUTOMATION_VERSION_CONFLICT）时自动 refresh 拉回真实状态。
   */
  const runMutation = async (busyKey: string, action: () => Promise<void>): Promise<void> => {
    if (!isTauriEnvironment()) {
      set({ error: 'desktop_only' });
      throw new Error('desktop_only');
    }
    set({ busyKey, error: null });
    try {
      await action();
    } catch (error) {
      set({ error: toErrorMessage(error) });
      // 版本冲突（乐观并发失败）：本地快照已过期，自动拉回真实状态
      if (isAutomationVersionConflictError(error)) {
        void get().refresh();
      }
      throw error;
    } finally {
      if (get().busyKey === busyKey) {
        set({ busyKey: null });
      }
    }
  };

  return {
    automations: [],
    count: 0,
    max: 20,
    summary: null,
    runs: [],
    loading: false,
    error: null,
    busyKey: null,

    refresh: async () => {
      if (!isTauriEnvironment()) {
        set({ loading: false, error: 'desktop_only' });
        return;
      }
      // 并发去重：进行中的 refresh 直接复用，并在其完成后补拉一轮避免旧快照
      if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
      }

      const version = ++requestVersion;
      if (!hasLoadedOnce) {
        set({ loading: true });
      }

      refreshInFlight = (async () => {
        try {
          const [listResult, summary, runs] = await Promise.all([
            listAutomations(invoke),
            getAutomationSummary(invoke),
            listAutomationRuns(invoke, undefined, RUNS_LIMIT),
          ]);
          if (version !== requestVersion) return;
          hasLoadedOnce = true;
          set({
            automations: listResult.automations,
            count: listResult.count,
            max: listResult.max,
            summary,
            runs,
            loading: false,
            error: null,
          });
        } catch (error) {
          if (version !== requestVersion) return;
          set({ loading: false, error: toErrorMessage(error) });
        } finally {
          refreshInFlight = null;
          if (refreshQueued) {
            refreshQueued = false;
            void get().refresh();
          }
        }
      })();

      return refreshInFlight;
    },

    setEnabled: async (id, version, enabled) => {
      const originalEnabled = get().automations.find((item) => item.id === id)?.enabled;
      await runMutation(`enable:${id}`, async () => {
        // 乐观更新（含 summary 派生字段）
        set((state) => {
          const automations = state.automations.map((item) =>
            item.id === id ? { ...item, enabled } : item,
          );
          return { automations, ...deriveSummaryPatch(automations, state.summary) };
        });
        try {
          const snapshot = await setAutomationEnabled(invoke, id, version, enabled);
          if (snapshot) {
            patchAutomation(snapshot);
          } else {
            await get().refresh();
          }
        } catch (error) {
          // 失败只回滚该条目的 enabled 字段：整体恢复旧快照会覆盖
          // 期间并发 refresh / patch 带回的其他新数据
          set((state) => {
            const automations = state.automations.map((item) =>
              item.id === id && originalEnabled !== undefined
                ? { ...item, enabled: originalEnabled }
                : item,
            );
            return { automations, ...deriveSummaryPatch(automations, state.summary) };
          });
          throw error;
        }
      });
    },

    create: async (input) => {
      await runMutation('create', async () => {
        const snapshot = await createAutomation(invoke, input);
        if (snapshot) {
          patchAutomation(snapshot);
        } else {
          await get().refresh();
        }
      });
    },

    update: async (input) => {
      await runMutation(`update:${input.automationId}`, async () => {
        const snapshot = await updateAutomation(invoke, input);
        if (snapshot) {
          patchAutomation(snapshot);
        } else {
          await get().refresh();
        }
      });
    },

    remove: async (id, version) => {
      await runMutation(`delete:${id}`, async () => {
        await deleteAutomation(invoke, id, version);
        set((state) => {
          const automations = state.automations.filter((item) => item.id !== id);
          return {
            automations,
            count: Math.max(0, state.count - 1),
            runs: state.runs.filter((run) => run.automationId !== id),
            ...deriveSummaryPatch(automations, state.summary),
          };
        });
      });
    },

    runNow: async (id, version) => {
      await runMutation(`run:${id}`, async () => {
        await runAutomationNow(invoke, id, version);
        // run_now 无条目快照，runs / summary 都会变化 → 全量 refresh
        await get().refresh();
      });
    },

    retryRun: async (runId) => {
      await runMutation(`retry:${runId}`, async () => {
        await retryAutomationRun(invoke, runId);
        await get().refresh();
      });
    },

    cancelRun: async (runId) => {
      await runMutation(`cancel:${runId}`, async () => {
        await cancelAutomationRun(invoke, runId);
        await get().refresh();
      });
    },

    setBackgroundEnabled: async (enabled) => {
      const previousEnabled = get().summary?.backgroundEnabled ?? true;
      await runMutation('background', async () => {
        // 乐观更新 summary.backgroundEnabled
        set((state) => ({
          summary: state.summary ? { ...state.summary, backgroundEnabled: enabled } : state.summary,
        }));
        try {
          await setAutomationBackgroundEnabled(invoke, enabled);
        } catch (error) {
          // 只回滚 backgroundEnabled 字段，保留期间刷新带回的其余 summary 数据
          set((state) => ({
            summary: state.summary
              ? { ...state.summary, backgroundEnabled: previousEnabled }
              : state.summary,
          }));
          throw error;
        }
      });
    },
  };
});

// ---------------------------------------------------------------------------
// startAutomationSync：幂等单例事件订阅（引用计数，多处调用共享一个监听）
// ---------------------------------------------------------------------------

let syncRefCount = 0;
let syncUnlisten: (() => void) | null = null;
let syncPollTimer: ReturnType<typeof setInterval> | null = null;
let syncGeneration = 0;

/**
 * 订阅 `chat_v2://automations_changed` → refresh()；
 * listen 不可用（事件桥失败）时降级为 30s 轮询。
 * 返回停止函数；多处调用共享同一个监听（引用计数归零才真正停止）。
 */
export function startAutomationSync(): () => void {
  syncRefCount += 1;

  if (syncRefCount === 1) {
    const generation = ++syncGeneration;

    if (isTauriEnvironment()) {
      // 首次启动立即拉一次数据
      void useAutomationStore.getState().refresh();

      void listen('chat_v2://automations_changed', () => {
        void useAutomationStore.getState().refresh();
      })
        .then((unlisten) => {
          if (generation !== syncGeneration || syncRefCount === 0) {
            unlisten();
            return;
          }
          syncUnlisten = unlisten;
        })
        .catch(() => {
          if (generation !== syncGeneration || syncRefCount === 0) return;
          // 事件桥不可用 → 30s 轮询兜底
          syncPollTimer = setInterval(() => {
            void useAutomationStore.getState().refresh();
          }, FALLBACK_POLL_INTERVAL_MS);
        });
    } else {
      useAutomationStore.setState({ loading: false, error: 'desktop_only' });
    }
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    syncRefCount = Math.max(0, syncRefCount - 1);
    if (syncRefCount === 0) {
      syncGeneration += 1;
      syncUnlisten?.();
      syncUnlisten = null;
      if (syncPollTimer !== null) {
        clearInterval(syncPollTimer);
        syncPollTimer = null;
      }
    }
  };
}
