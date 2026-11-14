import { expect, it } from 'vitest';
import { parseBridgeEnvelope } from '../shell/browser-protocol.ts';
import type { ShellErrorData } from '../../host/kernel/api.ts';

function rejection(raw: unknown): Error & { data?: ShellErrorData } {
  try { parseBridgeEnvelope(raw); }
  catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected envelope rejection');
}

it('parse_envelope_password_blocked retains typed body independently of Display', () => {
  // bridge.rs:772–796, all original assertions plus exact text/body.
  const error = rejection('{"ok":false,"v":1,"epoch":3,"error":{"code":"BLOCKED","message":"password fields cannot be typed by agent bridge","details":{"reason":"password_field","ref":"e1"}}}');
  expect(error.data?.code).toBe('BLOCKED');
  expect(error.data?.message).toContain('password');
  expect(error.data?.details).toEqual({ reason: 'password_field', ref: 'e1' });
  expect(error.message).toBe('bridge error BLOCKED: password fields cannot be typed by agent bridge');
});

it.each([undefined, null, false, 0, '', [null, { nested: ['原样', false, 0] }]])('finish_script_result_maps_bridge_error_envelope: Option details %j', details => {
  const raw = JSON.stringify({ ok: false, error: { code: 'EVAL_THROW', message: 'x', details } });
  for (const input of [raw, JSON.stringify(raw)]) {
    const error = rejection(input);
    expect(error.message).toBe('bridge error EVAL_THROW: x');
    expect(error.data).toStrictEqual({ code: 'EVAL_THROW', message: 'x', ...(details == null ? {} : { details }) });
    expect(Object.hasOwn(error.data!, 'details')).toBe(details != null);
  }
});

it('keeps non-typed failures plain, including malformed bodies and invalid JSON', () => {
  const inputs = [' ', '{oops', '42', '{"ok":1}', '{"ok":false}', '{"ok":false,"error":null}',
    '{"ok":false,"error":"bridge error BLOCKED: x"}', '{"ok":false,"error":{"code":17,"message":"x"}}',
    '{"ok":false,"error":{"code":"BLOCKED","message":null,"details":{"data":true}}}'];
  for (const input of inputs) expect(rejection(input)).not.toHaveProperty('data');
  expect(rejection(inputs[0]).message).toBe('invalid JSON from bridge: empty script result');
  expect(rejection(inputs[4]).message).toBe('bridge error UNKNOWN: bridge returned ok=false without error');
  expect(rejection(inputs[7]).message).toBe('bridge error UNKNOWN: x');
});
