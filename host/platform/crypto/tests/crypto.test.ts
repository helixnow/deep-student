/**
 * `ctx.crypto` 的两种实现跑同一套用例：桌面 Node 实现与 Web（WebCrypto + @noble/hashes）实现。
 * 向量来源：FIPS 180 示例、RFC 2202 / RFC 4231（HMAC）、GCM 规范 Test Case 3/4/16、RFC 4648。
 * `node:crypto` 只在测试里作为对照（oracle）使用。
 */
import { createCipheriv, createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoError, type CryptoService, type DigestAlgorithm } from '../api.ts';
import crypto, { createNodeCrypto } from '../index.ts';
import { createWebCrypto, type WebCryptoLike } from '../web.ts';
import { createTestHost } from '../../../kernel/testing.ts';

const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'));
const toHexString = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function expectPlain(bytes: Uint8Array): void {
  expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
}

async function expectCryptoError(promise: Promise<unknown> | (() => unknown), kind: CryptoError['kind']): Promise<void> {
  let caught: unknown;
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CryptoError);
  expect((caught as CryptoError).kind).toBe(kind);
}

const DIGESTS: Record<DigestAlgorithm, Record<string, string>> = {
  'SHA-1': {
    '': 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    abc: 'a9993e364706816aba3e25717850c26c9cd0d89d',
  },
  'SHA-256': {
    '': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    abc: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  'SHA-384': {
    abc: 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
  },
  'SHA-512': {
    abc: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  },
};

const GCM_P = 'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39';
const GCM_VECTORS = [
  {
    name: 'Test Case 3 (AES-128, no AAD)',
    key: 'feffe9928665731c6d6a8f9467308308',
    iv: 'cafebabefacedbaddecaf888',
    plaintext: `${GCM_P}1aafd255`,
    aad: '',
    ciphertext: '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091473f5985',
    tag: '4d5c2af327cd64a62cf35abd2ba6fab4',
  },
  {
    name: 'Test Case 4 (AES-128, AAD)',
    key: 'feffe9928665731c6d6a8f9467308308',
    iv: 'cafebabefacedbaddecaf888',
    plaintext: GCM_P,
    aad: 'feedfacedeadbeeffeedfacedeadbeefabaddad2',
    ciphertext: '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091',
    tag: '5bc94fbc3221a5db94fae95ae7121a47',
  },
  {
    name: 'Test Case 16 (AES-256, AAD)',
    key: 'feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308',
    iv: 'cafebabefacedbaddecaf888',
    plaintext: GCM_P,
    aad: 'feedfacedeadbeeffeedfacedeadbeefabaddad2',
    ciphertext: '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662',
    tag: '76fc6ece0f4e1768cddf8853bb2d551b',
  },
];

const IMPLEMENTATIONS: Array<[string, () => CryptoService]> = [
  ['node', () => createNodeCrypto()],
  ['web', () => createWebCrypto()],
];

describe.each(IMPLEMENTATIONS)('ctx.crypto (%s implementation)', (name, create) => {
  const service = create();

  it('reports its implementation', () => {
    expect(service.implementation).toBe(name);
  });

  describe('digests', () => {
    for (const [algorithm, vectors] of Object.entries(DIGESTS) as Array<[DigestAlgorithm, Record<string, string>]>) {
      for (const [input, expected] of Object.entries(vectors)) {
        it(`${algorithm}(${JSON.stringify(input)}) async, sync and incremental agree with FIPS 180`, async () => {
          const asyncDigest = await service.digest(algorithm, input);
          expectPlain(asyncDigest);
          expect(toHexString(asyncDigest)).toBe(expected);
          const syncDigest = service.digestSync(algorithm, new TextEncoder().encode(input));
          expectPlain(syncDigest);
          expect(toHexString(syncDigest)).toBe(expected);
          const hasher = service.createHasher(algorithm);
          for (const char of input) hasher.update(char);
          expect(hasher.digestHex()).toBe(expected);
        });
      }
    }

    it('encodes strings as UTF-8 and matches node:crypto on large random input', async () => {
      const text = '错题本 · Δ ✓ 🎓';
      expect(await service.sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      expect(service.sha256HexSync(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      const big = Uint8Array.from(nodeRandomBytes(300_000));
      const expected = createHash('sha256').update(big).digest('hex');
      expect(toHexString(await service.sha256(big))).toBe(expected);
      const hasher = service.createHasher('SHA-256');
      for (let offset = 0; offset < big.length; offset += 65_537) hasher.update(big.subarray(offset, offset + 65_537));
      expect(hasher.digestHex()).toBe(expected);
      expect(await service.sha1Hex(big)).toBe(createHash('sha1').update(big).digest('hex'));
    });

    it('refuses to reuse a finalized hasher', async () => {
      const hasher = service.createHasher('SHA-256').update('abc');
      expectPlain(hasher.digest());
      await expectCryptoError(() => hasher.update('more'), 'HasherFinalized');
      await expectCryptoError(() => hasher.digest(), 'HasherFinalized');
      await expectCryptoError(() => hasher.digestHex(), 'HasherFinalized');
    });
  });

  describe('HMAC', () => {
    const data = 'what do ya want for nothing?';
    it('RFC 2202 / RFC 4231 test case 2 ("Jefe")', async () => {
      expect(toHexString(await service.hmac('SHA-1', 'Jefe', data))).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
      expect(toHexString(await service.hmac('SHA-256', 'Jefe', data))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
      expect(toHexString(await service.hmac('SHA-512', 'Jefe', data))).toBe(
        '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737',
      );
      const sync = service.hmacSync('SHA-256', new TextEncoder().encode('Jefe'), data);
      expectPlain(sync);
      expect(toHexString(sync)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });

    it('RFC 4231 test case 6 (key longer than the block size)', async () => {
      const key = new Uint8Array(131).fill(0xaa);
      const message = 'Test Using Larger Than Block-Size Key - Hash Key First';
      const expected = '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54';
      expect(toHexString(await service.hmac('SHA-256', key, message))).toBe(expected);
      expect(toHexString(service.hmacSync('SHA-256', key, message))).toBe(expected);
    });

    it('accepts an empty key (WebCrypto itself rejects zero-length HMAC keys)', async () => {
      for (const algorithm of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
        const nodeAlgorithm = algorithm.replace('-', '').toLowerCase();
        const expected = createHmac(nodeAlgorithm, Buffer.alloc(0)).update('message').digest('hex');
        expect(toHexString(await service.hmac(algorithm, '', 'message'))).toBe(expected);
        expect(toHexString(service.hmacSync(algorithm, new Uint8Array(0), 'message'))).toBe(expected);
      }
    });
  });

  describe('random', () => {
    it('randomBytes returns plain, distinct buffers of the requested length (including > 65536)', () => {
      const a = service.randomBytes(32);
      const b = service.randomBytes(32);
      expectPlain(a);
      expect(a).toHaveLength(32);
      expect(toHexString(a)).not.toBe(toHexString(b));
      const large = service.randomBytes(200_000);
      expect(large).toHaveLength(200_000);
      // WebCrypto 单次 getRandomValues 上限 65536 字节：分段填充后尾部也必须是随机的。
      expect(large.subarray(150_000).some((byte) => byte !== 0)).toBe(true);
      expect(service.randomBytes(0)).toHaveLength(0);
    });

    it('randomBytes rejects invalid lengths', async () => {
      await expectCryptoError(() => service.randomBytes(-1), 'InvalidArgument');
      await expectCryptoError(() => service.randomBytes(1.5), 'InvalidArgument');
    });

    it('randomUUID is a lowercase RFC 4122 v4 UUID', () => {
      const ids = new Set(Array.from({ length: 50 }, () => service.randomUUID()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('randomInt stays in [min, max) and covers the range', async () => {
      const seen = new Set<number>();
      for (let i = 0; i < 2000; i++) {
        const value = service.randomInt(97, 123);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(97);
        expect(value).toBeLessThan(123);
        seen.add(value);
      }
      expect(seen.size).toBe(26);
      expect(service.randomInt(-5, -4)).toBe(-5);
      const wide = service.randomInt(0, 2 ** 48 - 1);
      expect(wide).toBeGreaterThanOrEqual(0);
      expect(wide).toBeLessThan(2 ** 48 - 1);
      await expectCryptoError(() => service.randomInt(5, 5), 'InvalidArgument');
      await expectCryptoError(() => service.randomInt(0, 2 ** 48), 'InvalidArgument');
      await expectCryptoError(() => service.randomInt(0.5, 3), 'InvalidArgument');
    });
  });

  describe('AES-GCM', () => {
    for (const vector of GCM_VECTORS) {
      it(`encrypts and decrypts ${vector.name}`, async () => {
        const params = { key: hex(vector.key), iv: hex(vector.iv), ...(vector.aad ? { additionalData: hex(vector.aad) } : {}) };
        const sealed = await service.aesGcmEncrypt({ ...params, plaintext: hex(vector.plaintext) });
        expectPlain(sealed);
        expect(toHexString(sealed)).toBe(vector.ciphertext + vector.tag);
        const opened = await service.aesGcmDecrypt({ ...params, ciphertext: sealed });
        expectPlain(opened);
        expect(toHexString(opened)).toBe(vector.plaintext);
      });
    }

    it('round-trips UTF-8 text with a 12-byte tag and empty plaintext', async () => {
      const key = service.randomBytes(32);
      const iv = service.randomBytes(12);
      const sealed = await service.aesGcmEncrypt({ key, iv, plaintext: '学习伴侣', tagLength: 12 });
      expect(sealed).toHaveLength(new TextEncoder().encode('学习伴侣').length + 12);
      const opened = await service.aesGcmDecrypt({ key, iv, ciphertext: sealed, tagLength: 12 });
      expect(service.utf8Decode(opened)).toBe('学习伴侣');
      const empty = await service.aesGcmEncrypt({ key, iv, plaintext: new Uint8Array(0) });
      expect(empty).toHaveLength(16);
      expect(await service.aesGcmDecrypt({ key, iv, ciphertext: empty })).toHaveLength(0);
    });

    it('fails closed with DecryptFailed on tampering, wrong AAD, wrong key or truncated input', async () => {
      const key = service.randomBytes(16);
      const iv = service.randomBytes(12);
      const additionalData = service.utf8Encode('header');
      const sealed = await service.aesGcmEncrypt({ key, iv, additionalData, plaintext: 'secret' });
      const tampered = sealed.slice();
      tampered[0]! ^= 1;
      await expectCryptoError(service.aesGcmDecrypt({ key, iv, additionalData, ciphertext: tampered }), 'DecryptFailed');
      const badTag = sealed.slice();
      badTag[badTag.length - 1]! ^= 0x80;
      await expectCryptoError(service.aesGcmDecrypt({ key, iv, additionalData, ciphertext: badTag }), 'DecryptFailed');
      await expectCryptoError(service.aesGcmDecrypt({ key, iv, additionalData: service.utf8Encode('other'), ciphertext: sealed }), 'DecryptFailed');
      await expectCryptoError(service.aesGcmDecrypt({ key, iv, ciphertext: sealed }), 'DecryptFailed');
      await expectCryptoError(service.aesGcmDecrypt({ key: service.randomBytes(16), iv, additionalData, ciphertext: sealed }), 'DecryptFailed');
      await expectCryptoError(service.aesGcmDecrypt({ key, iv, additionalData, ciphertext: sealed.subarray(0, 10) }), 'DecryptFailed');
    });

    it('validates key, iv and tag length before touching the cipher', async () => {
      const iv = new Uint8Array(12);
      await expectCryptoError(service.aesGcmEncrypt({ key: new Uint8Array(20), iv, plaintext: 'x' }), 'InvalidKey');
      await expectCryptoError(service.aesGcmDecrypt({ key: new Uint8Array(20), iv, ciphertext: new Uint8Array(16) }), 'InvalidKey');
      await expectCryptoError(service.aesGcmEncrypt({ key: new Uint8Array(16), iv: new Uint8Array(0), plaintext: 'x' }), 'InvalidIv');
      await expectCryptoError(
        service.aesGcmEncrypt({ key: new Uint8Array(16), iv, plaintext: 'x', tagLength: 8 as unknown as 12 }),
        'InvalidArgument',
      );
    });

    it('produces the SecureStore on-disk layout (nonce ‖ AES-256-GCM ‖ tag, no AAD) byte for byte', async () => {
      // secrets/secure-store.ts 的 `<key>.enc` 用 node:crypto 写出；移动端只能经 ctx.crypto 读写同一格式。
      const key = Uint8Array.from(nodeRandomBytes(32));
      const nonce = Uint8Array.from(nodeRandomBytes(12));
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const legacy = Buffer.concat([nonce, cipher.update('sk-test-🔑', 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const sealed = await service.aesGcmEncrypt({ key, iv: nonce, plaintext: 'sk-test-🔑' });
      expect(toHexString(sealed)).toBe(legacy.subarray(12).toString('hex'));
      const opened = await service.aesGcmDecrypt({ key, iv: legacy.subarray(0, 12), ciphertext: legacy.subarray(12) });
      expect(service.utf8Decode(opened)).toBe('sk-test-🔑');
    });
  });

  describe('encoding', () => {
    const RFC4648: Array<[string, string]> = [
      ['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
    ];

    it('base64 encodes and decodes the RFC 4648 vectors', () => {
      for (const [plain, encoded] of RFC4648) {
        expect(service.toBase64(service.utf8Encode(plain))).toBe(encoded);
        expect(service.utf8Decode(service.fromBase64(encoded))).toBe(plain);
        expect(service.utf8Decode(service.fromBase64(encoded.replace(/=+$/, '')))).toBe(plain);
      }
    });

    it('base64url uses -_ and omits padding by default, like Node base64url', () => {
      const bytes = Uint8Array.of(0xfb, 0xff, 0xbf);
      expect(service.toBase64(bytes)).toBe('+/+/');
      expect(service.toBase64(bytes, { alphabet: 'url' })).toBe('-_-_');
      expect(service.toBase64(Uint8Array.of(0xfb, 0xff), { alphabet: 'url' })).toBe('-_8');
      expect(service.toBase64(Uint8Array.of(0xfb, 0xff), { alphabet: 'url', padding: true })).toBe('-_8=');
      expect(service.toBase64(Uint8Array.of(0xfb, 0xff), { padding: false })).toBe('+/8');
      expect([...service.fromBase64('-_8', { alphabet: 'url' })]).toEqual([0xfb, 0xff]);
      expect([...service.fromBase64('-_8=', { alphabet: 'either' })]).toEqual([0xfb, 0xff]);
      expect([...service.fromBase64('+/8=', { alphabet: 'either' })]).toEqual([0xfb, 0xff]);
      for (let length = 0; length < 40; length++) {
        const random = Uint8Array.from(nodeRandomBytes(length));
        expect(service.toBase64(random)).toBe(Buffer.from(random).toString('base64'));
        expect(service.toBase64(random, { alphabet: 'url' })).toBe(Buffer.from(random).toString('base64url'));
        expect(toHexString(service.fromBase64(Buffer.from(random).toString('base64')))).toBe(toHexString(random));
      }
    });

    it('base64 decoding is forgiving about whitespace but rejects foreign characters and bad lengths', async () => {
      expect(service.utf8Decode(service.fromBase64(' Zm9v\r\nYmFy\t'))).toBe('foobar');
      await expectCryptoError(() => service.fromBase64('Zm9v!'), 'InvalidEncoding');
      await expectCryptoError(() => service.fromBase64('Zm9vY'), 'InvalidEncoding');
      await expectCryptoError(() => service.fromBase64('Zg=a'), 'InvalidEncoding');
      await expectCryptoError(() => service.fromBase64('-_8'), 'InvalidEncoding');
      await expectCryptoError(() => service.fromBase64('+/8', { alphabet: 'url' }), 'InvalidEncoding');
    });

    it('hex round-trips and rejects odd lengths or non-hex digits instead of truncating', async () => {
      expect(service.toHex(Uint8Array.of(0, 1, 0xab, 0xff))).toBe('0001abff');
      expect([...service.fromHex('0001ABff')]).toEqual([0, 1, 0xab, 0xff]);
      expectPlain(service.fromHex(''));
      await expectCryptoError(() => service.fromHex('abc'), 'InvalidEncoding');
      await expectCryptoError(() => service.fromHex('zz'), 'InvalidEncoding');
    });

    it('UTF-8 decoding is lossy by default and strict on request', async () => {
      const broken = Uint8Array.of(0x61, 0xff, 0x62);
      expect(service.utf8Decode(broken)).toBe('a\uFFFDb');
      await expectCryptoError(() => service.utf8Decode(broken, { fatal: true }), 'InvalidEncoding');
      expect(service.utf8Decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61))).toBe('\uFEFFa');
    });

    it('timingSafeEqual compares content and length', () => {
      expect(service.timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
      expect(service.timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
      expect(service.timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
      expect(service.timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    });
  });
});

describe('cross-implementation interoperability', () => {
  const node = createNodeCrypto();
  const web = createWebCrypto();

  it('ciphertext sealed by one implementation opens with the other', async () => {
    const key = node.randomBytes(32);
    const iv = web.randomBytes(12);
    const additionalData = node.utf8Encode('aad');
    const fromNode = await node.aesGcmEncrypt({ key, iv, additionalData, plaintext: 'desktop → mobile' });
    expect(web.utf8Decode(await web.aesGcmDecrypt({ key, iv, additionalData, ciphertext: fromNode }))).toBe('desktop → mobile');
    const fromWeb = await web.aesGcmEncrypt({ key, iv, additionalData, plaintext: 'mobile → desktop' });
    expect(node.utf8Decode(await node.aesGcmDecrypt({ key, iv, additionalData, ciphertext: fromWeb }))).toBe('mobile → desktop');
    expect(toHexString(fromNode)).not.toBe(toHexString(fromWeb));
  });
});

describe('web implementation uses only the injected WebCrypto object', () => {
  it('routes async digests, HMAC, AES-GCM and randomness through crypto.subtle / getRandomValues / randomUUID', async () => {
    const calls: string[] = [];
    const real: WebCryptoLike = globalThis.crypto as unknown as WebCryptoLike;
    const subtle = new Proxy(real.subtle, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`subtle.${String(property)}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const injected: WebCryptoLike = {
      subtle: subtle as WebCryptoLike['subtle'],
      getRandomValues: <T extends Uint8Array>(array: T): T => {
        calls.push('getRandomValues');
        return real.getRandomValues(array);
      },
      randomUUID: () => {
        calls.push('randomUUID');
        return real.randomUUID();
      },
    };
    const web = createWebCrypto({ crypto: injected });
    await web.sha256Hex('abc');
    expect(calls).toEqual(['subtle.digest']);
    calls.length = 0;
    await web.hmac('SHA-256', 'k', 'v');
    expect(calls).toEqual(['subtle.importKey', 'subtle.sign']);
    calls.length = 0;
    const key = web.randomBytes(16);
    const iv = web.randomBytes(12);
    expect(calls).toEqual(['getRandomValues', 'getRandomValues']);
    calls.length = 0;
    const sealed = await web.aesGcmEncrypt({ key, iv, plaintext: 'x' });
    await web.aesGcmDecrypt({ key, iv, ciphertext: sealed });
    expect(calls).toEqual(['subtle.importKey', 'subtle.encrypt', 'subtle.importKey', 'subtle.decrypt']);
    calls.length = 0;
    web.randomBytes(70_000);
    expect(calls).toEqual(['getRandomValues', 'getRandomValues']);
    calls.length = 0;
    web.randomUUID();
    expect(calls).toEqual(['randomUUID']);
  });
});

describe('dstu.platform.crypto plugin', () => {
  it('provides ctx.crypto backed by the Node implementation on desktop', async () => {
    const host = await createTestHost({ plugins: [crypto] });
    try {
      expect(host.ctx.crypto.implementation).toBe('node');
      expect(await host.ctx.crypto.sha256Hex('abc')).toBe(DIGESTS['SHA-256'].abc);
    } finally {
      await host.dispose();
    }
  });
});
