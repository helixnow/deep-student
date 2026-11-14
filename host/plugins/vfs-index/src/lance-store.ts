/**
 * VFS Lance vector store.
 *
 * Behaviour is ported from `crates/dstu-vfs/src/vfs/lance_store.rs`. The native
 * LanceDB engine is supplied through {@link LanceConnection}; this module owns
 * profile/generation semantics, writes, deletes, search and maintenance.
 * Connection caching and table lifecycle live in `lance-tables.ts`, optimize/stats/
 * schema diagnostics in `lance-maintenance.ts`; SQLite bookkeeping lives in `repository/`.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsLanceRow, VfsLanceSearchResult } from '../api.ts';
import {
  embeddingProtocolForModality,
  getActiveProfile,
  getByKey,
  getProfileById,
  listAll,
  modelFingerprint,
  optimizeTableNames,
  profileIsReferenced,
  registerWithModelFingerprint,
  type VfsEmbeddingDim,
  type VfsIndexProfile,
} from '../repository/embedding-dim.ts';
import { deleteLanceOrphan, enqueueLanceOrphan } from '../repository/index-segment.ts';
import {
  generationEquals,
  generationIsNegative,
  generationIsZero,
  nextUnitGenerationValue,
  resourceAllowsLegacyGeneration,
  unitGenerationState,
} from '../repository/index-units.ts';
import { LanceTables } from './lance-tables.ts';
import { diagnoseLanceTables, lanceTableStats, optimizeLanceTable } from './lance-maintenance.ts';
import {
  ANN_INDEX_VERSION,
  MIN_ROWS_FOR_ANN_INDEX,
  OPTIMIZE_MIN_INTERVAL_SECS,
  VFS_MUTATION_LOCK,
  type LanceSearchRequest,
  type LanceTable,
  type LanceTableDiagnostic,
  type LanceTableSchema,
  type LanceWritableRow,
  type VfsLanceStoreOptions,
  invalidArgument,
  invalidState,
  notFound,
  other,
  parseLanceMetadataFields,
} from './lance-types.ts';

export {
  ANN_INDEX_VERSION,
  MIN_ROWS_FOR_ANN_INDEX,
  OPTIMIZE_MIN_INTERVAL_SECS,
  VFS_FTS_VERSION,
  VFS_LANCE_TABLE_PREFIX,
  VFS_MUTATION_LOCK,
  VfsStoreError,
  invalidArgument,
  invalidState,
  notFound,
  other,
  type LanceAdapter,
  type LanceColumnSchema,
  type LanceConnection,
  type LanceSearchRequest,
  type LanceTable,
  type LanceTableDiagnostic,
  type LanceTableSchema,
  type LanceVectorColumn,
  type LanceWritableRow,
  type VfsLanceStoreOptions,
} from './lance-types.ts';

export interface LanceSearchFilter {
  readonly folderIds?: readonly string[] | null;
  readonly resourceIds?: readonly string[] | null;
  readonly resourceTypes?: readonly string[] | null;
  readonly mountedResourceIds?: readonly string[] | null;
}

const SEARCH_RESULT_COLUMNS = [
  'embedding_id',
  'resource_id',
  'unit_id',
  'resource_type',
  'folder_id',
  'chunk_index',
  'text',
  'metadata',
  'index_profile_id',
  'generation',
] as const;

export class VfsLanceStore {
  private readonly db: SqlExecutor;
  private readonly tables: LanceTables;
  private lastOptimizeAt: number | null = null;

  constructor(db: SqlExecutor, options: VfsLanceStoreOptions) {
    this.db = db;
    this.tables = new LanceTables(db, options.basePath, options.adapter, options.logger, options.ensureBaseDir);
  }

  static tableName(modality: string, dim: number): string {
    return `vfs_emb_${modality}_${dim}`;
  }

  // ------------------------------------------------------------------ profiles

  ensureModelProfile(
    modality: string,
    dim: number,
    modelConfigId: string,
    modelName?: string | null,
  ): VfsIndexProfile {
    const protocol = embeddingProtocolForModality(modality);
    const effectiveModelName = modelName ?? modelConfigId;
    const expectedFingerprint = modelFingerprint(modelConfigId, effectiveModelName, protocol);
    return this.ensureModelProfileWithFingerprint(
      modality,
      dim,
      modelConfigId,
      effectiveModelName,
      expectedFingerprint,
    );
  }

  ensureModelProfileWithFingerprint(
    modality: string,
    dim: number,
    modelConfigId: string,
    modelName: string | null | undefined,
    expectedFingerprint: string,
  ): VfsIndexProfile {
    const effectiveModelName = modelName ?? modelConfigId;
    const current = getByKey(this.db, dim, modality);
    if (current !== undefined) {
      const sameProfile = current.model_fingerprint === expectedFingerprint;
      const expectedLegacyFingerprint = `legacy:model-config:${modelConfigId}`;
      const legacyProfileForConfig = current.model_fingerprint === expectedLegacyFingerprint
        && current.model_config_id === modelConfigId;
      if (current.record_count > 0 && !sameProfile && !legacyProfileForConfig) {
        throw invalidState(
          `Embedding result for ${modelConfigId}/${effectiveModelName} is stale; writable ${modality}:${dim} profile is ${JSON.stringify(current.model_fingerprint)}`,
        );
      }
    }
    const registered = registerWithModelFingerprint(this.db, {
      dimension: dim,
      modality,
      modelConfigId,
      modelName,
      fingerprintOverride: expectedFingerprint,
    });
    const profileId = registered.active_profile_id;
    if (profileId === null) {
      throw other(`Index profile was not created for ${modality}:${dim} model ${modelConfigId}`);
    }
    const profile = getActiveProfile(this.db, dim, modality);
    if (profile === undefined || profile.id !== profileId) {
      throw other(`Active index profile ${profileId} could not be resolved`);
    }
    return profile;
  }

  nextUnitGeneration(unitId: string, modality: string): bigint {
    if (modality !== 'text' && modality !== 'image' && modality !== 'multimodal') {
      throw invalidArgument('modality', `Unsupported modality: ${modality}`);
    }
    const next = nextUnitGenerationValue(this.db, unitId, modality);
    if (next === undefined) throw notFound('IndexUnit', unitId);
    return next;
  }

  private retainActiveUnitGenerations(
    modality: string,
    results: VfsLanceSearchResult[],
  ): VfsLanceSearchResult[] {
    if (modality !== 'text' && modality !== 'image' && modality !== 'multimodal') return [];
    const active = new Map<string, ReturnType<typeof unitGenerationState>>();
    const legacyAllowed = new Map<string, boolean>();
    const filtered: VfsLanceSearchResult[] = [];
    for (const result of results) {
      if (result.unit_id === '') {
        let allowed = legacyAllowed.get(result.resource_id);
        if (allowed === undefined) {
          allowed = resourceAllowsLegacyGeneration(this.db, result.resource_id, modality) ?? true;
          legacyAllowed.set(result.resource_id, allowed);
        }
        if (generationIsZero(result.generation) && allowed) filtered.push(result);
        continue;
      }
      let state = active.get(result.unit_id);
      if (state === undefined) {
        state = unitGenerationState(this.db, result.unit_id, modality);
        active.set(result.unit_id, state);
      }
      if (
        state !== undefined
        && state.allowed
        && generationEquals(state.generation, result.generation)
        && state.profileId === result.index_profile_id
      ) {
        filtered.push(result);
      }
    }
    return filtered;
  }

  // ------------------------------------------------------------------ tables

  async ensureTable(modality: string, dim: number): Promise<LanceTable> {
    return this.tables.ensureTable(modality, dim);
  }

  async ensureProfileReady(profileId: string): Promise<void> {
    const profile = this.resolveActiveProfileForSearch(profileId);
    await this.tables.openProfileTable(profile);
  }

  private resolveActiveProfileForSearch(profileId: string): VfsIndexProfile {
    const profile = getProfileById(this.db, profileId);
    if (profile === undefined) throw notFound('IndexProfile', profileId);
    const referenced = profileIsReferenced(this.db, profileId);
    if (!['active', 'building', 'queryable'].includes(profile.state) || !referenced) {
      throw invalidState(`Index profile ${profileId} is not queryable`);
    }
    return profile;
  }

  tableHasOnlyUnreferencedRetiredProfiles(tableName: string): boolean {
    return this.tables.tableHasOnlyUnreferencedRetiredProfiles(tableName);
  }

  retiredProfileTableCandidates(): string[] {
    return this.tables.retiredProfileTableCandidates();
  }

  async sweepRetiredProfileTablesWithPreDrop(preDrop: (tableName: string) => void): Promise<number> {
    return this.tables.sweepRetiredProfileTablesWithPreDrop(preDrop);
  }

  async sweepRetiredProfileTables(): Promise<number> {
    return this.tables.sweepRetiredProfileTables();
  }

  async dropTable(tableName: string): Promise<void> {
    return this.tables.dropTable(tableName);
  }

  isTableEnsured(tableName: string): boolean {
    return this.tables.isTableEnsured(tableName);
  }

  forgetEnsuredTable(tableName: string): void {
    this.tables.forgetEnsuredTable(tableName);
  }

  // ------------------------------------------------------------------ writes

  async writeChunks(modality: string, rows: readonly VfsLanceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await VFS_MUTATION_LOCK.read(async () => {
      const dim = rows[0]!.embedding.length;
      const profileId = rows[0]!.index_profile_id;
      if (profileId === '') {
        throw invalidArgument('index_profile_id', 'Vector rows must identify their index profile');
      }
      if (rows.some((row) => row.index_profile_id !== profileId
        || row.embedding.length !== dim
        || row.unit_id === ''
        || generationIsNegative(row.generation))) {
        throw invalidArgument(
          'rows',
          'A Lance write batch must use one profile and dimension, with non-empty Unit IDs and non-negative generations',
        );
      }
      const profile = getProfileById(this.db, profileId);
      if (profile === undefined) throw notFound('IndexProfile', profileId);
      const active = getActiveProfile(this.db, dim, modality);
      const isCurrentWriteProfile = active !== undefined && active.id === profile.id;
      if (profile.dimension !== dim
        || profile.modality !== modality
        || !['active', 'building'].includes(profile.state)
        || !isCurrentWriteProfile) {
        throw invalidState(
          `Index profile ${profile.id} is no longer the writable ${modality}:${dim} profile`,
        );
      }
      const table = await this.tables.openProfileTable(profile);
      const rowCountBefore = await table.countRows().catch((error: unknown) => {
        throw other(`Count rows before profile write ${profile.lance_table_name} failed: ${errorText(error)}`);
      });
      // Rust build_batch maps the DTO's metadata_json onto the Arrow metadata column.
      await table.add(rows.map(({ metadata_json, ...row }) => ({ ...row, metadata: metadata_json }))).catch((error: unknown) => {
        throw other(`写入 Lance 表失败 (append): ${errorText(error)}`);
      });
      if (rowCountBefore < MIN_ROWS_FOR_ANN_INDEX
        && rowCountBefore + rows.length >= MIN_ROWS_FOR_ANN_INDEX) {
        this.tables.forgetEnsuredTable(profile.lance_table_name);
      }
    });
  }

  async deleteByResource(modality: string, resourceId: string): Promise<number> {
    const connection = await this.tables.connect();
    let deleted = 0;
    let firstError: Error | null = null;
    const expr = `resource_id = '${resourceId.replace(/'/g, "''")}'`;
    for (const tableName of await this.tables.cleanupTableNames(modality)) {
      let table: LanceTable | null;
      try {
        table = await connection.openTable(tableName);
      } catch (error) {
        if (firstError === null) {
          firstError = other(`open table for delete_by_resource failed on ${tableName}: ${errorText(error)}`);
        }
        continue;
      }
      if (table === null) continue;
      try {
        await table.delete(expr);
        deleted += 1;
      } catch (error) {
        if (firstError === null) {
          firstError = other(`delete_by_resource failed on ${tableName}: ${errorText(error)}`);
        }
      }
    }
    if (firstError !== null) throw firstError;
    return deleted;
  }

  /** Delete a resource's vectors while keeping the active table for `keepDim`. */
  async deleteByResourceExceptDim(
    modality: string,
    resourceId: string,
    keepDim: number,
  ): Promise<number> {
    const connection = await this.tables.connect();
    const keepTable = this.tables.activeTableName(modality, keepDim);
    const expr = `resource_id = '${resourceId.replace(/'/g, "''")}'`;
    let deleted = 0;
    let firstError: Error | null = null;
    for (const tableName of await this.tables.cleanupTableNames(modality)) {
      if (tableName === keepTable) continue;
      try {
        const table = await connection.openTable(tableName);
        if (table === null) continue;
        await table.delete(expr);
        deleted += 1;
      } catch (error) {
        if (firstError === null) {
          firstError = other(
            `delete_by_resource_except_dim failed on ${tableName}: ${errorText(error)}`,
          );
        }
      }
    }
    if (firstError !== null) throw firstError;
    return deleted;
  }

  /** Delete a resource's old rows while keeping the supplied embedding ids. */
  async deleteByResourceExceptIds(
    modality: string,
    resourceId: string,
    keepIds: readonly string[],
  ): Promise<number> {
    const escapedResourceId = resourceId.replace(/'/g, "''");
    const expr = keepIds.length === 0
      ? `resource_id = '${escapedResourceId}'`
      : `resource_id = '${escapedResourceId}' AND embedding_id NOT IN (${keepIds
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(',')})`;
    const connection = await this.tables.connect();
    let deleted = 0;
    let firstError: Error | null = null;
    for (const tableName of await this.tables.cleanupTableNames(modality)) {
      try {
        const table = await connection.openTable(tableName);
        if (table === null) continue;
        await table.delete(expr);
        deleted += 1;
      } catch (error) {
        if (firstError === null) {
          firstError = other(
            `delete_by_resource_except_ids failed on ${tableName}: ${errorText(error)}`,
          );
        }
      }
    }
    if (firstError !== null) throw firstError;
    return deleted;
  }

  async deleteByEmbeddingIds(modality: string, embeddingIds: readonly string[]): Promise<number>;
  async deleteByEmbeddingIds(
    modality: string,
    dim: number,
    embeddingIds: readonly string[],
  ): Promise<number>;
  async deleteByEmbeddingIds(
    modality: string,
    dimOrIds: number | readonly string[],
    maybeIds?: readonly string[],
  ): Promise<number> {
    const embeddingIds = typeof dimOrIds === 'number' ? maybeIds! : dimOrIds;
    if (embeddingIds.length === 0) return 0;
    const connection = await this.tables.connect();
    const inList = embeddingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    const expr = `embedding_id IN (${inList})`;
    let deleted = 0;
    let firstError: Error | null = null;
    for (const tableName of await this.tables.cleanupTableNames(modality)) {
      let table: LanceTable | null;
      try {
        table = await connection.openTable(tableName);
      } catch (error) {
        if (firstError === null) {
          firstError = other(`open table for delete_by_embedding_ids failed on ${tableName}: ${errorText(error)}`);
        }
        continue;
      }
      if (table === null) continue;
      try {
        await table.delete(expr);
        deleted += 1;
      } catch (error) {
        if (firstError === null) {
          firstError = other(`delete_by_embedding_ids failed on ${tableName}: ${errorText(error)}`);
        }
      }
    }
    if (firstError !== null) throw firstError;
    return deleted;
  }

  async deleteByUnitExceptIds(
    modality: string,
    resourceId: string,
    unitId: string,
    keepEmbeddingIds: readonly string[],
  ): Promise<number> {
    const connection = await this.tables.connect();
    const keepClause = keepEmbeddingIds.length === 0
      ? ''
      : ` AND embedding_id NOT IN (${keepEmbeddingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')})`;
    const expr = `resource_id = '${resourceId.replace(/'/g, "''")}' AND (unit_id = '${unitId.replace(/'/g, "''")}' OR unit_id = '')${keepClause}`;
    let deleted = 0;
    let firstError: Error | null = null;
    for (const tableName of await this.tables.cleanupTableNames(modality)) {
      const table = await connection.openTable(tableName);
      if (table === null) continue;
      let schema: LanceTableSchema;
      try {
        schema = await table.schema();
      } catch (error) {
        if (firstError === null) {
          firstError = other(`read schema for unit cleanup failed on ${tableName}: ${errorText(error)}`);
        }
        continue;
      }
      const names = new Set(schema.fields.map((field) => field.name));
      const missing = ['unit_id', 'index_profile_id', 'generation'].filter((column) => !names.has(column));
      if (missing.length > 0) {
        if (this.tables.tableHasOnlyUnreferencedRetiredProfiles(tableName)) {
          try {
            await this.tables.dropTable(tableName);
            deleted += 1;
          } catch (error) {
            if (firstError === null) firstError = error instanceof Error ? error : other(String(error));
          }
        }
        continue;
      }
      try {
        await table.delete(expr);
        deleted += 1;
      } catch (error) {
        if (firstError === null) {
          firstError = other(`delete_by_unit_except_ids failed on ${tableName}: ${errorText(error)}`);
        }
      }
    }
    if (firstError !== null) throw firstError;
    return deleted;
  }

  async discardUncommittedRows(
    modality: string,
    resourceId: string,
    embeddingIds: readonly string[],
  ): Promise<void> {
    if (embeddingIds.length === 0) return;
    for (const embeddingId of embeddingIds) {
      enqueueLanceOrphan(this.db, embeddingId, resourceId);
    }
    await this.deleteByEmbeddingIds(modality, embeddingIds);
    for (const embeddingId of embeddingIds) {
      deleteLanceOrphan(this.db, embeddingId);
    }
  }

  // ------------------------------------------------------------------ search

  async vectorSearch(
    modality: string,
    queryEmbedding: readonly number[],
    topK: number,
    folderIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return this.vectorSearchFull(modality, queryEmbedding, topK, folderIds, null, resourceTypes);
  }

  async vectorSearchFull(
    _modality: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds?: readonly string[] | null,
    _resourceIds?: readonly string[] | null,
    _resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    throw invalidState(
      'dimension-only VFS vector search is disabled; use vector_search_profile_full with a planner-selected profile_id',
    );
  }

  async hybridSearch(
    modality: string,
    queryText: string,
    queryEmbedding: readonly number[],
    topK: number,
    folderIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return this.hybridSearchFull(
      modality, queryText, queryEmbedding, topK, folderIds, null, resourceTypes,
    );
  }

  async hybridSearchFull(
    _modality: string,
    _queryText: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds?: readonly string[] | null,
    _resourceIds?: readonly string[] | null,
    _resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    throw invalidState('dimension-only VFS hybrid search is disabled; use planner-owned profile routes');
  }

  async vectorSearchProfileFull(
    profileId: string,
    queryEmbedding: readonly number[],
    topK: number,
    folderIds?: readonly string[] | null,
    resourceIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
    mountedResourceIds?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    const profile = this.resolveActiveProfileForSearch(profileId);
    if (profile.dimension !== queryEmbedding.length) {
      throw invalidArgument(
        'query_embedding',
        `Profile ${profileId} expects dimension ${profile.dimension}, got ${queryEmbedding.length}`,
      );
    }
    const table = await this.tables.openProfileTable(profile);
    const rowCount = await table.countRows().catch((error: unknown) => {
      throw other(`统计 profile 查询表失败: ${errorText(error)}`);
    });
    const filter = VfsLanceStore.buildFilterExprFull(folderIds, resourceIds, resourceTypes, mountedResourceIds);
    const request: LanceSearchRequest = {
      vector: queryEmbedding,
      limit: Math.min(Math.max(topK * 3, 20), 500),
      filter,
      bypassVectorIndex: rowCount < MIN_ROWS_FOR_ANN_INDEX,
      refineFactor: rowCount < MIN_ROWS_FOR_ANN_INDEX ? null : 2,
      select: SEARCH_RESULT_COLUMNS,
    };
    let results = await table.vectorSearch(request).catch((error: unknown) => {
      throw other(`profile 向量查询执行失败: ${errorText(error)}`);
    });
    results = this.retainActiveUnitGenerations(profile.modality, results);
    results.sort((left, right) => right.score - left.score);
    return results.slice(0, topK);
  }

  async ftsSearchProfileFull(
    profileId: string,
    queryText: string,
    topK: number,
    folderIds?: readonly string[] | null,
    resourceIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
    mountedResourceIds?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    const profile = this.resolveActiveProfileForSearch(profileId);
    const table = await this.tables.openProfileTable(profile);
    const filter = VfsLanceStore.buildFilterExprFull(folderIds, resourceIds, resourceTypes, mountedResourceIds);
    const request: LanceSearchRequest = {
      text: queryText,
      limit: Math.min(Math.max(topK * 3, 20), 500),
      filter,
      bypassVectorIndex: false,
      refineFactor: null,
      select: SEARCH_RESULT_COLUMNS,
    };
    let results = await table.ftsSearch(request).catch((error: unknown) => {
      throw other(`FTS 查询执行失败: ${errorText(error)}`);
    });
    results = this.retainActiveUnitGenerations(profile.modality, results);
    results.sort((left, right) => right.score - left.score);
    return results.slice(0, topK);
  }

  static buildFilterExpr(
    folderIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
  ): string | null {
    return VfsLanceStore.buildFilterExprFull(folderIds, undefined, resourceTypes);
  }

  static buildFilterExprFull(filter: LanceSearchFilter): string | null;
  static buildFilterExprFull(
    folderIds?: readonly string[] | null,
    resourceIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
    mountedResourceIds?: readonly string[] | null,
  ): string | null;
  static buildFilterExprFull(
    folderIdsOrFilter?: readonly string[] | null | LanceSearchFilter,
    resourceIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null,
    mountedResourceIds?: readonly string[] | null,
  ): string | null {
    let resolvedFolders: readonly string[] | null | undefined;
    let resolvedResources: readonly string[] | null | undefined;
    let resolvedTypes: readonly string[] | null | undefined;
    let resolvedMounted: readonly string[] | null | undefined;

    if (
      folderIdsOrFilter !== null
      && folderIdsOrFilter !== undefined
      && !Array.isArray(folderIdsOrFilter)
      && typeof folderIdsOrFilter === 'object'
    ) {
      const filterObj = folderIdsOrFilter as LanceSearchFilter;
      resolvedFolders = filterObj.folderIds;
      resolvedResources = filterObj.resourceIds;
      resolvedTypes = filterObj.resourceTypes;
      resolvedMounted = filterObj.mountedResourceIds;
    } else {
      resolvedFolders = folderIdsOrFilter as readonly string[] | null | undefined;
      resolvedResources = resourceIds;
      resolvedTypes = resourceTypes;
      resolvedMounted = mountedResourceIds;
    }

    const parts: string[] = [];
    const quoteIds = (ids: readonly string[] | null | undefined): string[] => {
      if (ids === null || ids === undefined) return [];
      return ids
        .filter((value) => rustTrim(value) !== '')
        .map((value) => `'${value.replace(/'/g, "''")}'`);
    };
    const append = (column: string, ids: readonly string[] | null | undefined): void => {
      const values = quoteIds(ids);
      if (values.length === 0) return;
      parts.push(values.length === 1 ? `${column} = ${values[0]}` : `${column} IN (${values.join(', ')})`);
    };

    const folderValues = quoteIds(resolvedFolders);
    const mountedValues = quoteIds(resolvedMounted);
    if ((resolvedResources != null && quoteIds(resolvedResources).length === 0)
      || (resolvedTypes != null && quoteIds(resolvedTypes).length === 0)) return '1 = 0';
    if (resolvedFolders != null && folderValues.length === 0) {
      if (mountedValues.length === 0) return '1 = 0';
      append('resource_id', resolvedMounted);
    }
    if (folderValues.length > 0 && mountedValues.length > 0) {
      parts.push(
        `(folder_id IN (${folderValues.join(', ')}) OR resource_id IN (${mountedValues.join(', ')}))`,
      );
    } else {
      append('folder_id', resolvedFolders);
    }
    append('resource_id', resolvedResources);
    append('resource_type', resolvedTypes);
    return parts.length === 0 ? null : parts.join(' AND ');
  }

  static parseMetadataFields = parseLanceMetadataFields;

  // ------------------------------------------------------------------ optimize/stats

  async optimizeTable(modality: string, dim: number): Promise<void> {
    await this.optimizeTableByName(this.tables.activeTableName(modality, dim));
  }

  private async optimizeTableByName(tableName: string): Promise<void> {
    await optimizeLanceTable(this.tables, tableName);
  }

  async optimizeAll(modality: string): Promise<number> {
    let optimized = 0;
    for (const tableName of optimizeTableNames(this.db, modality)) {
      await this.optimizeTableByName(tableName);
      optimized += 1;
    }
    return optimized;
  }

  async maybeOptimizeAll(): Promise<number> {
    const now = performance.now();
    if (this.lastOptimizeAt !== null && now - this.lastOptimizeAt < OPTIMIZE_MIN_INTERVAL_SECS * 1000) {
      return 0;
    }
    this.lastOptimizeAt = now;
    let optimized = 0;
    for (const modality of ['text', 'multimodal']) {
      optimized += await this.optimizeAll(modality);
    }
    return optimized;
  }

  async getTableStats(modality: string): Promise<Array<[string, number]>> {
    return lanceTableStats(this.db, this.tables, modality);
  }

  async diagnoseTableSchema(modality: string): Promise<LanceTableDiagnostic[]> {
    return diagnoseLanceTables(this.tables, modality);
  }

  async clearAll(modality: string): Promise<number> {
    return VFS_MUTATION_LOCK.write(async () => {
      const connection = await this.tables.connect();
      const prefix = `vfs_emb_${modality}_`;
      const tableNames = (await connection.tableNames().catch((error: unknown) => {
        throw other(`枚举 Lance 表失败: ${errorText(error)}`);
      }))
        .filter((name) => {
          if (!name.startsWith(prefix)) return false;
          const dim = (name.slice(prefix.length).split('_')[0] ?? '');
          return /^\d+$/.test(dim);
        })
        .sort();
      for (const tableName of tableNames) {
        const table = await connection.openTable(tableName);
        if (table === null) {
          throw other(`打开待清空 Lance 表 ${tableName} 失败: table not found`);
        }
        await table.delete('true').catch((error: unknown) => {
          throw other(`清空 Lance 表 ${tableName} 失败: ${errorText(error)}`);
        });
        const remaining = await table.countRows().catch((error: unknown) => {
          throw other(`校验 Lance 表 ${tableName} 清空结果失败: ${errorText(error)}`);
        });
        if (remaining !== 0) {
          throw other(`Lance 表 ${tableName} 清空后仍残留 ${remaining} 行`);
        }
      }
      return tableNames.length;
    });
  }

  getDatabase(): SqlExecutor {
    return this.db;
  }

  getLancePath(): string {
    return this.tables.lancePath;
  }

  getRegisteredDimensions(): Array<[string, number]> {
    return listAll(this.db).map((dim) => [dim.modality, dim.dimension]);
  }

  getEmbeddingDim(dim: number, modality: string): VfsEmbeddingDim | undefined {
    return getByKey(this.db, dim, modality);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
