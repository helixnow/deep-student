/**
 * 技能 localStorage 覆盖状态订阅 Hooks
 *
 * 把 SkillSelector 等组件里手写的 setXxxTick 强刷模式收敛为声明式 hook：
 * 订阅对应 window CustomEvent，返回可直接用于渲染 / memo 依赖的状态。
 * 底层存储仍是各 storage 模块（skillEnableStorage / skillTrustStorage /
 * skillUsageStats / skillBundles），hook 只负责订阅与失效。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  isSkillDisabled,
  setSkillDisabled,
  SKILL_ENABLED_CHANGED_EVENT,
} from '../skillEnableStorage';
import {
  setSkillTrustOverride,
  SKILL_TRUST_CHANGED_EVENT,
  type SkillTrustOverride,
} from '../skillTrustStorage';
import { SKILL_USAGE_CHANGED_EVENT } from '../skillUsageStats';
import {
  getSkillBundles,
  saveSkillBundle,
  deleteSkillBundle,
  SKILL_BUNDLES_CHANGED_EVENT,
  type SkillBundle,
} from '../skillBundles';

/**
 * 订阅一个 window 事件，返回自增修订号。
 * 修订号本身没有语义，仅用作 useMemo/useCallback 依赖驱动重算
 * （对应存储是 localStorage 同步 getter，无法直接做状态快照订阅的场景）。
 */
export function useWindowEventRevision(eventType: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((v) => v + 1);
    window.addEventListener(eventType, bump);
    return () => window.removeEventListener(eventType, bump);
  }, [eventType]);
  return revision;
}

export interface UseSkillEnableOverridesReturn {
  /** 停用覆盖修订号（变更时自增，可作为 memo 依赖） */
  revision: number;
  /** 该技能是否被用户停用（实时读取最新覆盖） */
  isDisabled: (skillId: string) => boolean;
  /** 设置停用状态（内部广播事件，订阅方自动刷新） */
  setDisabled: (skillId: string, disabled: boolean) => void;
}

/** 订阅技能启用/停用覆盖 */
export function useSkillEnableOverrides(): UseSkillEnableOverridesReturn {
  const revision = useWindowEventRevision(SKILL_ENABLED_CHANGED_EVENT);
  const isDisabled = useCallback(
    (skillId: string) => isSkillDisabled(skillId),
    // revision 变化时刷新回调身份，促使依赖它的 memo 重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision]
  );
  const setDisabled = useCallback((skillId: string, disabled: boolean) => {
    setSkillDisabled(skillId, disabled);
  }, []);
  return { revision, isDisabled, setDisabled };
}

export interface UseSkillTrustReturn {
  /** 信任覆盖修订号（变更时自增，用于驱动 resolveEffectiveTrustStatus 重算） */
  revision: number;
  /** 设置信任覆盖（storage 层负责持久化并广播事件） */
  setTrust: (skillId: string, trust: SkillTrustOverride | null) => Promise<void>;
}

/** 订阅技能信任覆盖 */
export function useSkillTrust(): UseSkillTrustReturn {
  const revision = useWindowEventRevision(SKILL_TRUST_CHANGED_EVENT);
  const setTrust = useCallback(
    async (skillId: string, trust: SkillTrustOverride | null) => {
      await setSkillTrustOverride(skillId, trust);
    },
    []
  );
  return { revision, setTrust };
}

/** 订阅技能使用遥测变更（排序失效用） */
export function useSkillUsageRevision(): number {
  return useWindowEventRevision(SKILL_USAGE_CHANGED_EVENT);
}

export interface UseSkillBundlesReturn {
  bundles: SkillBundle[];
  saveBundle: typeof saveSkillBundle;
  deleteBundle: typeof deleteSkillBundle;
}

/** 订阅技能组合（Bundles）列表，返回实时快照与操作方法 */
export function useSkillBundles(): UseSkillBundlesReturn {
  const [bundles, setBundles] = useState<SkillBundle[]>(() => getSkillBundles());
  useEffect(() => {
    const sync = () => setBundles(getSkillBundles());
    window.addEventListener(SKILL_BUNDLES_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SKILL_BUNDLES_CHANGED_EVENT, sync);
  }, []);
  return { bundles, saveBundle: saveSkillBundle, deleteBundle: deleteSkillBundle };
}
