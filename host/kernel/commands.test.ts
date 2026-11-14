import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Service, type Context } from '@deepseek-ai/cordis';
import { CommandError, definePlugin } from './api.ts';
import { ContractSet } from './contracts.ts';
import greeter from './__fixtures__/greeter.plugin.ts';
import { createTestHost, HandlerPanic } from './testing.ts';

const FIXTURE_CONTRACTS = fileURLToPath(new URL('./__fixtures__/contracts', import.meta.url));
const contracts = () => ContractSet.fromDirectory(FIXTURE_CONTRACTS);

describe('command registry', () => {
  it('invokes a registered command with validated args', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    try {
      await expect(host.invoke('fixture_greet', { name: 'Ada' })).resolves.toBe('Hello, Ada');
      await expect(host.invoke('fixture_greet', { name: 'Ada', times: 2, extra: 'ignored' })).resolves.toBe('Hello, Ada Hello, Ada');
      // Option 参数：null 与缺省都是 None。
      await expect(host.invoke('fixture_greet', { name: 'Ada', times: null })).resolves.toBe('Hello, Ada');
      expect(host.eventsNamed('fixture-greeted')).toEqual([{ name: 'Ada' }, { name: 'Ada' }, { name: 'Ada' }]);
    } finally {
      await host.dispose();
    }
  });

  it('passes config to apply', async () => {
    const host = await createTestHost({ plugins: [[greeter, { greeting: 'Hey' }]], contracts: contracts() });
    await expect(host.invoke('fixture_greet', { name: 'Bo' })).resolves.toBe('Hey, Bo');
    await host.dispose();
  });

  it('maps undefined results to null', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    await expect(host.invoke('fixture_unit')).resolves.toBeNull();
    await host.dispose();
  });

  it('rejects with CommandError.value verbatim', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    await expect(host.invoke('fixture_greet', { name: '' })).rejects.toBe('name must not be empty');
    await host.dispose();
  });

  it('returns the exact Tauri ACL rejection for unknown commands', async () => {
    const debugHost = await createTestHost({ contracts: contracts() });
    await expect(debugHost.invoke('no_such_command')).rejects.toBe('no_such_command not allowed. Command not found');
    await expect(debugHost.invoke('plugin:fs|read_file')).rejects.toBe('fs.read_file not allowed. Plugin not found');
    // 有契约但尚未被任何插件注册的命令，与未知命令同样对待。
    await expect(debugHost.invoke('fixture_unported')).rejects.toBe('fixture_unported not allowed. Command not found');
    await debugHost.dispose();

    const releaseHost = await createTestHost({ contracts: contracts(), app: { debug: false } });
    await expect(releaseHost.invoke('no_such_command')).rejects.toBe('Command no_such_command not allowed by ACL');
    await expect(releaseHost.invoke('plugin:fs|read_file')).rejects.toBe('Command plugin:fs|read_file not allowed by ACL');
    await releaseHost.dispose();
  });

  it('produces Tauri invalid-args strings', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    try {
      await expect(host.invoke('fixture_greet', {})).rejects.toBe('invalid args `name` for command `fixture_greet`: command fixture_greet missing required key name');
      await expect(host.invoke('fixture_greet', { name: 5 })).rejects.toBe('invalid args `name` for command `fixture_greet`: invalid type: number, expected a string');
      await expect(host.invoke('fixture_greet', { name: null })).rejects.toBe('invalid args `name` for command `fixture_greet`: invalid type: null, expected a string');
      // 对象路径（没有 argsJson 文本）按 serde Number::deserialize_any 的访问顺序报错。
      await expect(host.invokeRaw('fixture_greet', { name: 'a', times: -1 })).rejects.toBe('invalid args `times` for command `fixture_greet`: invalid value: integer `-1`, expected u32');
      await expect(host.invokeRaw('fixture_greet', { name: 'a', times: 1.5 })).rejects.toBe('invalid args `times` for command `fixture_greet`: invalid type: floating point `1.5`, expected u32');
      // 生产路径（argsJson）：arbitrary_precision 下 Number::deserialize_u32 直接解析数字文本（serde.ts checkInteger）。
      await expect(host.invoke('fixture_greet', { name: 'a', times: -1 })).rejects.toBe('invalid args `times` for command `fixture_greet`: invalid number');
      await expect(host.invoke('fixture_greet', { name: 'a', times: 1.5 })).rejects.toBe('invalid args `times` for command `fixture_greet`: invalid number');
      await expect(host.invoke('fixture_greet', { name: 'a', times: '2' })).rejects.toBe('invalid args `times` for command `fixture_greet`: invalid type: string "2", expected u32');
      // 载荷不是对象：Value::get 对数组/null 都返回 None。
      await expect(host.invoke('fixture_greet', ['Ada'])).rejects.toBe('invalid args `name` for command `fixture_greet`: command fixture_greet missing required key name');
      // 字节载荷（InvokeBody::Raw）。
      await expect(host.invoke('fixture_greet', new Uint8Array([1]))).rejects.toBe(
        'invalid args `name` for command `fixture_greet`: command fixture_greet expected a value for key name but the IPC call used a bytes payload',
      );
    } finally {
      await host.dispose();
    }
  });

  it('reports struct and enum errors like serde', async () => {
    const plugin = definePlugin({
      meta: { id: 'fixture.struct', commands: ['fixture_struct'] },
      apply(ctx) {
        ctx.commands.register<{ request: { title: string; count: number }; mode: string; origin: unknown }>('fixture_struct', ({ request, mode, origin }) => ({
          summary: `${request.title}/${request.count}/${mode}/${JSON.stringify(origin)}`,
        }));
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    const err = (key: string, detail: string) => `invalid args \`${key}\` for command \`fixture_struct\`: ${detail}`;
    try {
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 3 }, mode: 'fast' })).resolves.toEqual({ summary: 't/3/fast/null' });
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 3 }, mode: 'slow', origin: { x: 1, y: -2 } })).resolves.toEqual({ summary: 't/3/slow/{"x":1,"y":-2}' });
      await expect(host.invoke('fixture_struct', { request: { title: 't' }, mode: 'fast' })).rejects.toBe(err('request', 'missing field `count`'));
      await expect(host.invokeRaw('fixture_struct', { request: { title: 't', count: 300 }, mode: 'fast' })).rejects.toBe(err('request', 'invalid value: integer `300`, expected u8'));
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 300 }, mode: 'fast' })).rejects.toBe(err('request', 'invalid number'));
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 1, bogus: 1 }, mode: 'fast' })).rejects.toBe(
        err('request', 'unknown field `bogus`, expected one of `title`, `count`, `tags`, `note`'),
      );
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 1, tags: ['a', 2] }, mode: 'fast' })).rejects.toBe(err('request', 'invalid type: number, expected a string'));
      await expect(host.invoke('fixture_struct', { request: 'x', mode: 'fast' })).rejects.toBe(err('request', 'invalid type: string "x", expected struct GreetRequest'));
      // 参数按 Rust 签名顺序反序列化：request 先于 mode 报错。
      await expect(host.invoke('fixture_struct', { request: 1, mode: 1 })).rejects.toBe(err('request', 'invalid type: number, expected struct GreetRequest'));
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 1 }, mode: 'turbo' })).rejects.toBe(err('mode', 'unknown variant `turbo`, expected one of `fast`, `slow`, `careful`'));
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 1 }, mode: 3 })).rejects.toBe(err('mode', 'invalid type: number, expected string or map'));
      await expect(host.invoke('fixture_struct', { request: { title: 't', count: 1 }, mode: 'fast', origin: { x: 1 } })).rejects.toBe(err('origin', 'missing field `y`'));
    } finally {
      await host.dispose();
    }
  });

  it('treats non-CommandError throws as panics', async () => {
    const plugin = definePlugin({
      meta: { id: 'fixture.panics', commands: ['fixture_unit'] },
      apply(ctx) {
        ctx.commands.register('fixture_unit', () => {
          throw new Error('index out of bounds');
        });
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    await expect(host.invoke('fixture_unit')).rejects.toBeInstanceOf(HandlerPanic);
    await host.dispose();
  });

  it('serializes BigInt at the IPC boundary and rejects other non-JSON results in debug only', async () => {
    let internal: { n: bigint; nested: bigint[]; unsafe: bigint } | undefined;
    const plugin = definePlugin({
      meta: { id: 'fixture.badvalues', commands: ['fixture_echo', 'fixture_greet'] },
      apply(ctx) {
        ctx.commands.register<{ value: string }>('fixture_echo', ({ value }) => {
          if (value === 'map') return new Map([[1, 2]]);
          if (value === 'bigint') {
            internal = { n: 1n, nested: [2n], unsafe: 9007199254740993n };
            return internal;
          }
          if (value === 'hole') return [1, undefined, 3];
          return { ok: true, skipped: undefined };
        });
        ctx.commands.register('fixture_greet', () => 42); // 契约 result 为 string
      },
    });
    const wireBig = { n: 1, nested: [2], unsafe: 9007199254740992 };
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    try {
      await expect(host.invoke('fixture_echo', { value: 'map' })).rejects.toMatch(/\$ is an instance of Map/);
      await expect(host.invoke('fixture_echo', { value: 'bigint' })).resolves.toEqual(wireBig);
      // D3：只转换线上副本，插件返回的内部对象仍是 BigInt。
      expect(internal).toEqual({ n: 1n, nested: [2n], unsafe: 9007199254740993n });
      await expect(host.invoke('fixture_echo', { value: 'hole' })).rejects.toMatch(/\$\[1\] is undefined/);
      await expect(host.invoke('fixture_echo', { value: 'ok' })).resolves.toEqual({ ok: true, skipped: undefined });
      await expect(host.invoke('fixture_greet', { name: 'x' })).rejects.toMatch(/violates its contract .*must be string/);
    } finally {
      await host.dispose();
    }
    const release = await createTestHost({ plugins: [plugin], contracts: contracts(), app: { debug: false } });
    await expect(release.invoke('fixture_echo', { value: 'bigint' })).resolves.toEqual(wireBig);
    await expect(release.invoke('fixture_greet', { name: 'x' })).resolves.toBe(42);
    await release.dispose();
  });

  it('validates CommandError values against the error schema in debug', async () => {
    const plugin = definePlugin({
      meta: { id: 'fixture.errors', commands: ['fixture_struct', 'fixture_unit'] },
      apply(ctx) {
        ctx.commands.register<{ mode: string }>('fixture_struct', ({ mode }) => {
          if (mode === 'fast') throw new CommandError({ code: 'E1', message: 'boom' });
          throw new CommandError({ code: 'E1' });
        });
        ctx.commands.register('fixture_unit', () => {
          throw new CommandError('fixture_unit does not return Result');
        });
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    const request = { title: 't', count: 1 };
    await expect(host.invoke('fixture_struct', { request, mode: 'fast' })).rejects.toEqual({ code: 'E1', message: 'boom' });
    await expect(host.invoke('fixture_struct', { request, mode: 'slow' })).rejects.toMatch(/rejected with a value that violates its contract/);
    await expect(host.invoke('fixture_unit')).rejects.toMatch(/does not return Result in Rust/);
    await host.dispose();
  });

  it('enforces registration rules', async () => {
    const host = await createTestHost({ contracts: contracts() });
    try {
      const undeclared = definePlugin({ meta: { id: 'fixture.undeclared', commands: [] }, apply: (ctx) => ctx.commands.register('fixture_unit', () => null) });
      await expect(host.install(undeclared)).rejects.toThrow(/does not declare this command in meta.commands/);
      const noContract = definePlugin({ meta: { id: 'fixture.nocontract', commands: ['made_up'] }, apply: (ctx) => ctx.commands.register('made_up', () => null) });
      await expect(host.install(noContract)).rejects.toThrow(/no contract for this command/);
      const first = definePlugin({ meta: { id: 'fixture.first', commands: ['fixture_echo'] }, apply: (ctx) => ctx.commands.register('fixture_echo', () => 'first') });
      const second = definePlugin({ meta: { id: 'fixture.second', commands: ['fixture_echo'] }, apply: (ctx) => ctx.commands.register('fixture_echo', () => 'second') });
      await host.install(first);
      await expect(host.install(second)).rejects.toThrow(/already registered by "fixture.first"/);
      expect(host.plugins.map((p) => p.id)).toEqual(['fixture.first']);
      expect(host.ctx.commands.has('fixture_echo')).toBe(true);
      // 注册随插件卸载撤销。
      await host.unload('fixture.first');
      expect(host.ctx.commands.has('fixture_echo')).toBe(false);
      await expect(host.invoke('fixture_echo', { value: 0 })).rejects.toBe('fixture_echo not allowed. Command not found');
      // 撤销后同名可以重新注册。
      await host.install(second);
      await expect(host.invoke('fixture_echo', { value: 0 })).resolves.toBe('second');
    } finally {
      await host.dispose();
    }
  });
});

describe('lifecycle', () => {
  it('aborts and awaits in-flight calls before revoking on unload', async () => {
    const order: string[] = [];
    const plugin = definePlugin({
      meta: { id: 'fixture.lifecycle', commands: ['fixture_slow'] },
      apply(ctx) {
        ctx.effect(() => () => order.push('effect disposed'));
        ctx.commands.register<{ ms: number }, string>('fixture_slow', (_args, call) => new Promise((resolve) => {
          call.signal.addEventListener('abort', () => {
            order.push(`aborted: ${(call.signal.reason as Error).name}`);
            setTimeout(() => {
              order.push('handler settled');
              resolve('late');
            }, 20);
          });
        }));
      },
    });
    const host = await createTestHost({ plugins: [plugin], contracts: contracts() });
    const pending = host.invoke('fixture_slow', { ms: 1000 });
    await Promise.resolve();
    const unloading = host.unload('fixture.lifecycle');
    // 停止期间的新调用被拒绝。
    await expect(host.invoke('fixture_slow', { ms: 1 })).rejects.toBe('fixture_slow not allowed. Command not found');
    await unloading;
    await expect(pending).resolves.toBe('late');
    expect(order).toEqual(['aborted: CommandStoppedError', 'handler settled', 'effect disposed']);
    await host.dispose();
  });

  it('aborts CallContext.signal on abandon without cancelling the result', async () => {
    const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
    const call = host.startInvoke('fixture_slow', { ms: 10_000 });
    call.abandon('reloaded');
    await expect(call.result).rejects.toBe('aborted');
    expect(host.eventsNamed('fixture-aborted')).toEqual([{ invokeId: call.id, reason: 'reloaded' }]);
    expect(host.events.at(-1)?.target).toEqual({ kind: 'WebviewWindow', label: 'main' });
    await host.dispose();
  });

  it('blocks unloading a provider while dependents are installed and rolls back failed installs', async () => {
    class Counter extends Service {
      value = 0;
      constructor(ctx: Context) {
        super(ctx, 'fixtureCounter');
      }
      next() {
        return ++this.value;
      }
    }
    const provider = definePlugin({ meta: { id: 'fixture.counter', provides: ['fixtureCounter'] }, apply: (ctx) => void new Counter(ctx) });
    const consumer = definePlugin({
      meta: { id: 'fixture.consumer', commands: ['fixture_echo'] },
      inject: ['fixtureCounter'],
      apply(ctx) {
        ctx.commands.register('fixture_echo', () => (ctx as Context & { fixtureCounter: Counter }).fixtureCounter.next());
      },
    });
    const host = await createTestHost({ plugins: [provider, consumer], contracts: contracts() });
    try {
      await expect(host.invoke('fixture_echo', { value: 0 })).resolves.toBe(1);
      await expect(host.unload('fixture.counter')).rejects.toThrow(/plugin "fixture.consumer" requires "fixtureCounter"/);
      await host.unload('fixture.consumer');
      await host.unload('fixture.counter');
      expect(host.plugins).toEqual([]);

      // 缺少依赖：安装失败并回滚。
      await expect(host.install(consumer)).rejects.toThrow(/required services not available: "fixtureCounter"/);
      expect(host.ctx.commands.has('fixture_echo')).toBe(false);

      // 声明了 provides 却没有提供。
      const liar = definePlugin({ meta: { id: 'fixture.liar', provides: ['fixtureNothing'] }, apply: () => undefined });
      await expect(host.install(liar)).rejects.toThrow(/declares meta.provides "fixtureNothing" but did not provide it/);
      // 提供了未声明的服务。
      const sneaky = definePlugin({ meta: { id: 'fixture.sneaky' }, apply: (ctx) => void new Counter(ctx) });
      await expect(host.install(sneaky)).rejects.toThrow(/provides "fixtureCounter" without declaring it/);
      expect(host.ctx.get('fixtureCounter')).toBeUndefined();

      // 批量安装中途失败：之前装好的按逆序回滚。
      const failing = definePlugin({ meta: { id: 'fixture.failing' }, apply: () => { throw new Error('nope'); } });
      await expect(host.install(provider, consumer, failing)).rejects.toThrow('nope');
      expect(host.plugins).toEqual([]);
      expect(host.ctx.commands.has('fixture_echo')).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it('provides test doubles for other lanes services', async () => {
    class FakeClock extends Service {
      constructor(ctx: Context) {
        super(ctx, 'fixtureClock');
      }
      now() {
        return 1234;
      }
    }
    const consumer = definePlugin({
      meta: { id: 'fixture.clock-consumer', commands: ['fixture_echo', 'fixture_greet'] },
      inject: ['fixtureClock', 'fixtureStore'],
      apply(ctx) {
        const c = ctx as Context & { fixtureClock: FakeClock; fixtureStore: { get(): string } };
        ctx.commands.register('fixture_echo', () => c.fixtureClock.now());
        ctx.commands.register('fixture_greet', () => c.fixtureStore.get());
      },
    });
    const host = await createTestHost({ plugins: [consumer], provide: { fixtureClock: FakeClock, fixtureStore: { get: () => 'stored' } }, contracts: contracts() });
    await expect(host.invoke('fixture_echo', { value: 0 })).resolves.toBe(1234);
    await expect(host.invoke('fixture_greet', { name: 'x' })).resolves.toBe('stored');
    await host.dispose();
  });

  it('exposes app info and creates/removes a temp data dir', async () => {
    const { existsSync } = await import('node:fs');
    const host = await createTestHost({ contracts: contracts(), app: { version: '9.9.9' } });
    expect(host.ctx.app.version).toBe('9.9.9');
    expect(host.ctx.app.debug).toBe(true);
    expect(existsSync(host.ctx.app.dataDir)).toBe(true);
    await host.dispose();
    expect(existsSync(host.app.dataDir)).toBe(false);
  });
});
