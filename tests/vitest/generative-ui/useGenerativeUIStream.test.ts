import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGenerativeUIStream } from '@/features/generative-ui/hooks/useGenerativeUIStream';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';

describe('useGenerativeUIStream', () => {
  it('sets intent directly', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.setIntent(LEARNING_DASHBOARD_EXAMPLE);
    });
    expect(result.current.intent?.blocks.length).toBeGreaterThan(0);
  });

  it('parses streamed chunks', () => {
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const mid = Math.floor(json.length / 2);
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append(json.slice(0, mid));
      result.current.append(json.slice(mid));
    });
    act(() => {
      result.current.finalize();
    });
    expect(result.current.intent).not.toBeNull();
  });

  it('resets state', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.setIntent(LEARNING_DASHBOARD_EXAMPLE);
      result.current.reset();
    });
    expect(result.current.intent).toBeNull();
  });

  it('keeps last-good intent when finalize JSON is truncated', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append('{"version":"1","blocks":[{"type":"text","props":{"body":"held"}}');
    });
    act(() => {
      result.current.finalize();
    });
    expect(result.current.partialIntent?.blocks[0]?.props?.body).toBe('held');
  });
});
