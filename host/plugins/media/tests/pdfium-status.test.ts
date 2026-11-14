import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { pdfium } from '../../../platform/native/pdfium/index.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

const settings = {
  get: (): string | null => null,
  save: (): void => undefined,
};
const paths = { appDataDir: process.cwd() };

it('test_pdfium_status loads the Host provider and parses the minimal PDF', async () => {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings, paths, nativePdfium: pdfium },
  });
  try {
    const status = await host.invoke<Record<string, string>>('test_pdfium_status');
    expect(status.exe_path).toBe(JSON.stringify(process.execPath));
    expect(status.exe_dir).toBe(JSON.stringify(dirname(process.execPath)));
    expect(status.load_result).toBe('OK');
    expect(status.parse_test).toBe('OK, pages=1');
    // Rust reports native-library candidates; the Host is a WASM adapter and
    // must not fabricate candidate paths.
    expect(Object.keys(status).some(key => key.startsWith('candidate_'))).toBe(false);
  } finally { await host.dispose(); }
});

it('test_pdfium_status reports a load failure instead of throwing', async () => {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings, paths },
  });
  try {
    const status = await host.invoke<Record<string, string>>('test_pdfium_status');
    expect(status.load_result).toBe('FAIL: nativePdfium service not available');
    expect(status.parse_test).toBeUndefined();
  } finally { await host.dispose(); }
});
