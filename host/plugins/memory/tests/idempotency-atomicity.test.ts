import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { SmartWriteOutput } from '../api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }

describe('idempotent smart write atomicity', () => {
  it('idempotent_note_mutation_rolls_back_when_receipt_write_is_interrupted', async () => {
    const host = await setup();
    const key = 'fault-before-receipt';
    host.db.run(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF event ON memory_write_idempotency
      BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;`);

    const first = await host.host.invoke('memory_write_smart', {
      title: 'Atomic receipt test',
      content: 'The note and receipt must commit together.',
      memoryType: 'fact',
      idempotencyKey: key,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(first).toBeTruthy();
    expect((first as { message?: string }).message ?? String(first))
      .toContain('injected receipt write failure');
    expect(host.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM notes WHERE title = 'Atomic receipt test' AND deleted_at IS NULL")!.count)
      .toBe(0);
    expect(host.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memory_write_idempotency WHERE idempotency_key = ?1', [key])!.count)
      .toBe(0);

    host.db.run('DROP TRIGGER fail_receipt');
    const output = await host.host.invoke('memory_write_smart', {
      title: 'Atomic receipt test',
      content: 'The note and receipt must commit together.',
      memoryType: 'fact',
      idempotencyKey: key,
    }) as SmartWriteOutput;
    expect(output.event).toBe('ADD');
    expect(output.noteId).toMatch(/^note_/);

    expect(host.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM notes WHERE title = 'Atomic receipt test' AND deleted_at IS NULL")!.count)
      .toBe(1);
    const receipt = host.db.get<{ note_id: string; event: string }>(
      'SELECT note_id AS note_id, event FROM memory_write_idempotency WHERE idempotency_key = ?1', [key]);
    expect(receipt).toMatchObject({ note_id: output.noteId, event: 'ADD' });
  });

  // L17-V2/R5-M3, Rust service.rs:3145-3150 + commit_idempotent_smart_mutation:1140-1181.
  // If another owner reclaims the lease while the note mutation runs, the receipt UPDATE
  // matches no row; that is a lease_lost Conflict and the note mutation rolls back.
  it('memory_write_smart rolls back the note when the lease is reclaimed before the receipt', async () => {
    const host = await setup();
    const key = 'lease-reclaimed-mid-write';
    host.db.run(`CREATE TRIGGER steal_lease AFTER INSERT ON notes
      BEGIN UPDATE memory_write_idempotency SET reason = 'other-owner-token'
            WHERE idempotency_key = '${key}'; END;`);

    const error = await host.host.invoke('memory_write_smart', {
      title: 'Lease fenced write',
      content: 'Must not survive a lost lease.',
      memoryType: 'fact',
      idempotencyKey: key,
    }).then(() => null, (failure: unknown) => failure);

    expect(String((error as { message?: string } | null)?.message ?? error))
      .toMatch(/CONFLICT\(memory\.idempotency\.lease_lost\)/);
    expect(host.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM notes WHERE title = 'Lease fenced write' AND deleted_at IS NULL")!.count)
      .toBe(0);
    expect(host.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memory_write_idempotency WHERE idempotency_key = ?1 AND event != 'IN_PROGRESS'",
      [key])!.count).toBe(0);
  });
});
