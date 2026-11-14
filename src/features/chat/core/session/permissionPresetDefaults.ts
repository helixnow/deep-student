/**
 * 新会话默认权限档位（做一做执行档位）记忆
 *
 * 规则（与 docs/user-guide/02-AI对话与会话管理.md「做一做执行档位」一致）：
 * - 用户切换档位时记住「上次选择」，之后的新会话默认沿用；
 * - 只记忆安全档（cautious / relaxed）。full_access / danger_full_access
 *   属于高权限档，只对当前会话生效，绝不跨会话记忆——
 *   与审批卡「本会话允许（无 always_allow）」同一安全哲学；
 * - 无记录 / 记录非法时回退产品默认 relaxed。
 */
import type { PermissionPreset } from '../types/store';
import { getSetting, saveSetting } from '@/utils/settingsApi';
import { isTauriRuntime } from '@/utils/shared';

export const DEFAULT_PERMISSION_PRESET_STORAGE_KEY = 'chat-v2:default-permission-preset';

/**
 * SQLite `settings` 中的默认档位副本。
 * localStorage 是运行时权威源；副本用于 origin 变更 / WebView 缓存清理后的回填，
 * 避免用户选择的 cautious 安全档静默回退成 relaxed。
 */
export const DEFAULT_PERMISSION_PRESET_SETTING_KEY = 'chat.defaultPermissionPreset';

/** 允许被记忆为默认值的安全档 */
const REMEMBERABLE_PRESETS = new Set<PermissionPreset>(['cautious', 'relaxed']);

function isRememberablePreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && REMEMBERABLE_PRESETS.has(value as PermissionPreset);
}

function readStoredPreset(): PermissionPreset | null {
  try {
    const raw = localStorage.getItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY);
    return isRememberablePreset(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 全进程共享一次 SQLite 读取（模块导入即触发） */
let presetHydration: Promise<void> | null = null;

/**
 * 从 SQLite settings 回填默认档位（localStorage 缺失或非法时才写入）。
 * @returns 回填完成后 resolve；无副本/读取失败时静默结束
 */
export function hydrateDefaultPermissionPreset(): Promise<void> {
  if (presetHydration) return presetHydration;
  if (!isTauriRuntime) {
    presetHydration = Promise.resolve();
    return presetHydration;
  }
  presetHydration = getSetting(DEFAULT_PERMISSION_PRESET_SETTING_KEY)
    .then((stored) => {
      if (!isRememberablePreset(stored)) return;
      if (readStoredPreset() !== null) return; // localStorage 权威
      try {
        localStorage.setItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY, stored);
      } catch {
        // localStorage 不可用：本次会话仍按 relaxed 回退，无法进一步兜底
      }
    })
    .catch((error: unknown) => {
      console.warn('[permissionPresetDefaults] 从 settings 回填默认档位失败:', error);
    });
  return presetHydration;
}

/**
 * 记录用户本次选择的档位作为后续新会话默认。
 * 高权限档（full_access / danger_full_access）跳过——不改写既有记忆，
 * 用户降回安全档时才更新。
 */
export function rememberPermissionPreset(preset: PermissionPreset): void {
  if (!REMEMBERABLE_PRESETS.has(preset)) return;
  try {
    localStorage.setItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY, preset);
  } catch {
    // 存储不可用（隐私模式等）：静默跳过，默认档回退 relaxed
  }
  // ★ BUG-7: 镜像到 SQLite settings（localStorage 丢失后 cautious 记忆不会静默回退 relaxed）
  void saveSetting(DEFAULT_PERMISSION_PRESET_SETTING_KEY, preset).catch((error: unknown) => {
    console.warn('[permissionPresetDefaults] 镜像默认档位到 settings 失败:', error);
  });
}

/** 新会话应使用的默认档位；无记忆或记录非法时为 relaxed */
export function getDefaultPermissionPreset(): PermissionPreset {
  return readStoredPreset() ?? 'relaxed';
}

// 模块导入即开始回填：新会话创建通常晚于这次异步 IPC，能拿到用户记忆的档位。
void hydrateDefaultPermissionPreset();
