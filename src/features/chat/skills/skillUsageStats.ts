/**
 * Chat V2 - 技能使用遥测（本地）
 *
 * 记录每个技能的手动激活次数、工具加载次数与最近使用时间，全部存于
 * localStorage，不上报任何远端。用途：
 *
 * - 技能选择器按使用频次排序（收藏 > 默认 > 常用）
 * - 管理页展示使用情况，辅助用户清理低频技能
 * - 为 agent 自创建/沉淀策略提供依据（高频重复的工作流值得沉淀为技能）
 */

const STORAGE_KEY = 'skills.usage.stats.v1';

/** 使用记录变化时派发的 window 事件 */
export const SKILL_USAGE_CHANGED_EVENT = 'SKILL_USAGE_CHANGED';

export interface SkillUsageRecord {
  /** 手动/斜杠/默认激活次数 */
  activations: number;
  /** 工具调用（load_skills / 渐进披露）加载次数 */
  toolLoads: number;
  /** 最近一次使用（毫秒时间戳） */
  lastUsedAt: number;
}

type UsageMap = Record<string, SkillUsageRecord>;

function loadStats(): UsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as UsageMap) : {};
  } catch {
    return {};
  }
}

function saveStats(stats: UsageMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    window.dispatchEvent(new CustomEvent(SKILL_USAGE_CHANGED_EVENT));
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级
  }
}

function bump(skillId: string, field: 'activations' | 'toolLoads'): void {
  if (!skillId) return;
  const stats = loadStats();
  const record = stats[skillId] ?? { activations: 0, toolLoads: 0, lastUsedAt: 0 };
  record[field] += 1;
  record.lastUsedAt = Date.now();
  stats[skillId] = record;
  saveStats(stats);
}

/** 记录一次显式激活（面板点击 / 斜杠命令 / 默认技能注入） */
export function recordSkillActivation(skillId: string): void {
  bump(skillId, 'activations');
}

/** 记录一次工具调用加载（load_skills / 依赖自动加载） */
export function recordSkillToolLoad(skillId: string): void {
  bump(skillId, 'toolLoads');
}

/** 查询单个技能的使用记录 */
export function getSkillUsage(skillId: string): SkillUsageRecord | undefined {
  return loadStats()[skillId];
}

/** 全量使用记录（返回副本） */
export function getAllSkillUsage(): UsageMap {
  return loadStats();
}

/** 综合使用分（激活权重高于工具加载），用于排序 */
export function getSkillUsageScore(skillId: string): number {
  const record = loadStats()[skillId];
  if (!record) return 0;
  return record.activations * 3 + record.toolLoads;
}

/** 删除技能时清理记录 */
export function clearSkillUsage(skillId: string): void {
  const stats = loadStats();
  if (skillId in stats) {
    delete stats[skillId];
    saveStats(stats);
  }
}
