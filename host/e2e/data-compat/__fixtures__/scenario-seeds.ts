/**
 * Scenario-v0 SQL/synthetic-file fixtures. The only A-binary artifacts are the frozen `a-produced/` files
 * (a-produced-seeds.ts); those seeds are listed once their PROVENANCE.json exists.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildOwnerDatabase, buildSlot } from './fixtures.ts';
import { historicalSql, OWNER_SEEDS, WORKSPACE_ID } from './owner-fixtures.ts';
import { writeSkillZipSeeds } from './skill-zip-seeds.ts';
import { writeTempSessionsSeed } from './temp-sessions-seeds.ts';
import { writeReviewCasTombstoneSeed } from './review-cas-tombstone-seeds.ts';
import { BACKUP_SEED_NAMES, writeBackupSeed, type BackupSeedName } from './backup-seeds.ts';
import { AUDIT_SEED_NAMES, writeAuditSeed, type AuditSeedName } from './audit-seeds.ts';
import { A_PRODUCED_SEED_NAMES, availableAProducedSeeds, writeAProducedSeed, type AProducedSeedName } from './a-produced-seeds.ts';
import { SLOT_SEED_NAMES, writeSlotSeed, type SlotSeedName } from './slot-seeds.ts';
import { copySeedTree } from './seed-files.ts';

export const SEED_NAMES = ['empty', 'historical-wp013-v1', 'skill-zip-v0', 'l22-temp-sessions-w0', 'l15-review-cas-tombstone-w0',
  ...SLOT_SEED_NAMES, ...BACKUP_SEED_NAMES, ...AUDIT_SEED_NAMES, ...availableAProducedSeeds()] as const;
export type SeedName = typeof SEED_NAMES[number];
export interface SeedDirectory {
  name: SeedName;
  /**
   * A-produced seeds also say 'sql-constructed'; their origin is a-produced/PROVENANCE.json. describe() is on
   * every scenario's G3 A path (resolveSeed/copySeed, g3-inputs v2 slice): any edit to it marks every A take stale.
   */
  provenance: 'empty' | 'sql-constructed' | 'synthetic-zip';
  directory: string;
  /** Pass these two paths to the runner's isolated app/OS-local-data configuration. */
  dataDir: string;
  dataLocalDir: string;
}

/**
 * G3 runners pass `dataDir` as XDG_DATA_HOME: A (Tauri, D-156 identifier) opens `$XDG_DATA_HOME/<identifier>`,
 * B hands the Host the same directory. Seeded slots must live there or neither side sees them.
 */
export const APP_IDENTIFIER = 'com.deepstudent.differential';
export function appDataRoot(seed: Pick<SeedDirectory, 'dataDir'>): string {
  return join(seed.dataDir, APP_IDENTIFIER);
}
/** `dirs::data_local_dir()` (Rust sync_state.db) is XDG_DATA_HOME on Linux, i.e. `dataDir` under the G3 runners. */
export function osDataLocalRoot(seed: Pick<SeedDirectory, 'dataDir'>): string {
  return seed.dataDir;
}

function seedName(name: string): SeedName {
  if (!(SEED_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown scenario seed: ${name}`);
  return name as SeedName;
}

function describe(name: SeedName, directory: string): SeedDirectory {
  const provenance = name === 'empty' ? 'empty' : name === 'skill-zip-v0' ? 'synthetic-zip' : 'sql-constructed';
  return { name, provenance, directory,
    dataDir: join(directory, 'app-data'), dataLocalDir: join(directory, 'local-data') };
}

/** Resolve scenario.seed by exact catalog name; does not create or mutate anything. */
export function resolveSeed(name: string, catalog: string): SeedDirectory {
  const known = seedName(name);
  return describe(known, resolve(catalog, known));
}

function emptyDestination(directory: string): void {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length) throw new Error(`Seed destination is not empty: ${directory}`);
}

/** Build once, then copy this closed/quiescent directory for A1, A2 and B. */
export function createSeed(name: string, catalog: string): SeedDirectory {
  const seed = resolveSeed(name, catalog);
  emptyDestination(seed.directory);
  mkdirSync(seed.dataDir);
  mkdirSync(seed.dataLocalDir);
  const app = appDataRoot(seed);
  if (seed.name === 'historical-wp013-v1') {
    const active = buildSlot(app);
    buildOwnerDatabase(join(active, 'databases/audit.db'), historicalSql('audit'), OWNER_SEEDS.audit);
    buildOwnerDatabase(join(osDataLocalRoot(seed), 'deep-student/sync/sync_state.db'), historicalSql('sync-state'), OWNER_SEEDS.sync_state);
    buildOwnerDatabase(join(active, `workspaces/ws_${WORKSPACE_ID}.db`), historicalSql('workspace-v1'), OWNER_SEEDS.workspace, 1);
  }
  if (seed.name === 'skill-zip-v0') writeSkillZipSeeds(seed.directory);
  if (seed.name === 'l22-temp-sessions-w0') writeTempSessionsSeed(app);
  if (seed.name === 'l15-review-cas-tombstone-w0') writeReviewCasTombstoneSeed(app);
  if ((SLOT_SEED_NAMES as readonly string[]).includes(seed.name)) writeSlotSeed(seed.name as SlotSeedName, app);
  if ((BACKUP_SEED_NAMES as readonly string[]).includes(seed.name)) writeBackupSeed(seed.name as BackupSeedName, app);
  if ((AUDIT_SEED_NAMES as readonly string[]).includes(seed.name)) writeAuditSeed(seed.name as AuditSeedName, app);
  if ((A_PRODUCED_SEED_NAMES as readonly string[]).includes(seed.name)) writeAProducedSeed(seed.name as AProducedSeedName, { directory: seed.directory, app });
  return seed;
}

/** Copy all fixture files, including non-DB files; never copy a running app's data. */
export function copySeed(name: string, catalog: string, destination: string): SeedDirectory {
  const source = resolveSeed(name, catalog);
  const target = resolve(destination);
  const nested = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  if (nested(source.directory, target) || nested(target, source.directory)) throw new Error('Seed source and destination overlap');
  if (!existsSync(source.dataDir) || !existsSync(source.dataLocalDir)) throw new Error(`Seed has not been created: ${source.directory}`);
  emptyDestination(target);
  copySeedTree(source.directory, target);
  return describe(source.name, target);
}
