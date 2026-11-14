import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { purge } from '@/dstu/api';

const sanitizeWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter((args: unknown[]) => args.some((a) => typeof a === 'string' && a.includes('路径格式不合法')));

describe('dstu path → sourceId extraction', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('RF-W09-dstu-resource-file-source-id-prefix: imported resource and file ids are valid sourceIds, not sanitized with a warning', async () => {
    for (const path of ['/res_V1StGXR8_Z5jdHi6B', '/folder/file_3f9a2c1d-77e0']) {
      expect((await purge(path)).ok).toBe(true);
    }
    expect(sanitizeWarnings(warn)).toEqual([]);
  });

  it('ids outside the known prefixes are still sanitized with a warning', async () => {
    expect((await purge('/folder/some name.md')).ok).toBe(true);
    expect(sanitizeWarnings(warn)).toHaveLength(1);
  });
});
