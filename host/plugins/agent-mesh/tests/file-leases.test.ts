import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { FileLeaseTable, patternsOverlap } from '../src/file-leases.ts';

const tables: FileLeaseTable[] = [];
const tempDirs: string[] = [];

function createTable(defaultTtlMs = 30_000): FileLeaseTable {
  const t = new FileLeaseTable({ defaultTtlMs });
  tables.push(t);
  return t;
}

afterEach(async () => {
  while (tables.length > 0) {
    tables.pop()!.dispose();
  }
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Path-Granularity FileLeaseTable', () => {
  it('accurately computes symmetric glob, prefix, and exact-path overlaps', () => {
    expect(patternsOverlap('src/db.ts', 'src/db-pool.ts')).toBe(false);
    expect(patternsOverlap('src/frontend/**', 'src/backend/**')).toBe(false);
    expect(patternsOverlap('src/raft/**', 'src/raft/election.ts')).toBe(true);
    expect(patternsOverlap('src/raft/election.ts', 'src/raft/**')).toBe(true);
    expect(patternsOverlap('src/raft', 'src/raft/log.ts')).toBe(true);
    expect(patternsOverlap('src/raft', 'src/raft-v2/log.ts')).toBe(false);
    expect(patternsOverlap('src/**/*.test.ts', 'src/raft/log.test.ts')).toBe(true);
    expect(patternsOverlap('src/**/*.test.ts', 'src/raft/log.ts')).toBe(false);
    expect(patternsOverlap('src/*.{ts,tsx}', 'src/App.tsx')).toBe(true);
    expect(patternsOverlap('src/*.{ts,tsx}', 'src/styles.css')).toBe(false);
  });

  it('grants disjoint leases in parallel and allows re-entrant TTL refresh by the same holder', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-lease-root-'));
    tempDirs.push(root);
    const table = createTable(5_000);

    const [claudeLease, codexLease] = await Promise.all([
      table.acquireLease({
        rootPath: root,
        patterns: ['src/ui/**', 'src/shared-types.ts'],
        holderAgentId: 'claude',
        threadId: 'thread-claude',
        ttlMs: 2_000,
      }),
      table.acquireLease({
        rootPath: root,
        patterns: ['src/server/**', 'src/shared-types-v2.ts'],
        holderAgentId: 'codex',
        threadId: 'thread-codex',
        ttlMs: 2_000,
      }),
    ]);

    expect(claudeLease.granted).toBe(true);
    expect(codexLease.granted).toBe(true);
    expect(table.listActiveLeases(root)).toHaveLength(4);

    // Re-entrant acquisition by `claude` on an overlapping file & existing glob refreshes TTL
    const firstExpiry = claudeLease.granted ? claudeLease.leases[0]!.expiresAt : 0;
    const reentrant = await table.acquireLease({
      rootPath: root,
      patterns: ['src/ui/Button.tsx', 'src/ui/**'],
      holderAgentId: 'claude',
      threadId: 'thread-claude',
      ttlMs: 15_000,
    });
    expect(reentrant.granted).toBe(true);
    if (reentrant.granted) {
      const refreshedGlob = reentrant.leases.find((l) => l.pattern === 'src/ui/**');
      expect(refreshedGlob).toBeDefined();
      expect(refreshedGlob!.expiresAt).toBeGreaterThan(firstExpiry);
    }
  });

  it('queues overlapping acquirers up to waitMs, wakes immediately on release, and returns conflict metadata on timeout', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-lease-wait-'));
    tempDirs.push(root);
    const table = createTable(30_000);

    const initial = await table.acquireLease({
      rootPath: root,
      patterns: ['src/raft/**'],
      holderAgentId: 'arch-claude',
      threadId: 'thread-a',
    });
    expect(initial.granted).toBe(true);

    // Immediate non-waiting conflict check (`waitMs: 0`)
    const immediateBlocked = await table.acquireLease({
      rootPath: root,
      patterns: ['src/raft/state-machine.ts'],
      holderAgentId: 'impl-codex',
      threadId: 'thread-b',
      waitMs: 0,
    });
    expect(immediateBlocked.granted).toBe(false);
    if (!immediateBlocked.granted) {
      expect(immediateBlocked.conflict).toMatchObject({
        holderAgentId: 'arch-claude',
        holderThreadId: 'thread-a',
        conflictingPattern: 'src/raft/**',
        requestedPattern: 'src/raft/state-machine.ts',
      });
      expect(immediateBlocked.conflict.heldSince).toBeGreaterThan(0);
      expect(immediateBlocked.hint).toContain('@arch-claude');
    }

    // Waiting acquirer (`waitMs: 5000`) wakes up immediately when holder releases after 40ms
    const waitStart = Date.now();
    const pendingAcquire = table.acquireLease({
      rootPath: root,
      patterns: ['src/raft/state-machine.ts'],
      holderAgentId: 'impl-codex',
      threadId: 'thread-b',
      waitMs: 5_000,
    });

    setTimeout(() => {
      table.releaseAgentLeases('arch-claude', 'thread-a');
    }, 40);

    const woken = await pendingAcquire;
    const elapsed = Date.now() - waitStart;
    expect(woken.granted).toBe(true);
    expect(elapsed).toBeLessThan(1_500);

    // Now a third agent waiting only 50ms while `impl-codex` holds `src/raft/state-machine.ts` times out cleanly
    const timedOut = await table.acquireLease({
      rootPath: root,
      patterns: ['src/raft/**'],
      holderAgentId: 'pi-reviewer',
      threadId: 'thread-c',
      waitMs: 50,
    });
    expect(timedOut.granted).toBe(false);
    if (!timedOut.granted) {
      expect(timedOut.conflict.holderAgentId).toBe('impl-codex');
      expect(timedOut.conflict.conflictingPattern).toBe('src/raft/state-machine.ts');
    }
  });

  it('automatically expires stale leases on TTL and wakes waiting peers without manual release', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dstu-lease-ttl-'));
    tempDirs.push(root);
    const table = createTable(60);

    const shortLease = await table.acquireLease({
      rootPath: root,
      patterns: ['src/shared.ts'],
      holderAgentId: 'stalled-agent',
      threadId: 'thread-stalled',
      ttlMs: 60,
    });
    expect(shortLease.granted).toBe(true);

    // Peer waits up to 2000ms; TTL expires at ~60ms and wakes peer automatically
    const handedOver = await table.acquireLease({
      rootPath: root,
      patterns: ['src/shared.ts'],
      holderAgentId: 'healthy-agent',
      threadId: 'thread-healthy',
      ttlMs: 10_000,
      waitMs: 2_000,
    });
    expect(handedOver.granted).toBe(true);

    const active = table.listActiveLeases(root);
    expect(active).toHaveLength(1);
    expect(active[0]!.holderAgentId).toBe('healthy-agent');
  });
});
