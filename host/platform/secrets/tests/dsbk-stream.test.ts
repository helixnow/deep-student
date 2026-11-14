/**
 * DSBK 的 Web Streams 版加解密：与路径式接口逐字节互通、错误文案相同；失败时取消输入、中止输出。
 * 帧逻辑在可移植的 `dsbk-stream.ts`，运行时不得触达 Node 专有依赖。
 */
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argon2id } from '@noble/hashes/argon2.js';
import { afterEach, describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { createNodeFiles } from '../../files/index.ts';
import { BackupCryptoError, createBackupCrypto, DEFAULT_M_COST, DEFAULT_P_COST, DEFAULT_T_COST, STREAM_PLAINTEXT_CHUNK } from '../backup-crypto.ts';
import { encryptDsbkStream, isEncryptedBackup, type DsbkStreamDeps } from '../dsbk-stream.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HEAVY = 300_000;
const CHUNK = STREAM_PLAINTEXT_CHUNK;
const AEAD_FAILED = '备份解密失败（密码错误或数据损坏）: aead::Error';
/** backup-crypto.test.ts 的 cheap 参数（m=8,t=1,p=1）独立向量：salt 07×16，v1 nonce 00..0b，v2 前缀 aa×7。 */
const CHEAP_V1_HEX = '4453424b0108000000010000000100000007070707070707070707070707070707000102030405060708090a0bbe4d70e908a49ffe756754ba8295b972cd65d2c190abc6b1da5874b0c2890acb7c8f';
const CHEAP_V2_HEX = '4453424b0208000000010000000100000007070707070707070707070707070707aaaaaaaaaaaaaa00001000840a6fd86a2d08e1112b70602f6e348a3be138b9687590853c4bc70855e04c307448';
const VECTOR_TEXT = 'hello backup world';

const bc = createBackupCrypto();
const cheap = (password: string) => bc.createFileCipherSession(password, { mCost: 8, tCost: 1, pCost: 1 });
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'w07-dsbk-stream-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 按不规则分块（含空分块）吐出 `bytes`；可在第 `failAfter` 次 pull 时出错。 */
function source(bytes: Uint8Array, options: { failAfter?: number; sizes?: number[] } = {}) {
  const sizes = options.sizes ?? [1, 0, 7, 65_536, 1_000_003];
  const state: { cancelled: unknown; pulls: number } = { cancelled: undefined, pulls: 0 };
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      if (options.failAfter !== undefined && state.pulls > options.failAfter) {
        controller.error(new Error('disk gone'));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const n = sizes[(state.pulls - 1) % sizes.length]!;
      controller.enqueue(bytes.slice(offset, offset + n));
      offset += n;
    },
    cancel(reason) {
      state.cancelled = reason ?? true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

function sink(options: { failWriteAt?: number; failClose?: boolean } = {}) {
  const chunks: Uint8Array[] = [];
  const state: { closed: boolean; aborted: unknown; writes: number } = { closed: false, aborted: undefined, writes: 0 };
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      state.writes++;
      if (state.writes === options.failWriteAt) throw new Error('disk full');
      chunks.push(chunk.slice());
    },
    close() {
      if (options.failClose) throw new Error('rename failed');
      state.closed = true;
    },
    abort(reason) {
      state.aborted = reason ?? true;
    },
  });
  return { stream, state, bytes: () => new Uint8Array(Buffer.concat(chunks)) };
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/** 同一输入分别交给路径式与流式解密，返回两者的错误文案。 */
async function bothDecryptErrors(data: Uint8Array, password: string): Promise<[string, string]> {
  const d = temp();
  writeFileSync(join(d, 'in'), data);
  const pathError = await failure(bc.decryptBackupFile(join(d, 'in'), join(d, 'out'), password));
  const streamError = await failure(bc.decryptBackupStream(source(data).stream, sink().stream, password));
  return [pathError.message, streamError.message];
}

describe('round trips and interoperability', () => {
  it('every chunk boundary round-trips and interoperates with the path API in both directions', async () => {
    const session = await cheap('pw');
    try {
      for (const len of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 5]) {
        const plain = pattern(len);
        const out = sink();
        await session.encryptStream(source(plain).stream, out.stream);
        expect(out.state.closed).toBe(true);
        const encrypted = out.bytes();
        const chunks = len === 0 ? 1 : Math.ceil(len / CHUNK);
        expect(encrypted.length, `size ${len}`).toBe(44 + len + 16 * chunks);
        expect(Buffer.from(encrypted.subarray(0, 5)).toString('latin1')).toBe('DSBK\x02');

        const d = temp();
        writeFileSync(join(d, 'stream.enc'), encrypted);
        await session.decryptFile(join(d, 'stream.enc'), join(d, 'stream.out'));
        expect(Buffer.compare(readFileSync(join(d, 'stream.out')), plain), `path decrypt ${len}`).toBe(0);

        writeFileSync(join(d, 'plain'), plain);
        await session.encryptFile(join(d, 'plain'), join(d, 'path.enc'));
        const back = sink();
        await session.decryptStream(source(new Uint8Array(readFileSync(join(d, 'path.enc')))).stream, back.stream);
        expect(back.state.closed).toBe(true);
        expect(Buffer.compare(back.bytes(), plain), `stream decrypt ${len}`).toBe(0);
      }
    } finally {
      session.dispose();
    }
  });

  it('the independent v1/v2 vectors decrypt through the password stream API', async () => {
    for (const vector of [CHEAP_V1_HEX, CHEAP_V2_HEX]) {
      const out = sink();
      await bc.decryptBackupStream(source(hex(vector)).stream, out.stream, 'pw-vector');
      expect(Buffer.from(out.bytes()).toString()).toBe(VECTOR_TEXT);
    }
  });

  it('with the vector salt, prefix and key the stream encryptor reproduces the v2 bytes exactly', async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = argon2id(Buffer.from('pw-vector'), salt, { t: 1, m: 8, p: 1, dkLen: 32, version: 0x13 });
    const deps: DsbkStreamDeps = {
      aead: {
        seal: (k, nonce, pt) => {
          const c = createCipheriv('aes-256-gcm', k, nonce);
          return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
        },
        open: () => null,
      },
      randomBytes: (n) => new Uint8Array(n).fill(0xaa),
    };
    const out = sink();
    await encryptDsbkStream(source(Buffer.from(VECTOR_TEXT)).stream, out.stream, { salt, m: 8, t: 1, p: 1 }, async () => key, deps);
    expect(Buffer.from(out.bytes()).toString('hex')).toBe(CHEAP_V2_HEX);
  });

  it('encryptBackupStream writes the default KDF parameters and the path API decrypts it', async () => {
    const plain = pattern(CHUNK + 3);
    const out = sink();
    await bc.encryptBackupStream(source(plain).stream, out.stream, 'default-params');
    const encrypted = Buffer.from(out.bytes());
    expect([encrypted.readUInt32LE(5), encrypted.readUInt32LE(9), encrypted.readUInt32LE(13)]).toEqual([DEFAULT_M_COST, DEFAULT_T_COST, DEFAULT_P_COST]);
    const d = temp();
    writeFileSync(join(d, 'enc'), encrypted);
    await bc.decryptBackupFile(join(d, 'enc'), join(d, 'out'), 'default-params');
    expect(Buffer.compare(readFileSync(join(d, 'out')), plain)).toBe(0);
  }, HEAVY);
});

describe('failures', () => {
  it('a wrong password fails like the path API, writes nothing, aborts the output and cancels the input', async () => {
    const session = await cheap('right');
    const enc = sink();
    await session.encryptStream(source(pattern(2 * CHUNK + 10)).stream, enc.stream);
    session.dispose();
    const encrypted = enc.bytes();

    const input = source(encrypted);
    const out = sink();
    const error = await failure(bc.decryptBackupStream(input.stream, out.stream, 'wrong'));
    expect(error).toBeInstanceOf(BackupCryptoError);
    expect(error.message).toBe(AEAD_FAILED);
    expect(out.state.writes).toBe(0);
    expect(out.state.aborted).toBe(error);
    expect(out.state.closed).toBe(false);
    expect(input.state.cancelled).toBe(error);
    expect(await bothDecryptErrors(encrypted, 'wrong')).toEqual([AEAD_FAILED, AEAD_FAILED]);
  });

  it('a dropped or truncated final chunk is detected after the authenticated prefix', async () => {
    const session = await cheap('pw');
    try {
      const enc = sink();
      await session.encryptStream(source(pattern(CHUNK + 10)).stream, enc.stream);
      const encrypted = enc.bytes();
      for (const cut of [encrypted.subarray(0, 44 + CHUNK + 16), encrypted.subarray(0, encrypted.length - 1)]) {
        const out = sink();
        const error = await failure(session.decryptStream(source(cut).stream, out.stream));
        expect(error.message).toBe(AEAD_FAILED);
        expect(out.state.aborted).toBe(error);
        expect(out.state.closed).toBe(false);
      }
    } finally {
      session.dispose();
    }
  });

  it('v1 is authenticated as a whole before anything is written', async () => {
    const tampered = hex(CHEAP_V1_HEX);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    const out = sink();
    const error = await failure(bc.decryptBackupStream(source(tampered).stream, out.stream, 'pw-vector'));
    expect(error.message).toBe(AEAD_FAILED);
    expect(out.state.writes).toBe(0);
    expect(out.state.aborted).toBe(error);
  });

  it('malformed headers produce the same Rust messages as the path API', async () => {
    const v2 = hex(CHEAP_V2_HEX);
    const zeroChunk = v2.slice(0, 44);
    zeroChunk.set([0, 0, 0, 0], 40);
    const version3 = v2.slice();
    version3[4] = 3;
    const cases: Array<[Uint8Array, string]> = [
      [Buffer.from('PK\x03\x04 zip'), '非加密备份文件（无 DSBK 标头）'],
      [Buffer.from('DSB'), '读取加密头失败: failed to fill whole buffer'],
      [version3, '不支持的加密版本: 3'],
      [v2.slice(0, 10), '读取加密参数失败: failed to fill whole buffer'],
      [v2.slice(0, 30), '读取 salt 失败: failed to fill whole buffer'],
      [v2.slice(0, 36), '读取 nonce 前缀失败: failed to fill whole buffer'],
      [v2.slice(0, 42), '读取分块大小失败: failed to fill whole buffer'],
      [zeroChunk, '加密分块大小非法: 0'],
      [v2.slice(0, 44), '加密备份缺少数据块'],
      [hex(CHEAP_V1_HEX).slice(0, 30), '加密备份数据太短'],
    ];
    for (const [data, message] of cases) {
      expect(await bothDecryptErrors(data, 'pw-vector'), message).toEqual([message, message]);
    }
  });

  it('source errors keep the Rust read context and abort the output', async () => {
    const session = await cheap('pw');
    try {
      const out = sink();
      const error = await failure(session.encryptStream(source(pattern(CHUNK * 2), { failAfter: 3 }).stream, out.stream));
      expect(error.message).toBe('读取数据失败: disk gone');
      expect(out.state.aborted).toBe(error);

      const head = sink();
      const headError = await failure(session.decryptStream(source(Buffer.from('DSBK\x02'), { failAfter: 0 }).stream, head.stream));
      expect(headError.message).toBe('读取加密头失败: disk gone');
      expect(head.state.aborted).toBe(headError);
    } finally {
      session.dispose();
    }
  });

  it('sink failures keep the Rust write/flush context and cancel the input', async () => {
    const session = await cheap('pw');
    try {
      for (const [options, message] of [
        [{ failWriteAt: 1 }, '写入加密头部失败: disk full'],
        [{ failWriteAt: 2 }, '写入密文失败: disk full'],
        [{ failClose: true }, '刷新加密输出失败: rename failed'],
      ] as const) {
        const input = source(pattern(3 * CHUNK));
        const error = await failure(session.encryptStream(input.stream, sink(options).stream));
        expect(error.message).toBe(message);
        if (!('failClose' in options)) expect(input.state.cancelled).toBe(error);
      }
      const enc = sink();
      await session.encryptStream(source(pattern(10)).stream, enc.stream);
      const write = await failure(session.decryptStream(source(enc.bytes()).stream, sink({ failWriteAt: 1 }).stream));
      expect(write.message).toBe('写入解密输出失败: disk full');
      const flush = await failure(session.decryptStream(source(enc.bytes()).stream, sink({ failClose: true }).stream));
      expect(flush.message).toBe('刷新解密输出失败: rename failed');
    } finally {
      session.dispose();
    }
  });

  it('a disposed session refuses to encrypt instead of using the wiped key', async () => {
    const session = await cheap('pw');
    session.dispose();
    const input = source(pattern(10));
    const out = sink();
    const error = await failure(session.encryptStream(input.stream, out.stream));
    expect(error.message).toBe('加密会话已释放');
    expect(out.state.writes).toBe(0);
    expect(out.state.aborted).toBe(error);
    expect(input.state.cancelled).toBe(error);
  });
});

describe('with the real files service', () => {
  it('openRead → decryptBackupStream → openWrite(atomic) publishes on success and leaves nothing on failure', async () => {
    const root = temp();
    const files = createNodeFiles({ roots: [{ name: 'appData', path: root }] });
    const plain = pattern(CHUNK * 2 + 17);
    writeFileSync(join(root, 'plain'), plain);
    const session = await cheap('pw');
    try {
      await session.encryptFile(join(root, 'plain'), join(root, 'backup.enc'));
    } finally {
      session.dispose();
    }

    const failed = await failure(bc.decryptBackupStream(
      await files.openRead(join(root, 'backup.enc')), await files.openWrite(join(root, 'wrong.zip'), { mode: 'atomic' }), 'nope'));
    expect(failed.message).toBe(AEAD_FAILED);
    expect(readdirSync(root).sort()).toEqual(['backup.enc', 'plain']);

    await bc.decryptBackupStream(await files.openRead(join(root, 'backup.enc')), await files.openWrite(join(root, 'restored.zip'), { mode: 'atomic' }), 'pw');
    expect(Buffer.compare(readFileSync(join(root, 'restored.zip')), plain)).toBe(0);
    expect(readdirSync(root).sort()).toEqual(['backup.enc', 'plain', 'restored.zip']);
  });
});

it('dsbk-stream never loads Node modules at runtime', () => {
  expect(checkModulesClosure(ROOT, ['host/platform/secrets/dsbk-stream.ts'])).toEqual([]);
});

it('isEncryptedBackup lives in the portable module: only the 4-byte DSBK magic counts, on any Uint8Array view', () => {
  expect(isEncryptedBackup).toBe(bc.isEncryptedBackup);
  expect(isEncryptedBackup(hex(CHEAP_V1_HEX))).toBe(true);
  expect(isEncryptedBackup(hex(CHEAP_V2_HEX).subarray(0, 4))).toBe(true);
  expect(isEncryptedBackup(new TextEncoder().encode('DSB'))).toBe(false);
  expect(isEncryptedBackup(new TextEncoder().encode('PK\u0003\u0004DSBK'))).toBe(false);
  expect(isEncryptedBackup(new TextEncoder().encode('xxDSBK').subarray(2))).toBe(true);
});
