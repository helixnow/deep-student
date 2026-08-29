/**
 * desktopNameStore — Spaces 最小命名桌面（会话空间的用户命名）
 *
 * 对标 Arc Spaces / macOS 桌面空间的「空间有名字」语义的最小落地：
 * 单桌面阶段先让唯一的学习桌面可命名、可持久化，后续多 Space 时
 * 该键自然演化为 per-space 字段。
 *
 * 存储：独立设置键 'desktop.workbenchDesktopName'（save_setting / get_setting，
 * 非 Tauri 环境回退 localStorage）——**刻意不进 workbenchSnapshot**：
 * 快照白名单只存窗口壳（快照纯净性 P0 约束），空间元数据走 settings 通道，
 * 与 wallpaper / materialTier 的设置键同族。
 * 热更新：复用 'workbench:settings-changed' 事件契约（DesktopContextMenu /
 * WorkbenchDesktop / StatusBar 同款），跨入口改名即时生效。
 * 解析：core/persistedSettings.parsePersistedDesktopName（控制字符清洗 +
 * 码点截断；空/坏值 → null，展示方回退默认品牌名）。
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { parsePersistedDesktopName } from '../core/persistedSettings';

/** 设置键：桌面（Space）自定义名称；空串 = 未命名（回退默认品牌名） */
export const DESKTOP_NAME_SETTING_KEY = 'desktop.workbenchDesktopName';

interface DesktopNameState {
  /** 清洗后的自定义名称；null = 未设置（展示方回退 menubar.appName） */
  name: string | null;
  setName: (value: string | null) => void;
}

export const useDesktopNameStore = create<DesktopNameState>((set) => ({
  name: null,
  setName: (value) => set({ name: value }),
}));

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) ||
      Boolean((window as unknown as Record<string, unknown>).__TAURI_IPC__))
  );
}

async function readSetting(key: string): Promise<string | null> {
  try {
    if (!isTauriRuntime()) {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    }
    return await invoke<string | null>('get_setting', { key });
  } catch {
    return null;
  }
}

let syncStarted = false;
/** 热更新是否已先于启动回放到达（r6 复核补丁：晚到的启动读不得覆盖更新值） */
let hotUpdateSeen = false;

/**
 * 一次性接线：启动回放（get_setting）+ 'workbench:settings-changed' 热更新。
 * 幂等，可被任意消费方（useDesktopName）重复调用；监听器随模块存活。
 */
export function ensureDesktopNameSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void readSetting(DESKTOP_NAME_SETTING_KEY).then((raw) => {
    if (hotUpdateSeen) return;
    useDesktopNameStore.getState().setName(parsePersistedDesktopName(raw));
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('workbench:settings-changed', (e: Event) => {
      const { key, value } = (e as CustomEvent<{ key?: string; value?: unknown }>).detail ?? {};
      if (key !== DESKTOP_NAME_SETTING_KEY) return;
      hotUpdateSeen = true;
      useDesktopNameStore.getState().setName(parsePersistedDesktopName(value));
    });
  }
}

/** 订阅桌面名称（自动完成首次读取接线）；null = 未命名 */
export function useDesktopName(): string | null {
  ensureDesktopNameSync();
  return useDesktopNameStore((s) => s.name);
}

/**
 * 持久化桌面名称并派发热更新。传入原始输入，内部统一清洗；
 * 清洗后为空 → 落盘空串（= 清除命名，回退默认名）。
 * 落盘失败仍派发事件（本次会话内生效），与 persistWorkbenchSetting 同策略。
 */
export async function persistDesktopName(rawInput: string): Promise<void> {
  const parsed = parsePersistedDesktopName(rawInput);
  const raw = parsed ?? '';
  try {
    if (isTauriRuntime()) {
      await invoke('save_setting', { key: DESKTOP_NAME_SETTING_KEY, value: raw });
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DESKTOP_NAME_SETTING_KEY, raw);
    }
  } catch {
    // 落盘失败仍走热更新，本次会话内先生效
  }
  try {
    window.dispatchEvent(
      new CustomEvent('workbench:settings-changed', {
        detail: { key: DESKTOP_NAME_SETTING_KEY, value: raw },
      }),
    );
  } catch {
    // 非浏览器环境忽略
  }
}

/** 仅供单元测试：复位 store 状态（settings-changed 监听器随模块存活，不重复安装） */
export function resetDesktopNameForTests(): void {
  useDesktopNameStore.setState({ name: null });
}
