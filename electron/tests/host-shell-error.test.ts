/** Supplement the real Electron chain with negative branding cases at the supervisor boundary. */
import { afterEach, expect, it, vi } from 'vitest';
import { MessageChannelMain } from 'electron';
import { HostSupervisor } from '../shell/host.ts';
import { parseBridgeEnvelope } from '../shell/browser-protocol.ts';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    utilityProcess: { fork: () => Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() }) },
    MessageChannelMain: vi.fn(function () {
      return { port1: Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn(), close: vi.fn() }), port2: {} };
    }),
  };
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

it('only a decoded bridge body gains errorData; Error/string/object lookalikes and invalid JSON stay ordinary', async () => {
  vi.useFakeTimers();
  const data = { code: 'BLOCKED', message: 'lookalike', details: { ref: 'e1' } };
  const errors = [new Error('ordinary'), 'bridge error BLOCKED: lookalike', { ...data, data },
    Object.assign(new Error('bridge error BLOCKED: lookalike'), { data }),
    new Error('bridge call timed out after 3s')];
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onUnavailable: vi.fn(), log: vi.fn(),
    onShellRequest: async request => {
      if (request.id === 'invalid') return parseBridgeEnvelope(' ');
      throw errors[Number(request.id)];
    },
  });
  supervisor.start();
  const port = vi.mocked(MessageChannelMain).mock.results[0]!.value.port1;
  port.emit('message', { data: { kind: 'ready', protocol: 1 } });
  for (let i = 0; i < errors.length; i++) {
    port.emit('message', { data: { kind: 'shell-request', id: String(i), op: 'browser.typeText', args: {} } });
  }
  port.emit('message', { data: { kind: 'shell-request', id: 'invalid', op: 'browser.typeText', args: {} } });
  await Promise.resolve();
  expect(port.postMessage.mock.calls.slice(1).map((call: unknown[]) => call[0])).toEqual([
    ...errors.map((error, i) => ({ kind: 'shell-result', id: String(i), ok: false, error: error instanceof Error ? error.message : String(error) })),
    { kind: 'shell-result', id: 'invalid', ok: false, error: 'invalid JSON from bridge: empty script result' },
  ]);
});
