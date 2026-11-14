import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useGenerativeUIStream } from '../hooks/useGenerativeUIStream';

const view = (text: string) => JSON.stringify({ version: '1', blocks: [
  { type: 'markdown', props: { content: text } },
] });

describe('useGenerativeUIStream replacement', () => {
  it('does not redisplay an older committed intent after a new partial stream finishes', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => result.current.setIntent(view('old')));
    act(() => result.current.append(view('new').slice(0, -2)));
    expect(JSON.stringify(result.current.intent)).not.toContain('old');
    act(() => { result.current.finalize(); });
    expect(JSON.stringify(result.current.intent)).toContain('new');
    expect(JSON.stringify(result.current.intent)).not.toContain('old');
  });

  it('replaces an active parser buffer when an authoritative intent is set', () => {
    const { result } = renderHook(() => useGenerativeUIStream());
    act(() => result.current.append('{"version":"1","blocks":['));
    act(() => result.current.setIntent(view('authoritative')));
    expect(result.current.isStreaming).toBe(false);
    expect(JSON.stringify(result.current.intent)).toContain('authoritative');
    act(() => result.current.append(view('next')));
    act(() => { result.current.finalize(); });
    expect(JSON.stringify(result.current.intent)).toContain('next');
    expect(result.current.errors).toEqual([]);
  });
});
