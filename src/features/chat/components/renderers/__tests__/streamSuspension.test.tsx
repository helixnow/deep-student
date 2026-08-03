/**
 * useSuspendedStreamContent — OS 模式 background 窗挂起期冻结流式提交。
 *
 * 验证契约：
 * - 无 Provider / 未挂起：内容直通（非 OS 模式行为不变）；
 * - suspended && isStreaming：内容冻结在挂起前的值（token 缓冲留在上游不丢）；
 * - 恢复可见：立即跟随最新内容整段补渲；
 * - 挂起期间流式结束：最终内容照常提交（隐藏窗数据仍完整）。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  StreamPreferencesProvider,
  useSuspendedStreamContent,
} from '../StreamPreferencesContext';

interface HookProps {
  content: string;
  isStreaming: boolean;
}

// wrapper 每次 rerender 都会重渲染，因此用外部可变量驱动 suspended
function makeWrapper(state: { suspended: boolean }): React.FC<{ children: React.ReactNode }> {
  return ({ children }) => (
    <StreamPreferencesProvider preset="balanced" mode="blocked" suspended={state.suspended}>
      {children}
    </StreamPreferencesProvider>
  );
}

describe('useSuspendedStreamContent', () => {
  it('passes content through when no provider is mounted (legacy paths unchanged)', () => {
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: HookProps) => useSuspendedStreamContent(content, isStreaming),
      { initialProps: { content: 'a', isStreaming: true } },
    );
    expect(result.current).toBe('a');
    rerender({ content: 'ab', isStreaming: true });
    expect(result.current).toBe('ab');
  });

  it('freezes streaming commits while suspended and catches up immediately on resume', () => {
    const state = { suspended: false };
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: HookProps) => useSuspendedStreamContent(content, isStreaming),
      { initialProps: { content: 'hello', isStreaming: true }, wrapper: makeWrapper(state) },
    );
    expect(result.current).toBe('hello');

    // 挂起：新 token 到达但提交内容冻结
    state.suspended = true;
    rerender({ content: 'hello wor', isStreaming: true });
    expect(result.current).toBe('hello');
    rerender({ content: 'hello world', isStreaming: true });
    expect(result.current).toBe('hello');

    // 恢复：立即补渲到最新内容（缓冲不丢）
    state.suspended = false;
    rerender({ content: 'hello world', isStreaming: true });
    expect(result.current).toBe('hello world');
  });

  it('commits the final content when the stream completes while suspended', () => {
    const state = { suspended: true };
    const { result, rerender } = renderHook(
      ({ content, isStreaming }: HookProps) => useSuspendedStreamContent(content, isStreaming),
      { initialProps: { content: 'partial', isStreaming: true }, wrapper: makeWrapper(state) },
    );
    expect(result.current).toBe('partial');

    rerender({ content: 'partial + more', isStreaming: true });
    expect(result.current).toBe('partial');

    // 流式结束：即使仍挂起也提交最终内容（隐藏窗数据完整）
    rerender({ content: 'partial + more + done', isStreaming: false });
    expect(result.current).toBe('partial + more + done');
  });
});
