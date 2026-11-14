import { expect, test } from 'vitest';
import { unexpectedIpcFailures, type G1Call } from './__fixtures__/g1-ipc-verdict.ts';

// Values from the 891d75ed real-dist vEROQT recording, including its unintended shutdown error.
const failure = (cmd: string, args: unknown, error: string): G1Call => ({
  phase: 'platform-probes', cmd, outcome: 'error',
  payload: { contentType: 'application/json', data: JSON.stringify(args) },
  body: { kind: 'json', data: JSON.stringify(error) },
});
const opener = failure('plugin:opener|open_url', { url: 'x1-invalid-url' }, 'Not allowed to open url x1-invalid-url');
const updater = failure('plugin:updater|check', { timeout: -1 },
  'The value of "delay" is out of range. It must be >= 0 && <= 4294967295. Received -1');

test('the two exact deliberate negative probes do not turn G1 red', () => {
  expect(unexpectedIpcFailures([opener, updater])).toEqual([]);
});

test('snapshot save rejected during shutdown turns G1 red even in platform-probes', () => {
  const save = failure('save_setting', { key: 'desktop.workbenchSnapshot', value: '{}' }, 'Desktop Host exited (code 0)');
  expect(unexpectedIpcFailures([opener, updater, save])).toEqual([save]);
});

test.each([opener, updater])('$cmd does not exempt a different input, phase, outcome or error category', probe => {
  const wrongInput = { ...probe, payload: { ...probe.payload, data: probe === opener
    ? JSON.stringify({ url: 'https://example.com' }) : JSON.stringify({ timeout: 10 }) } };
  const extraInput = { ...probe, payload: { ...probe.payload, data: probe === opener
    ? JSON.stringify({ url: 'x1-invalid-url', extra: true }) : JSON.stringify({ timeout: -1, extra: true }) } };
  const hostExit = { ...probe, body: { kind: 'json', data: JSON.stringify('Desktop Host exited (code 0)') } };
  const failures = [wrongInput, extraInput, hostExit, { ...probe, phase: 'workbench:settings' },
    { ...probe, outcome: 'pending' }, { ...probe, outcome: 'timeout' },
    { ...probe, payload: { contentType: 'application/json', data: 'not-json' } }];
  expect(unexpectedIpcFailures(failures)).toEqual(failures);
});

test('ordinary successful calls stay green; unrelated errors in the probe phase stay red', () => {
  const clipboard = failure('plugin:clipboard-manager|read_text', {}, 'clipboard unavailable');
  expect(unexpectedIpcFailures([{ ...clipboard, outcome: 'result' }, clipboard])).toEqual([clipboard]);
});
