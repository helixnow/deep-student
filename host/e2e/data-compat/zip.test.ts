import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openHost } from './__tests__/host.ts';
import { ISO, buildSlot, cleanup, dbPath, history, rawHistory, rawSnapshot, snapshot, sqlMigrations, tempDir } from './__fixtures__/fixtures.ts';

const CORE = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const;
let base: string, active: string, real: Awaited<ReturnType<typeof openHost>>;
// The same five-database SQL fixture is built here before the public ZIP import assertions run.
beforeAll(async () => {
  base = tempDir(); active = buildSlot(base);
  writeFileSync(join(base, 'slots/state.json'), '{"active":"slotA","pending":null}');
  real = await openHost(base, true);
}, 60_000);
afterAll(async () => { try { await real?.dispose(); } finally { if (base) cleanup(base); } });

// Shape transcribed from dstu-sync/data_governance/backup/mod.rs BackupManifest/BackupFile.
// No Host exporter/manifest constructor is involved in making this legacy archive.
it.each(['1.0.0', '2.0.0'])('L21 public import reads Rust-format legacy manifest %s ZIP and actual databases', async version => {
  const zip = new JSZip();
  const files = CORE.map(db => {
    const bytes = readFileSync(dbPath(active, db));
    zip.file(`${db}.db`, bytes);
    return { path: `${db}.db`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), database_id: db };
  });
  const manifest = { version, app_version: '0.9.44', created_at: ISO, platform: 'linux',
    schema_versions: Object.fromEntries(CORE.map(db => [db, sqlMigrations(db).at(-1)!.version])),
    files, is_incremental: false, incremental_base: null, backup_id: `rust-legacy-${version}`,
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  const zipPath = join(base, `old-${version}.zip`);
  writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const backupId = `imported-${version}`;
  const started = await real.host.invoke<{ job_id: string }>('data_governance_import_zip', { zipPath, backupId });
  await vi.waitFor(() => {
    const job = real.host.ctx.backup.jobs.getJob(started.job_id);
    expect(job?.status, JSON.stringify(job)).toBe('completed');
  }, { timeout: 20_000, interval: 20 });
  const target = join(base, 'recovery/backups', backupId);
  for (const db of CORE) {
    const imported = real.storage.openFile(join(target, `${db}.db`), { mustExist: true, profile: { readonly: true } });
    try {
      expect(snapshot(imported, db), db).toEqual(rawSnapshot(active, db));
      expect(history(imported), `${db} history`).toEqual(rawHistory(active, db));
    } finally { real.storage.close(imported); }
  }
  // Import is read/stage only. It must not silently activate a new data-space slot.
  expect(real.storage.locations.activeSlot).toBe('slotA');
  const importedManifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));
  expect(importedManifest.version).toBe(version);
  expect(importedManifest.files).toEqual(files);
});
