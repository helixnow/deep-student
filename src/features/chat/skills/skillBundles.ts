/**
 * Chat V2 - 技能 Bundles（组合）
 *
 * 把一组常一起使用的技能保存为命名组合，一键整组激活
 * （对标 Hermes 的 skill bundles / OpenClaw 的 multi-skill 叠加）。
 * 全部存于 localStorage，随导出/沉淀策略演进可迁移到 settings。
 */

export interface SkillBundle {
  id: string;
  name: string;
  skillIds: string[];
  createdAt: number;
}

const STORAGE_KEY = 'skills.bundles.v1';

/** 组合变化时派发的 window 事件 */
export const SKILL_BUNDLES_CHANGED_EVENT = 'SKILL_BUNDLES_CHANGED';

const MAX_BUNDLES = 32;
const MAX_SKILLS_PER_BUNDLE = 12;

function loadBundles(): SkillBundle[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is SkillBundle =>
        b &&
        typeof b.id === 'string' &&
        typeof b.name === 'string' &&
        Array.isArray(b.skillIds)
    );
  } catch {
    return [];
  }
}

function saveBundles(bundles: SkillBundle[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bundles));
    window.dispatchEvent(new CustomEvent(SKILL_BUNDLES_CHANGED_EVENT));
  } catch {
    // localStorage 不可用时静默降级
  }
}

/** 全部组合（返回副本） */
export function getSkillBundles(): SkillBundle[] {
  return loadBundles();
}

/**
 * 创建组合；同名组合会被替换（更新语义）。
 *
 * @returns 创建的组合，超限或参数非法时返回 null
 */
export function saveSkillBundle(name: string, skillIds: string[]): SkillBundle | null {
  const trimmedName = name.trim();
  const uniqueIds = [...new Set(skillIds)].slice(0, MAX_SKILLS_PER_BUNDLE);
  if (!trimmedName || uniqueIds.length === 0) return null;

  const bundles = loadBundles().filter((b) => b.name !== trimmedName);
  if (bundles.length >= MAX_BUNDLES) return null;

  const bundle: SkillBundle = {
    id: `bundle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: trimmedName,
    skillIds: uniqueIds,
    createdAt: Date.now(),
  };
  saveBundles([bundle, ...bundles]);
  return bundle;
}

/** 删除组合 */
export function deleteSkillBundle(bundleId: string): void {
  const bundles = loadBundles();
  const next = bundles.filter((b) => b.id !== bundleId);
  if (next.length !== bundles.length) {
    saveBundles(next);
  }
}
