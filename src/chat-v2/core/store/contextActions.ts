/**
 * Chat V2 - 上下文引用 Actions
 *
 * 实现统一上下文注入系统的 Store Actions
 *
 * @see 16-统一上下文注入系统架构设计.md 第六章 Store 扩展
 */

import type { ContextRef } from '../../context/types';
import type { ResourceInjectModes } from '../../context/vfsRefTypes';
import { contextTypeRegistry } from '../../context/registry';
import type { ChatStoreState, SetState, GetState } from './types';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * 创建上下文引用相关的 Actions
 *
 * @param set Zustand set 函数
 * @param get Zustand get 函数
 * @returns Context Actions 对象
 */
export function createContextActions(
  set: SetState,
  get: GetState
) {
  return {
    /**
     * 添加上下文引用
     *
     * 【原子性设计】使用单一的 set() 调用确保去重逻辑的原子性，
     * 避免 get() 和 set() 之间的时间窗口导致的数据竞争。
     *
     * 检查重复（相同 resourceId）：如果已存在，则更新 hash；否则添加新引用
     */
    addContextRef: (ref: ContextRef): void => {
      // 【原子性保证】将所有逻辑放在 set() 回调内部执行
      // Zustand 的 set() 回调是同步执行的，确保整个检查-更新过程的原子性
      set((state: ChatStoreState) => {
        // 在回调内部执行去重检查，避免竞态条件
        const existingIndex = state.pendingContextRefs.findIndex(
          (r) => r.resourceId === ref.resourceId
        );

        if (existingIndex !== -1) {
          // 已存在相同 resourceId 的引用
          const existingRef = state.pendingContextRefs[existingIndex];
          const mergedRef = { ...existingRef, ...ref };
          const injectModesChanged =
            JSON.stringify(existingRef.injectModes ?? null) !== JSON.stringify(ref.injectModes ?? null);
          const hasMeaningfulChange =
            existingRef.hash !== ref.hash
            || existingRef.typeId !== ref.typeId
            || existingRef.displayName !== ref.displayName
            || existingRef.isSticky !== ref.isSticky
            || existingRef.skillId !== ref.skillId
            || injectModesChanged;

          if (hasMeaningfulChange) {
            // 引用有差异，更新完整字段（不仅是 hash）
            console.log(
              '[ChatStore] addContextRef: 更新引用（去重）',
              ref.resourceId,
              `${existingRef.hash.slice(0, 8)}... → ${ref.hash.slice(0, 8)}...`
            );

            // 返回新状态：更新完整引用，避免 displayName/injectModes 等字段滞后
            return {
              pendingContextRefs: state.pendingContextRefs.map((r, idx) =>
                idx === existingIndex ? mergedRef : r
              ),
              pendingContextRefsDirty: true,
            };
          } else {
            // hash 相同，完全重复，跳过
            console.log(
              '[ChatStore] addContextRef: 相同引用已存在（跳过）',
              ref.resourceId
            );

            // 返回空对象，不修改状态，避免触发不必要的重渲染
            return {};
          }
        } else {
          // 不存在相同 resourceId 的引用，添加新引用
          console.log(
            '[ChatStore] addContextRef: 添加新引用',
            ref.typeId,
            ref.resourceId
          );

          // 返回新状态：添加引用
          return {
            pendingContextRefs: [...state.pendingContextRefs, ref],
            pendingContextRefsDirty: true,
          };
        }
      });
    },

    /**
     * 移除上下文引用
     * 
     * 🔧 多技能激活修复：如果移除的是技能类型的 ContextRef，
     * 同步从 activeSkillIds 中移除对应的 skillId
     * 
     * ★ 2026-01-25 修复：使用 ContextRef.skillId 同步更新，不再异步查找
     */
    removeContextRef: (resourceId: string): void => {
      // 🔧 原子性修复：将查找逻辑移入 set() 回调内部
      // 避免 get() 和 set() 之间的时间窗口导致竞态
      set((s: ChatStoreState) => {
        const removedRef = s.pendingContextRefs.find(
          (r) => r.resourceId === resourceId
        );

        if (!removedRef) {
          // ref 已不存在（可能被其他操作先移除了），无需修改状态
          return {};
        }

        const newRefs = s.pendingContextRefs.filter(
          (r) => r.resourceId !== resourceId
        );

        // 如果是技能类型且有 skillId，同步更新 activeSkillIds
        if (removedRef.typeId === SKILL_INSTRUCTION_TYPE_ID && removedRef.skillId) {
          console.log('[ChatStore] removeContextRef: sync removed skill', resourceId, removedRef.skillId);
          return {
            pendingContextRefs: newRefs,
            activeSkillIds: s.activeSkillIds.filter(id => id !== removedRef.skillId),
            pendingContextRefsDirty: true,
            skillStateJson: null,
          };
        }

        console.log('[ChatStore] removeContextRef:', resourceId);
        return {
          pendingContextRefs: newRefs,
          pendingContextRefsDirty: true,
          skillStateJson: null,
        };
      });
    },

    /**
     * 清空上下文引用
     * 支持按 typeId 过滤
     * 
     * 🔧 多技能激活修复：如果清空的是技能类型，同步清空 activeSkillIds
     * ★ 2026-01-25 修复：使用原子更新，避免两次 set() 调用
     */
    clearContextRefs: (typeId?: string): void => {
      if (typeId) {
        // 只清空指定类型
        const isSkillType = typeId === SKILL_INSTRUCTION_TYPE_ID;
        
        // 🔧 原子更新：一次 set() 完成所有状态变更
        set((s: ChatStoreState) => ({
          pendingContextRefs: s.pendingContextRefs.filter(
            (r) => r.typeId !== typeId
          ),
          pendingContextRefsDirty: true,
          // 如果是技能类型，同时清空 activeSkillIds
          ...(isSkillType ? { activeSkillIds: [], skillStateJson: null } : {}),
        }));
        
        console.log('[ChatStore] clearContextRefs (type):', typeId, isSkillType ? '(+ activeSkillIds)' : '');
      } else {
        // 清空所有，同时清空 activeSkillIds
        set({
          pendingContextRefs: [],
          pendingContextRefsDirty: true,
          activeSkillIds: [],
          skillStateJson: null,
        } as Partial<ChatStoreState>);
        console.log('[ChatStore] clearContextRefs: all (including activeSkillIds)');
      }
    },

    /**
     * 按类型获取上下文引用
     */
    getContextRefsByType: (typeId: string): ContextRef[] => {
      const state = get();
      return state.pendingContextRefs.filter((r) => r.typeId === typeId);
    },

    /**
     * 获取启用的工具 ID 列表
     * 根据 pendingContextRefs 中的类型收集关联工具
     */
    getEnabledTools: (): string[] => {
      const state = get();
      
      // 收集所有类型 ID（去重）
      const typeIds = [...new Set(state.pendingContextRefs.map((r) => r.typeId))];
      
      // 使用 Registry 收集关联工具
      return contextTypeRegistry.collectToolsForTypes(typeIds);
    },

    /**
     * 更新上下文引用的注入模式
     *
     * 用于在用户修改附件的注入模式时更新对应的 ContextRef
     *
     * @param resourceId 资源 ID
     * @param injectModes 注入模式配置
     */
    updateContextRefInjectModes: (resourceId: string, injectModes: ResourceInjectModes | undefined): void => {
      set((state: ChatStoreState) => {
        const existingIndex = state.pendingContextRefs.findIndex(
          (r) => r.resourceId === resourceId
        );

        if (existingIndex === -1) {
          console.warn(
            '[ChatStore] updateContextRefInjectModes: 未找到引用',
            resourceId
          );
          return {};
        }

        console.log(
          '[ChatStore] updateContextRefInjectModes:',
          resourceId,
          injectModes
        );

        return {
          pendingContextRefs: state.pendingContextRefs.map((r, idx) =>
            idx === existingIndex ? { ...r, injectModes } : r
          ),
          pendingContextRefsDirty: true,
        };
      });
    },
  };
}

/**
 * Context Actions 类型定义
 */
export type ContextActions = ReturnType<typeof createContextActions>;
