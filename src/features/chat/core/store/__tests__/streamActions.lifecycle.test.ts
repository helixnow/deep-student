import { describe, expect, it } from 'vitest';
import type { ChatStoreState, GetState, SetState } from '../types';
import { createStreamActions } from '../streamActions';
import type { Block } from '../../types/block';
import type { Message } from '../../types/message';

function createHarness(initial: Partial<ChatStoreState> & {
  sessionStatus: ChatStoreState['sessionStatus'];
}) {
  let state = {
    activeBlockIds: new Set<string>(),
    currentStreamingMessageId: null as string | null,
    blocks: new Map<string, Block>(),
    messageMap: new Map<string, Message>(),
    ...initial,
  } as unknown as ChatStoreState;

  const set: SetState = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };
  const getState: GetState = () => state as ReturnType<GetState>;
  const actions = createStreamActions(set, getState);
  return {
    getState: () => state,
    actions,
  };
}

describe('completeStream lifecycle cleanup', () => {
  it('clears a stale streaming message id even when status already raced back to idle', () => {
    const harness = createHarness({
      sessionStatus: 'idle',
      currentStreamingMessageId: 'msg_stale',
      activeBlockIds: new Set(['blk_stale']),
    });

    harness.actions.completeStream('success');

    expect(harness.getState().currentStreamingMessageId).toBeNull();
    expect(harness.getState().activeBlockIds.size).toBe(0);
  });

  it('does not label orphan preparing blocks as cancelled when stream completes successfully', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      toolCallId: 'call_1',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep', 'blk_real'],
      _meta: { preparingToolCall: { toolCallId: 'call_1', toolName: 'load_skills' } },
    } as unknown as Message;
    const real: Block = {
      id: 'blk_real',
      type: 'mcp_tool',
      status: 'success',
      messageId: 'msg_1',
      toolName: 'load_skills',
      toolCallId: 'call_2',
      isPreparing: false,
    };

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([
        ['blk_prep', preparing],
        ['blk_real', real],
      ]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('success');

    const state = harness.getState();
    expect(state.sessionStatus).toBe('idle');
    expect(state.blocks.has('blk_prep')).toBe(false);
    expect(state.blocks.get('blk_real')?.status).toBe('success');
    expect(state.messageMap.get('msg_1')?.blockIds).toEqual(['blk_real']);
    expect(state.messageMap.get('msg_1')?._meta?.preparingToolCall).toBeUndefined();
  });

  // 回归：Super 会话里在 super_dispatch_worker 参数生成中途点停止，后端保存部分结果后
  // 按 success 收尾；preparing 占位块在 activeBlockIds 中但未登记进 message.blockIds，
  // 曾被第 1 步标成 success 而保留 isPreparing，子代理卡片永久显示“执行中”。
  it.each(['success', 'cancelled'] as const)(
    'never leaves a success+isPreparing block for active preparing blocks missing from blockIds (%s)',
    (reason) => {
      const preparing: Block = {
        id: 'blk_prep_active',
        type: 'subagent_embed',
        status: 'pending',
        messageId: 'msg_1',
        toolName: 'builtin-super_dispatch_worker',
        toolCallId: 'call_1',
        isPreparing: true,
      };
      const msg = {
        id: 'msg_1',
        role: 'assistant',
        blockIds: [],
        _meta: { preparingToolCall: { toolCallId: 'call_1', toolName: 'builtin-super_dispatch_worker' } },
      } as unknown as Message;
      const harness = createHarness({
        sessionStatus: 'streaming',
        currentStreamingMessageId: 'msg_1',
        activeBlockIds: new Set(['blk_prep_active']),
        blocks: new Map([['blk_prep_active', preparing]]),
        messageMap: new Map([['msg_1', msg]]),
      });

      harness.actions.completeStream(reason);

      const block = harness.getState().blocks.get('blk_prep_active');
      if (reason === 'success') {
        expect(block).toBeUndefined();
      } else {
        expect(block?.isPreparing).toBe(false);
        expect(block?.status).toBe('error');
        expect(block?.error).toContain('before tool execution');
      }
      expect(harness.getState().activeBlockIds.size).toBe(0);
    },
  );

  it('keeps cancelled wording only when stream is cancelled', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'builtin-local_shell_preflight',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('cancelled');

    const block = harness.getState().blocks.get('blk_prep');
    expect(block?.status).toBe('error');
    expect(block?.isPreparing).toBe(false);
    expect(block?.error).toBe('Stream cancelled before tool execution');
  });

  it('uses error-before-execution wording when stream ends with error', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('error');

    expect(harness.getState().blocks.get('blk_prep')?.error).toBe(
      'Stream ended with error before tool execution',
    );
  });

  it('surfaces the normalized terminal error on orphan preparing blocks', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('error', 'Load failed: upstream 429 rate limit exceeded');

    const block = harness.getState().blocks.get('blk_prep');
    expect(block?.status).toBe('error');
    expect(block?.isPreparing).toBe(false);
    expect(block?.error).toBe('Load failed: upstream 429 rate limit exceeded');
  });

  it('falls back to the generic error wording when terminalError is blank', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('error', '   ');

    expect(harness.getState().blocks.get('blk_prep')?.error).toBe(
      'Stream ended with error before tool execution',
    );
  });

  it('ignores terminalError on the cancelled path', () => {
    const preparing: Block = {
      id: 'blk_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_1',
      toolName: 'load_skills',
      isPreparing: true,
    };
    const msg = {
      id: 'msg_1',
      role: 'assistant',
      blockIds: ['blk_prep'],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      blocks: new Map([['blk_prep', preparing]]),
      messageMap: new Map([['msg_1', msg]]),
    });

    harness.actions.completeStream('cancelled', 'Load failed: upstream 429 rate limit exceeded');

    expect(harness.getState().blocks.get('blk_prep')?.error).toBe(
      'Stream cancelled before tool execution',
    );
  });

  it('clears a pending tool approval when the stream terminates', () => {
    const pendingApproval = {
      kind: 'tool_approval',
      toolCallId: 'call_1',
      toolName: 'note_set',
      arguments: {},
      sensitivity: 'high',
      description: 'd',
      timeoutSeconds: 300,
    } as unknown as ChatStoreState['pendingBlockingInteraction'];
    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      pendingBlockingInteraction: pendingApproval,
      pendingApprovalRequest: { toolCallId: 'call-1' } as unknown as ChatStoreState['pendingApprovalRequest'],
      // setPendingApproval 是 action（在 ChatStore 而非 ChatStoreState 上），
      // completeStream 用它做审批运行时清理的 WeakMap key
      ...({ setPendingApproval: () => undefined } as unknown as Partial<ChatStoreState>),
    });

    harness.actions.completeStream('error');

    expect(harness.getState().pendingBlockingInteraction).toBeNull();
    expect(harness.getState().pendingApprovalRequest).toBeNull();
  });

  it('keeps non-approval blocking interactions untouched on stream terminate', () => {
    const toolLimit = {
      kind: 'tool_limit',
      blockId: 'b1',
      content: '',
      onContinue: null,
    } as unknown as ChatStoreState['pendingBlockingInteraction'];
    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_1',
      pendingBlockingInteraction: toolLimit,
    });

    harness.actions.completeStream('cancelled');

    expect(harness.getState().pendingBlockingInteraction).toBe(toolLimit);
  });

  it('cleans up residual preparing and running blocks even when sessionStatus is already idle', () => {
    const prepBlock: Block = {
      id: 'blk_idle_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_idle',
      toolName: 'note_read',
      toolCallId: 'call_idle_prep',
      isPreparing: true,
    };
    const runningBlock: Block = {
      id: 'blk_idle_run',
      type: 'rag',
      status: 'running',
      messageId: 'msg_idle',
    };
    const msg = {
      id: 'msg_idle',
      role: 'assistant',
      blockIds: ['blk_idle_prep', 'blk_idle_run'],
      _meta: { preparingToolCall: { toolCallId: 'call_idle_prep', toolName: 'note_read' } },
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'idle',
      currentStreamingMessageId: null,
      messageOrder: ['msg_idle'],
      activeBlockIds: new Set(['blk_idle_prep', 'blk_idle_run']),
      blocks: new Map([
        ['blk_idle_prep', prepBlock],
        ['blk_idle_run', runningBlock],
      ]),
      messageMap: new Map([['msg_idle', msg]]),
    });

    harness.actions.completeStream('error', 'upstream timeout');

    expect(harness.getState().activeBlockIds.size).toBe(0);
    expect(harness.getState().blocks.get('blk_idle_prep')).toMatchObject({
      isPreparing: false,
      status: 'error',
      error: 'upstream timeout',
    });
    expect(harness.getState().blocks.get('blk_idle_run')).toMatchObject({
      status: 'error',
    });
    expect(harness.getState().messageMap.get('msg_idle')?._meta?.preparingToolCall).toBeUndefined();
  });

  it('cleans up preparing and running blocks inside message.variants', () => {
    const vPrep: Block = {
      id: 'blk_v_prep',
      type: 'mcp_tool',
      status: 'pending',
      messageId: 'msg_var',
      toolName: 'web_search',
      toolCallId: 'call_v',
      isPreparing: true,
    };
    const vRun: Block = {
      id: 'blk_v_run',
      type: 'mcp_tool',
      status: 'running',
      messageId: 'msg_var',
      toolName: 'note_read',
    };
    const msg = {
      id: 'msg_var',
      role: 'assistant',
      blockIds: [],
      variants: [
        { id: 'var_1', modelId: 'm1', status: 'streaming', blockIds: ['blk_v_prep', 'blk_v_run'], createdAt: 1 },
      ],
    } as unknown as Message;

    const harness = createHarness({
      sessionStatus: 'streaming',
      currentStreamingMessageId: 'msg_var',
      activeBlockIds: new Set(['blk_v_prep', 'blk_v_run']),
      blocks: new Map([
        ['blk_v_prep', vPrep],
        ['blk_v_run', vRun],
      ]),
      messageMap: new Map([['msg_var', msg]]),
    });

    harness.actions.completeStream('success');

    expect(harness.getState().blocks.has('blk_v_prep')).toBe(false);
    expect(harness.getState().blocks.get('blk_v_run')?.status).toBe('success');
    expect(harness.getState().messageMap.get('msg_var')?.variants?.[0]?.blockIds).toEqual(['blk_v_run']);
  });
});
