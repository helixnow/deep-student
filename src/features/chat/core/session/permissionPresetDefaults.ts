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

export const DEFAULT_PERMISSION_PRESET_STORAGE_KEY = 'chat-v2:default-permission-preset';

/** 允许被记忆为默认值的安全档 */
const REMEMBERABLE_PRESETS = new Set<PermissionPreset>(['cautious', 'relaxed']);

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
}

/** 新会话应使用的默认档位；无记忆或记录非法时为 relaxed */
export function getDefaultPermissionPreset(): PermissionPreset {
  try {
    const raw = localStorage.getItem(DEFAULT_PERMISSION_PRESET_STORAGE_KEY);
    if (raw && REMEMBERABLE_PRESETS.has(raw as PermissionPreset)) {
      return raw as PermissionPreset;
    }
  } catch {
    // ignore
  }
  return 'relaxed';
}
