/**
 * Browser ControlMode 前端镜像同步（ACR R2-10）
 *
 * Rust 为权威：`browser:control-mode-changed`（agent_claim / user_takeover / password_blocked）。
 * 本模块经 workbench eventHub 单订阅，把 controlMode 写回 sessionStore，避免 chrome 与权威漂移。
 */
import { hubListen } from '@/features/workbench/core/eventHub';
import { parseControlMode } from './browserApi';
import { useBrowserSessionStore } from './sessionStore';

/** 与 Rust `events::EVT_CONTROL_MODE_CHANGED` 对齐 */
export const BROWSER_CONTROL_MODE_CHANGED_EVENT = 'browser:control-mode-changed';

export interface BrowserControlModeChangedPayload {
  sessionId?: string;
  session_id?: string;
  label?: string;
  controlMode?: string;
  control_mode?: string;
  reason?: string;
  at?: string;
}

let unlisten: (() => void) | null = null;
let refCount = 0;

function applyControlModePayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as BrowserControlModeChangedPayload;
  const modeRaw = p.controlMode ?? p.control_mode;
  const mode = parseControlMode(modeRaw);
  const sessionId = p.sessionId ?? p.session_id;

  const state = useBrowserSessionStore.getState();
  // 无活跃 session 时仍接受权威态（开窗瞬间 claim 可能早于 hydrate）
  if (sessionId && state.sessionId && sessionId !== state.sessionId) {
    return;
  }

  if (state.controlMode === mode) return;
  useBrowserSessionStore.setState({ controlMode: mode });
}

/**
 * 订阅 ControlMode 权威事件。可重入：挂载计数，末次 dispose 才拆监听。
 */
export function ensureBrowserControlModeSync(): () => void {
  refCount += 1;
  if (!unlisten) {
    unlisten = hubListen(BROWSER_CONTROL_MODE_CHANGED_EVENT, applyControlModePayload);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/** 单测：直接喂事件载荷 */
export function __applyControlModePayloadForTest(payload: unknown): void {
  applyControlModePayload(payload);
}

/** 单测：重置订阅计数 */
export function __resetControlModeSyncForTest(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  refCount = 0;
}
