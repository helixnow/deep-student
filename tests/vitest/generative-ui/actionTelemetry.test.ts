import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '@/features/generative-ui/types';
import {
  wrapActionWithTelemetry,
  defaultGenerativeActionTelemetrySink,
  type GenerativeActionTelemetryEvent,
} from '@/features/generative-ui/handlers/actionTelemetry';
import { withGenerativeActionInstrumentation } from '@/features/generative-ui/actions';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';

function makeDef(
  overrides: Partial<GenerativeActionDefinition> & Pick<GenerativeActionDefinition, 'handler'>,
): GenerativeActionDefinition {
  return {
    id: 'demo-action',
    label: 'Demo',
    riskLevel: 'medium',
    ...overrides,
  };
}

describe('wrapActionWithTelemetry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records success duration (actionId / riskLevel / startedAt / durationMs / ok)', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_042);

    const wrapped = wrapActionWithTelemetry(
      makeDef({
        handler: () => undefined,
      }),
      (event) => events.push(event),
    );

    await wrapped.handler();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actionId: 'demo-action',
      riskLevel: 'medium',
      startedAt: 1_000,
      durationMs: 42,
      ok: true,
      phase: 'execute',
    });
    expect(events[0]?.error).toBeUndefined();
  });

  it('records failure duration and rethrows the original error', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const boom = new Error('handler exploded');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(5_000).mockReturnValueOnce(5_017);

    const wrapped = wrapActionWithTelemetry(
      makeDef({
        riskLevel: 'high',
        handler: () => {
          throw boom;
        },
      }),
      (event) => events.push(event),
    );

    await expect(wrapped.handler()).rejects.toBe(boom);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actionId: 'demo-action',
      riskLevel: 'high',
      startedAt: 5_000,
      durationMs: 17,
      ok: false,
      error: boom,
      phase: 'execute',
    });
  });

  it('rethrows async rejection after recording telemetry', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const boom = new Error('async fail');
    const wrapped = wrapActionWithTelemetry(
      makeDef({
        handler: async () => {
          throw boom;
        },
      }),
      (event) => events.push(event),
    );

    await expect(wrapped.handler()).rejects.toBe(boom);
    expect(events[0]?.ok).toBe(false);
    expect(events[0]?.error).toBe(boom);
  });

  it('uses console.debug as the default sink when none is provided', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const wrapped = wrapActionWithTelemetry(
      makeDef({
        handler: () => undefined,
      }),
    );

    await wrapped.handler();

    expect(debug).toHaveBeenCalled();
    const [, event] = debug.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      actionId: 'demo-action',
      ok: true,
    });
  });
});

describe('defaultGenerativeActionTelemetrySink', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes the event to console.debug', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const event: GenerativeActionTelemetryEvent = {
      actionId: 'x',
      riskLevel: 'low',
      startedAt: 1,
      durationMs: 2,
      ok: true,
    };
    defaultGenerativeActionTelemetrySink(event);
    expect(debug).toHaveBeenCalledWith('[generative-ui:action]', event);
  });
});

describe('withGenerativeActionInstrumentation', () => {
  it('wraps every handler without changing ids / labels / riskLevel', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const inner = vi.fn();
    const handlers = withGenerativeActionInstrumentation(
      {
        'start-review': makeDef({
          id: 'start-review',
          label: '开始复习',
          riskLevel: 'low',
          handler: inner,
        }),
      },
      { sink: (event) => events.push(event) },
    );

    expect(handlers['start-review']?.id).toBe('start-review');
    expect(handlers['start-review']?.label).toBe('开始复习');
    expect(handlers['start-review']?.riskLevel).toBe('low');

    await handlers['start-review']?.handler();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.actionId).toBe('start-review');
    expect(events[0]?.fingerprint).toBeUndefined();
  });

  it('attaches optional fingerprint from intent without changing required sink fields', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const intent: GenerativeUIIntent = {
      version: '1',
      blocks: [{ type: 'text', props: { body: 'hello' } }],
    };
    const handlers = withGenerativeActionInstrumentation(
      {
        'copy-intent': makeDef({
          id: 'copy-intent',
          handler: () => undefined,
        }),
      },
      { sink: (event) => events.push(event), intent },
    );

    await handlers['copy-intent']?.handler();
    expect(events[0]).toMatchObject({
      actionId: 'copy-intent',
      riskLevel: 'medium',
      ok: true,
      phase: 'execute',
      fingerprint: fingerprintGenerativeUIIntent(intent),
    });
  });
});

describe('wrapActionWithTelemetry extras', () => {
  it('passes through an explicit fingerprint', async () => {
    const events: GenerativeActionTelemetryEvent[] = [];
    const wrapped = wrapActionWithTelemetry(
      makeDef({ handler: () => undefined }),
      (event) => events.push(event),
      { fingerprint: 'deadbeefcafebabe' },
    );

    await wrapped.handler();
    expect(events[0]?.fingerprint).toBe('deadbeefcafebabe');
  });
});
