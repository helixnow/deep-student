/**
 * Workbench 诊断门闩：开发版默认关闭 HUD / interactionTrace 落盘。
 *
 * 仅当带参数启动时开启：
 * - 环境变量 `VITE_WB_DIAGNOSTICS=1`（如 `npm run dev:tauri:diag`）
 * - URL `?wbDiag=1` / `?wb-diagnostics=1`（写入 sessionStorage，同会话内刷新仍有效）
 * - hash `#wbDiag` / `#wbDiag=1`
 */

const SESSION_KEY = '__WB_DIAGNOSTICS__';

function envFlagOn(): boolean {
  try {
    const raw = String(import.meta.env?.VITE_WB_DIAGNOSTICS ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  } catch {
    return false;
  }
}

function persistSessionFlag(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_KEY, '1');
    }
  } catch {
    /* private mode */
  }
}

function readSessionFlag(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function readUrlFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('wbDiag') === '1' || params.get('wb-diagnostics') === '1') {
      persistSessionFlag();
      return true;
    }
    const hash = window.location.hash.replace(/^#/, '');
    if (hash === 'wbDiag' || hash.includes('wbDiag=1')) {
      persistSessionFlag();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** 本次进程/会话是否请求开启 Workbench 诊断（HUD + 交互时间线落盘）。 */
export function isWorkbenchDiagnosticsRequested(): boolean {
  if (envFlagOn()) return true;
  if (readUrlFlag()) return true;
  return readSessionFlag();
}
