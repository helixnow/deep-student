/**
 * ACR AgentBridge 传输层 — R1-07
 *
 * 复刻 mcpService.setupTauriBridge：listen 请求 → 处理 → emit 响应（禁止 invoke）。
 * 进度经 emitAcrProgress 按 correlationId ≤5Hz 尾随合并。
 *
 * 设计：docs/dev/acr/DESIGN.md §2.1
 */

import type { AcrBridgeRequest, AcrBridgeResponse, AcrProgressEvent } from './types';
import {
  ACR_EVENT_PROGRESS_PREFIX,
  ACR_EVENT_REQUEST,
  ACR_EVENT_RESPONSE_PREFIX,
} from './types';
import { stageManager } from './stageManager';

const PROGRESS_MIN_INTERVAL_MS = 200; // ≤5Hz

type UnlistenFn = () => void;

interface ProgressThrottleEntry {
  /** 上次实际发出的时间；null = 尚未发出过（首条立即发） */
  lastEmitAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  pending: AcrProgressEvent | null;
  inFlight: Promise<void> | null;
}

let bridgeActive = false;
let activeUnlisten: UnlistenFn | null = null;
const progressThrottle = new Map<string, ProgressThrottleEntry>();

function progressKey(correlationId: string, bridgeToken?: string): string {
  return JSON.stringify([correlationId, bridgeToken ?? '']);
}

type EmitFn = (event: string, payload: unknown) => Promise<void>;
let cachedEmit: EmitFn | null = null;

async function getEmit(): Promise<EmitFn | null> {
  if (cachedEmit) return cachedEmit;
  try {
    const mod = await import('@tauri-apps/api/event');
    cachedEmit = mod.emit as EmitFn;
    return cachedEmit;
  } catch {
    return null;
  }
}

async function emitProgressPayload(payload: AcrProgressEvent): Promise<void> {
  const emit = await getEmit();
  if (!emit) return;
  try {
    await emit(`${ACR_EVENT_PROGRESS_PREFIX}${payload.correlationId}`, payload);
  } catch {
    /* best-effort */
  }
}

function flushProgress(key: string): void {
  const entry = progressThrottle.get(key);
  if (!entry?.pending) return;
  const payload = entry.pending;
  entry.pending = null;
  entry.lastEmitAt = Date.now();
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const task = emitProgressPayload(payload);
  entry.inFlight = task;
  void task.finally(() => {
    if (entry.inFlight === task) entry.inFlight = null;
  });
}

async function finalizeProgress(
  correlationId: string,
  bridgeToken?: string,
): Promise<void> {
  const key = progressKey(correlationId, bridgeToken);
  const entry = progressThrottle.get(key);
  if (!entry) return;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.inFlight) await entry.inFlight;

  const pending = entry.pending;
  entry.pending = null;
  if (pending) {
    entry.lastEmitAt = Date.now();
    await emitProgressPayload(pending);
  }

  if (progressThrottle.get(key) === entry) {
    progressThrottle.delete(key);
  }
}

function mergeProgress(
  prev: AcrProgressEvent | null,
  next: AcrProgressEvent,
): AcrProgressEvent {
  if (!prev) return next;
  return {
    ...next,
    step: Math.max(prev.step, next.step),
  };
}

/**
 * 向 Rust 上报进度（≤5Hz）。同一 correlationId 在 200ms 窗口内尾随合并，
 * 只发最后一条，但 step 单调取最大值。
 * ROUND1 亦称 emitProgress；此处保留 emitAcrProgress 为主名。
 */
export function emitAcrProgress(
  correlationId: string,
  step: number,
  total: number | undefined,
  message: string,
  entityId?: string,
  bridgeToken?: string,
): void {
  if (!correlationId) return;
  const next: AcrProgressEvent = {
    correlationId,
    ...(bridgeToken ? { bridgeToken } : {}),
    step,
    total,
    message,
    entityId,
  };

  const key = progressKey(correlationId, bridgeToken);
  let entry = progressThrottle.get(key);
  if (!entry) {
    entry = { lastEmitAt: null, timer: null, pending: null, inFlight: null };
    progressThrottle.set(key, entry);
  }

  entry.pending = mergeProgress(entry.pending, next);
  if (entry.lastEmitAt == null) {
    flushProgress(key);
    return;
  }

  const elapsed = Date.now() - entry.lastEmitAt;
  if (elapsed >= PROGRESS_MIN_INTERVAL_MS) {
    flushProgress(key);
    return;
  }

  if (entry.timer) return;
  const wait = PROGRESS_MIN_INTERVAL_MS - elapsed;
  entry.timer = setTimeout(() => {
    entry!.timer = null;
    flushProgress(key);
  }, wait);
}

/** ROUND1 别名：emitProgress ≡ emitAcrProgress */
export const emitProgress = emitAcrProgress;

/** 测试/卸载：清空进度节流状态 */
export function __resetAcrProgressThrottleForTests(): void {
  for (const entry of progressThrottle.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  progressThrottle.clear();
}

async function handleRequest(req: AcrBridgeRequest): Promise<void> {
  let response: AcrBridgeResponse;
  try {
    response = await stageManager.handleBridgeRequest(req);
    response = {
      ...response,
      correlationId: req.correlationId,
      ...(req.bridgeToken ? { bridgeToken: req.bridgeToken } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    response = {
      correlationId: req.correlationId,
      ...(req.bridgeToken ? { bridgeToken: req.bridgeToken } : {}),
      ok: false,
      error: message || 'StageManager handleBridgeRequest failed',
    };
  }

  await finalizeProgress(req.correlationId, req.bridgeToken);

  try {
    const { emit } = await import('@tauri-apps/api/event');
    const corrEvent = `${ACR_EVENT_RESPONSE_PREFIX}${req.correlationId}`;
    try {
      await emit(corrEvent, response);
    } catch {
      /* best-effort */
    }
    // 诊断用广播（无 correlation 后缀）
    try {
      await emit('acr:bridge-response', response);
    } catch {
      /* best-effort */
    }
  } catch (err) {
    console.warn('[ACR] emit bridge response failed:', err);
  }
}

/**
 * 注册 acr:bridge-request 监听。返回卸载函数。
 * 重复调用时先卸载旧监听，保证单例。
 */
export function setupAgentBridge(): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* noop */
    };
  }

  // 重复挂载防护：先清掉旧监听
  if (bridgeActive && activeUnlisten) {
    try {
      activeUnlisten();
    } catch {
      /* ignore */
    }
    activeUnlisten = null;
    bridgeActive = false;
  }

  let cancelled = false;
  let unlistenFn: UnlistenFn | null = null;

  const teardown = () => {
    cancelled = true;
    if (unlistenFn) {
      try {
        unlistenFn();
      } catch {
        /* ignore */
      }
      unlistenFn = null;
    }
    if (activeUnlisten === teardown) {
      activeUnlisten = null;
      bridgeActive = false;
    }
    __resetAcrProgressThrottleForTests();
  };

  bridgeActive = true;
  activeUnlisten = teardown;

  // 动态 import：web-only / jsdom 下由 mock 或 catch 降级（对齐 mcp 桥懒加载）
  import('@tauri-apps/api/event')
    .then(({ listen }) => {
      if (cancelled) return;
      return listen<AcrBridgeRequest>(ACR_EVENT_REQUEST, (ev) => {
        const req = ev.payload;
        if (!req?.correlationId) {
          console.warn('[ACR] bridge-request missing correlationId');
          return;
        }
        void handleRequest(req);
      }).then((unlisten) => {
        if (cancelled) {
          try {
            unlisten();
          } catch {
            /* ignore */
          }
          return;
        }
        unlistenFn = unlisten;
      });
    })
    .catch((err) => {
      console.warn('[ACR] setupAgentBridge failed:', err);
      bridgeActive = false;
      if (activeUnlisten === teardown) activeUnlisten = null;
    });

  return teardown;
}
