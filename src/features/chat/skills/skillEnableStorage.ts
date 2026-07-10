/**
 * 用户显式 Skill 启用/停用覆盖（localStorage）
 *
 * 停用是技能的一等状态：停用后不进 schema 工具收集、不参与自动激活/手动选择，
 * UI 置灰但保留技能定义与文件（区别于删除）。
 * 存储模式完全仿照 skillTrustStorage：localStorage 持久化 + window CustomEvent 广播。
 */

import type { SkillDefinition } from './types';

const STORAGE_KEY = 'deep-student.skill-enable-overrides';

/** 停用状态变更广播事件名（detail: { skillId, disabled }） */
export const SKILL_ENABLED_CHANGED_EVENT = 'SKILL_ENABLED_CHANGED';

/** skillId -> true 表示已停用；无条目表示默认启用 */
type EnableOverrideMap = Record<string, boolean>;

function readMap(): EnableOverrideMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as EnableOverrideMap;
  } catch {
    return {};
  }
}

function writeMap(map: EnableOverrideMap): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** 该 skill 是否被用户停用。无覆盖时默认启用（返回 false）。 */
export function isSkillDisabled(skillId: string): boolean {
  return readMap()[skillId] === true;
}

/** 设置停用状态。disabled 为 false 时删除覆盖条目，回到默认启用。 */
export function setSkillDisabled(skillId: string, disabled: boolean): void {
  const map = readMap();
  if (disabled) {
    map[skillId] = true;
  } else {
    delete map[skillId];
  }
  writeMap(map);
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(SKILL_ENABLED_CHANGED_EVENT, { detail: { skillId, disabled } })
    );
  }
}

/**
 * 注册时给 skill 附加 disabled 标记快照。
 *
 * 注意：注册后用户可随时切换停用状态而不触发 registry 重载，
 * 运行时判断请优先调用 isSkillDisabled(skill.id) 获取最新值
 * （与 trust 体系的 resolveEffectiveTrustStatus 同理）。
 */
export function applyEnableOverride(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    disabled: isSkillDisabled(skill.id),
  };
}
