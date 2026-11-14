import './local-fs-fixture.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ListOutcome } from '../api.ts';
import { acquireBackupRepoLease } from '../src/backup_lease.ts';
import {
  BACKUP_V2_GC_CANDIDATES_PREFIX,
  GcCandidateV2,
  collectGcCandidates,
  sweepGcCandidates,
} from '../src/delta_gc.ts';
import { decodeSnapshotDescriptor } from '../src/delta_format.ts';
import { chronoAutoSiUtc } from '../src/time.ts';
import {
  BACKUP_V2_OBJECTS_PREFIX,
  publishVerifiedStaging,
  type DeltaInventory,
  type DeltaInventoryProvider,
} from '../src/delta_upload.ts';
import { MemoryStorage } from './memory_storage.ts';

const tempDirs: string[] = [];

afterAll(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function stagingDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'delta-gc-test-'));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

const provider: DeltaInventoryProvider = {
  async buildCrossChecked(root: string): Promise<DeltaInventory> {
    const { readdir, readFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const entries: { logicalPath: string; size: number; plaintextSha256: string }[] = [];
    async function walk(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const logicalPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full, logicalPath);
        else if (entry.isFile()) {
          const data = await readFile(full);
          entries.push({
            logicalPath,
            size: data.byteLength,
            plaintextSha256: createHash('sha256').update(data).digest('hex'),
          });
        }
      }
    }
    await walk(root, '');
    entries.sort((left, right) => Buffer.compare(
      Buffer.from(left.logicalPath, 'utf8'), Buffer.from(right.logicalPath, 'utf8'),
    ));
    return { entries, logicalSize: entries.reduce((sum, entry) => sum + entry.size, 0) };
  },
};

class TruncatedStorage extends MemoryStorage {
  override async listOutcome(prefix: string): Promise<ListOutcome> {
    // The lease must still be acquirable so this exercises the GC scan itself.
    if (prefix.startsWith('backup-v2/locks/')) return super.listOutcome(prefix);
    return { files: await this.list(prefix), truncated: true };
  }
}

async function publishedRepo(): Promise<{ storage: MemoryStorage; orphan: string }> {
  const root = await stagingDir({ 'manifest.json': '{"v":1}', 'db/a.bin': 'a' });
  const storage = new MemoryStorage();
  await publishVerifiedStaging(storage, root, { deviceId: 'device-1' }, provider);
  const orphan = `${BACKUP_V2_OBJECTS_PREFIX}device-1/orphan.dsbk`;
  await storage.put(orphan, Buffer.from('orphan'));
  return { storage, orphan };
}

async function candidateKeys(storage: MemoryStorage): Promise<string[]> {
  return [...storage.files.keys()].filter(key => key.startsWith(BACKUP_V2_GC_CANDIDATES_PREFIX));
}

describe('delta_gc.rs', () => {
  it('collect registers unreferenced keys without deleting anything', async () => {
    const { storage, orphan } = await publishedRepo();
    const now = Date.now();
    const result = await collectGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now, graceMs: 1_000,
    });

    expect(result.unreferencedKeys).toEqual([orphan]);
    expect(result.newCandidateKeys).toHaveLength(1);
    expect(result.retainedCandidates).toBe(0);
    expect(await storage.get(orphan)).not.toBeNull();

    const candidate = GcCandidateV2.decode((await storage.get(result.newCandidateKeys[0]!))!);
    expect(candidate.objectKey).toBe(orphan);
    expect(candidate.firstSeen).toBe(chronoAutoSiUtc(now));
  });

  it('collect retains an existing candidate and does not refresh firstSeen', async () => {
    const { storage, orphan } = await publishedRepo();
    const now = Date.now();
    const first = await collectGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now, graceMs: 1_000,
    });
    const candidateKey = first.newCandidateKeys[0]!;
    const firstSeen = GcCandidateV2.decode((await storage.get(candidateKey))!).firstSeen;

    const second = await collectGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now + 5_000, graceMs: 1_000,
    });
    expect(second.retainedCandidates).toBe(1);
    expect(second.newCandidateKeys).toHaveLength(0);
    expect(second.unreferencedKeys).toEqual([orphan]);
    expect(GcCandidateV2.decode((await storage.get(candidateKey))!).firstSeen).toBe(firstSeen);
  });

  it('sweep respects grace, then deletes the orphan and its candidate', async () => {
    const { storage, orphan } = await publishedRepo();
    const now = Date.now();
    const collect = await collectGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now, graceMs: 1_000,
    });
    const candidateKey = collect.newCandidateKeys[0]!;

    const pending = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now + 500, graceMs: 1_000,
    });
    expect(pending.pendingCandidates).toBe(1);
    expect(pending.deletedObjectKeys).toHaveLength(0);
    expect(await storage.get(orphan)).not.toBeNull();

    const swept = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: now + 1_001, graceMs: 1_000,
    });
    expect(swept.deletedObjectKeys).toEqual([orphan]);
    expect(swept.deletedCandidateKeys).toEqual([candidateKey]);
    expect(await storage.get(orphan)).toBeNull();
    expect(await storage.get(candidateKey)).toBeNull();
  });

  it('sweep never deletes a re-referenced object, only its stale candidate', async () => {
    const { storage } = await publishedRepo();
    const snapshot = [...storage.files.keys()].find(key => key.startsWith('backup-v2/snapshots/'))!;
    const descriptor = decodeSnapshotDescriptor((await storage.get(snapshot))!);
    const liveObject = descriptor.files[0]!.objectKey;
    const candidateKey = `${BACKUP_V2_GC_CANDIDATES_PREFIX}00000000-0000-4000-8000-000000000001.json`;
    const candidate = new GcCandidateV2({
      format: 'backup-v2-gc-candidate',
      formatVersion: 2,
      objectKey: liveObject,
      firstSeen: new Date(Date.now() - 10_000).toISOString(),
      sweepGeneration: 1,
    });
    storage.putAt(candidateKey, candidate.encode(), Date.now() - 10_000);

    const swept = await sweepGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: Date.now(), graceMs: 1_000,
    });
    expect(swept.droppedCandidateKeys).toEqual([candidateKey]);
    expect(swept.deletedObjectKeys).toHaveLength(0);
    expect(await storage.get(liveObject)).not.toBeNull();
    expect(await storage.get(candidateKey)).toBeNull();
  });

  it('fails closed on truncated listings', async () => {
    const storage = new TruncatedStorage();
    await expect(collectGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: Date.now(), graceMs: 1_000,
    })).rejects.toThrow(/truncated/);
    expect(await candidateKeys(storage)).toHaveLength(0);
  });

  it('fails closed on a corrupt candidate before deleting anything', async () => {
    const { storage, orphan } = await publishedRepo();
    storage.putAt(
      `${BACKUP_V2_GC_CANDIDATES_PREFIX}00000000-0000-4000-8000-000000000002.json`,
      Buffer.from('{broken'),
      Date.now() - 10_000,
    );
    await expect(sweepGcCandidates(storage, {
      holderDeviceId: 'device-1', nowMs: Date.now(), graceMs: 1_000,
    })).rejects.toThrow(/GC candidate 解析失败/);
    expect(await storage.get(orphan)).not.toBeNull();
  });

  it('reports the backup lease error code when another holder exists', async () => {
    const { storage } = await publishedRepo();
    const guard = await acquireBackupRepoLease(storage, 'other-device');
    try {
      await expect(collectGcCandidates(storage, {
        holderDeviceId: 'device-1', nowMs: Date.now(), graceMs: 1_000,
      })).rejects.toThrow(/E_BACKUP_LEASE_HELD/);
    } finally {
      await guard.release();
    }
  });
});
