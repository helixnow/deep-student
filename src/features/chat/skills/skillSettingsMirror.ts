/**
 * Skills UI 状态的 localStorage → 后端 settings 镜像。
 *
 * 四个 UI 状态目前只存在 localStorage（`deep-student.skill-enable-overrides`、
 * `deep-student.skill-trust-overrides`、`dstu-skill-favorites`、`skills.bundles.v1`）：
 * 换设备、清 WebView 数据或移动端重装后会丢失。这里把它们镜像到主库 `settings` 表：
 *
 * | localStorage | settings key |
 * |---|---|
 * | `deep-student.skill-enable-overrides` | `skill.ui.enable_overrides` |
 * | `deep-student.skill-trust-overrides`  | `skill.ui.trust_overrides` |
 * | `dstu-skill-favorites`                | `skill.ui.favorites` |
 * | `skills.bundles.v1`                   | `skill.ui.bundles` |
 *
 * 读路径仍然同步走 localStorage（渲染期大量同步读取），镜像只在两个时机参与：
 * - 启动加载技能前 `hydrateSkillUiSettings()`：后端有值则覆盖本地；后端为空且本地有值则上送（首次迁移）；
 * - 每次本地写入后异步 `save_setting`（失败只告警，不阻塞 UI）。
 *
 * 不在 Tauri 运行时（纯浏览器 / 测试）时所有函数静默降级。
 */

import { invoke } from '@tauri-apps/api/core';

export type SkillUiStoreName = 'enable' | 'trust' | 'favorites' | 'bundles';

export const SKILL_UI_LOCAL_KEYS: Record<SkillUiStoreName, string> = {
  enable: 'deep-student.skill-enable-overrides',
  trust: 'deep-student.skill-trust-overrides',
  favorites: 'dstu-skill-favorites',
  bundles: 'skills.bundles.v1',
};

export const SKILL_UI_SETTING_KEYS: Record<SkillUiStoreName, string> = {
  enable: 'skill.ui.enable_overrides',
  trust: 'skill.ui.trust_overrides',
  favorites: 'skill.ui.favorites',
  bundles: 'skill.ui.bundles',
};

const LOG_PREFIX = '[SkillSettingsMirror]';

function hasLocalStorage(): boolean {
  try { return typeof localStorage !== 'undefined'; }
  catch { return false; }
}

export function isTauriRuntimeAvailable(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** 把四个 UI 状态同步到后端；只在会话启动时调用一次。返回是否至少有后端值被应用。 */
export async function hydrateSkillUiSettings(): Promise<boolean> {
  if (!isTauriRuntimeAvailable() || !hasLocalStorage()) return false;
  let applied = false;
  for (const name of Object.keys(SKILL_UI_LOCAL_KEYS) as SkillUiStoreName[]) {
    const settingKey = SKILL_UI_SETTING_KEYS[name];
    let remote: string | null;
    try {
      remote = await invoke<string | null>('get_setting', { key: settingKey });
    } catch (error: unknown) {
      console.warn(LOG_PREFIX, `read ${settingKey} failed:`, error);
      continue;
    }
    if (typeof remote === 'string' && remote.length > 0) {
      try {
        localStorage.setItem(SKILL_UI_LOCAL_KEYS[name], remote);
        applied = true;
      } catch (error: unknown) {
        console.warn(LOG_PREFIX, `apply ${settingKey} failed:`, error);
      }
      continue;
    }
    const local = localStorage.getItem(SKILL_UI_LOCAL_KEYS[name]);
    if (local) saveSkillUiSetting(name, local);
  }
  return applied;
}

/** 本地写入后异步镜像；失败只告警（UI 状态不因持久化失败而回滚）。 */
export function saveSkillUiSetting(name: SkillUiStoreName, value: string): void {
  if (!isTauriRuntimeAvailable()) return;
  const message = `save ${SKILL_UI_SETTING_KEYS[name]} failed:`;
  try {
    // `invoke` returns a promise in Tauri; Promise.resolve keeps test doubles (which may
    // return undefined) from turning the mirror into a synchronous throw.
    void Promise.resolve(invoke('save_setting', { key: SKILL_UI_SETTING_KEYS[name], value }))
      .catch((error: unknown) => console.warn(LOG_PREFIX, message, error));
  } catch (error: unknown) {
    console.warn(LOG_PREFIX, message, error);
  }
}

/** 读取当前 localStorage 原始值（镜像写入用）。 */
export function readLocalSkillUiValue(name: SkillUiStoreName): string | null {
  if (!hasLocalStorage()) return null;
  try { return localStorage.getItem(SKILL_UI_LOCAL_KEYS[name]); }
  catch { return null; }
}
