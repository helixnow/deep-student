import type { BackupCrypto, FileCipherSession, PasswordVerifier } from '../secrets/api.ts';
import type { CryptoService } from '../crypto/api.ts';
import { fromHex, toHex, timingSafeEqual, utf8Encode } from '../crypto/encoding.ts';
import { createHasherSync, sha256HexSync } from '../crypto/sync.ts';
import { isFileNotFound, type FilesService } from '../files/api.ts';
import { chunkNonce, decryptDsbkStream, encryptDsbkStream, isEncryptedBackup, DSBK_V2_HEADER_LEN } from '../secrets/dsbk-stream.ts';
import { dsbkFirstChunkSpeculativePrefixLen, planFirstChunkTrial } from '../secrets/dsbk-prefix.ts';
import { mobileDsbkDeps, deriveMobileBackupKey } from './backup-cipher.ts';

const defaults = { mCost: 65536, tCost: 3, pCost: 4 };
const streamOf = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
async function collect(run: (out: WritableStream<Uint8Array>) => Promise<void>) {
  const parts: Uint8Array[] = [];
  await run(new WritableStream({ write(bytes) { parts.push(bytes); } }));
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export interface MobileCipherFileCache {
  flushPending(): Promise<void>;
  loadPersistedFile(path: string): Promise<void>;
}
export function createMobileSyncCrypto(files: FilesService, crypto: CryptoService, cache?: () => MobileCipherFileCache): BackupCrypto {
  const deps = mobileDsbkDeps(crypto);
  async function session(password: string, params = defaults): Promise<FileCipherSession> {
    const secret = utf8Encode(password), salt = crypto.randomBytes(16);
    let key: Uint8Array | undefined, disposed = false;
    const derived = new Set<Uint8Array>();
    const keyFor = async (s: Uint8Array, m: number, t: number, p: number) => {
      if (disposed) throw new Error('Cipher session has closed');
      const isOwn = m === params.mCost && t === params.tCost && p === params.pCost && timingSafeEqual(s, salt);
      if (isOwn && key) return key;
      const material = await deriveMobileBackupKey(secret, s, m, t, p);
      if (disposed) { material.fill(0); throw new Error('Cipher session has closed'); }
      if (isOwn) key = material;
      derived.add(material);
      return material;
    };
    const enc = (input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>) => encryptDsbkStream(input, output, { salt, m: params.mCost, t: params.tCost, p: params.pCost }, keyFor, deps);
    const dec = (input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>) => decryptDsbkStream(input, output, keyFor, deps);
    const transformFile = async (input: string, output: string, transform: typeof dec) => {
      const local = cache?.();
      await local?.flushPending();
      const source = await files.openRead(input);
      let target;
      try { target = await files.openWrite(output, { mode: 'atomic', createParents: true }); }
      catch (error) { await source.cancel().catch(() => {}); throw error; }
      await transform(source, target);
      await local?.loadPersistedFile(output);
    };
    return {
      async encryptBytes(bytes) {
        const iv = crypto.randomBytes(12);
        const data = await deps.aead.seal(await keyFor(salt, params.mCost, params.tCost, params.pCost), iv, bytes);
        const result = new Uint8Array(45 + data.length), view = new DataView(result.buffer);
        result.set([68,83,66,75,1]); view.setUint32(5, params.mCost, true); view.setUint32(9, params.tCost, true); view.setUint32(13, params.pCost, true);
        result.set(salt, 17); result.set(iv, 33); result.set(data, 45); return result;
      },
      decryptBytes: data => collect(output => dec(streamOf(data), output)),
      encryptStream: enc, decryptStream: dec,
      encryptFile: (input, output) => transformFile(input, output, enc),
      decryptFile: (input, output) => transformFile(input, output, dec),
      dispose() { disposed = true; secret.fill(0); for (const k of derived) k.fill(0); derived.clear(); },
    };
  }
  async function using<T>(password: string, run: (cipher: FileCipherSession) => Promise<T>) {
    const cipher = await session(password);
    try { return await run(cipher); } finally { cipher.dispose(); }
  }
  async function verifier(password: string, p: Omit<PasswordVerifier, 'digest'>) {
    const secret = utf8Encode(password);
    if (p.kdf !== 'argon2id') throw new Error('Unknown verifier KDF');
    try {
      const key = await deriveMobileBackupKey(secret, fromHex(p.salt), p.mCost, p.tCost, p.pCost);
      try { return createHasherSync('SHA-256').update(utf8Encode('deep-student.encryption-marker.verifier.v1')).update(key).digestHex(); }
      finally { key.fill(0); }
    } finally { secret.fill(0); }
  }
  let memoryTail = Promise.resolve();
  return {
    createFileCipherSession: session, isEncryptedBackup, dsbkFirstChunkSpeculativePrefixLen, planFirstChunkTrial,
    encryptBackup: (data, pw) => using(pw, c => c.encryptBytes(data)), decryptBackup: (data, pw) => using(pw, c => c.decryptBytes(data)),
    encryptBackupStream: (i, o, pw) => using(pw, c => c.encryptStream(i, o)), decryptBackupStream: (i, o, pw) => using(pw, c => c.decryptStream(i, o)),
    encryptBackupFile: (i, o, pw) => using(pw, c => c.encryptFile(i, o)), decryptBackupFile: (i, o, pw) => using(pw, c => c.decryptFile(i, o)),
    async trialDecryptFirstChunk(prefix, size, pw) {
      const plan = planFirstChunkTrial(prefix, size);
      if (plan.kind !== 'StreamV2' || prefix.length < plan.prefixLen) throw new Error('Missing authenticated DSBK v2 chunk');
      const v = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
      const secret = utf8Encode(pw);
      try {
        const k = await deriveMobileBackupKey(secret, prefix.subarray(17,33), v.getUint32(5,true), v.getUint32(9,true), v.getUint32(13,true));
        try {
          const nonce = chunkNonce(prefix.subarray(33,40), 0, BigInt(size) === BigInt(plan.prefixLen));
          const pt = await deps.aead.open(k, nonce, prefix.subarray(DSBK_V2_HEADER_LEN, plan.prefixLen));
          if (!pt) throw new Error('备份解密失败（密码错误或数据损坏）');
          pt.fill(0);
        } finally { k.fill(0); }
      } finally { secret.fill(0); }
    },
    async createPasswordVerifier(pw) {
      const p = { ...defaults, kdf: 'argon2id', salt: toHex(crypto.randomBytes(16)) };
      return { ...p, digest: await verifier(pw, p) };
    },
    async checkPasswordVerifier(pw, p) {
      const expected = fromHex(p.digest);
      if (expected.length !== 32) throw new Error('Invalid verifier length');
      return timingSafeEqual(expected, fromHex(await verifier(pw, p)));
    },
    encryptedRootFingerprint: hint => sha256HexSync('deep-student.encrypted-root-memory.v1' + hint),
    encryptedRootMemory(path) {
      async function roots(): Promise<Record<string,string>> {
        let text: string;
        try { text = await files.readText(path); } catch (err) { if (isFileNotFound(err)) return {}; throw err; }
        const record = JSON.parse(text);
        if (record.version !== 1 || !record.roots || typeof record.roots !== 'object' || Array.isArray(record.roots)) throw new Error('加密目录记录损坏');
        return record.roots;
      }
      return { path,
        async wasEncrypted(key) { try { return Object.hasOwn(await roots(), key); } catch { return true; } },
        remember(key) {
          const task = memoryTail.then(async () => {
            const entries = await roots();
            if (Object.hasOwn(entries, key)) return;
            entries[key] = new Date().toISOString();
            await files.writeAtomic(path, JSON.stringify({ version: 1, roots: entries }));
          });
          memoryTail = task.catch(() => undefined);
          return task;
        },
      };
    },
  };
}
