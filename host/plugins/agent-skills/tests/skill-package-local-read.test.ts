import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PathsService } from '../../../platform/paths/api.ts';

const readState = vi.hoisted(() => ({
  grow: false,
  calls: 0,
  requested: [] as number[],
  returned: 0,
  limit: null as number | null,
  readAfterLimit: false,
}));

// Only the external FileHandle.read seam is replaced; readZipBytes's
// production open/read loop/close still runs.
// Host setup preloads the public barrel; reload before installing the fs fault injection.
vi.hoisted(() => vi.resetModules());
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!readState.grow) return handle;
      const read = ((
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
      ) => {
        if (readState.limit !== null && readState.returned >= readState.limit + 1) {
          readState.readAfterLimit = true;
        }
        readState.calls++;
        readState.requested.push(length);
        readState.returned += length;
        (buffer as Buffer).fill(0x50, offset, offset + length);
        return Promise.resolve({ bytesRead: length, buffer });
      }) as unknown as typeof handle.read;
      return Object.assign(handle, { read });
    }) as typeof actual.open,
  };
});

import { SkillFiles } from '../src/files.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES, SkillPackages } from '../src/skill-package.ts';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-zip-grow-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const paths = {
  os: { home: tmpdir(), data: tmpdir() },
  appDataDir: tmpdir(),
} as unknown as PathsService;

describe('skills.rs local zip bounded read', () => {
  it('stops_at_limit_plus_one_when_file_grows_after_stat', async () => {
    const max = MAX_SKILL_PACKAGE_ZIP_BYTES;
    const file = path.join(tempDir(), 'grow.zip');
    writeFileSync(file, 'PK');
    readState.calls = 0;
    readState.requested = [];
    readState.returned = 0;
    readState.limit = max;
    readState.readAfterLimit = false;
    readState.grow = true;
    try {
      const packages = new SkillPackages(new SkillFiles(paths));
      let caught: unknown;
      try {
        await packages.readZipBytes(file, () => {
          throw new Error('virtual reader must not run');
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/Zip grew beyond the \d+ byte limit while being read/);

      // The production loop must request exactly MAX+1 bytes total and stop:
      // 1 MiB chunks until the limit, then the final 1-byte read.
      expect(readState.requested.reduce((sum, length) => sum + length, 0)).toBe(max + 1);
      expect(readState.returned).toBe(max + 1);
      expect(readState.requested.at(-1)).toBe(1);
      expect(readState.readAfterLimit).toBe(false);

      const callsAtFailure = readState.calls;
      expect(callsAtFailure).toBe(readState.requested.length);
      await Promise.resolve();
      expect(readState.calls).toBe(callsAtFailure);
    } finally {
      readState.grow = false;
      readState.limit = null;
    }
  });

  it('L07-05 local zip read yields to the Host event loop before resolving', async () => {
    const file = path.join(tempDir(), 'small.zip');
    writeFileSync(file, 'PK\u0003\u0004');
    const packages = new SkillPackages(new SkillFiles(paths));
    let immediateRan = false;
    setImmediate(() => { immediateRan = true; });
    const bytes = await packages.readZipBytes(file, () => {
      throw new Error('virtual reader must not run');
    });
    expect(Buffer.from(bytes).toString('latin1')).toBe('PK\u0003\u0004');
    expect(immediateRan).toBe(true);
  });
});
