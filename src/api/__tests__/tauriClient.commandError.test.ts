/**
 * TD-11：CommandError envelope 解析与 invoke 错误归类的纯单测。
 * 契约：前端只依赖稳定 `code`；`message` 文案随时可变，不得影响分类结果。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  classifyInvokeError,
  parseCommandErrorEnvelope,
  TauriIpcError,
} from '../tauriClient';

describe('parseCommandErrorEnvelope', () => {
  it('parses an object payload with code/message/data/traceId', () => {
    const envelope = parseCommandErrorEnvelope({
      code: 'VFS_CONFLICT',
      message: 'CONFLICT(todo.conflict): stale item',
      data: { key: 'todo.conflict' },
      traceId: 'trace-1',
    });
    expect(envelope).toEqual({
      code: 'VFS_CONFLICT',
      message: 'CONFLICT(todo.conflict): stale item',
      data: { key: 'todo.conflict' },
      traceId: 'trace-1',
    });
  });

  it('parses a JSON string payload (string-transport variant)', () => {
    const envelope = parseCommandErrorEnvelope(
      JSON.stringify({ code: 'VFS_NOT_FOUND', message: 'Todo not found: t1' }),
    );
    expect(envelope?.code).toBe('VFS_NOT_FOUND');
    expect(envelope?.message).toBe('Todo not found: t1');
    expect(envelope?.traceId).toBeUndefined();
  });

  it('rejects legacy / malformed payloads', () => {
    expect(parseCommandErrorEnvelope('Database error: locked')).toBeNull();
    expect(parseCommandErrorEnvelope('{not json')).toBeNull();
    expect(parseCommandErrorEnvelope(null)).toBeNull();
    expect(parseCommandErrorEnvelope(undefined)).toBeNull();
    expect(parseCommandErrorEnvelope(42)).toBeNull();
    // code 必须是非空字符串，message 必须是字符串
    expect(parseCommandErrorEnvelope({ code: '', message: 'x' })).toBeNull();
    expect(parseCommandErrorEnvelope({ code: 7, message: 'x' })).toBeNull();
    expect(parseCommandErrorEnvelope({ code: 'X' })).toBeNull();
  });
});

describe('classifyInvokeError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers the structured envelope and exposes the stable code', () => {
    const err = classifyInvokeError('todo_toggle_item', {
      code: 'VFS_CONFLICT',
      message: 'CONFLICT(todo.conflict): stale',
      traceId: 't-9',
    });
    expect(err).toBeInstanceOf(TauriIpcError);
    expect(err.kind).toBe('business');
    expect(err.code).toBe('VFS_CONFLICT');
    expect(err.envelope?.traceId).toBe('t-9');
    expect(err.message).toContain('todo_toggle_item');
  });

  it('keeps the stable code when only the message changes', () => {
    const a = classifyInvokeError('todo_update_item', {
      code: 'VFS_CONFLICT',
      message: 'old wording',
    });
    const b = classifyInvokeError('todo_update_item', {
      code: 'VFS_CONFLICT',
      message: '全新的中文文案，与旧版完全不同',
    });
    expect(a.code).toBe(b.code);
    expect(a.message).not.toBe(b.message);
  });

  it('classifies infra failures as ipc without envelope', () => {
    const err = classifyInvokeError('todo_list_items', 'unknown command todo_list_items');
    expect(err.kind).toBe('ipc');
    expect(err.code).toBeUndefined();
    expect(err.envelope).toBeNull();
  });

  it('falls back to legacy business classification with an observability warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = classifyInvokeError(
      `legacy_cmd_${Date.now()}`,
      'Database error: connection failed',
    );
    expect(err.kind).toBe('business');
    expect(err.envelope).toBeNull();
    expect(
      warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('legacy string error payload')),
      ),
    ).toBe(true);
  });
});
