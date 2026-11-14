// boundary-allow native-import: L21 A 产出种子流水线验收只在隔离临时目录里造合成产出并读回夹具库；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, ROOT, tempDir } from './__fixtures__/fixtures.ts';
import { A_PRODUCED_SEED_NAMES, availableAProducedSeeds, collectAProduced, FULL_BACKUP_SCENARIO, readProvenance, rewriteManifestKey,
  SEALED_ZIP_PASSWORD, seedBindings, unallocatedByteOffset, writeAProducedSeed, ZIPS_SCENARIO, type AProducedSeedName } from './__fixtures__/a-produced-seeds.ts';
import { snapshotDatabase, snapshotDirectory } from './__fixtures__/database-state.ts';
import { seedFingerprintDifferences, timedBuild } from './__fixtures__/seed-determinism.ts';
import { APP_IDENTIFIER, SEED_NAMES } from './__fixtures__/scenario-seeds.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${path}/`, ...files(directory, path)] : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).filter(f => !f.endsWith('/'))
  .map(f => [f, sha256(readFileSync(join(directory, f)))]));
const write = (file: string, bytes: string | Buffer) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); };

const BACKUP_ID = '20261107_010203';
const BACKUP_FILES = ['chat_v2.db', 'databases/vfs.db', 'manifest.json'];

function sqlite(file: string, tables: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    for (let i = 0; i < tables; i++) db.exec(`CREATE TABLE t${i}(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t${i}(v) VALUES ('w21-${i}')`);
  } finally { db.close(); }
}

/** g3-run layout for producers.v0.json: `<out>/<scenario>/<take>/{trace.json,run/app-data/<id>/...}`. */
function syntheticRun(out: string, zips: string, take: string): void {
  const backup = join(out, FULL_BACKUP_SCENARIO, take, 'run/app-data', APP_IDENTIFIER, 'recovery/backups', BACKUP_ID);
  sqlite(join(backup, 'chat_v2.db'), 3);
  sqlite(join(backup, 'databases/vfs.db'), 40);
  mkdirSync(join(backup, 'assets/empty'), { recursive: true });
  const entry = (path: string, id: string) => `    {\n      "path": "${path}",\n      "size": ${statSync(join(backup, path)).size},\n`
    + `      "sha256": "${sha256(readFileSync(join(backup, path)))}",\n      "database_id": "${id}"\n    }`;
  write(join(backup, 'manifest.json'), `{\n  "version": "3.0.0",\n  "app_version": "0.9.2",\n  "created_at": "2026-11-07T01:02:03.456789+00:00",\n`
    + `  "platform": "linux",\n  "schema_versions": {\n    "created_at": "nested"\n  },\n  "files": [\n${entry('chat_v2.db', 'chat_v2')},\n`
    + `${entry('databases/vfs.db', 'vfs')}\n  ],\n  "is_incremental": false,\n  "incremental_base": null,\n  "backup_id": "${BACKUP_ID}",\n`
    + `  "snapshot_epoch": 18446744073709551615\n}`);
  const call = (command: string, kind: string, raw: unknown) => ({ command, argsRaw: '{}', outcome: { kind, raw: JSON.stringify(raw) } });
  const job = (id: string) => call('data_governance_get_backup_job', 'result', { job_id: id, status: 'completed' });
  const text = (value: string | null) => ({ storageClass: value === null ? 'null' : 'text', value });
  const auditRow = (operation_type: string, operation_data: string, details: string, timestamp: string) => ({ values: {
    operation_type: text(operation_type), status: text('Completed'), operation_data: text(operation_data), details: text(details), timestamp: text(timestamp) } });
  write(join(out, FULL_BACKUP_SCENARIO, take, 'trace.json'), JSON.stringify({ calls: [
    call('data_governance_run_backup', 'result', { job_id: 'job-1' }), call('data_governance_delete_backup', 'error', 'missing'),
    job('job-1'), call('data_governance_get_backup_list', 'result', [{ id: BACKUP_ID, path: BACKUP_ID }])],
  finalDatabases: { version: 0, databases: { [`app-data/${APP_IDENTIFIER}/slots/slotA/databases/audit.db`]: { tables: { __audit_log: { rows: [
    auditRow('Backup', '{"type":"Backup","backup_type":"Full","file_count":5,"total_size":4169728}', '{"job_id":"job-1"}', '2026-11-07T01:02:04.123456789+00:00'),
    auditRow('Migration', '{"type":"Migration","from_version":0,"to_version":20261027,"applied_count":71}', 'null', '2026-11-07T01:02:03.186+00:00'),
  ] } } } } } }));
  write(join(out, ZIPS_SCENARIO, take, 'trace.json'), JSON.stringify({ calls: [
    call('data_governance_backup_and_export_zip', 'result', { job_id: 'job-2' }), call('data_governance_delete_backup', 'error', 'missing'),
    job('job-2'), call('data_governance_backup_and_export_zip', 'result', { job_id: 'job-3' }),
    call('data_governance_delete_backup', 'error', 'missing'), job('job-3')] }));
  write(join(zips, 'portable.zip'), Buffer.from('PK\x05\x06portable', 'latin1'));
  write(join(zips, 'sealed.zip'), Buffer.from('PK\x05\x06sealed', 'latin1'));
}

let root: string, fixture: string;
const seed = (name: AProducedSeedName, under: string) => {
  const directory = join(root, under, name), app = join(directory, 'app-data', APP_IDENTIFIER);
  mkdirSync(join(directory, 'local-data'), { recursive: true });
  writeAProducedSeed(name, { directory, app }, fixture, { allowLocalCheck: true });
  return { directory, app };
};
beforeAll(() => {
  root = tempDir();
  syntheticRun(join(root, 'run'), join(root, 'zips'), 'B');
  fixture = join(root, 'fixture');
  collectAProduced({ runOutput: join(root, 'run'), zipsDir: join(root, 'zips'), outDir: fixture, take: 'B', localCheck: true,
    treeCommit: 'w21-test', root: ROOT });
}, 120_000);
afterAll(() => { if (root) cleanup(root); });

describe('L21 A-produced seeds', () => {
  it('a --local-check (B) fixture is never offered as a seed; the catalog offers none until A artifacts are frozen', () => {
    expect(readProvenance(fixture)).toMatchObject({ take: 'B', localCheck: true, a: null,
      seeds: ['l21-backups-mixed-v1', 'l21-backups-legacy-mirror-v1', 'l21-historical-zip-v1'] });
    expect(availableAProducedSeeds(fixture)).toEqual([]);
    expect(() => writeAProducedSeed('l21-backups-mixed-v1', { directory: join(root, 'x'), app: join(root, 'x/app') }, fixture)).toThrow(/A take/);
    expect(SEED_NAMES.filter(name => (A_PRODUCED_SEED_NAMES as readonly string[]).includes(name))).toEqual(availableAProducedSeeds());
  });

  it('an A take needs a successful build receipt and is then offered', () => {
    const receipt = join(root, 'receipt.json');
    write(receipt, JSON.stringify({ schema: 'wp043-tauri-build', code: 0, job: 'job', binarySha256: 'b'.repeat(64),
      submittedRevision: 'r', rustSourceTree: 't' }));
    syntheticRun(join(root, 'run-a'), join(root, 'zips-a'), 'A1');
    const options = { runOutput: join(root, 'run-a'), zipsDir: join(root, 'zips-a'), take: 'A1', treeCommit: 'w21-test', root: ROOT };
    expect(() => collectAProduced({ ...options, outDir: join(root, 'fixture-no-receipt') })).toThrow(/receipt/);
    const provenance = collectAProduced({ ...options, outDir: join(root, 'fixture-a'), receiptFile: receipt });
    expect(provenance.a).toMatchObject({ receiptSha256: sha256(readFileSync(receipt)), job: 'job' });
    expect(availableAProducedSeeds(join(root, 'fixture-a'))).toEqual([...A_PRODUCED_SEED_NAMES]);
    expect(digest(join(root, 'fixture-a'))).toMatchObject(Object.fromEntries(Object.entries(digest(fixture)).filter(([f]) => f !== 'PROVENANCE.json')));
  });

  it('freezes every file and directory of the backup gzip-wrapped, with size and sha256', () => {
    const provenance = readProvenance(fixture)!;
    expect(provenance.fullBackup!.backupId).toBe(BACKUP_ID);
    expect(provenance.fullBackup!.directories).toEqual(['assets', 'assets/empty', 'databases']);
    expect(provenance.fullBackup!.files.map(f => f.path)).toEqual(BACKUP_FILES);
    expect(provenance.fullBackup!.flip.path).toMatch(/\.db$/);
    expect(provenance.zips!.sealed.password).toBe(SEALED_ZIP_PASSWORD);
    expect(provenance.audit!.rows.map(r => r.operation_type)).toEqual(['Migration', 'Backup']);
    expect(provenance.audit!.mismatches).toEqual([]);
    expect(files(fixture)).toEqual(['PROVENANCE.json', 'full-backup/', 'full-backup/chat_v2.db.gz', 'full-backup/databases/',
      'full-backup/databases/vfs.db.gz', 'full-backup/manifest.json.gz', 'historical-zip/', 'historical-zip/portable.zip.gz', 'historical-zip/sealed.zip.gz']);
  });

  it('mixed: five variants of the one backup plus a stray file; rebuilds to the same G3 fingerprint, backup trees byte-identical', async () => {
    let built!: { directory: string; app: string };
    const first = timedBuild(() => (built = seed('l21-backups-mixed-v1', 'a')).directory);
    await new Promise(resolve => { setTimeout(resolve, 1_100); });
    const second = timedBuild(() => seed('l21-backups-mixed-v1', 'b').directory);
    expect(seedFingerprintDifferences(first, second)).toEqual([]);
    const recovery = (dir: string) => join(dir, 'app-data', APP_IDENTIFIER, 'recovery');
    expect(digest(recovery(second.directory))).toEqual(digest(recovery(first.directory)));
    const { directory, app } = built;
    const backups = join(app, 'recovery/backups');
    expect(readdirSync(backups).sort()).toEqual(['20260101_000000_full_ok', '20260102_000000_checksum_bad', '20260103_000000_dirname_mismatch',
      '20260104_000000_bad_manifest', '20260105_000000_no_manifest', 'stray.txt']);
    const manifest = (id: string) => readFileSync(join(backups, id, 'manifest.json'), 'utf8');
    const parsed = (id: string) => JSON.parse(manifest(id).replace(/: (\d{16,})/g, ': "$1"'));
    expect(parsed('20260101_000000_full_ok')).toMatchObject({ backup_id: '20260101_000000_full_ok', created_at: '2026-01-01T00:00:00+00:00',
      schema_versions: { created_at: 'nested' } });
    expect(parsed('20260102_000000_checksum_bad').created_at).toBe('2026-01-02T00:00:00+00:00');
    expect(parsed('20260103_000000_dirname_mismatch')).toMatchObject({ backup_id: 'other_manifest_id', created_at: '2026-01-03T00:00:00+00:00' });
    expect(manifest('20260104_000000_bad_manifest')).toBe('not json\n');
    expect(readdirSync(join(backups, '20260105_000000_no_manifest'))).not.toContain('manifest.json');
    for (const id of readdirSync(backups).filter(f => f !== 'stray.txt')) {
      expect(files(join(backups, id)).filter(f => f !== 'manifest.json'), id).toEqual(['assets/', 'assets/empty/', 'chat_v2.db', 'databases/', 'databases/vfs.db']);
    }
    // Only the two rewritten lines differ from the A manifest; the u64 literal survives.
    const original = readFileSync(join(root, 'run', FULL_BACKUP_SCENARIO, 'B/run/app-data', APP_IDENTIFIER, 'recovery/backups', BACKUP_ID, 'manifest.json'), 'utf8').split('\n');
    const rewritten = manifest('20260101_000000_full_ok').split('\n');
    expect(rewritten.length).toBe(original.length);
    expect(rewritten.filter((line, i) => line !== original[i])).toEqual(['  "created_at": "2026-01-01T00:00:00+00:00",', '  "backup_id": "20260101_000000_full_ok",']);
    expect(manifest('20260101_000000_full_ok')).toContain('"snapshot_epoch": 18446744073709551615');
    expect(readFileSync(join(directory, 'app-data', APP_IDENTIFIER, 'slots/state.json'), 'utf8')).toContain('"active": "slotA"');
  });

  it('checksum_bad: one byte differs from the manifest sha256, yet the database still opens and snapshots like full_ok', () => {
    const { app } = seed('l21-backups-mixed-v1', 'c');
    const { path } = readProvenance(fixture)!.fullBackup!.flip;
    const good = join(app, 'recovery/backups/20260101_000000_full_ok', path), bad = join(app, 'recovery/backups/20260102_000000_checksum_bad', path);
    const [a, b] = [readFileSync(good), readFileSync(bad)];
    expect(a.length).toBe(b.length);
    expect([...a].filter((byte, i) => byte !== b[i])).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(app, 'recovery/backups/20260102_000000_checksum_bad/manifest.json'), 'utf8').replace(/: (\d{16,})/g, ': "$1"'));
    expect(manifest.files.find((f: { path: string }) => f.path === path).sha256).toBe(sha256(a));
    expect(snapshotDatabase(bad)).toEqual(snapshotDatabase(good));
    const db = new Database(bad, { readonly: true });
    try { expect(db.pragma('integrity_check', { simple: true })).toBe('ok'); } finally { db.close(); }
    expect(Object.keys(snapshotDirectory(app).databases)).toContain(`recovery/backups/20260102_000000_checksum_bad/${path}`);
  });

  it('legacy mirror: mixed plus full_ok and checksum_bad copied under the legacy <base>/backups', () => {
    const { app } = seed('l21-backups-legacy-mirror-v1', 'd');
    expect(readdirSync(join(app, 'backups')).sort()).toEqual(['20260101_000000_full_ok', '20260102_000000_checksum_bad']);
    for (const id of ['20260101_000000_full_ok', '20260102_000000_checksum_bad']) {
      expect(digest(join(app, 'backups', id))).toEqual(digest(join(app, 'recovery/backups', id)));
    }
    expect(readFileSync(join(app, 'slots/.legacy_migration_complete'), 'utf8')).toBe('1');
  });

  it('historical zip: both ZIPs outside app-data, bound through seedBindings', () => {
    const { directory, app } = seed('l21-historical-zip-v1', 'e');
    expect(readdirSync(join(directory, 'files')).sort()).toEqual(['portable.zip', 'sealed.zip']);
    expect(readFileSync(join(directory, 'files/sealed.zip'))).toEqual(readFileSync(join(root, 'zips/sealed.zip')));
    expect(files(app).filter(f => f.endsWith('.zip'))).toEqual([]);
    expect(seedBindings('l21-historical-zip-v1', directory, fixture)).toEqual({
      file: { portableZip: join(directory, 'files/portable.zip'), sealedZip: join(directory, 'files/sealed.zip') },
      secret: { sealedZipPassword: SEALED_ZIP_PASSWORD } });
    expect(seedBindings('l21-backups-mixed-v1', directory, fixture)).toBeNull();
  });

  it('manifest rewrite only touches one top-level key; page-1 free byte offset lies between the pointer array and the content', () => {
    expect(rewriteManifestKey('{\n  "a": "x",\n  "b": {\n    "a": "y"\n  }\n}', 'a', 'z')).toBe('{\n  "a": "z",\n  "b": {\n    "a": "y"\n  }\n}');
    expect(() => rewriteManifestKey('{\n  "b": 1\n}', 'a', 'z')).toThrow(/0 top-level/);
    const file = join(root, 'page1.db');
    sqlite(file, 2);
    const bytes = readFileSync(file), offset = unallocatedByteOffset(bytes)!;
    expect(offset).toBeGreaterThanOrEqual(100 + 8 + 2 * bytes.readUInt16BE(103));
    expect(offset).toBeLessThan(bytes.readUInt16BE(105));
    expect(unallocatedByteOffset(Buffer.from('not sqlite'))).toBeNull();
  });
});
