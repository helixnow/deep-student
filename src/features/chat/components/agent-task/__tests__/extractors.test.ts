/**
 * extractChanges 聚合数据源测试（P2 复审补全：mindmap/anki 来源）
 */

import { describe, expect, it } from 'vitest';

import { extractChanges, isChangeProducingTool } from '../extractors';
import type { Block } from '../../../core/types';

function toolBlock(overrides: Partial<Block>): Block {
  return {
    id: overrides.id ?? 'b1',
    messageId: 'm1',
    type: 'mcp_tool',
    status: 'success',
    createdAt: 0,
    ...overrides,
  } as Block;
}

describe('isChangeProducingTool（P2 数据源补全）', () => {
  it('mindmap_edit_nodes / chatanki_update_library_card 入列（含 builtin- 前缀）', () => {
    expect(isChangeProducingTool('builtin-mindmap_edit_nodes')).toBe(true);
    expect(isChangeProducingTool('mindmap_edit_nodes')).toBe(true);
    expect(isChangeProducingTool('builtin-chatanki_update_library_card')).toBe(true);
  });

  it('既有来源不回归', () => {
    expect(isChangeProducingTool('builtin-note_append')).toBe(true);
    expect(isChangeProducingTool('file_write')).toBe(true);
    expect(isChangeProducingTool('builtin-web_search')).toBe(false);
  });
});

describe('extractChanges（mindmap / anki 分支）', () => {
  it('mindmap_edit_nodes：kind=mindmap，标题取自 citation，openId=mindmap_id', () => {
    const changes = extractChanges([
      toolBlock({
        id: 'b-mm',
        toolName: 'builtin-mindmap_edit_nodes',
        toolInput: { mindmap_id: 'mm_123', operations: [] },
        toolOutput: {
          success: true,
          appliedCount: 3,
          versionId: 'v9',
          citation: '[思维导图:v9:数据并行框架]',
        },
      }),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'mindmap',
      action: 'update',
      label: '数据并行框架',
      openId: 'mm_123',
      target: 'mm_123',
    });
  });

  it('mindmap_edit_nodes：无 citation 时回退 mindmap_id', () => {
    const changes = extractChanges([
      toolBlock({
        toolName: 'builtin-mindmap_edit_nodes',
        toolInput: { mindmap_id: 'mm_9' },
        toolOutput: { success: true, appliedCount: 1 },
      }),
    ]);
    expect(changes[0]?.label).toBe('mm_9');
  });

  it('chatanki_update_library_card：kind=anki，label 含字段名，无打开目标', () => {
    const changes = extractChanges([
      toolBlock({
        toolName: 'builtin-chatanki_update_library_card',
        toolInput: { cardId: 'card-abcdef123456', fields: { front: '新正面', back: '新背面' } },
        toolOutput: { success: true },
      }),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('anki');
    expect(changes[0]?.action).toBe('update');
    expect(changes[0]?.label).toContain('card-abc');
    expect(changes[0]?.label).toContain('front/back');
    expect(changes[0]?.openId).toBeUndefined();
    expect(changes[0]?.target).toBeUndefined();
  });

  it('非 success 块不产生变更记录', () => {
    const changes = extractChanges([
      toolBlock({
        status: 'error',
        toolName: 'builtin-mindmap_edit_nodes',
        toolInput: { mindmap_id: 'mm_1' },
      }),
    ]);
    expect(changes).toHaveLength(0);
  });
});
