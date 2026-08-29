import { describe, it, expect, afterEach } from 'vitest';
import type { GenerativeActionDefinition } from '@/features/generative-ui/types';
import { withGenerativeActionInstrumentation } from '@/features/generative-ui/actions';
import {
  GenerativeActionRateLimitError,
  GENERATIVE_ACTION_COOLDOWN_MS,
} from '@/features/generative-ui/handlers/actionRateLimit';
import {
  getDefaultGenerativeActionTelemetryRing,
  resetDefaultGenerativeActionTelemetryRing,
} from '@/features/generative-ui/handlers/actionTelemetryRing';

function makeDef(
  overrides: Partial<GenerativeActionDefinition> & Pick<GenerativeActionDefinition, 'handler'>,
): GenerativeActionDefinition {
  return {
    id: 'demo-action',
    label: 'Demo',
    riskLevel: 'low',
    ...overrides,
  };
}

describe('withGenerativeActionInstrumentation guards', () => {
  afterEach(() => {
    resetDefaultGenerativeActionTelemetryRing();
  });

  it('rate-limits a second immediate invoke on the same wrapped handler', async () => {
    const handlers = withGenerativeActionInstrumentation(
      {
        save: makeDef({
          id: 'save',
          handler: () => undefined,
        }),
      },
      { sink: () => undefined },
    );

    await handlers.save?.handler();
    await expect(handlers.save?.handler()).rejects.toBeInstanceOf(GenerativeActionRateLimitError);
    expect(GENERATIVE_ACTION_COOLDOWN_MS).toBe(400);
  });

  it('pushes telemetry events into the default ring', async () => {
    const handlers = withGenerativeActionInstrumentation(
      {
        save: makeDef({
          id: 'save',
          handler: () => undefined,
        }),
      },
      { sink: () => undefined, cooldownMs: 0 },
    );

    await handlers.save?.handler();
    const latest = getDefaultGenerativeActionTelemetryRing().latest();
    expect(latest?.actionId).toBe('save');
    expect(latest?.ok).toBe(true);
    expect(latest?.phase).toBe('execute');
  });

  it('skips timeout wrap when timeoutMs is 0', async () => {
    const handlers = withGenerativeActionInstrumentation(
      {
        save: makeDef({
          id: 'save',
          handler: () => ({ undone: false }),
        }),
      },
      { sink: () => undefined, timeoutMs: 0, cooldownMs: 0 },
    );

    await expect(handlers.save?.handler()).resolves.toEqual({ undone: false });
  });
});
