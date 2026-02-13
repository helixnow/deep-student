/**
 * Chat V2 - Skill Actions
 *
 * 实现 Skills 系统的 Store Actions
 *
 * 设计说明：
 * - 复用 contextActions 的 addContextRef / removeContextRef 方法
 * - 支持同时激活多个 skill（多选模式）
 * - skill 内容通过 ContextRef 注入到对话上下文
 */

import i18n from 'i18next';
import type { ChatStoreState, SetState, GetState } from './types';
import type { ContextRef } from '../../context/types';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '../../skills/utils';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillActions]';

// ============================================================================
// Skill Actions 创建
// ============================================================================

/**
 * 创建 Skill 相关的 Actions
 *
 * @param set Zustand set 函数
 * @param get Zustand get 函数
 * @returns Skill Actions 对象
 */
export function createSkillActions(
  set: SetState,
  get: GetState
) {
  // 🔧 并发锁绑定到当前 store 实例（而非模块级全局变量）
  // 避免多个会话 store 共享同一把锁导致互相阻塞
  let _activating = false;

  return {
    /**
     * 激活 Skill（多选模式：添加到已激活列表）
     *
     * 通过 skillRegistry 获取 skill 内容，创建 ContextRef 并添加到 pendingContextRefs
     *
     * @param skillId Skill ID
     * @returns Promise<boolean> 是否激活成功
     */
    activateSkill: async (skillId: string): Promise<boolean> => {
      // 并发锁：防止快速连续点击导致状态不一致（per-store 实例）
      if (_activating) {
        console.warn(LOG_PREFIX, 'Activation in progress, ignoring duplicate request');
        return false;
      }
      _activating = true;

      try {
        const state = get();

        // 检查是否已激活
        if (state.activeSkillIds.includes(skillId)) {
          console.log(LOG_PREFIX, `Skill already activated, skipping: ${skillId}`);
          return true;
        }

        // 动态导入避免循环依赖
        const { skillRegistry } = await import('../../skills/registry');
        const { createResourceFromSkill } = await import('../../skills/resourceHelper');

        // 检查 skill 是否存在
        const skill = skillRegistry.get(skillId);
        if (!skill) {
          console.warn(LOG_PREFIX, `Skill not found: ${skillId}`);
          // 🔧 用户可见通知（避免静默失败）
          try {
            const { showGlobalNotification } = await import('../../../components/UnifiedNotification');
            showGlobalNotification('warning', i18n.t('skills:errors.skillNotFoundNotification', { id: skillId }));
          } catch { /* notification optional */ }
          return false;
        }

        // 创建资源和 ContextRef
        const contextRef = await createResourceFromSkill(skill);
        if (!contextRef) {
          console.error(LOG_PREFIX, `Failed to create skill resource: ${skillId}`);
          try {
            const { showGlobalNotification } = await import('../../../components/UnifiedNotification');
            const localizedName = getLocalizedSkillName(skill.id, skill.name, i18n.t.bind(i18n));
            showGlobalNotification('error', i18n.t('skills:errors.activateFailedRetry', { name: localizedName }));
          } catch { /* notification optional */ }
          return false;
        }

        // 🔧 原子化状态更新：将 addContextRef 和 activeSkillIds 在同一个 set() 中完成
        // 避免两步更新之间的中间状态不一致
        set((s: ChatStoreState) => {
          // 再次检查防止并发重复添加
          if (s.activeSkillIds.includes(skillId)) {
            return {};
          }
          return {
            pendingContextRefs: [...s.pendingContextRefs, contextRef],
            activeSkillIds: [...s.activeSkillIds, skillId],
          };
        });

        // 🆕 激活技能时自动加载 embeddedTools，避免 load_skills 白名单死锁
        if ((skill.embeddedTools && skill.embeddedTools.length > 0)
          || (skill.dependencies && skill.dependencies.length > 0)) {
          try {
            const { loadSkillsToSession, isSkillLoaded } = await import('../../skills/progressiveDisclosure');
            if (!isSkillLoaded(state.sessionId, skillId)) {
              const loadResult = loadSkillsToSession(state.sessionId, [skillId]);
              console.log(LOG_PREFIX, `Auto-loaded skill tools for activation: ${skillId}`, {
                loaded: loadResult.loaded.length,
                alreadyLoaded: loadResult.alreadyLoaded.length,
                notFound: loadResult.notFound.length,
              });
            }
          } catch (error: unknown) {
            console.warn(LOG_PREFIX, 'Auto-load embedded tools failed:', error);
          }
        }

        console.log(LOG_PREFIX, `Activated skill: ${skill.name} (${skillId})`);
        return true;
      } catch (error: unknown) {
        console.error(LOG_PREFIX, `Failed to activate skill:`, error);
        return false;
      } finally {
        _activating = false;
      }
    },

    /**
     * 取消激活单个 Skill
     *
     * ★ 2026-01-25 修复：直接使用 ContextRef.skillId 同步查找，
     * 不再异步调用 resourceStoreApi.get()
     * 
     * ★ removeContextRef 已经会同步更新 activeSkillIds，
     * 无需额外手动更新
     *
     * @param skillId 要取消的 Skill ID，如果不传则取消所有
     */
    deactivateSkill: (skillId?: string): void => {
      const state = get();

      if (skillId) {
        // 🔧 直接使用 ref.skillId 同步查找，不再异步调用 API
        const targetRef = state.pendingContextRefs.find(
          (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.skillId === skillId
        );

        if (targetRef) {
          // removeContextRef 内部会同步更新 activeSkillIds
          state.removeContextRef(targetRef.resourceId);
          console.log(LOG_PREFIX, `Deactivated skill: ${skillId}`);
        } else {
          // 🔧 兜底：ref 不存在但 activeSkillIds 中有，清理脏数据
          const currentState = get();
          if (currentState.activeSkillIds.includes(skillId)) {
            set((s: ChatStoreState) => ({
              activeSkillIds: s.activeSkillIds.filter(id => id !== skillId),
            }));
            console.warn(LOG_PREFIX, `Cleaning stale data: activeSkillIds contains entry without matching ref: ${skillId}`);
          }
        }
      } else {
        // 取消所有 skill（clearContextRefs 已会同步清空 activeSkillIds）
        state.clearContextRefs(SKILL_INSTRUCTION_TYPE_ID);
        console.log(LOG_PREFIX, 'Deactivated all skills');
      }
    },

    /**
     * 获取当前激活的 Skill ID 列表
     *
     * @returns 当前激活的 Skill ID 数组
     */
    getActiveSkillIds: (): string[] => {
      return get().activeSkillIds ?? [];
    },

    /**
     * 检查是否有激活的 Skill（纯查询，无副作用）
     *
     * ★ 修复：移除自愈逻辑（getter 中调用 set() 会导致 React 渲染循环）
     * 自愈逻辑已提取到 repairSkillState()，需在明确入口点显式调用
     *
     * @returns 是否有激活的 skill
     */
    hasActiveSkill: (): boolean => {
      const state = get();
      const hasSkillRef = state.pendingContextRefs.some(
        (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
      );
      return state.activeSkillIds.length > 0 && hasSkillRef;
    },

    /**
     * 修复 activeSkillIds 与 pendingContextRefs 的不一致状态
     *
     * ★ 从 hasActiveSkill 中提取的自愈逻辑，避免 getter 产生副作用
     * 应在明确的入口点调用：会话恢复完成后、发送消息前等
     */
    repairSkillState: (): void => {
      const state = get();
      const hasSkillRef = state.pendingContextRefs.some(
        (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
      );

      if (state.activeSkillIds.length > 0 && !hasSkillRef) {
        // activeSkillIds 存在但没有对应的 skill ref → 清除 activeSkillIds
        console.warn('[SkillActions] repairSkillState: activeSkillIds exist but no ref, clearing');
        set({ activeSkillIds: [] } as Partial<ChatStoreState>);
      }
    },

    /**
     * 检查指定 Skill 是否已激活
     *
     * @param skillId Skill ID
     * @returns 是否已激活
     */
    isSkillActive: (skillId: string): boolean => {
      return get().activeSkillIds.includes(skillId);
    },

    /**
     * 获取当前激活的所有 Skill 信息
     *
     * @returns Skill 元数据数组
     */
    getActiveSkillsInfo: async (): Promise<Array<{
      id: string;
      name: string;
      description: string;
      allowedTools?: string[];
    }>> => {
      const state = get();
      const skillIds = state.activeSkillIds;

      if (skillIds.length === 0) {
        return [];
      }

      // 动态导入
      const { skillRegistry } = await import('../../skills/registry');
      
      const results: Array<{
        id: string;
        name: string;
        description: string;
        allowedTools?: string[];
      }> = [];

      for (const skillId of skillIds) {
        const skill = skillRegistry.get(skillId);
        if (skill) {
          results.push({
            id: skill.id,
            name: getLocalizedSkillName(skill.id, skill.name, i18n.t.bind(i18n)),
            description: getLocalizedSkillDescription(skill.id, skill.description, i18n.t.bind(i18n)),
            allowedTools: skill.allowedTools ?? skill.tools,
          });
        }
      }

      return results;
    },
  };
}

/**
 * Skill Actions 类型定义
 */
export type SkillActions = ReturnType<typeof createSkillActions>;
