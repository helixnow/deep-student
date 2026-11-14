/**
 * V05-02 / V08-04：错误的显示文本。
 *
 * Rust `impl Display for AppError` 只写 `self.message`（crates/dstu-core/src/models.rs:1038-1042），
 * `e.to_string()` / `format!("{e}")` 都不带 error_type。Host 里 `AppError.*` 是普通对象：
 * - `new CommandError(appError).message` 以前是整段 JSON，业务代码拼 `e.message` 会把 `{"error_type":…}` 显示给用户；
 * - 裸抛的 AppError 经 `String(error)` 变成 `[object Object]`。
 */
import { describe, expect, it } from 'vitest';
import { CommandError, errorDisplay } from '../api.ts';
import { AppError, errorDisplay as errorsApiDisplay } from '../../platform/errors/api.ts';
import { thrownMessage } from '../commands.ts';

describe('V05-02 CommandError.message', () => {
  it('is the message field of AppError / envelope / DstuError values, like Rust Display', () => {
    expect(new CommandError(AppError.configuration('x')).message).toBe('x');
    expect(new CommandError(AppError.with_details('Conflict', 'REVIEW_CONFLICT', { field: 'title' })).message).toBe('REVIEW_CONFLICT');
    expect(new CommandError({ code: 'INTERNAL_ERROR', message: 'envelope text' }).message).toBe('envelope text');
    expect(new CommandError({ type: 'Internal', message: 'dstu text' }).message).toBe('dstu text');
    expect(new CommandError('plain').message).toBe('plain');
  });

  it('leaves the IPC value untouched', () => {
    const value = AppError.not_found('gone');
    expect(new CommandError(value).value).toBe(value);
  });

  it('falls back to the JSON text (or the non-JSON diagnostic) when there is no usable message', () => {
    expect(new CommandError(AppError.validation('')).message).toBe('{"error_type":"Validation","message":"","details":null}');
    expect(new CommandError({ code: 7, reason: 'nope' }).message).toBe('{"code":7,"reason":"nope"}');
    expect(new CommandError({ message: 42 }).message).toBe('{"message":42}');
    expect(new CommandError(['a', 1]).message).toBe('["a",1]');
    expect(new CommandError({ id: 1n }).message).toBe('{"id":"1"}');
    // 类实例不是 IPC 值：保留诊断文本，不读它的 message。
    expect(new CommandError(new Error('inner')).message).toMatch(/is an instance of Error/);
  });
});

describe('V08-04 errorDisplay', () => {
  it('a bare AppError shows its message instead of [object Object]', () => {
    const error: unknown = AppError.configuration('没有可用的 OCR 模型');
    expect(String(error)).toBe('[object Object]');
    expect(errorDisplay(error)).toBe('没有可用的 OCR 模型');
  });

  it('agrees with CommandError.message and the kernel panic text for every thrown shape', () => {
    const appError = AppError.llm('quota exceeded');
    expect(errorDisplay(new CommandError(appError))).toBe('quota exceeded');
    expect(errorDisplay(new Error('boom'))).toBe('boom');
    expect(errorDisplay(new TypeError(''))).toBe('TypeError');
    expect(errorDisplay('text')).toBe('text');
    expect(errorDisplay({ code: 7 })).toBe('{"code":7}');
    expect(errorDisplay(undefined)).toBe('undefined');
    expect(errorDisplay(12n)).toBe('12');
    const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
    expect(errorDisplay(hostile)).toBe('unprintable thrown value');
    expect(thrownMessage).toBe(errorDisplay);
  });

  it('is the same function from kernel/api and platform/errors/api', () => {
    expect(errorsApiDisplay).toBe(errorDisplay);
  });
});
