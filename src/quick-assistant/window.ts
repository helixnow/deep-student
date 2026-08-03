import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QUICK_ASSISTANT_SHORTCUT } from './config';

export const QUICK_ASSISTANT_LABEL = 'quick-assistant';
export const QUICK_ASSISTANT_SHOWN_EVENT = 'quick-assistant://shown';
export const QUICK_ASSISTANT_OPEN_TARGET_EVENT = 'quick-assistant://open-target';

export interface QuickAssistantOpenTarget {
  kind: 'session' | 'resource' | 'view';
  id?: string;
  /** 资源目标的 DSTU 路径（openResource 处理器按路径打开，非根目录资源不能用 /{id}） */
  path?: string;
  view?: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

/**
 * 显示小窗。窗口的创建、多屏定位、位置恢复全部由原生侧完成，
 * 前端各调用点只负责触发。
 */
export async function openQuickAssistantWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke('quick_assistant_show');
  return true;
}

/**
 * 隐藏小窗。走原生命令以便执行焦点归还与位置持久化；
 * 命令不可用时（如权限缺失）回退为直接隐藏当前窗口。
 */
export async function hideCurrentQuickAssistantWindow(): Promise<void> {
  try {
    await invoke('quick_assistant_hide');
  } catch {
    await getCurrentWindow().hide();
  }
}

export async function openQuickAssistantTarget(target: QuickAssistantOpenTarget): Promise<void> {
  await emitTo('main', QUICK_ASSISTANT_OPEN_TARGET_EVENT, target);
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const main = await WebviewWindow.getByLabel('main');
  if (main) {
    await main.show();
    await main.unminimize();
    await main.setFocus();
  }
  await hideCurrentQuickAssistantWindow();
}

export async function initializeQuickAssistantMainBridge(): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<QuickAssistantOpenTarget>(QUICK_ASSISTANT_OPEN_TARGET_EVENT, (event) => {
    const target = event.payload;
    if (target.kind === 'session' && target.id) {
      window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'chat-v2' } }));
      for (const delay of [50, 400, 1200]) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('navigate-to-session', { detail: { sessionId: target.id } }));
        }, delay);
      }
      return;
    }
    if (target.kind === 'resource' && (target.path || target.id)) {
      window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
        detail: { view: 'learning-hub', openResource: target.path || `/${target.id}` },
      }));
      return;
    }
    if (target.kind === 'view' && target.view) {
      window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: target.view } }));
    }
  });
}

export async function initializeQuickAssistantGlobalShortcut(): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { register, unregister, isRegistered } = await import('@tauri-apps/plugin-global-shortcut');

  const syncRegistration = async () => {
    const { enabled } = await import('./config').then((module) => module.getQuickAssistantConfig());
    const registered = await isRegistered(QUICK_ASSISTANT_SHORTCUT);
    if (enabled) {
      // The native registration survives a WebView reload, while its JS callback does not.
      // Rebind on every sync so the shortcut also recovers after refresh/HMR.
      if (registered) await unregister(QUICK_ASSISTANT_SHORTCUT);
      // Window toggling is handled by the native plugin handler so it survives
      // WebView reloads and frontend error-boundary recovery.
      await register(QUICK_ASSISTANT_SHORTCUT, () => {});
    } else if (!enabled && registered) {
      await unregister(QUICK_ASSISTANT_SHORTCUT);
    }
    // 原生侧联动：开启时预加载隐藏窗口（首次呼出零延迟），关闭时销毁。
    await invoke('quick_assistant_apply_enabled', { enabled }).catch(() => {});
  };

  await syncRegistration();
  const onChanged = () => { void syncRegistration(); };
  window.addEventListener('quick-assistant-config-changed', onChanged);
  return () => {
    window.removeEventListener('quick-assistant-config-changed', onChanged);
    void unregister(QUICK_ASSISTANT_SHORTCUT).catch(() => {});
  };
}
