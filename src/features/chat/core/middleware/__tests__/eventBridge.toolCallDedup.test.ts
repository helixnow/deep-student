/**
 * 工具调用时间线重复行回归测试
 *
 * 现象：同一 tool_call_id 在时间线出现两行——一行停在「准备中/执行中」（计时不停），
 * 另一行「已完成」，直到 stream_complete 才清理。
 *
 * 根因：eventBridge 的乱序缓冲回放 / gap 超时冲刷在同一份旧 store 快照上连续
 * 处理多个事件；同批内先创建的 preparing 占位块对 tool_call start 不可见，
 * start 另建执行块，占位块成为孤儿。另：handler 对同一 toolCallId 不幂等。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import { createChatStore } from '../../store/createChatStore';
import type { ChatStore } from '../../types';
import type { Block } from '../../types/block';
import {
  clearBridgeState,
  clearEventContext,
  clearProcessedEventIds,
  handleBackendEventWithSequence,
  registerBridgeStoreResolver,
  resetBridgeState,
  type BackendEvent,
} from '../eventBridge';
// 自注册 tool_call / tool_call_preparing / image_gen / retrieval / generative_ui handler
import '../../../plugins/events/toolCall';
import '../../../plugins/events/retrieval';
import '../../../plugins/events/generativeUI';

const MSG = 'msg_tool_dedup';

function blocksFor(store: StoreApi<ChatStore>, toolCallId: string): Block[] {
  return Array.from(store.getState().blocks.values()).filter((b) => b.toolCallId === toolCallId);
}

function preparingStart(seq: number, blockId: string, toolCallId: string, toolName = 'builtin-note_read'): BackendEvent {
  return {
    sequenceId: seq,
    type: 'tool_call_preparing',
    phase: 'start',
    messageId: MSG,
    blockId,
    payload: { toolCallId, toolName, status: 'preparing' },
  };
}

function preparingChunk(seq: number, blockId: string, chunk: string): BackendEvent {
  return { sequenceId: seq, type: 'tool_call_preparing', phase: 'chunk', blockId, chunk };
}

function toolStart(seq: number, blockId: string, toolCallId: string, toolName = 'builtin-note_read'): BackendEvent {
  return {
    sequenceId: seq,
    type: 'tool_call',
    phase: 'start',
    messageId: MSG,
    blockId,
    payload: { toolName, toolInput: { note_id: 'n1' }, toolCallId },
  };
}

function toolEnd(seq: number, blockId: string): BackendEvent {
  return {
    sequenceId: seq,
    type: 'tool_call',
    phase: 'end',
    blockId,
    result: { result: { ok: true }, durationMs: 1 },
  };
}

describe('eventBridge tool call dedup (one timeline row per tool_call_id)', () => {
  let sessionId: string;
  let store: StoreApi<ChatStore>;
  let unregister: () => void;
  let counter = 0;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sessionId = `sess_tool_dedup_${++counter}`;
    store = createChatStore(sessionId);
    store.setState({ currentStreamingMessageId: MSG } as Partial<ChatStore>);
    resetBridgeState(sessionId);
    unregister = registerBridgeStoreResolver(sessionId, () => store.getState());
  });

  afterEach(() => {
    unregister();
    clearProcessedEventIds(sessionId);
    clearEventContext(sessionId);
    clearBridgeState(sessionId);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('promotes the preparing block when preparing+start are replayed from the reorder buffer', () => {
    // seq0 打开流；seq1 迟到 → seq2..5 进入乱序缓冲；seq1 到达时整批回放
    handleBackendEventWithSequence(store.getState(), preparingStart(0, 'blk_prep_a', 'call_a', 'builtin-resource_list'));
    handleBackendEventWithSequence(store.getState(), preparingStart(2, 'blk_prep_x', 'call_x'));
    handleBackendEventWithSequence(store.getState(), preparingChunk(3, 'blk_prep_x', '{"note_id":'));
    handleBackendEventWithSequence(store.getState(), toolStart(4, 'blk_exec_x', 'call_x'));
    handleBackendEventWithSequence(store.getState(), toolEnd(5, 'blk_exec_x'));
    handleBackendEventWithSequence(store.getState(), preparingChunk(1, 'blk_prep_a', '{}'));

    const rows = blocksFor(store, 'call_x');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('blk_exec_x');
    expect(rows[0].isPreparing).toBe(false);
    expect(rows[0].status).toBe('success');
    const message = store.getState().messageMap.get(MSG)!;
    expect(message.blockIds.filter((id) => id === 'blk_prep_x')).toHaveLength(0);
    expect(message.blockIds.filter((id) => id === 'blk_exec_x')).toHaveLength(1);
  });

  it('promotes the preparing block when the gap timer flushes with a timer-time snapshot', () => {
    vi.useFakeTimers();
    handleBackendEventWithSequence(store.getState(), preparingStart(0, 'blk_prep_a', 'call_a', 'builtin-resource_list'));
    // seq1 永远丢失：后续事件全部缓冲，gap 定时器以「此刻」快照冲刷
    handleBackendEventWithSequence(store.getState(), preparingStart(2, 'blk_prep_x', 'call_x'));
    handleBackendEventWithSequence(store.getState(), toolStart(3, 'blk_exec_x', 'call_x'));
    handleBackendEventWithSequence(store.getState(), toolEnd(4, 'blk_exec_x'));
    vi.advanceTimersByTime(5000);

    const rows = blocksFor(store, 'call_x');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('blk_exec_x');
    expect(rows[0].isPreparing).toBe(false);
    expect(rows[0].status).toBe('success');
  });

  it('keeps a single placeholder when tool_call_preparing is delivered twice for one tool_call_id', () => {
    handleBackendEventWithSequence(store.getState(), preparingStart(0, 'blk_prep_1', 'call_x'));
    handleBackendEventWithSequence(store.getState(), preparingStart(1, 'blk_prep_2', 'call_x'));
    // 第二次 preparing 的 block_id 生效：后续预览 chunk 仍落在同一个占位块
    handleBackendEventWithSequence(store.getState(), preparingChunk(2, 'blk_prep_2', '{"a":1}'));

    let rows = blocksFor(store, 'call_x');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('blk_prep_2');
    expect(rows[0].content).toBe('{"a":1}');

    handleBackendEventWithSequence(store.getState(), toolStart(3, 'blk_exec_x', 'call_x'));
    handleBackendEventWithSequence(store.getState(), toolEnd(4, 'blk_exec_x'));

    rows = blocksFor(store, 'call_x');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('blk_exec_x');
    expect(rows[0].status).toBe('success');
    expect(store.getState().messageMap.get(MSG)!.blockIds).toEqual(['blk_exec_x']);
  });

  it('tool_call start removes leftover duplicate preparing blocks of the same tool_call_id', () => {
    const now = Date.now();
    const prep = (id: string): Block => ({
      id,
      type: 'mcp_tool',
      status: 'running',
      messageId: MSG,
      toolName: 'builtin-resource_list',
      toolCallId: 'call_dup',
      isPreparing: true,
      startedAt: now,
    });
    store.setState((s) => {
      const blocks = new Map(s.blocks);
      blocks.set('blk_p1', prep('blk_p1'));
      blocks.set('blk_p2', prep('blk_p2'));
      const messageMap = new Map(s.messageMap);
      messageMap.set(MSG, {
        id: MSG,
        role: 'assistant',
        blockIds: ['blk_p1', 'blk_p2'],
        timestamp: now,
      } as never);
      return { blocks, messageMap } as Partial<ChatStore>;
    });

    handleBackendEventWithSequence(store.getState(), toolStart(0, 'blk_exec', 'call_dup', 'builtin-resource_list'));
    handleBackendEventWithSequence(store.getState(), toolEnd(1, 'blk_exec'));

    const rows = blocksFor(store, 'call_dup');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('blk_exec');
    expect(rows[0].status).toBe('success');
    expect(store.getState().messageMap.get(MSG)!.blockIds).toEqual(['blk_exec']);
  });

  it('custom block starts (rag, generative_ui, image_gen) clean up matching tool_call_preparing block by toolCallId', () => {
    handleBackendEventWithSequence(
      store.getState(),
      preparingStart(0, 'blk_prep_rag', 'call_rag', 'rag_search'),
    );
    expect(store.getState().blocks.get('blk_prep_rag')?.isPreparing).toBe(true);

    handleBackendEventWithSequence(store.getState(), {
      type: 'rag',
      phase: 'start',
      messageId: MSG,
      blockId: 'blk_rag_exec',
      sequenceId: 1,
      payload: { toolCallId: 'call_rag', query: 'eigenvalue' },
    });
    expect(store.getState().blocks.has('blk_prep_rag')).toBe(false);
    expect(store.getState().blocks.get('blk_rag_exec')).toMatchObject({
      type: 'rag',
      status: 'running',
      isPreparing: false,
      toolCallId: 'call_rag',
    });

    handleBackendEventWithSequence(
      store.getState(),
      preparingStart(2, 'blk_prep_ui', 'call_ui', 'render_generative_ui'),
    );
    handleBackendEventWithSequence(store.getState(), {
      type: 'generative_ui',
      phase: 'start',
      messageId: MSG,
      blockId: 'blk_ui_exec',
      sequenceId: 3,
      payload: { toolCallId: 'call_ui', title: 'Demo' },
    });
    expect(store.getState().blocks.has('blk_prep_ui')).toBe(false);
    expect(store.getState().blocks.get('blk_ui_exec')).toMatchObject({
      type: 'generative_ui',
      isPreparing: false,
      toolCallId: 'call_ui',
    });

    handleBackendEventWithSequence(
      store.getState(),
      preparingStart(4, 'blk_prep_img', 'call_img', 'image_generate'),
    );
    handleBackendEventWithSequence(store.getState(), {
      type: 'image_gen',
      phase: 'start',
      messageId: MSG,
      blockId: 'blk_img_exec',
      sequenceId: 5,
      payload: { toolCallId: 'call_img', prompt: 'cat' },
    });
    expect(store.getState().blocks.has('blk_prep_img')).toBe(false);
    expect(store.getState().blocks.get('blk_img_exec')).toMatchObject({
      type: 'image_gen',
      status: 'running',
      isPreparing: false,
      toolCallId: 'call_img',
    });
  });

  it('handles tool_call_preparing end and error terminal events', () => {
    handleBackendEventWithSequence(
      store.getState(),
      preparingStart(0, 'blk_prep_drop', 'call_drop', 'note_read'),
    );
    handleBackendEventWithSequence(store.getState(), {
      type: 'tool_call_preparing',
      phase: 'end',
      messageId: MSG,
      blockId: 'blk_prep_drop',
      sequenceId: 1,
    });
    expect(store.getState().blocks.has('blk_prep_drop')).toBe(false);

    handleBackendEventWithSequence(
      store.getState(),
      preparingStart(2, 'blk_prep_fail', 'call_fail', 'note_read'),
    );
    handleBackendEventWithSequence(store.getState(), {
      type: 'tool_call_preparing',
      phase: 'error',
      messageId: MSG,
      blockId: 'blk_prep_fail',
      sequenceId: 3,
      error: 'stream aborted',
    });
    expect(store.getState().blocks.get('blk_prep_fail')).toMatchObject({
      isPreparing: false,
      status: 'error',
      error: 'stream aborted',
    });
  });

  it('restarts an errored block on transient retry start without duplicating blockIds', () => {
    handleBackendEventWithSequence(store.getState(), toolStart(0, 'blk_retry', 'call_retry', 'note_read'));
    handleBackendEventWithSequence(store.getState(), {
      type: 'tool_call',
      phase: 'error',
      messageId: MSG,
      blockId: 'blk_retry',
      sequenceId: 1,
      error: 'ECONNRESET',
    });
    expect(store.getState().blocks.get('blk_retry')?.status).toBe('error');

    handleBackendEventWithSequence(store.getState(), {
      type: 'tool_call',
      phase: 'start',
      messageId: MSG,
      blockId: 'blk_retry',
      sequenceId: 2,
      payload: {
        toolName: 'note_read',
        toolCallId: 'call_retry',
        toolInput: { id: 'n1' },
        retry: true,
        retryAttempt: 1,
      },
    });
    expect(store.getState().blocks.get('blk_retry')).toMatchObject({
      status: 'running',
      error: undefined,
    });
    expect(store.getState().messageMap.get(MSG)!.blockIds).toEqual(['blk_retry']);

    handleBackendEventWithSequence(store.getState(), toolEnd(3, 'blk_retry'));
    expect(store.getState().blocks.get('blk_retry')?.status).toBe('success');
  });
});
