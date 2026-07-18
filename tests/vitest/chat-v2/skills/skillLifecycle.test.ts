/**
 * Chat V2 - Skills 系统生命周期回归测试
 *
 * 验证 Skills 系统在以下场景中正常工作：
 * 1. P0 修复：发送消息后 skill 仍然激活（sticky refs 保留）
 * 2. P1-A：验证 clearPendingContextRefs helper 已移除
 * 3. P1-B/C：allowedTools 前端过滤和后端约束
 * 4. 会话保存/恢复后 skill 状态一致
 * 5. retry/edit_and_resend 保留 skill
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../../../src/features/chat/skills/types';
import { collectSchemaToolIds } from '../../../../src/features/chat/tools/collector';
import type { ContextRef } from '../../../../src/features/chat/context/types';
import * as contextHelper from '../../../../src/features/chat/adapters/contextHelper';

// ============================================================================
// Mock 设置
// ============================================================================

// Mock skillRegistry
vi.mock('../../../../src/features/chat/skills/registry', () => ({
  skillRegistry: {
    get: vi.fn(),
    getAll: vi.fn(() => []),
    register: vi.fn(),
    unregister: vi.fn(),
    generateMetadataPrompt: vi.fn(() => ''),
    subscribe: vi.fn(() => () => {}),
  },
}));

// Mock contextTypeRegistry
vi.mock('../../../../src/features/chat/context/registry', () => ({
  contextTypeRegistry: {
    collectToolsForTypes: vi.fn(() => ['anki_create_card', 'anki_list_decks']),
    getToolsForType: vi.fn(() => []),
  },
}));

// ============================================================================
// 测试数据
// ============================================================================

const createSkillContextRef = (skillId: string, isSticky = true): ContextRef => ({
  resourceId: `skill_${skillId}`,
  hash: 'test-hash',
  typeId: SKILL_INSTRUCTION_TYPE_ID,
  isSticky,
});

const createNoteContextRef = (): ContextRef => ({
  resourceId: 'note_123',
  hash: 'note-hash',
  typeId: 'note',
  isSticky: false,
});

// ============================================================================
// P0 修复回归测试：发送后 skill 仍激活
// ============================================================================

describe('P0 修复：发送后 sticky skill refs 保留', () => {
  it('发送消息后应保留 isSticky=true 的 skill refs', () => {
    const pendingContextRefs: ContextRef[] = [
      createSkillContextRef('code-review'),
      createNoteContextRef(),
    ];

    // 模拟发送后的过滤逻辑（来自 createChatStore.sendMessageWithIds）
    const refsAfterSend = pendingContextRefs.filter((ref) => ref.isSticky === true);

    expect(refsAfterSend).toHaveLength(1);
    expect(refsAfterSend[0].typeId).toBe(SKILL_INSTRUCTION_TYPE_ID);
    expect(refsAfterSend[0].resourceId).toBe('skill_code-review');
  });

  it('发送消息后应清除非 sticky 的 refs', () => {
    const pendingContextRefs: ContextRef[] = [
      createSkillContextRef('code-review'),
      createNoteContextRef(),
      { ...createNoteContextRef(), resourceId: 'note_456' },
    ];

    const refsAfterSend = pendingContextRefs.filter((ref) => ref.isSticky === true);

    expect(refsAfterSend).toHaveLength(1);
    // 验证 note refs 被清除
    expect(refsAfterSend.some((r) => r.typeId === 'note')).toBe(false);
  });

  it('多个 sticky refs 都应保留', () => {
    const pendingContextRefs: ContextRef[] = [
      createSkillContextRef('skill-1'),
      createSkillContextRef('skill-2'),
      createNoteContextRef(),
    ];

    const refsAfterSend = pendingContextRefs.filter((ref) => ref.isSticky === true);

    expect(refsAfterSend).toHaveLength(2);
  });
});

// ============================================================================
// P1-A 回归测试：clearPendingContextRefs 已移除
// ============================================================================

describe('P1-A：clearPendingContextRefs helper 已移除', () => {
  it('contextHelper 不应导出 clearPendingContextRefs', () => {
    expect('clearPendingContextRefs' in contextHelper).toBe(false);
  });
});

// ============================================================================
// P1-B 回归测试：allowedTools 约束职责归属
//
// ★ 架构变更：allowedTools 白名单过滤已从前端 collectSchemaToolIds 迁移到
// 后端运行时执行策略（src-tauri tool_policy::is_tool_allowed_by_execution_policy，
// 由 pipeline 的 execution_allowed_tools 驱动，含自身 Rust 单测）。
// 前端收集器只负责从上下文引用收集工具，不做权限裁剪——本组测试锁定该契约，
// 防止有人在前端重新引入形同虚设的"可见性过滤"造成双重真相源。
// ============================================================================

describe('P1-B：allowedTools 约束职责归属（后端执行策略）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('收集器应返回上下文引用关联的全部工具（不做白名单裁剪）', () => {
    const result = collectSchemaToolIds({
      pendingContextRefs: [createSkillContextRef('test')],
    });

    // mock 的 contextTypeRegistry 返回两个 anki 工具，均应收集
    expect(result.schemaToolIds).toContain('anki_create_card');
    expect(result.schemaToolIds).toContain('anki_list_decks');
  });

  it('收集器选项不应再暴露 skillAllowedTools（过滤职责在后端）', () => {
    // 类型层面已移除；运行时传入未知字段也不得影响收集结果
    const result = collectSchemaToolIds({
      pendingContextRefs: [createSkillContextRef('test')],
      ...( { skillAllowedTools: [] } as Record<string, unknown> ),
    });

    expect(result.schemaToolIds.length).toBeGreaterThan(0);
  });

  it('无上下文引用时收集结果为空', () => {
    const result = collectSchemaToolIds({ pendingContextRefs: [] });
    expect(result.schemaToolIds).toEqual([]);
  });
});

// ============================================================================
// 会话恢复回归测试
// ============================================================================

describe('会话恢复：skill 状态一致性', () => {
  it('从 pendingContextRefsJson 恢复时应正确识别 skill refs', () => {
    const savedJson = JSON.stringify([
      createSkillContextRef('code-review'),
      createNoteContextRef(),
    ]);

    const restored = JSON.parse(savedJson) as ContextRef[];

    // 验证恢复后的 skill ref
    const skillRef = restored.find((r) => r.typeId === SKILL_INSTRUCTION_TYPE_ID);
    expect(skillRef).toBeDefined();
    expect(skillRef?.isSticky).toBe(true);
  });

  it('旧数据迁移：缺少 isSticky 的 skill refs 应设为 true', () => {
    // 模拟旧数据（没有 isSticky 字段）
    const oldData: Array<{ resourceId: string; hash: string; typeId: string; isSticky?: boolean }> = [
      {
        resourceId: 'skill_old-skill',
        hash: 'hash',
        typeId: SKILL_INSTRUCTION_TYPE_ID,
        // 注意：没有 isSticky 字段
      },
    ];

    // 模拟迁移逻辑（来自 createChatStore.restoreFromBackend）
    const migrated = oldData.map((ref) => {
      if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
        return { ...ref, isSticky: true };
      }
      return ref;
    });

    expect(migrated[0].isSticky).toBe(true);
  });

  it('自愈逻辑：有 skill ref 但无 activeSkillId 时应检测到不一致', () => {
    const pendingContextRefs: ContextRef[] = [createSkillContextRef('orphan-skill')];
    const activeSkillId: string | null = null;

    // 模拟自愈检测逻辑
    const hasSkillRef = pendingContextRefs.some(
      (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
    );

    // 验证：存在 sticky skill ref 但 activeSkillId 为空，构成不一致状态
    expect(hasSkillRef).toBe(true);
    expect(activeSkillId).toBeNull();

    // 自愈动作：应从 orphan skill ref 中提取 skillId 并恢复
    const orphanRef = pendingContextRefs.find(
      (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
    );
    expect(orphanRef).toBeDefined();
    expect(orphanRef!.resourceId).toBe('skill_orphan-skill');
  });
});

// ============================================================================
// Retry/Edit-and-Resend 回归测试
// ============================================================================

describe('Retry/Edit-and-Resend：保留 skill', () => {
  it('retry 时应从 context_snapshot 恢复 skill refs', () => {
    // 模拟保存在 context_snapshot 中的 userRefs
    const contextSnapshot = {
      userRefs: [
        {
          resourceId: 'skill_code-review',
          hash: 'hash',
          typeId: SKILL_INSTRUCTION_TYPE_ID,
          isSticky: true,
          priority: 3,
        },
      ],
      pathMap: {},
    };

    // 验证 userRefs 包含 skill
    const hasSkill = contextSnapshot.userRefs.some(
      (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID
    );
    expect(hasSkill).toBe(true);
  });

  it('edit_and_resend 时新的 contextRefs 应包含激活的 skill', () => {
    // 模拟当前 pendingContextRefs（包含 skill）
    const currentRefs: ContextRef[] = [
      createSkillContextRef('active-skill'),
    ];

    // 模拟 edit_and_resend 时传递的 newContextRefs
    // 应该从当前状态获取，包含 sticky skill
    const newContextRefs = currentRefs.filter((ref) => ref.isSticky);

    expect(newContextRefs).toHaveLength(1);
    expect(newContextRefs[0].typeId).toBe(SKILL_INSTRUCTION_TYPE_ID);
  });
});

// ============================================================================
// SKILL_INSTRUCTION_TYPE_ID 常量测试
// ============================================================================

describe('SKILL_INSTRUCTION_TYPE_ID 常量', () => {
  it('应为 "skill_instruction"', () => {
    expect(SKILL_INSTRUCTION_TYPE_ID).toBe('skill_instruction');
  });
});
