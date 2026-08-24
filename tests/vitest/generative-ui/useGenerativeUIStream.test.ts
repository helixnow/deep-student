import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGenerativeUIStream } from '@/features/generative-ui/hooks/useGenerativeUIStream';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import {
  getDefaultGenerativeUIIntentSnapshotRing,
  resetDefaultGenerativeUIIntentSnapshotRing,
} from '@/features/generative-ui/utils/intentSnapshotRing';

describe('useGenerativeUIStream', () => {
  afterEach(() => {
    resetDefaultGenerativeUIIntentSnapshotRing();
  });

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

  it('classifies invalid JSON finalize as invalid-json', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append('{ not valid json');
    });
    act(() => {
      result.current.finalize();
    });
    expect(result.current.errorCodes[0]?.code).toBe('invalid-json');
  });

  it('clears stale parse errors when a failed stream resumes', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append(
        '{"version":"1","blocks":[{"type":"text","props":{"body":"held',
      );
      result.current.finalize();
    });
    expect(result.current.errorCodes[0]?.code).toBe('invalid-json');

    act(() => {
      result.current.append('"}}]}');
    });
    expect(result.current.errorCodes).toEqual([]);
    expect(result.current.errors).toEqual([]);
    expect(result.current.partialIntent?.blocks[0]?.props?.body).toBe('held');
  });

  it('rejects invalid object intents without recording a snapshot', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.setIntent({ version: '2', blocks: [] } as never);
    });

    expect(result.current.intent).toBeNull();
    expect(result.current.errorCodes[0]?.code).toBe('unknown-version');
    expect(getDefaultGenerativeUIIntentSnapshotRing().size).toBe(0);
  });

  it('pushes default snapshot on successful finalize', () => {
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => {
      result.current.append(json);
    });
    act(() => {
      result.current.finalize();
    });
    const latest = getDefaultGenerativeUIIntentSnapshotRing().latest();
    expect(latest?.intent).toEqual(result.current.intent);
    expect(latest?.intent.meta?.title).toBe(LEARNING_DASHBOARD_EXAMPLE.meta?.title);
  });
});
