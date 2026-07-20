/**
 * Chat V2 - 技能 requires 加载期门控
 *
 * 安装期的 requires.bins/env 探测只发生一次；本模块在技能加载/刷新时
 * 重新探测本机环境（在加载前检查本机环境与
 * requires_toolsets），结果用于：
 *
 * - `<available_skills>` 元数据：不满足 requires 的技能不再推荐给 LLM，
 *   并附缺失说明，避免模型加载注定失败的技能
 * - UI 可通过 getRequiresGate 查询缺失详情
 *
 * 手动激活不受门控（用户显式操作优先）。探测失败（如非 Tauri 环境）时
 * fail-open：视为满足，保持既有行为。
 */

import { invoke } from '@tauri-apps/api/core';
import type { SkillDefinition } from './types';

export interface SkillRequiresGate {
  /** requires 声明是否全部满足 */
  satisfied: boolean;
  /** 缺失的可执行依赖 */
  missingBins: string[];
  /** 缺失的环境变量 */
  missingEnv: string[];
}

interface SkillRequiresProbeResult {
  bins: Array<{ name: string; found: boolean }>;
  env: Array<{ name: string; set: boolean }>;
  invalid: string[];
  missing_count: number;
}

const LOG_PREFIX = '[SkillRequiresGating]';

/** skillId → 门控结果；未探测/无 requires 的技能不在表中 */
let gateCache = new Map<string, SkillRequiresGate>();

/**
 * 重新探测所有带 requires 声明的技能。
 *
 * @param skills 当前注册的全部技能（由调用方传入，避免与 registry 循环依赖）
 */
export async function refreshRequiresGates(skills: SkillDefinition[]): Promise<void> {
  const nextCache = new Map<string, SkillRequiresGate>();

  for (const skill of skills) {
    const bins = skill.requires?.bins ?? [];
    const env = skill.requires?.env ?? [];
    if (bins.length === 0 && env.length === 0) continue;

    try {
      const probe = await invoke<SkillRequiresProbeResult>('skill_probe_requires', {
        bins,
        env,
      });
      const missingBins = probe.bins.filter((b) => !b.found).map((b) => b.name);
      const missingEnv = probe.env.filter((e) => !e.set).map((e) => e.name);
      nextCache.set(skill.id, {
        satisfied: missingBins.length === 0 && missingEnv.length === 0,
        missingBins,
        missingEnv,
      });
    } catch (error) {
      // 非 Tauri 环境或命令失败：fail-open，不做门控
      console.warn(LOG_PREFIX, `probe failed for ${skill.id}:`, error);
    }
  }

  gateCache = nextCache;
}

/** 查询技能的 requires 门控结果；无 requires 或未探测时返回 undefined */
export function getRequiresGate(skillId: string): SkillRequiresGate | undefined {
  return gateCache.get(skillId);
}

/** requires 是否满足（无声明/未探测视为满足） */
export function isSkillRequiresSatisfied(skillId: string): boolean {
  return gateCache.get(skillId)?.satisfied ?? true;
}

/** 仅测试用：直接注入门控结果 */
export function __setRequiresGateForTest(skillId: string, gate: SkillRequiresGate | null): void {
  if (gate === null) {
    gateCache.delete(skillId);
  } else {
    gateCache.set(skillId, gate);
  }
}
