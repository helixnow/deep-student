/** 测试夹具插件：覆盖命令 / CommandError / 事件 / 协议流 / abandon。用于单测与 E2E。 */
import { CommandError, definePlugin } from '../api.ts';

export interface GreeterConfig {
  greeting?: string;
}

export default definePlugin<GreeterConfig | undefined>({
  meta: {
    id: 'fixture.greeter',
    lane: 'F1-fixture',
    commands: ['fixture_greet', 'fixture_slow', 'fixture_unit', 'fixture_echo', 'fixture_headers', 'fixture_binary', 'fixture_binary_envelope'],
  },
  apply(ctx, config) {
    const greeting = config?.greeting ?? 'Hello';

    ctx.commands.register<{ name: string; times: number | null }, string>('fixture_greet', ({ name, times }) => {
      if (name === '') throw new CommandError('name must not be empty');
      ctx.backendEvents.emit('fixture-greeted', { name });
      return Array.from({ length: times ?? 1 }, () => `${greeting}, ${name}`).join(' ');
    });

    ctx.commands.register<{ ms: number }, string>('fixture_slow', ({ ms }, call) => {
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(`slept ${ms}`), ms);
        call.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          ctx.backendEvents.emitTo({ kind: 'WebviewWindow', label: call.source.webview }, 'fixture-aborted', { invokeId: call.invokeId, reason: String(call.signal.reason) });
          reject(new CommandError('aborted'));
        }, { once: true });
      });
    });

    ctx.commands.register('fixture_unit', () => undefined);
    ctx.commands.register<{ value: unknown }>('fixture_echo', ({ value }) => value);
    ctx.commands.register('fixture_headers', (_args, call) => call.headers ?? null);
    // x-binary 契约：原始字节应原样穿过 Host 边界（不变成 JSON 数组 / 对象）。
    ctx.commands.register('fixture_binary', () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    ctx.commands.register('fixture_binary_envelope', () => ({ __dstuRawBytes: 'AQIDBA==' }));

    ctx.backendEvents.listen('fixture-ping', (payload, source) => {
      ctx.backendEvents.emit('fixture-pong', { payload, from: source.window });
    });

    ctx.protocols.register('fixturestream', (req) => {
      const url = new URL(req.url);
      const n = Number(url.searchParams.get('n') ?? '0');
      if (url.pathname === '/whole') {
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('whole body') };
      }
      async function* chunks() {
        for (let i = 0; i < n; i++) yield new TextEncoder().encode(`chunk${i};`);
        if (url.searchParams.has('fail')) throw new Error('disk went away');
      }
      return { status: 206, headers: { 'content-type': 'application/octet-stream' }, body: chunks() };
    });
  },
});
