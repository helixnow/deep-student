import { describe, it, expect, vi } from 'vitest';
import type { ContextRef } from '../../../src/chat-v2/context/types';
import { dispatchContextRefPreview } from '../../../src/chat-v2/utils/contextRefPreview';

describe('dispatchContextRefPreview', () => {
  it('dispatches context-ref preview event with resolved path detail', () => {
    const listener = vi.fn();
    const ref: ContextRef = {
      resourceId: 'res_12345678',
      hash: 'hash_abc',
      typeId: 'note',
    };
    const pathMap = { [ref.resourceId]: '/tmp/test-note.md' };

    document.addEventListener('context-ref:preview', listener as EventListener, { once: true });
    dispatchContextRefPreview(ref, pathMap);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{
      resourceId: string;
      hash: string;
      typeId: string;
      path?: string;
    }>;
    expect(event.bubbles).toBe(true);
    expect(event.detail).toEqual({
      resourceId: 'res_12345678',
      hash: 'hash_abc',
      typeId: 'note',
      path: '/tmp/test-note.md',
    });
  });
});
