/**
 * `mobile/src/shims/` 与 Node 内建模块对拍（测试在 Node 中运行，真模块就在手边）：
 * 哈希 / HMAC 逐字节一致，Buffer 编码往返一致，EventEmitter 与 util.format 的常用行为一致，不支持的接口抛带 code 的错误。
 */
import * as nodeCrypto from 'node:crypto';
import { EventEmitter as NodeEmitter } from 'node:events';
import * as nodeUtil from 'node:util';
import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from '../../src/shims/async-hooks.ts';
import { Buffer as ShimBuffer } from '../../src/shims/buffer.ts';
import * as childProcess from '../../src/shims/child-process.ts';
import * as crypto from '../../src/shims/crypto.ts';
import events, { EventEmitter, once } from '../../src/shims/events.ts';
import * as os from '../../src/shims/os.ts';
import * as util from '../../src/shims/util.ts';

const INPUTS = ['', 'abc', 'The quick brown fox jumps over the lazy dog', '中文 profile ✓', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)];

describe('crypto shim', () => {
  it.each(['sha256', 'sha1', 'md5'])('createHash(%s) matches node:crypto', (algorithm) => {
    for (const input of INPUTS) {
      expect(crypto.createHash(algorithm).update(input).digest('hex'), `${algorithm} ${input.length}`)
        .toBe(nodeCrypto.createHash(algorithm).update(input).digest('hex'));
    }
    const chunked = crypto.createHash(algorithm).update('ab').update(new TextEncoder().encode('c')).digest('base64');
    expect(chunked).toBe(nodeCrypto.createHash(algorithm).update('abc').digest('base64'));
  });

  it('createHmac matches node:crypto, including keys longer than the block', () => {
    for (const key of ['k', 'k'.repeat(100)]) {
      expect(crypto.createHmac('sha256', key).update('message').digest('hex')).toBe(nodeCrypto.createHmac('sha256', key).update('message').digest('hex'));
    }
  });

  it('random helpers, timingSafeEqual and unsupported APIs', () => {
    expect(crypto.randomBytes(70_000)).toHaveLength(70_000);
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(crypto.randomInt(5, 6)).toBe(5);
    expect(crypto.timingSafeEqual(ShimBuffer.from('ab'), ShimBuffer.from('ab'))).toBe(true);
    expect(crypto.timingSafeEqual(ShimBuffer.from('ab'), ShimBuffer.from('ac'))).toBe(false);
    expect(() => crypto.timingSafeEqual(ShimBuffer.from('a'), ShimBuffer.from('ab'))).toThrow(RangeError);
    expect(() => crypto.createHash('sha512')).toThrow(expect.objectContaining({ code: 'ERR_CRYPTO_UNSUPPORTED_ON_PLATFORM' }));
    expect(() => crypto.createCipheriv()).toThrow(/UNSUPPORTED_ON_PLATFORM/);
  });
});

describe('buffer shim', () => {
  it('round-trips encodings like node:buffer', () => {
    for (const input of INPUTS) {
      for (const encoding of ['utf8', 'hex', 'base64', 'base64url', 'latin1', 'utf16le'] as const) {
        const node = Buffer.from(input, 'utf8').toString(encoding);
        expect(ShimBuffer.from(input, 'utf8').toString(encoding), encoding).toBe(node);
        expect(Array.from(ShimBuffer.from(node, encoding)), encoding).toEqual(Array.from(Buffer.from(node, encoding)));
      }
    }
    expect(ShimBuffer.concat([ShimBuffer.from('a'), ShimBuffer.from('bc')]).toString()).toBe('abc');
    expect(ShimBuffer.byteLength('中')).toBe(3);
    const shared = ShimBuffer.from('abc');
    shared.slice(0, 1)[0] = 0x7a;
    expect(shared.toString()).toBe('zbc');
    expect(ShimBuffer.isBuffer(shared.subarray(1))).toBe(true);
  });
});

describe('events shim', () => {
  it('behaves like node:events for on / once / off / emit and error', async () => {
    const trace = (emitter: EventEmitter | NodeEmitter) => {
      const calls: string[] = [];
      const a = (x: unknown) => calls.push(`a${x}`);
      emitter.on('e', a);
      emitter.once('e', x => calls.push(`once${x}`));
      emitter.emit('e', 1);
      emitter.emit('e', 2);
      emitter.off('e', a);
      calls.push(String(emitter.emit('e', 3)), String(emitter.listenerCount('e')));
      return calls;
    };
    expect(trace(new EventEmitter())).toEqual(trace(new NodeEmitter()));
    expect(() => new EventEmitter().emit('error', new Error('boom'))).toThrow('boom');
    const emitter = new events();
    const waiting = once(emitter, 'ready');
    emitter.emit('ready', 'v');
    await expect(waiting).resolves.toEqual(['v']);
  });
});

describe('util / os / async_hooks / child_process shims', () => {
  it('util.format and promisify', async () => {
    for (const args of [['%s=%d', 'a', 1], ['%j', { a: 1 }], ['plain', 'extra', 2], ['100%%'], ['%s', 'only']] as const) {
      expect(util.format(...args)).toBe(nodeUtil.format(...args));
    }
    const done = util.promisify((x: number, cb: (error: unknown, value: number) => void) => cb(null, x + 1));
    await expect(done(1)).resolves.toBe(2);
    expect(util.TextEncoder).toBe(globalThis.TextEncoder);
    expect(util.inspect({ a: [1, 'x'] })).toBe("{ a: [ 1, 'x' ] }");
  });

  it('os reports the virtual mobile layout', () => {
    expect([os.tmpdir(), os.homedir(), os.platform(), os.EOL]).toEqual(['/deep-student/tmp', '/deep-student', 'linux', '\n']);
  });

  it('AsyncLocalStorage keeps the store for the synchronous run scope', () => {
    const storage = new AsyncLocalStorage<string>();
    expect(storage.run('fiber', () => storage.getStore())).toBe('fiber');
    expect(storage.getStore()).toBeUndefined();
  });

  it('child_process throws UNSUPPORTED_ON_PLATFORM', () => {
    expect(() => childProcess.spawn()).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ON_PLATFORM' }));
  });
});
