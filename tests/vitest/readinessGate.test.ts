import { describe, expect, it } from 'vitest';

import {
  checkChatReadiness,
  resolveChatReadiness,
} from '@/chat-v2/readiness/readinessGate';

describe('readinessGate', () => {
  it('blocks send when model2 is missing', () => {
    const result = checkChatReadiness({ model2Configured: false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('MODEL2_MISSING');
    expect(result.cta).toBe('OPEN_SETTINGS_MODELS');
  });

  it('allows send when model2 is configured', () => {
    const result = checkChatReadiness({ model2Configured: true });
    expect(result).toEqual({ ok: true });
  });

  it('resolves readiness from assignments provider', async () => {
    const blocked = await resolveChatReadiness(async () => ({ model2_config_id: null }));
    expect(blocked.ok).toBe(false);

    const ready = await resolveChatReadiness(async () => ({ model2_config_id: 'cfg_model_2' }));
    expect(ready.ok).toBe(true);
  });
});
