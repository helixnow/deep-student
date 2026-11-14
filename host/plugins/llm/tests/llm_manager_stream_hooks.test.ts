import { describe, expect, it } from 'vitest';
import { StreamHookRegistry } from '../src/stream_hooks.ts';

describe('llm_manager/mod.rs', () => {
  it('stale_stream_hook_owner_cannot_unregister_replacement', () => {
    const registry = new StreamHookRegistry();
    const oldOwner = { owner: 'old' };
    const replacement = { owner: 'replacement' };

    registry.registerStreamHooks('chat_v2_event_test', oldOwner);
    registry.registerStreamHooks('chat_v2_event_test', replacement);

    expect(
      registry.unregisterStreamHooksIfOwner('chat_v2_event_test', oldOwner),
      'stale cleanup must not remove the replacement hook',
    ).toBe(false);
    const current = registry.getHook('chat_v2_event_test');
    expect(current, 'replacement hook should remain registered').not.toBeNull();
    expect(current).toBe(replacement);
    expect(registry.unregisterStreamHooksIfOwner('chat_v2_event_test', replacement)).toBe(true);
    expect(registry.getHook('chat_v2_event_test')).toBeNull();
  });
});
