import { describe, it, expect } from 'vitest';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { argon2Missing } from './pending-dependency.ts';

describe('backup_crypto.rs Argon2id v0x13 native acceleration', () => {
  it.skipIf(argon2Missing)('matches noble raw bytes for passwords containing UTF-8/NUL and multiple lanes', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      for (const password of ['password', '密码\0🙂']) {
        const pwd = Buffer.from(password), salt = Buffer.from('0123456789abcdef');
        for (const p of [1, 4]) {
          const expected = await argon2idAsync(pwd, salt, { m: 64, t: 3, p, dkLen: 32, version: 0x13 });
          expect(await host.ctx.nativeArgon2.deriveKey(pwd, salt, 64, 3, p)).toEqual(Buffer.from(expected));
        }
      }
    } finally { await host.dispose(); }
  });

  it.skipIf(argon2Missing)('matches the production DSBK 64MiB/t3/p4 key without blocking Host timer delivery', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      const password = Buffer.from('DeepStudent DSBK'), salt = Buffer.from('0123456789abcdef');
      const expected = await argon2idAsync(password, salt, { m: 65536, t: 3, p: 4, dkLen: 32, version: 0x13 });
      let ticked = false;
      const timer = setTimeout(() => { ticked = true; }, 0);
      try {
        expect(await host.ctx.nativeArgon2.deriveKey(password, salt, 65536, 3, 4)).toEqual(Buffer.from(expected));
        expect(ticked).toBe(true);
      } finally { clearTimeout(timer); }
    } finally { await host.dispose(); }
  });
});
