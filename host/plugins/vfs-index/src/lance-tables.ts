/**
 * Lance connection + table lifecycle for the VFS profile store.
 *
 * Ported from the table-management half of
 * `crates/dstu-vfs/src/vfs/lance_store.rs`: connection caching, lazy table
 * creation, lifecycle column upgrades, ANN/FTS/scalar index repair and retired
 * profile sweeps. SQL is never issued here; profile rows come from
 * `repository/embedding-dim.ts`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import {
  getByKey,
  listByModality,
  retiredProfileTableCandidates,
  setAnnStatus,
  setProfileAnnStatus,
  tableHasOnlyUnreferencedRetiredProfiles,
  type VfsIndexProfile,
} from '../repository/embedding-dim.ts';
import {
  ANN_INDEX_VERSION,
  MIN_ROWS_FOR_ANN_INDEX,
  VFS_LANCE_TABLE_PREFIX,
  type LanceAdapter,
  type LanceConnection,
  type LanceTable,
  other,
  vfsLanceTableColumns,
} from './lance-types.ts';
import type { LaneLogger } from './logger.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LanceTables {
  private readonly db: SqlExecutor;
  private readonly basePath: string;
  private readonly adapter: LanceAdapter;
  private readonly logger: LaneLogger | undefined;
  private connectionPromise: Promise<LanceConnection> | null = null;
  private connection: LanceConnection | null = null;
  private readonly ensuredTables = new Set<string>();
  private prepare: (() => Promise<void>) | undefined;

  constructor(
    db: SqlExecutor,
    basePath: string,
    adapter: LanceAdapter,
    logger?: LaneLogger,
    prepare?: () => Promise<void>,
  ) {
    this.db = db;
    this.basePath = basePath;
    this.adapter = adapter;
    this.logger = logger;
    this.prepare = prepare;
  }

  get lancePath(): string {
    return this.basePath;
  }

  async connect(): Promise<LanceConnection> {
    if (this.connectionPromise === null) {
      this.connectionPromise = (this.prepare ? this.prepare() : Promise.resolve())
        .then(() => this.adapter.connect(this.lancePath)).then((connection) => {
        this.connection = connection;
        return connection;
      }).catch((error: unknown) => {
        this.connectionPromise = null;
        throw other(`连接 LanceDB 失败: ${messageOf(error)}`);
      });
    }
    return this.connectionPromise;
  }

  activeTableName(modality: string, dim: number): string {
    const registered = getByKey(this.db, dim, modality);
    return registered?.lance_table_name ?? `${VFS_LANCE_TABLE_PREFIX}${modality}_${dim}`;
  }

  private discoverTablesFromDisk(
    modality: string,
    tableNames: readonly string[],
  ): Array<[string, number]> {
    const prefix = `${VFS_LANCE_TABLE_PREFIX}${modality}_`;
    const tables: Array<[string, number]> = [];
    for (const rawName of tableNames) {
      const name = rawName.endsWith('.lance') ? rawName.slice(0, -'.lance'.length) : rawName;
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      const dimPart = suffix.split('_')[0] ?? '';
      if (dimPart !== '' && /^\d+$/.test(dimPart)) {
        tables.push([name, Number(dimPart)]);
      }
    }
    tables.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return tables.filter((entry, index) => index === 0 || entry[0] !== tables[index - 1]![0]);
  }

  async cleanupTableNames(modality: string): Promise<string[]> {
    const names = listByModality(this.db, modality).map((dim) => dim.lance_table_name);
    const connection = await this.connect();
    names.push(...this.discoverTablesFromDisk(modality, await connection.tableNames()).map(([name]) => name));
    names.sort();
    return names.filter((name, index) => index === 0 || name !== names[index - 1]);
  }

  tableHasOnlyUnreferencedRetiredProfiles(tableName: string): boolean {
    return tableHasOnlyUnreferencedRetiredProfiles(this.db, tableName);
  }

  retiredProfileTableCandidates(): string[] {
    return retiredProfileTableCandidates(this.db);
  }

  async sweepRetiredProfileTablesWithPreDrop(preDrop: (tableName: string) => void): Promise<number> {
    const candidates = this.retiredProfileTableCandidates()
      .filter((tableName) => this.connectionHasDirectory(tableName));
    if (candidates.length === 0) return 0;
    const connection = await this.connect();
    const existingTables = await connection.tableNames().catch((error: unknown) => {
      throw other(`list Lance tables for retired sweep failed: ${messageOf(error)}`);
    });
    let dropped = 0;
    let firstError: Error | null = null;
    for (const tableName of candidates) {
      if (!existingTables.includes(tableName)) continue;
      try {
        preDrop(tableName);
      } catch (error) {
        if (firstError === null) firstError = error instanceof Error ? error : other(String(error));
        continue;
      }
      try {
        await this.dropTable(tableName);
        dropped += 1;
      } catch (error) {
        if (firstError === null) firstError = error instanceof Error ? error : other(String(error));
      }
    }
    if (firstError !== null) throw firstError;
    return dropped;
  }

  async sweepRetiredProfileTables(): Promise<number> {
    return this.sweepRetiredProfileTablesWithPreDrop(() => undefined);
  }

  private connectionHasDirectory(tableName: string): boolean {
    return this.connection === null ? true : this.connection.hasTableDirectory(tableName);
  }

  async dropTable(tableName: string): Promise<void> {
    const connection = await this.connect();
    this.ensuredTables.delete(tableName);
    try {
      await connection.dropTable(tableName);
    } catch (error) {
      const text = messageOf(error);
      if (text.includes('not found') || text.includes('does not exist') || text.includes('Table not found')) {
        return;
      }
      throw other(`Failed to drop Lance table ${tableName}: ${text}`);
    }
  }

  private async ensureLifecycleColumns(
    table: LanceTable,
    modality: string,
    dim: number,
    explicitProfileId?: string,
  ): Promise<void> {
    const schema = await table.schema().catch((error: unknown) => {
      throw other(`读取 Lance 生命周期 schema 失败: ${messageOf(error)}`);
    });
    const profileId = explicitProfileId ?? getByKey(this.db, dim, modality)?.active_profile_id
      ?? `profile_legacy_${modality}_${dim}`;
    const expressions: Array<[string, string]> = [];
    const names = new Set(schema.fields.map((field) => field.name));
    if (!names.has('unit_id')) expressions.push(['unit_id', "''"]);
    if (!names.has('index_profile_id')) {
      expressions.push(['index_profile_id', `'${profileId.replace(/'/g, "''")}'`]);
    }
    if (!names.has('generation')) expressions.push(['generation', 'CAST(0 AS BIGINT)']);
    if (expressions.length > 0) {
      await table.addColumns(expressions).catch((error: unknown) => {
        throw other(`升级 legacy Lance 表生命周期列失败 (${modality}:${dim}): ${messageOf(error)}`);
      });
    }
  }

  async ensureTable(modality: string, dim: number): Promise<LanceTable> {
    const connection = await this.connect();
    const tableName = this.activeTableName(modality, dim);
    const alreadyEnsured = this.ensuredTables.has(tableName);
    let table: LanceTable | null;
    try {
      table = await connection.openTable(tableName);
    } catch (error) {
      throw other(`打开 Lance 表 ${tableName} 失败: ${messageOf(error)}`);
    }
    if (table === null) {
      this.ensuredTables.delete(tableName);
      table = await connection.createTable(tableName, vfsLanceTableColumns(dim)).catch((error: unknown) => {
        throw other(`创建 Lance 表失败: ${messageOf(error)}`);
      });
    } else if (alreadyEnsured) {
      return table;
    }

    await this.ensureLifecycleColumns(table, modality, dim);
    const rowCount = await table.countRows().catch((error: unknown) => {
      throw other(`统计 Lance 表 ${tableName} 行数失败: ${messageOf(error)}`);
    });

    const embedOk = true;
    if (rowCount < MIN_ROWS_FOR_ANN_INDEX) {
      setAnnStatus(this.db, dim, modality, 'exact', ANN_INDEX_VERSION);
    } else {
      const state = getByKey(this.db, dim, modality);
      const mustReplace = state !== undefined
        && (state.ann_metric !== 'cosine' || state.ann_index_version !== ANN_INDEX_VERSION);
      try {
        await table.createIndex(['embedding'], 'cosine-ivf-pq');
        setAnnStatus(this.db, dim, modality, 'cosine', ANN_INDEX_VERSION);
      } catch (error) {
        const text = messageOf(error);
        if (!(!mustReplace && text.includes('already exists'))) {
          throw other(
            `创建 Cosine IVF-PQ 索引失败 (table=${tableName}, rows=${rowCount}): ${text}`,
          );
        }
      }
    }

    let ftsOk = true;
    try {
      await table.createIndex(['text'], 'fts-ngram');
    } catch (error) {
      const text = messageOf(error);
      if (!text.includes('already exists')) {
        ftsOk = false;
        this.logger?.warn(`[VfsLanceStore] FTS index ensure failed on ${tableName}: ${text}`);
      }
    }
    let scalarOk = true;
    for (const [column, kind] of [
      ['resource_id', 'btree'],
      ['folder_id', 'btree'],
      ['resource_type', 'bitmap'],
    ] as const) {
      try {
        await table.createIndex([column], kind);
      } catch (error) {
        const text = messageOf(error);
        if (!text.includes('already exists')) {
          scalarOk = false;
          this.logger?.warn(
            `[VfsLanceStore] scalar index ensure failed on ${tableName}.${column}: ${text}`,
          );
        }
      }
    }
    if (embedOk && ftsOk && scalarOk && rowCount >= MIN_ROWS_FOR_ANN_INDEX) {
      this.ensuredTables.add(tableName);
    }
    return table;
  }

  async openProfileTable(profile: VfsIndexProfile): Promise<LanceTable> {
    const connection = await this.connect();
    let table = await connection.openTable(profile.lance_table_name);
    if (table === null) {
      if (profile.state === 'active' || profile.state === 'building') {
        this.ensuredTables.delete(profile.lance_table_name);
        table = await connection.createTable(
          profile.lance_table_name,
          vfsLanceTableColumns(profile.dimension),
        ).catch((error: unknown) => {
          throw other(`创建 profile Lance 表 ${profile.lance_table_name} 失败: ${messageOf(error)}`);
        });
      } else {
        throw other(`打开 profile Lance 表 ${profile.lance_table_name} 失败: table not found`);
      }
    }
    if (this.ensuredTables.has(profile.lance_table_name)) return table;

    await this.ensureLifecycleColumns(table, profile.modality, profile.dimension, profile.id);
    const rowCount = await table.countRows().catch((error: unknown) => {
      throw other(`统计 profile Lance 表 ${profile.lance_table_name} 失败: ${messageOf(error)}`);
    });
    if (rowCount >= MIN_ROWS_FOR_ANN_INDEX) {
      const mustReplace = profile.ann_metric !== 'cosine'
        || profile.ann_index_version !== ANN_INDEX_VERSION;
      try {
        await table.createIndex(['embedding'], 'cosine-ivf-pq');
        setProfileAnnStatus(this.db, profile.id, 'cosine', ANN_INDEX_VERSION);
      } catch (error) {
        const text = messageOf(error);
        if (!(!mustReplace && text.includes('already exists'))) {
          throw other(`创建 profile Cosine IVF-PQ 索引失败 ${profile.lance_table_name}: ${text}`);
        }
      }
    } else {
      setProfileAnnStatus(this.db, profile.id, 'exact', ANN_INDEX_VERSION);
    }
    const secondaryReady = await this.ensureProfileSecondaryIndexes(
      table,
      profile.lance_table_name,
      profile.modality,
    );
    if (secondaryReady) this.ensuredTables.add(profile.lance_table_name);
    return table;
  }

  private async ensureProfileSecondaryIndexes(
    table: LanceTable,
    tableName: string,
    modality: string,
  ): Promise<boolean> {
    let allReady = true;
    if (modality === 'text') {
      try {
        await table.createIndex(['text'], 'fts-ngram');
      } catch (error) {
        const text = messageOf(error);
        if (!text.includes('already exists')) {
          allReady = false;
          this.logger?.warn(`[VfsLanceStore] FTS index ensure failed on ${tableName}: ${text}`);
        }
      }
    }
    for (const [column, kind] of [
      ['resource_id', 'btree'],
      ['folder_id', 'btree'],
      ['resource_type', 'bitmap'],
    ] as const) {
      try {
        await table.createIndex([column], kind);
      } catch (error) {
        const text = messageOf(error);
        if (!text.includes('already exists')) {
          allReady = false;
          this.logger?.warn(
            `[VfsLanceStore] scalar index ensure failed on ${tableName}.${column}: ${text}`,
          );
        }
      }
    }
    return allReady;
  }

  isTableEnsured(tableName: string): boolean {
    return this.ensuredTables.has(tableName);
  }

  forgetEnsuredTable(tableName: string): void {
    this.ensuredTables.delete(tableName);
  }
}
