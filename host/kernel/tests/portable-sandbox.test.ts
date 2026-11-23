import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageChannel as WorkerThreadsMessageChannel } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { checkModulesClosure } from '../../../scripts/portability/lib/portability.mjs';
import {
  SandboxError,
  SandboxHostBroker,
  createSandboxGuestBridge,
  type SandboxTransport,
} from '../sandbox/portable-sandbox.ts';
import {
  createMemoryTransportPair,
  createMessagePortTransport,
  type MessagePortLike,
} from '../sandbox/worker-sandbox-host.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PORTABLE_SANDBOX_PATH = fileURLToPath(new URL('../sandbox/portable-sandbox.ts', import.meta.url));

interface TransportPairFactory {
  name: string;
  create: () => {
    hostTransport: SandboxTransport;
    guestTransport: SandboxTransport;
    cleanup: () => Promise<void> | void;
  };
}

const TRANSPORT_FACTORIES: readonly TransportPairFactory[] = [
  {
    name: 'createMemoryTransportPair',
    create: () => {
      const [hostTransport, guestTransport] = createMemoryTransportPair();
      return {
        hostTransport,
        guestTransport,
        cleanup: async () => {
          await hostTransport.terminate();
          await guestTransport.terminate();
        },
      };
    },
  },
  {
    name: 'global MessageChannel (Web MessagePort)',
    create: () => {
      const channel = new MessageChannel();
      const hostTransport = createMessagePortTransport(channel.port1);
      const guestTransport = createMessagePortTransport(channel.port2);
      return {
        hostTransport,
        guestTransport,
        cleanup: async () => {
          await hostTransport.terminate();
          await guestTransport.terminate();
        },
      };
    },
  },
  {
    name: 'node:worker_threads MessageChannel (on/off EventEmitter port)',
    create: () => {
      const channel = new WorkerThreadsMessageChannel();
      const asEventEmitterPort = (port: typeof channel.port1): MessagePortLike => ({
        postMessage: (msg) => port.postMessage(msg),
        on: (event, listener) => port.on(event, listener),
        off: (event, listener) => port.off(event, listener),
        close: () => port.close(),
      });
      const hostTransport = createMessagePortTransport(asEventEmitterPort(channel.port1));
      const guestTransport = createMessagePortTransport(asEventEmitterPort(channel.port2));
      return {
        hostTransport,
        guestTransport,
        cleanup: async () => {
          await hostTransport.terminate();
          await guestTransport.terminate();
        },
      };
    },
  },
];

describe('portable sandbox runtime foundation', () => {
  it('has ZERO node:* imports and a completely Node-free runtime closure', () => {
    const source = readFileSync(PORTABLE_SANDBOX_PATH, 'utf8');
    expect(source).not.toMatch(/['"]node:[^'"]+['"]/);
    expect(checkModulesClosure(ROOT, ['host/kernel/sandbox/portable-sandbox.ts'])).toEqual([]);
    expect(checkModulesClosure(ROOT, ['host/kernel/sandbox/worker-sandbox-host.ts'])).toEqual([]);
  });

  describe.each(TRANSPORT_FACTORIES)('broker + guest bridge over $name', (factory) => {
    function setup(options?: { defaultTimeoutMs?: number; maxConcurrentCalls?: number }) {
      const pair = factory.create();
      const terminateSpy = vi.spyOn(pair.hostTransport, 'terminate');
      const notes = [
        { id: 'n-1', title: 'Linear Algebra', tags: ['math'] },
        { id: 'n-2', title: 'Organic Chemistry', tags: ['chem'] },
      ];

      class StudyNotesApi {
        private readonly prefix = 'note';
        list(tag?: string) {
          const filtered = tag ? notes.filter((n) => n.tags.includes(tag)) : notes;
          return filtered.map((n) => ({ ...n, kind: this.prefix }));
        }
      }

      const secretSpy = vi.fn(() => 'super-secret-token');
      const broker = new SandboxHostBroker({
        pluginId: 'alice.study-helper',
        manifest: {
          id: 'alice.study-helper',
          permissions: ['service:studyData'],
        },
        transport: pair.hostTransport,
        services: {
          studyData: {
            notes: new StudyNotesApi(),
            slowOp: () => new Promise((resolve) => setTimeout(() => resolve('done'), 80)),
          },
          secrets: {
            get: secretSpy,
          },
        },
        defaultTimeoutMs: options?.defaultTimeoutMs ?? 500,
        maxConcurrentCalls: options?.maxConcurrentCalls ?? 4,
      });

      const guest = createSandboxGuestBridge(pair.guestTransport, {
        greet: (name: unknown) => `Hello, ${String(name)}!`,
        sumAsync: async (a: unknown, b: unknown) => Number(a) + Number(b),
        hangForever: () => new Promise(() => {}),
        slowEcho: (val: unknown) => new Promise((resolve) => setTimeout(() => resolve(val), 80)),
      });

      return { pair, broker, guest, secretSpy, terminateSpy };
    }

    it('allows guest to invoke declared service:studyData dot-path methods and returns JSON data', async () => {
      const { pair, broker, guest } = setup();
      try {
        const result = await guest.callHost('studyData', 'notes.list', 'math');
        expect(result).toEqual([{ id: 'n-1', title: 'Linear Algebra', tags: ['math'], kind: 'note' }]);
      } finally {
        guest.dispose();
        await broker.dispose();
        await pair.cleanup();
      }
    });

    it('fails closed with PERMISSION_DENIED when guest calls an undeclared service', async () => {
      const { pair, broker, guest, secretSpy } = setup();
      try {
        await expect(guest.callHost('secrets', 'get', 'api_key')).rejects.toMatchObject({
          name: 'SandboxError',
          code: 'PERMISSION_DENIED',
        });
        expect(secretSpy).not.toHaveBeenCalled();
      } finally {
        guest.dispose();
        await broker.dispose();
        await pair.cleanup();
      }
    });

    it('fails closed with PERMISSION_DENIED on prototype pollution attempts', async () => {
      const { pair, broker, guest } = setup();
      try {
        const attempts: Array<[string, string]> = [
          ['studyData', '__proto__.toString'],
          ['studyData', 'constructor.constructor'],
          ['__proto__', 'toString'],
          ['constructor', 'constructor'],
          ['studyData', 'toString'],
          ['studyData', 'notes.list.constructor'],
          ['studyData', 'notes.list.call'],
        ];
        for (const [service, method] of attempts) {
          const err = await guest.callHost(service, method).catch((e) => e);
          expect(err, `expected PERMISSION_DENIED for ${service}.${method}`).toBeInstanceOf(SandboxError);
          expect((err as SandboxError).code, `for ${service}.${method}`).toBe('PERMISSION_DENIED');
        }
      } finally {
        guest.dispose();
        await broker.dispose();
        await pair.cleanup();
      }
    });

    it('invokes guest handlers and rejects hung guest handlers with SANDBOX_TIMEOUT within budget', async () => {
      const { pair, broker, guest } = setup({ defaultTimeoutMs: 500 });
      try {
        expect(await broker.callPlugin('greet', ['DeepStudent'])).toBe('Hello, DeepStudent!');
        expect(await broker.callPlugin('sumAsync', [19, 23])).toBe(42);

        const started = Date.now();
        await expect(broker.callPlugin('hangForever', [], 40)).rejects.toMatchObject({
          name: 'SandboxError',
          code: 'SANDBOX_TIMEOUT',
        });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(400);
      } finally {
        guest.dispose();
        await broker.dispose();
        await pair.cleanup();
      }
    });

    it('enforces maxConcurrentCalls with SANDBOX_OVERLOADED in both directions', async () => {
      const { pair, broker, guest } = setup({ maxConcurrentCalls: 2, defaultTimeoutMs: 500 });
      try {
        const p1 = broker.callPlugin('slowEcho', ['a']);
        const p2 = broker.callPlugin('slowEcho', ['b']);
        await expect(broker.callPlugin('slowEcho', ['c'])).rejects.toMatchObject({
          name: 'SandboxError',
          code: 'SANDBOX_OVERLOADED',
        });
        expect(await Promise.all([p1, p2])).toEqual(['a', 'b']);

        const g1 = guest.callHost('studyData', 'slowOp');
        const g2 = guest.callHost('studyData', 'slowOp');
        const g3 = guest.callHost('studyData', 'slowOp');
        const outcomes = await Promise.allSettled([g1, g2, g3]);
        const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect(rejected.length).toBeGreaterThanOrEqual(1);
        expect(rejected[0]!.reason).toMatchObject({
          name: 'SandboxError',
          code: 'SANDBOX_OVERLOADED',
        });
      } finally {
        guest.dispose();
        await broker.dispose();
        await pair.cleanup();
      }
    });

    it('rejects pending calls with SANDBOX_DISPOSED and calls transport.terminate() on dispose()', async () => {
      const { pair, broker, guest, terminateSpy } = setup({ defaultTimeoutMs: 2_000 });
      try {
        const pending = broker.callPlugin('hangForever');
        await broker.dispose();
        await broker.dispose(); // idempotent

        await expect(pending).rejects.toMatchObject({
          name: 'SandboxError',
          code: 'SANDBOX_DISPOSED',
        });
        expect(broker.disposed).toBe(true);
        expect(terminateSpy).toHaveBeenCalledTimes(1);

        await expect(broker.callPlugin('greet', ['after-dispose'])).rejects.toMatchObject({
          name: 'SandboxError',
          code: 'SANDBOX_DISPOSED',
        });
      } finally {
        guest.dispose();
        await pair.cleanup();
      }
    });
  });
});
