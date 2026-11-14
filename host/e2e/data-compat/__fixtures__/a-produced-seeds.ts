/**
 * L21 seeds built from artifacts the A reference build produced (backup equivalence README §4.1, §4.4, §10.5).
 * `a-produced/collect.ts` freezes them under `a-produced/` on the server (steps in `a-produced/README.md`);
 * building a seed only copies and rewrites those frozen bytes, so two builds are byte-identical. A seed is
 * offered (SEED_NAMES) only once `a-produced/PROVENANCE.json` exists, comes from an A take and lists it.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AUDIT_DB, auditShapeMismatches, type AuditSampleRow } from './audit-seeds.ts';
import { HERE } from './fixtures.ts';
import { replaySlot, writeSlotState } from './slot-seeds.ts';

export const A_PRODUCED_SEED_NAMES = ['l21-backups-mixed-v1', 'l21-backups-legacy-mirror-v1', 'l21-historical-zip-v1'] as const;
export type AProducedSeedName = typeof A_PRODUCED_SEED_NAMES[number];
export const A_PRODUCED_DIR = join(HERE, '__fixtures__/a-produced');
export const PROVENANCE_SCHEMA = 'w21-a-produced/v1';
export const PRODUCER_SUITE = 'host/e2e/data-compat/__fixtures__/a-produced/producers.v0.json';
export const FULL_BACKUP_SCENARIO = 'w21.a-produce.full-backup';
export const ZIPS_SCENARIO = 'w21.a-produce.historical-zips';
/** `outputPath` and `encryptionPassword` of the zips scenario in producers.v0.json. */
export const ZIP_OUTPUT_DIR = '/tmp/w21-a-produced';
export const SEALED_ZIP_PASSWORD = 'w21-l21-historical-sealed';
export const STORED_BYTES_LIMIT = 32 * 1024 * 1024;

const BACKUPS_DIR = 'recovery/backups';
/** Legacy `<base>/backups` that `verify_backup_with_assets` resolves against (commands_asset.rs:173-174). */
const LEGACY_BACKUPS_DIR = 'backups';
const MANIFEST = 'manifest.json';
/** `<seed>/files/`: outside app-data, so neither app sees the ZIPs as its own data. */
export const SEED_FILES_DIR = 'files';

export interface FrozenFile { path: string; size: number; sha256: string }
export interface AProducedProvenance {
  schema: typeof PROVENANCE_SCHEMA;
  seeds: AProducedSeedName[];
  take: string;
  /** Set only by `collect.ts --local-check` (a B take used to exercise the pipeline); such a fixture never becomes a seed. */
  localCheck?: true;
  producer: { suite: string; suiteSha256: string; treeCommit: string };
  a: { receiptSha256: string; job: string; binarySha256: string; submittedRevision: string; rustSourceTree: string } | null;
  fullBackup: { backupId: string; directories: string[]; files: FrozenFile[]; flip: { path: string; offset: number } } | null;
  zips: { portable: FrozenFile; sealed: FrozenFile & { password: string } } | null;
  /** Audit rows the producer run wrote itself, against which the constructed audit seeds are checked (audit-seeds.ts). */
  audit: { rows: AuditSampleRow[]; mismatches: string[] } | null;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const posixPath = (path: string) => path.split(sep).join(posix.sep);

export function readProvenance(dir = A_PRODUCED_DIR): AProducedProvenance | null {
  const file = join(dir, 'PROVENANCE.json');
  if (!existsSync(file)) return null;
  const provenance = JSON.parse(readFileSync(file, 'utf8')) as AProducedProvenance;
  if (provenance.schema !== PROVENANCE_SCHEMA) throw new Error(`${file}: schema must be ${PROVENANCE_SCHEMA}`);
  return provenance;
}

/** Seeds whose A artifacts are frozen in `dir`; a `--local-check` fixture offers none. */
export function availableAProducedSeeds(dir = A_PRODUCED_DIR): AProducedSeedName[] {
  const provenance = readProvenance(dir);
  if (!provenance || provenance.localCheck || !provenance.a || !/^A[12]$/.test(provenance.take)) return [];
  return A_PRODUCED_SEED_NAMES.filter(name => provenance.seeds.includes(name));
}

/**
 * Replace one top-level key of a `serde_json::to_string_pretty` manifest (backup/mod.rs:1615-1617) and keep
 * every other byte: big integers and key order survive, which a JSON round trip would not guarantee.
 */
export function rewriteManifestKey(manifest: string, key: string, value: string): string {
  const pattern = new RegExp(`^(  "${key}": )"(?:[^"\\\\]|\\\\.)*"`, 'gm');
  const count = manifest.match(pattern)?.length ?? 0;
  if (count !== 1) throw new Error(`manifest has ${count} top-level "${key}" string fields; expected exactly one`);
  return manifest.replace(pattern, (_, prefix: string) => `${prefix}${JSON.stringify(value)}`);
}

/**
 * Offset of one byte in page 1's unallocated area (between the cell pointer array and the cell content
 * area). Changing it changes the file's sha256 but not what SQLite reads, so the copy stays a valid
 * database for both apps and for the G3 snapshotter. Null if page 1 has no such byte.
 */
export function unallocatedByteOffset(db: Buffer): number | null {
  if (db.length < 112 || db.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') return null;
  const pageSize = db.readUInt16BE(16) === 1 ? 65536 : db.readUInt16BE(16);
  const type = db[100];
  if (type !== 0x0d && type !== 0x05) return null;
  const pointersEnd = 100 + (type === 0x05 ? 12 : 8) + 2 * db.readUInt16BE(103);
  const contentStart = db.readUInt16BE(105) || 65536;
  if (contentStart > pageSize || contentStart - pointersEnd < 1) return null;
  return pointersEnd + Math.floor((contentStart - pointersEnd) / 2);
}

function walkTree(root: string): { directories: string[]; files: string[] } {
  const directories: string[] = [], files: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), rel = posixPath(relative(root, path)), stat = lstatSync(path);
      if (stat.isDirectory()) { directories.push(rel); walk(path); }
      else if (stat.isFile()) files.push(rel);
      else throw new Error(`A artifact is not a regular file or directory: ${path}`);
    }
  };
  walk(root);
  return { directories, files };
}

function readFrozen(dir: string, stored: string, file: FrozenFile): Buffer {
  const raw = readFileSync(join(dir, stored));
  const bytes = stored.endsWith('.gz') ? gunzipSync(raw) : raw;
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`${stored}: frozen bytes differ from PROVENANCE.json`);
  return bytes;
}

function write(file: string, bytes: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

type ManifestMode = { kind: 'rewrite'; backupId: string; createdAt: string } | { kind: 'invalid' } | { kind: 'absent' };

function writeBackupCopy(target: string, provenance: AProducedProvenance, dir: string, manifest: ManifestMode, flip = false): void {
  const backup = provenance.fullBackup!;
  mkdirSync(target, { recursive: true });
  for (const directory of backup.directories) mkdirSync(join(target, directory), { recursive: true });
  for (const file of backup.files) {
    let bytes = readFrozen(dir, `full-backup/${file.path}.gz`, file);
    if (file.path === MANIFEST) {
      if (manifest.kind === 'absent') continue;
      if (manifest.kind === 'invalid') { write(join(target, MANIFEST), 'not json\n'); continue; }
      let text = rewriteManifestKey(bytes.toString('utf8'), 'backup_id', manifest.backupId);
      text = rewriteManifestKey(text, 'created_at', manifest.createdAt);
      bytes = Buffer.from(text, 'utf8');
    } else if (flip && file.path === backup.flip.path) {
      bytes = Buffer.from(bytes);
      bytes[backup.flip.offset] = bytes[backup.flip.offset]! ^ 0xff;
    }
    write(join(target, file.path), bytes);
  }
}

/**
 * `l21-backups-mixed-v1` (README §4.1): one A full backup, copied into five variants; `created_at` follows the
 * directory date so `auto_verify`'s `max_by(created_at)` picks 20260103 before and after the deletions.
 */
function writeMixedBackups(app: string, provenance: AProducedProvenance, dir: string): void {
  const root = join(app, BACKUPS_DIR);
  const rewrite = (backupId: string, day: string): ManifestMode => ({ kind: 'rewrite', backupId, createdAt: `2026-01-${day}T00:00:00+00:00` });
  writeBackupCopy(join(root, '20260101_000000_full_ok'), provenance, dir, rewrite('20260101_000000_full_ok', '01'));
  writeBackupCopy(join(root, '20260102_000000_checksum_bad'), provenance, dir, rewrite('20260102_000000_checksum_bad', '02'), true);
  writeBackupCopy(join(root, '20260103_000000_dirname_mismatch'), provenance, dir, rewrite('other_manifest_id', '03'));
  writeBackupCopy(join(root, '20260104_000000_bad_manifest'), provenance, dir, { kind: 'invalid' });
  writeBackupCopy(join(root, '20260105_000000_no_manifest'), provenance, dir, { kind: 'absent' });
  write(join(root, 'stray.txt'), 'not a backup\n');
}

function copyTree(source: string, target: string): void {
  const { directories, files } = walkTree(source);
  mkdirSync(target, { recursive: true });
  for (const directory of directories) mkdirSync(join(target, directory), { recursive: true });
  for (const file of files) copyFileSync(join(source, file), join(target, file));
}

export interface AProducedSeedTarget { directory: string; app: string }

/** `allowLocalCheck` lets tests build from a `--local-check` fixture; the catalog never does. */
export function writeAProducedSeed(name: AProducedSeedName, seed: AProducedSeedTarget, dir = A_PRODUCED_DIR, options: { allowLocalCheck?: boolean } = {}): void {
  const provenance = readProvenance(dir);
  if (!provenance || !provenance.seeds.includes(name)) throw new Error(`A-produced seed ${name} is not frozen in ${dir} (a-produced/README.md)`);
  if ((provenance.localCheck || !provenance.a) && !options.allowLocalCheck) throw new Error(`${dir}: fixture was not produced by an A take`);
  replaySlot(join(seed.app, 'slots/slotA'));
  writeSlotState(seed.app, { legacyMigrationComplete: true });
  switch (name) {
    case 'l21-backups-mixed-v1': return writeMixedBackups(seed.app, provenance, dir);
    case 'l21-backups-legacy-mirror-v1':
      writeMixedBackups(seed.app, provenance, dir);
      for (const id of ['20260101_000000_full_ok', '20260102_000000_checksum_bad']) {
        copyTree(join(seed.app, BACKUPS_DIR, id), join(seed.app, LEGACY_BACKUPS_DIR, id));
      }
      return;
    case 'l21-historical-zip-v1': {
      const zips = provenance.zips!;
      write(join(seed.directory, SEED_FILES_DIR, 'portable.zip'), readFrozen(dir, zips.portable.path, zips.portable));
      write(join(seed.directory, SEED_FILES_DIR, 'sealed.zip'), readFrozen(dir, zips.sealed.path, zips.sealed));
      return;
    }
    default: throw new Error(`Unhandled A-produced seed: ${name satisfies never}`);
  }
}

/**
 * `${seed.file.portableZip}`, `${seed.file.sealedZip}`, `${seed.secret.sealedZipPassword}` (historical-zip.json)
 * for the run copy at `seedDirectory`; the recorder's resolver does not read a `seed` namespace yet (W13).
 */
export function seedBindings(name: string, seedDirectory: string, dir = A_PRODUCED_DIR): Record<string, Record<string, string>> | null {
  if (name !== 'l21-historical-zip-v1') return null;
  const zips = readProvenance(dir)?.zips;
  if (!zips) return null;
  return { file: { portableZip: join(seedDirectory, SEED_FILES_DIR, 'portable.zip'), sealedZip: join(seedDirectory, SEED_FILES_DIR, 'sealed.zip') },
    secret: { sealedZipPassword: zips.sealed.password } };
}

interface TraceCall { command: string; outcome: { kind: string; raw: string } }
type SnapshotRow = { values: Record<string, { value: string | null }> };
interface Trace { calls: TraceCall[]; finalDatabases?: { databases: Record<string, { tables: Record<string, { rows: SnapshotRow[] }> }> } }
function readTrace(takeDir: string): Trace {
  for (const name of ['trace.json', 'trace.json.gz']) {
    const file = join(takeDir, name);
    if (existsSync(file)) return JSON.parse((name.endsWith('.gz') ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString('utf8'));
  }
  throw new Error(`no trace in ${takeDir}`);
}
function completedJob(call: TraceCall | undefined, label: string): void {
  if (call?.command !== 'data_governance_get_backup_job' || call.outcome.kind !== 'result') throw new Error(`${label}: get_backup_job did not return`);
  const job = JSON.parse(call.outcome.raw) as { status?: string; error?: string } | null;
  if (job?.status !== 'completed') throw new Error(`${label}: job ended ${JSON.stringify(job?.status ?? null)} (${job?.error ?? 'no error text'})`);
}

export interface CollectOptions {
  /** g3-run-a.mjs output directory for producers.v0.json (run without --compact). */
  runOutput: string;
  zipsDir?: string;
  receiptFile?: string;
  treeCommit: string;
  outDir: string;
  take?: string;
  localCheck?: boolean;
  root: string;
}

/** Freeze the producer run's artifacts into `outDir` (layout described in a-produced/README.md). */
export function collectAProduced(options: CollectOptions): AProducedProvenance {
  const take = options.take ?? 'A1';
  if (!options.localCheck && (!/^A[12]$/.test(take) || !options.receiptFile)) throw new Error('an A take (A1/A2) and its build receipt are required');
  if (existsSync(options.outDir) && readdirSync(options.outDir).length) throw new Error(`output directory is not empty: ${options.outDir}`);
  let a: AProducedProvenance['a'] = null;
  if (options.receiptFile) {
    const bytes = readFileSync(options.receiptFile);
    const receipt = JSON.parse(bytes.toString('utf8'));
    if (receipt.schema !== 'wp043-tauri-build' || receipt.code !== 0) throw new Error('successful wp043 Tauri build receipt required');
    a = { receiptSha256: sha256(bytes), job: receipt.job, binarySha256: receipt.binarySha256,
      submittedRevision: receipt.submittedRevision, rustSourceTree: receipt.rustSourceTree };
  }
  const seeds: AProducedSeedName[] = [];
  let stored = 0;
  const store = (rel: string, bytes: Buffer) => {
    stored += bytes.length;
    if (stored > STORED_BYTES_LIMIT) throw new Error(`frozen artifacts exceed ${STORED_BYTES_LIMIT} bytes`);
    write(join(options.outDir, rel), bytes);
  };

  let fullBackup: AProducedProvenance['fullBackup'] = null, audit: AProducedProvenance['audit'] = null;
  const backupTake = join(options.runOutput, FULL_BACKUP_SCENARIO, take);
  if (existsSync(backupTake)) {
    const trace = readTrace(backupTake), calls = trace.calls;
    completedJob(calls[2], FULL_BACKUP_SCENARIO);
    const auditRows = trace.finalDatabases?.databases[`app-data/com.deepstudent.differential/slots/slotA/${AUDIT_DB}`]?.tables.__audit_log?.rows;
    if (auditRows?.length) {
      const rows = auditRows.map(({ values }) => ({ operation_type: values.operation_type!.value!, status: values.status!.value!,
        operation_data: values.operation_data!.value!, details: values.details?.value ?? null, timestamp: values.timestamp!.value! }))
        .sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
      audit = { rows, mismatches: auditShapeMismatches(rows) };
    }
    const list = calls[3]?.outcome.kind === 'result' ? JSON.parse(calls[3].outcome.raw) as { path?: string; id?: string }[] : [];
    if (list.length !== 1) throw new Error(`${FULL_BACKUP_SCENARIO}: expected exactly one backup, got ${list.length}`);
    const root = join(backupTake, 'run/app-data/com.deepstudent.differential', BACKUPS_DIR);
    const ids = readdirSync(root).filter(name => lstatSync(join(root, name)).isDirectory());
    if (ids.length !== 1) throw new Error(`${root}: expected one backup directory, got ${ids.join(', ')}`);
    const backupId = ids[0]!, source = join(root, backupId);
    const { directories, files } = walkTree(source);
    if (!files.includes(MANIFEST)) throw new Error(`${source}: no ${MANIFEST}`);
    const frozen: FrozenFile[] = [];
    let flip: { path: string; offset: number } | null = null;
    for (const path of files) {
      const bytes = readFileSync(join(source, path));
      if (path === MANIFEST) rewriteManifestKey(rewriteManifestKey(bytes.toString('utf8'), 'backup_id', 'x'), 'created_at', 'x');
      const offset: number | null = flip || !path.endsWith('.db') ? null : unallocatedByteOffset(bytes);
      if (offset !== null) flip = { path, offset };
      frozen.push({ path, size: bytes.length, sha256: sha256(bytes) });
      store(`full-backup/${path}.gz`, gzipSync(bytes, { level: 9 }));
    }
    if (!flip) throw new Error(`${source}: no .db file with an unallocated byte on page 1 for checksum_bad`);
    fullBackup = { backupId, directories, files: frozen, flip };
    seeds.push('l21-backups-mixed-v1', 'l21-backups-legacy-mirror-v1');
  }

  let zips: AProducedProvenance['zips'] = null;
  const zipsTake = join(options.runOutput, ZIPS_SCENARIO, take);
  if (existsSync(zipsTake)) {
    const calls = readTrace(zipsTake).calls;
    completedJob(calls[2], `${ZIPS_SCENARIO} portable`);
    completedJob(calls[5], `${ZIPS_SCENARIO} sealed`);
    // Stored gzip-wrapped like the backup files: `*.zip` is gitignored.
    const freeze = (name: string): FrozenFile => {
      const bytes = readFileSync(join(options.zipsDir ?? ZIP_OUTPUT_DIR, name));
      store(`historical-zip/${name}.gz`, gzipSync(bytes, { level: 9 }));
      return { path: `historical-zip/${name}.gz`, size: bytes.length, sha256: sha256(bytes) };
    };
    zips = { portable: freeze('portable.zip'), sealed: { ...freeze('sealed.zip'), password: SEALED_ZIP_PASSWORD } };
    seeds.push('l21-historical-zip-v1');
  }
  if (!seeds.length) throw new Error(`${options.runOutput}: neither producer scenario has a ${take} take`);

  const provenance: AProducedProvenance = { schema: PROVENANCE_SCHEMA, seeds, take, ...(options.localCheck ? { localCheck: true as const } : {}),
    producer: { suite: PRODUCER_SUITE, suiteSha256: sha256(readFileSync(join(options.root, PRODUCER_SUITE))), treeCommit: options.treeCommit },
    a, fullBackup, zips, audit };
  write(join(options.outDir, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}
