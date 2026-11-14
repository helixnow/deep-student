/**
 * `VfsLanceStore` no-op stub from `crates/dstu-vfs/src/vfs/lance_store_stub.rs`.
 *
 * Used when the F7 Lance build is unavailable (mobile-slim equivalent):
 * read paths return empty results so SQLite lexical retrieval stays usable,
 * delete/cleanup paths succeed as no-ops, and write/profile paths fail with
 * `VFS_INVALID_OPERATION` so the indexing pipeline records a real failure
 * instead of silently dropping embeddings.
 */
import { invalidState } from './lance-types.ts';
import type {
  VfsIndexProfile, VfsLanceRow, VfsLanceSearchResult, VfsLanceStore,
} from '../api.ts';
import type { LanceTable, LanceTableDiagnostic } from './lance-types.ts';

export const LANCE_DISABLED_MSG = '向量索引功能未启用（当前构建未包含 lance feature）';

function lanceDisabled(): never {
  throw invalidState(LANCE_DISABLED_MSG);
}

export interface LifecycleLanceStore {
  readonly store: VfsLanceStore;
  set(next: VfsLanceStore): void;
  enabled(): boolean;
}

/**
 * Stable `vfsIndex.lance` identity while F7's `vector` provider appears,
 * disappears or is replaced. Before the provider exists it behaves exactly like
 * {@link VfsLanceDisabled}; afterwards every call is forwarded to the real
 * store, so apply-time `undefined` is never cached.
 */
export function createLifecycleLanceStore(): LifecycleLanceStore {
  let current: VfsLanceStore = new VfsLanceDisabled();
  const store = new Proxy(Object.create(null) as VfsLanceStore, {
    get(_target, property) {
      const value = Reflect.get(current as object, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => Reflect.apply(value, current, args);
    },
  });
  return {
    store,
    set(next: VfsLanceStore): void {
      current = next;
    },
    enabled(): boolean {
      return !(current instanceof VfsLanceDisabled);
    },
  };
}

export class VfsLanceDisabled implements VfsLanceStore {
  ensureModelProfile(
    _modality: string,
    _dim: number,
    _modelConfigId: string,
    _modelName?: string | null,
  ): VfsIndexProfile {
    return lanceDisabled();
  }

  nextUnitGeneration(_unitId: string, _modality: string): number {
    return lanceDisabled();
  }

  ensureModelProfileWithFingerprint(
    _modality: string,
    _dim: number,
    _modelConfigId: string,
    _modelName: string | null | undefined,
    _expectedFingerprint: string,
  ): VfsIndexProfile {
    return lanceDisabled();
  }

  async writeChunks(_modality: string, _rows: readonly VfsLanceRow[]): Promise<void> {
    lanceDisabled();
  }

  async ensureTable(_modality: string, _dim: number): Promise<LanceTable> {
    return lanceDisabled();
  }

  async deleteByResource(_modality: string, _resourceId: string): Promise<number> {
    return 0;
  }

  async deleteByResourceExceptDim(
    _modality: string,
    _resourceId: string,
    _keepDim: number,
  ): Promise<number> {
    return 0;
  }

  async deleteByResourceExceptIds(
    _modality: string,
    _resourceId: string,
    _keepIds: readonly string[],
  ): Promise<number> {
    return 0;
  }

  async vectorSearch(
    _modality: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds?: readonly string[] | null,
    _resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async hybridSearch(
    _modality: string,
    _queryText: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds?: readonly string[] | null,
    _resourceTypes?: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async vectorSearchFull(
    _modality: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds: readonly string[] | null,
    _resourceIds: readonly string[] | null,
    _resourceTypes: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async hybridSearchFull(
    _modality: string,
    _queryText: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds: readonly string[] | null,
    _resourceIds: readonly string[] | null,
    _resourceTypes: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async deleteByEmbeddingIds(
    _modality: string,
    _dimOrIds: number | readonly string[],
    _ids?: readonly string[],
  ): Promise<number> {
    return 0;
  }

  async deleteByUnitExceptIds(
    _modality: string,
    _resourceId: string,
    _unitId: string,
    _keepIds: readonly string[],
  ): Promise<number> {
    return 0;
  }

  async discardUncommittedRows(
    _modality: string,
    _resourceId: string,
    _embeddingIds: readonly string[],
  ): Promise<void> {
    // No vectors were written, so there is nothing to discard.
  }

  async ensureProfileReady(_profileId: string): Promise<void> {
    // `lance_store_stub.rs`: profile readiness is a no-op without vectors.
  }

  async vectorSearchProfileFull(
    _profileId: string,
    _queryEmbedding: readonly number[],
    _topK: number,
    _folderIds: readonly string[] | null,
    _resourceIds: readonly string[] | null,
    _resourceTypes: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async ftsSearchProfileFull(
    _profileId: string,
    _queryText: string,
    _topK: number,
    _folderIds: readonly string[] | null,
    _resourceIds: readonly string[] | null,
    _resourceTypes: readonly string[] | null,
  ): Promise<VfsLanceSearchResult[]> {
    return [];
  }

  async optimizeTable(_modality: string, _dim: number): Promise<void> {}

  async optimizeAll(_modality: string): Promise<number> {
    return 0;
  }

  async maybeOptimizeAll(): Promise<number> {
    return 0;
  }

  async getTableStats(_modality: string): Promise<Array<[string, number]>> {
    return [];
  }

  async diagnoseTableSchema(_modality: string): Promise<LanceTableDiagnostic[]> {
    return [];
  }

  async dropTable(_tableName: string): Promise<void> {}

  async sweepRetiredProfileTables(): Promise<number> {
    return 0;
  }

  async clearAll(_modality: string): Promise<number> {
    return 0;
  }
}
