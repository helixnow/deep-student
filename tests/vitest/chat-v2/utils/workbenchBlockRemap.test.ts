/**
 * ACR R2-05 — workbenchBlockRemap 单元测试
 */
import { describe, expect, it } from 'vitest';
import {
  isWorkbenchOpsToolName,
  isWorkbenchToolName,
  remapWorkbenchBlockType,
  resolveWorkbenchRunId,
  stripToolNamePrefix,
} from '@/features/chat/utils/workbenchBlockRemap';
import { convertBackendBlock } from '@/features/chat/adapters/types';

describe('workbenchBlockRemap', () => {
  it('strips builtin-/mcp prefixes', () => {
    expect(stripToolNamePrefix('builtin-workbench_open_app')).toBe('workbench_open_app');
    expect(stripToolNamePrefix('mcp.tools.workbench_list_windows')).toBe('workbench_list_windows');
  });

  it('detects workbench tools', () => {
    expect(isWorkbenchToolName('builtin-workbench_close_window')).toBe(true);
    expect(isWorkbenchToolName('builtin-todo_create')).toBe(false);
  });

  it('R3-01：域委托写工具也视为 workbench_ops', () => {
    expect(isWorkbenchOpsToolName('builtin-note_append')).toBe(true);
    expect(isWorkbenchOpsToolName('builtin-mindmap_edit_nodes')).toBe(true);
    expect(isWorkbenchOpsToolName('builtin-note_read')).toBe(false);
    expect(remapWorkbenchBlockType('mcp_tool', 'builtin-note_append')).toBe(
      'workbench_ops'
    );
    expect(remapWorkbenchBlockType('mcp_tool', 'builtin-mindmap_edit_nodes')).toBe(
      'workbench_ops'
    );
  });

  it('remaps mcp_tool + workbench_* → workbench_ops', () => {
    expect(remapWorkbenchBlockType('mcp_tool', 'builtin-workbench_open_app')).toBe('workbench_ops');
    expect(remapWorkbenchBlockType('workbench_ops', 'builtin-workbench_open_app')).toBe(
      'workbench_ops'
    );
    expect(remapWorkbenchBlockType('mcp_tool', 'builtin-todo_create')).toBe('mcp_tool');
  });

  it('resolveWorkbenchRunId prefers ledger-alive id', () => {
    const block = { id: 'blk_1', toolCallId: 'call_1' };
    expect(resolveWorkbenchRunId(block, (id) => id === 'blk_1')).toBe('blk_1');
    expect(resolveWorkbenchRunId(block, (id) => id === 'call_1')).toBe('call_1');
    expect(resolveWorkbenchRunId(block)).toBe('call_1');
  });
});

describe('convertBackendBlock workbench restore', () => {
  it('remaps persisted mcp_tool workbench blocks and backfills toolCallId=id', () => {
    const block = convertBackendBlock({
      id: 'blk_wb',
      messageId: 'msg_1',
      type: 'mcp_tool',
      status: 'success',
      toolName: 'builtin-workbench_list_windows',
      toolOutput: {
        result: {
          status: 'completed',
          mode: 'frontend',
          applied: 0,
          totalOps: 0,
          entityIds: [],
          done: [],
          undone: [],
        },
      },
    });

    expect(block.type).toBe('workbench_ops');
    expect(block.toolCallId).toBe('blk_wb');
  });

  it('keeps non-workbench mcp_tool unchanged', () => {
    const block = convertBackendBlock({
      id: 'blk_todo',
      messageId: 'msg_1',
      type: 'mcp_tool',
      status: 'success',
      toolName: 'builtin-todo_create',
    });
    expect(block.type).toBe('mcp_tool');
    expect(block.toolCallId).toBeUndefined();
  });
});
