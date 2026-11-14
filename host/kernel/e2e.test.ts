/**
 * 端到端：以真实子进程运行 host/kernel/main.ts，经协议消息驱动
 * 握手 → invoke → 事件 → 协议流 → abandon → shutdown。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain, type MainToHostMessage } from './protocol.ts';
import { electronParentPortTransport, type ParentPortLike, type PortLike } from './transports.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const SOURCE = { window: 'main', webview: 'main' };

class HostProcess {
  readonly child: ChildProcess;
  readonly received: HostToMain[] = [];
  stderr = '';
  private waiters: { match: (m: HostToMain) => boolean; resolve: (m: HostToMain) => void }[] = [];
  readonly exited: Promise<number | null>;

  constructor(args: string[]) {
    this.child = fork(MAIN, [...args, `--tauri-dir=${FIXTURES}`], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    this.child.stderr?.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.child.on('message', (message) => {
      const m = message as HostToMain;
      this.received.push(m);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(m)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(m);
        }
      }
    });
    this.exited = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)));
  }

  send(message: MainToHostMessage): void {
    this.child.send(message);
  }

  next<K extends HostToMain['kind']>(kind: K, match: (m: Extract<HostToMain, { kind: K }>) => boolean = () => true, timeoutMs = 10_000): Promise<Extract<HostToMain, { kind: K }>> {
    const existing = this.received.find((m) => m.kind === kind && match(m as Extract<HostToMain, { kind: K }>));
    if (existing) {
      this.received.splice(this.received.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<HostToMain, { kind: K }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}; stderr:\n${this.stderr}`)), timeoutMs);
      this.waiters.push({
        match: (m) => m.kind === kind && match(m as Extract<HostToMain, { kind: K }>),
        resolve: (m) => {
          clearTimeout(timer);
          const index = this.received.indexOf(m);
          if (index >= 0) this.received.splice(index, 1);
          resolve(m as Extract<HostToMain, { kind: K }>);
        },
      });
    });
  }
}

const handshake = (extra: Partial<Handshake> = {}): Handshake => ({
  kind: 'handshake',
  protocol: HOST_PROTOCOL_VERSION,
  appDataDir: '/tmp/dstu-e2e-unused',
  appVersion: '1.2.3',
  platform: 'darwin',
  debug: true,
  ...extra,
});

let host: HostProcess | null = null;
afterEach(() => {
  if (host && host.child.exitCode === null) host.child.kill('SIGKILL');
  host = null;
});

describe('Host process end to end', () => {
  it('F1-RAWJSON-02 preserves raw origin through the real process result/error/event protocol', async () => {
    host = new HostProcess([`--profile=${FIXTURES}raw-json.profile.json`, `--contracts=${FIXTURES}contracts`]);
    host.send(handshake({ debug: false }));
    await host.next('ready');
    const text = '{"raw":1e400,"typed":null,"decimal":1.234567890123456789,"nested":[-0,-1e-400,9007199254740993],"plain":{"rawJSON":"1e400"}}';
    for (const mode of ['success', 'error']) {
      host.send({ kind: 'invoke', id: mode, cmd: 'fixture_raw_json', args: { mode }, source: SOURCE });
      const result = await host.next('result', message => message.id === mode);
      expect(result.ok).toBe(mode === 'success');
      expect(result.json).toBe(text);
      expect(result.ok ? result.value : result.error).toEqual(JSON.parse(text));
      const event = await host.next('event', message => message.event === 'fixture-raw-json');
      expect(event.payloadJson).toBe(text);
      expect(event.payload).toEqual(JSON.parse(text));
      expect(event.target).toEqual({ kind: 'Any' });
    }
    host.send({ kind: 'invoke', id: 'ordinary', cmd: 'fixture_raw_json', args: { mode: 'ordinary' }, source: SOURCE });
    const ordinary = await host.next('result', message => message.id === 'ordinary');
    expect(Object.hasOwn(ordinary, 'json')).toBe(false);
    expect(ordinary.ok && JSON.parse(JSON.stringify(ordinary.value))).toEqual({ typed: null, plain: { rawJSON: '1e400' } });
    const event = await host.next('event', message => message.event === 'fixture-raw-json');
    expect(Object.hasOwn(event, 'payloadJson')).toBe(false);
    host.send({ kind: 'invoke', id: 'raw-binary', cmd: 'fixture_binary', args: new Uint8Array([1]), source: SOURCE });
    const binary = await host.next('result', message => message.id === 'raw-binary');
    expect(binary.ok && binary.value).toBeInstanceOf(Uint8Array);
    expect(Object.hasOwn(binary, 'json')).toBe(false);
    host.send({ kind: 'shutdown' });
    await expect(host.exited).resolves.toBe(0);
  }, 30_000);

  it('handshake → invoke → events → protocol stream → abandon → shutdown', async () => {
    host = new HostProcess([`--profile=${FIXTURES}e2e.profile.json`, `--contracts=${FIXTURES}contracts`]);
    // 握手之前发出的消息会被缓冲，ready 之后再处理。
    host.send({ kind: 'invoke', id: 'early', cmd: 'fixture_greet', args: { name: 'Early' }, source: SOURCE });
    host.send(handshake());
    await expect(host.next('ready')).resolves.toEqual({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    await expect(host.next('result', (m) => m.id === 'early')).resolves.toEqual({ kind: 'result', id: 'early', ok: true, value: 'Hi, Early' });

    host.send({ kind: 'invoke', id: 'i1', cmd: 'fixture_greet', args: { name: 'Ada', times: 2 }, source: SOURCE });
    await expect(host.next('result', (m) => m.id === 'i1')).resolves.toEqual({ kind: 'result', id: 'i1', ok: true, value: 'Hi, Ada Hi, Ada' });
    await expect(host.next('event', (m) => m.event === 'fixture-greeted' && (m.payload as { name: string }).name === 'Ada')).resolves.toMatchObject({ target: { kind: 'Any' } });

    const rawHeaders = { 'content-type': 'application/octet-stream', 'x-raw-body': '1' };
    host.send({ kind: 'invoke', id: 'headers', cmd: 'fixture_headers', args: {}, source: SOURCE, headers: rawHeaders });
    await expect(host.next('result', (m) => m.id === 'headers')).resolves.toEqual({ kind: 'result', id: 'headers', ok: true, value: rawHeaders });

    // x-binary（Rust `tauri::ipc::Response`）：原始字节经 fork advanced serialization 原样到达 main，
    // 不经过 JSON 数组/对象转换；raw body 输入（HEIC 的 Request 注入）同样可用。
    host.send({ kind: 'invoke', id: 'binary', cmd: 'fixture_binary', args: new Uint8Array([0x48, 0x45, 0x49, 0x43]), source: SOURCE });
    const binary = await host.next('result', (m) => m.id === 'binary');
    expect(binary).toMatchObject({ kind: 'result', id: 'binary', ok: true });
    const binaryValue = (binary as { value: unknown }).value;
    expect(binaryValue).toBeInstanceOf(Uint8Array);
    expect(Array.from(binaryValue as Uint8Array)).toEqual([0x89, 0x50, 0x4e, 0x47]);

    host.send({ kind: 'invoke', id: 'i2', cmd: 'fixture_greet', args: {}, source: SOURCE });
    await expect(host.next('result', (m) => m.id === 'i2')).resolves.toEqual({
      kind: 'result', id: 'i2', ok: false, error: 'invalid args `name` for command `fixture_greet`: command fixture_greet missing required key name',
    });
    host.send({ kind: 'invoke', id: 'i3', cmd: 'nope', args: {}, source: SOURCE });
    await expect(host.next('result', (m) => m.id === 'i3')).resolves.toEqual({ kind: 'result', id: 'i3', ok: false, error: 'nope not allowed. Command not found' });

    host.send({ kind: 'frontend-event', event: 'fixture-ping', payload: { n: 7 }, target: { kind: 'Any' }, source: { window: 'quick', webview: 'quick' } });
    await expect(host.next('event', (m) => m.event === 'fixture-pong')).resolves.toMatchObject({ payload: { payload: { n: 7 }, from: 'quick' } });

    host.send({ kind: 'protocol', id: 'p1', scheme: 'fixturestream', url: 'fixturestream://localhost/chunks?n=2', method: 'GET', headers: {} });
    const head = await host.next('protocol-result', (m) => m.id === 'p1');
    expect(head).toMatchObject({ status: 206, final: false, headers: { 'content-type': 'application/octet-stream' } });
    const chunks: string[] = [];
    for (;;) {
      const chunk = await host.next('protocol-chunk', (m) => m.id === 'p1');
      chunks.push(new TextDecoder().decode(chunk.body));
      if (chunk.final) break;
    }
    expect(chunks).toEqual(['chunk0;', 'chunk1;', '']);

    host.send({ kind: 'invoke', id: 'slow', cmd: 'fixture_slow', args: { ms: 60_000 }, source: SOURCE });
    // 等处理函数开始运行再放弃。
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.send({ kind: 'abandon', id: 'slow', reason: 'window-closed' });
    await expect(host.next('event', (m) => m.event === 'fixture-aborted')).resolves.toMatchObject({ payload: { invokeId: 'slow', reason: 'window-closed' }, target: { kind: 'WebviewWindow', label: 'main' } });
    await expect(host.next('result', (m) => m.id === 'slow')).resolves.toEqual({ kind: 'result', id: 'slow', ok: false, error: 'aborted' });

    host.send({ kind: 'shutdown' });
    await expect(host.exited).resolves.toBe(0);
  }, 30_000);

  it('reports HostFatal and exits 1 when the profile file is invalid', async () => {
    host = new HostProcess([`--profile=${FIXTURES}invalid.profile.json`, `--contracts=${FIXTURES}contracts`]);
    host.send(handshake());
    const fatal = await host.next('fatal');
    expect(fatal.message).toBe(`${FIXTURES}invalid.profile.json: plugins[0]: "module" must be a non-empty string`);
    await expect(host.exited).resolves.toBe(1);
    expect(host.received.some((m) => m.kind === 'ready')).toBe(false);
  }, 30_000);

  it('rejects a protocol version mismatch', async () => {
    host = new HostProcess([`--contracts=${FIXTURES}contracts`]);
    host.send({ ...handshake(), protocol: 999 as never });
    await expect(host.next('fatal')).resolves.toMatchObject({ message: 'invalid handshake: protocol mismatch: main speaks 999, Host speaks 1' });
    await expect(host.exited).resolves.toBe(1);
  }, 30_000);

  it('shuts down when the IPC channel disconnects', async () => {
    host = new HostProcess([`--contracts=${FIXTURES}contracts`]);
    host.send(handshake({ profile: `${FIXTURES}e2e.profile.json` }));
    await host.next('ready');
    host.child.disconnect();
    await expect(host.exited).resolves.toBe(0);
  }, 30_000);
});

describe('Electron parentPort transport', () => {
  it('adopts a transferred MessagePort from the first message', async () => {
    const control = new MessageChannel();
    const connection = new MessageChannel();
    const parentPort: ParentPortLike = {
      postMessage: (message) => control.port1.postMessage(message),
      on: (_event, listener) => {
        control.port1.on('message', (data: { data: unknown; ports: PortLike[] }) => listener(data));
        return parentPort;
      },
      off: () => parentPort,
    };
    const transportPromise = electronParentPortTransport(parentPort);
    // Electron 中 main 用 child.postMessage({ kind: 'connect' }, [port]) 转移端口；这里直接构造同形状的事件。
    control.port1.emit('message', { data: { kind: 'connect' }, ports: [wrapNodePort(connection.port2)] });
    const transport = await transportPromise;
    const received: unknown[] = [];
    transport.onMessage((m) => received.push(m));
    connection.port1.postMessage({ kind: 'handshake' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([{ kind: 'handshake' }]);
    const back = new Promise((resolve) => connection.port1.once('message', resolve));
    transport.send({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    await expect(back).resolves.toEqual({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    transport.close();
    control.port1.close();
    connection.port1.close();
  });
});

/** 把 Node MessagePort 包成 Electron MessagePortMain 的事件形状（`{ data }`）。 */
function wrapNodePort(port: import('node:worker_threads').MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    on: ((event: 'message' | 'close', listener: (e?: unknown) => void) => {
      if (event === 'message') port.on('message', (data) => listener({ data }));
      else port.on('close', () => listener());
      return port;
    }) as PortLike['on'],
    start: () => port.start(),
    close: () => port.close(),
  };
}
