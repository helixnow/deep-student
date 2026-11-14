import { describe, expect, it } from 'vitest';
import {
  assertCentralDispatcherAvailable, canHandleToolPack, createSubContext, DEFAULT_PACK_TIMEOUT_SECS,
  MAX_CONCURRENCY, MAX_SUB_TOOLS, TOOL_PACK_EXECUTOR_NAME,
} from '../src/tool-pack.ts';

describe('tool_pack_executor.rs constants and admission', () => {
  it('test_can_handle', () => {
    expect(canHandleToolPack('builtin-tool_pack')).toBe(true);
    expect(canHandleToolPack('tool_pack')).toBe(true);
    expect(canHandleToolPack('builtin-note_read')).toBe(false);
    expect(canHandleToolPack('other_tool')).toBe(false);
  });

  it('test_executor_name', () => {
    expect(TOOL_PACK_EXECUTOR_NAME).toBe('ToolPackExecutor');
  });

  it('test_constants', () => {
    expect(MAX_SUB_TOOLS).toBe(20);
    expect(MAX_CONCURRENCY).toBe(10);
    expect(DEFAULT_PACK_TIMEOUT_SECS).toBe(300);
  });

  it('requires_central_admitted_dispatcher', () => {
    expect(() => assertCentralDispatcherAvailable(false))
      .toThrow('central admitted tool dispatcher');
    expect(() => assertCentralDispatcherAvailable(true)).not.toThrow();
  });

  it('sub_context_inherits_session_id_for_tree_budget', () => {
    const parent = {
      sessionId: 'tree-member-session', messageId: 'message', blockId: 'block',
      variantId: null, roundId: 'round-1', toolCallId: 'call-1', canvasNoteId: 'canvas-1',
      shellGuardApproved: true, shellAuthorityAdmission: { token: 'approved' },
      admittedToolDispatcher: 'central',
    };
    const token = new AbortController().signal;
    const sub = createSubContext(parent, 'sub-block', token);

    expect(sub.sessionId).toBe('tree-member-session');
    expect(sub.messageId).toBe('message');
    expect(sub.roundId).toBe('round-1');
    expect(sub.toolCallId).toBe('call-1');
    expect(sub.canvasNoteId).toBe('canvas-1');
    expect(sub.admittedToolDispatcher).toBe('central');
    expect(sub.blockId).toBe('sub-block');
    expect(sub.cancellationToken).toBe(token);
    expect(sub.shellGuardApproved).toBe(false);
    expect(sub.shellAuthorityAdmission).toBeNull();
  });
});
