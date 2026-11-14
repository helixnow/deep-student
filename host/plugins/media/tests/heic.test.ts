import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { heic as nativeHeic } from '../../../platform/native/heic/index.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

const settings = {
  get: (): string | null => null,
  save: (): void => undefined,
};

it('convert_heic_to_jpeg keeps raw-body validation and desktop rejection', async () => {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings,
      paths: { appDataDir: process.cwd() },
      nativeHeic,
    },
  });
  try {
    const invalid = (message: string) => ({
      error_type: 'Validation', message, details: null,
    });
    await expect(host.invoke('convert_heic_to_jpeg')).rejects.toEqual(
      invalid('HEIC_INVALID_INPUT: expected raw binary request body'));
    await expect(host.invoke('convert_heic_to_jpeg', { bytes: [1, 2, 3] })).rejects.toEqual(
      invalid('HEIC_INVALID_INPUT: expected raw binary request body'));
    await expect(host.invoke('convert_heic_to_jpeg', new Uint8Array())).rejects.toEqual(
      invalid('HEIC_INVALID_INPUT: empty image body'));

    const unsupported = invalid(
      'HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android');
    await expect(host.invoke('convert_heic_to_jpeg', new Uint8Array([1, 2, 3])))
      .rejects.toEqual(unsupported);
    await expect(host.invoke('convert_heic_to_jpeg', new Uint8Array([1, 2, 3]).buffer))
      .rejects.toEqual(unsupported);
  } finally { await host.dispose(); }
});
