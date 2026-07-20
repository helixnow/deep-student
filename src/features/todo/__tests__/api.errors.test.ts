/**
 * TD-11：todo API 错误归一的单测。
 * 核心契约：优先按后端稳定 code（CommandError envelope）映射 TodoErrorCode；
 * message 改文案不影响分类；未知 code 统一降级 'unknown'；
 * legacy 字符串错误仍可通过 Display 文案启发式归类（迁移期兜底）。
 */
import { describe, expect, it, vi } from 'vitest';

import { classifyTodoError, toTodoApiError, TodoApiError } from '../api';

describe('toTodoApiError (structured envelope path)', () => {
  it('maps backend stable codes to TodoErrorCode', () => {
    const cases: Array<[string, string]> = [
      ['VFS_CONFLICT', 'conflict'],
      ['VFS_NOT_FOUND', 'notFound'],
      ['VFS_INVALID_ARGUMENT', 'invalidArgument'],
      ['VFS_INVALID_OPERATION', 'invalidOperation'],
      ['VFS_LIMIT_EXCEEDED', 'invalidOperation'],
      ['VFS_MAINTENANCE', 'maintenance'],
      ['VFS_STORAGE', 'storage'],
      ['VFS_IO', 'storage'],
      ['VFS_SERIALIZATION', 'storage'],
    ];
    for (const [backendCode, expected] of cases) {
      const err = toTodoApiError(
        { code: backendCode, message: 'any message' },
        'todo_update_item',
      );
      expect(err).toBeInstanceOf(TodoApiError);
      expect(err.code).toBe(expected);
      expect(err.backendCode).toBe(backendCode);
    }
  });

  it('keeps classification stable when only the message changes (TD-11 contract)', () => {
    const oldWording = toTodoApiError(
      { code: 'VFS_CONFLICT', message: 'CONFLICT(todo.conflict): TODO_CONFLICT: stale' },
      'todo_toggle_item',
    );
    const newWording = toTodoApiError(
      // 完全不含 legacy 启发式能识别的关键词，验证分类只看 code
      { code: 'VFS_CONFLICT', message: '这条任务刚被其他窗口修改过，请刷新后重试' },
      'todo_toggle_item',
    );
    expect(oldWording.code).toBe('conflict');
    expect(newWording.code).toBe('conflict');
    expect(newWording.message).toBe('这条任务刚被其他窗口修改过，请刷新后重试');
  });

  it('degrades unknown backend codes to "unknown" while preserving message and traceId', () => {
    const err = toTodoApiError(
      { code: 'SOME_FUTURE_CODE', message: '新版后端的新错误', traceId: 'trace-42' },
      'todo_create_item',
    );
    expect(err.code).toBe('unknown');
    expect(err.backendCode).toBe('SOME_FUTURE_CODE');
    expect(err.traceId).toBe('trace-42');
    expect(err.message).toBe('新版后端的新错误');
  });

  it('preserves conflict envelopes delivered as JSON strings', () => {
    const err = toTodoApiError(
      JSON.stringify({ code: 'VFS_NOT_FOUND', message: 'todo not found: t1' }),
      'todo_get_item',
    );
    expect(err.code).toBe('notFound');
    expect(err.backendCode).toBe('VFS_NOT_FOUND');
  });

  it('returns existing TodoApiError unchanged', () => {
    const original = new TodoApiError('boom', 'storage', 'todo_list_items');
    expect(toTodoApiError(original, 'todo_list_items')).toBe(original);
  });
});

describe('toTodoApiError (legacy fallback path)', () => {
  it('classifies legacy display strings and warns once per command', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const command = `legacy_todo_cmd_${Date.now()}`;

    const err = toTodoApiError('CONFLICT(todo.conflict): TODO_CONFLICT: stale', command);
    expect(err.code).toBe('conflict');
    expect(err.backendCode).toBeUndefined();

    const warnsForCommand = () =>
      warnSpy.mock.calls.filter((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('legacy string error payload')),
      ).length;
    const afterFirst = warnsForCommand();
    expect(afterFirst).toBeGreaterThan(0);

    // 同一命令再次出错不重复告警（避免刷屏）
    toTodoApiError('Database error: locked', command);
    expect(warnsForCommand()).toBe(afterFirst);
    warnSpy.mockRestore();
  });
});

describe('classifyTodoError (legacy heuristics kept for fallback)', () => {
  it('still maps known display prefixes', () => {
    expect(classifyTodoError('CONFLICT(todo.conflict): stale')).toBe('conflict');
    expect(classifyTodoError('Note not found: n1')).toBe('notFound');
    expect(classifyTodoError("Invalid argument 'title': empty")).toBe('invalidArgument');
    expect(classifyTodoError('INVALID_OPERATION: batch - too many')).toBe('invalidOperation');
    expect(classifyTodoError('MAINTENANCE_MODE: vfs is temporarily unavailable')).toBe(
      'maintenance',
    );
    expect(classifyTodoError('Database error: locked')).toBe('storage');
    expect(classifyTodoError('mystery failure')).toBe('unknown');
  });
});
