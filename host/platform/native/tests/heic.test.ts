import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { CommandError } from '../../../kernel/api.ts';
import native from '../index.ts';

describe('desktop heic_decoder.rs branches', () => {
  it('validates raw body before rejecting unsupported desktop conversion', async () => {
    const host = await createTestHost({ plugins: [native] });
    const check = (body: unknown, message: string) => {
      try { host.ctx.nativeHeic.convertToJpeg(body); throw new Error('expected rejection'); }
      catch (e) {
        expect(e).toBeInstanceOf(CommandError);
        expect((e as CommandError).value).toEqual({ error_type: 'Validation', message, details: null });
      }
    };
    try {
      check({}, 'HEIC_INVALID_INPUT: expected raw binary request body');
      check(new Uint8Array(), 'HEIC_INVALID_INPUT: empty image body');
      check(new Uint8Array(50 * 1024 * 1024 + 1), 'HEIC_INVALID_INPUT: image exceeds 50 MB');
      check(new Uint8Array([1]), 'HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android');
      check(new Uint8Array([1]).buffer, 'HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android');
    } finally { await host.dispose(); }
  });
});
