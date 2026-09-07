/**
 * Chat V2 - 技能使用遥测（本地）
 *
 * 记录每个技能的手动激活次数、工具加载次数与最近使用时间，全部存于
 * localStorage，不上报任何远端。用途：
 *
 * - 技能选择器按使用频次排序（收藏 > 默认 > 常用）
 * - 管理页展示使用情况，辅助用户清理低频技能
 * - 为 agent 自创建/沉淀策略提供依据（高频重复的工作流值得沉淀为技能）
 *
 * G09-P0 后端账目镜像：激活事件在写完 localStorage 后 fire-and-forget 同步到
 * 后端 `skill_usage` 表（chat_v2 库，命令 chat_v2_record_skill_activation）。
 * 仅激活走前端镜像——工具加载（toolLoads）由后端轮末钩子从 load_skills 工具
 * 结果权威聚合写入（见 src-tauri/src/chat_v2/skill_usage.rs），前端再写会双计。
 * 镜像失败静默：本地计数是快路径，后端账目可缺失、不可阻塞。
 */

const STORAGE_KEY = 'skills.usage.stats.v1';

/** G09-P0：后端账目镜像命令（chat_v2::skill_usage） */
const RECORD_ACTIVATION_COMMAND = 'chat_v2_record_skill_activation';

/**
 * 把一次显式激活镜像到后端 skill_usage 表（fire-and-forget，失败静默）。
 *
 * sessionId 在调用时惰性解析（sessionManager 动态导入，避免模块初始化顺序
 * 耦合）；解析不到会话时传 null，后端以未知会话落账。
 */
function mirrorActivationToBackend(skillId: string): void {
  void (async () => {
    try {
      const [{ invoke }, { getSessionManager }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('../core/session/sessionManager'),
      ]);
      const sessionId = getSessionManager().getCurrentSessionId();
      await invoke(RECORD_ACTIVATION_COMMAND, { skillId, sessionId: sessionId ?? null });
    } catch {
      // 后端账目镜像失败静默降级（非 Tauri 环境 / 早期启动 / 命令缺失）
    }
  })();
}

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
  // G09-P0：localStorage 快路径完成后镜像后端账目（fire-and-forget，失败静默）
  mirrorActivationToBackend(skillId);
}

/**
 * 记录一次工具调用加载（load_skills / 依赖自动加载）
 *
 * 仅本地计数：后端 tool_load 账目由轮末钩子从 load_skills 工具结果权威写入，
 * 这里不做后端镜像（避免双计）。
 */
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
