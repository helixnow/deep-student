/**
 * `lance_store.rs` maintenance: per-table optimize, row-count stats and the
 * schema/metadata diagnostic.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { listByModality } from '../repository/embedding-dim.ts';
import type { LanceTables } from './lance-tables.ts';
import { other, type LanceTableDiagnostic } from './lance-types.ts';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function optimizeLanceTable(tables: LanceTables, tableName: string): Promise<void> {
  tables.forgetEnsuredTable(tableName);
  const connection = await tables.connect();
  const table = await connection.openTable(tableName);
  if (table === null) return;
  // F7's Node binding exposes all-actions optimize only. Rust runs
  // Compact + Prune(7 days, delete_unverified=false) + Index; the adapter's
  // optimizeAll carries the same prune options, but we never use it for an
  // individual compact/prune/index request.
  if (table.optimizeAll !== undefined) {
    await table.optimizeAll({ olderThanDays: 7, deleteUnverified: false })
      .catch((error: unknown) => {
        throw other(`全量优化失败: ${errorText(error)}`);
      });
    return;
  }
  await table.optimize('compact').catch((error: unknown) => {
    throw other(`Compact 优化失败: ${errorText(error)}`);
  });
  await table.optimize('prune').catch((error: unknown) => {
    throw other(`Prune 优化失败: ${errorText(error)}`);
  });
  await table.optimize('index').catch((error: unknown) => {
    throw other(`Index 优化失败: ${errorText(error)}`);
  });
}

export async function lanceTableStats(
  db: SqlExecutor,
  tables: LanceTables,
  modality: string,
): Promise<Array<[string, number]>> {
  const connection = await tables.connect();
  const stats: Array<[string, number]> = [];
  for (const dim of listByModality(db, modality)) {
    // Rust `if let Ok(tbl)`: an unreadable table is skipped, not fatal.
    let table: Awaited<ReturnType<typeof connection.openTable>>;
    try {
      table = await connection.openTable(dim.lance_table_name);
    } catch {
      continue;
    }
    if (table === null) continue;
    const count = await table.countRows().catch(() => 0);
    if (count > 0) stats.push([dim.lance_table_name, count]);
  }
  return stats;
}

export async function diagnoseLanceTables(
  tables: LanceTables,
  modality: string,
): Promise<LanceTableDiagnostic[]> {
  const connection = await tables.connect();
  const diagnostics: LanceTableDiagnostic[] = [];
  const prefix = `vfs_emb_${modality}_`;
  for (const tableName of await tables.cleanupTableNames(modality)) {
    const suffix = tableName.startsWith(prefix) ? tableName.slice(prefix.length) : '';
    const dimPart = suffix.split('_')[0] ?? '';
    const dimension = /^\d+$/.test(dimPart) ? Number(dimPart) : 0;
    // Rust skips tables that cannot be opened; schema errors still propagate.
    let table: Awaited<ReturnType<typeof connection.openTable>>;
    try {
      table = await connection.openTable(tableName);
    } catch {
      continue;
    }
    if (table === null) continue;
    const schema = await table.schema().catch((error: unknown) => {
      throw other(`获取 schema 失败: ${errorText(error)}`);
    });
    const columns = schema.fields.map((field) => field.name);
    const hasMetadata = columns.includes('metadata');
    const rowCount = await table.countRows().catch(() => 0);
    let sampleMetadata: Array<string | null> = [];
    let metadataWithPageIndex = 0;
    let metadataNullCount = 0;
    if (hasMetadata && rowCount > 0 && table.scanMetadata !== undefined) {
      // A failed stream is tolerated: the Rust code simply stops sampling.
      const values = await table.scanMetadata().catch(() => [] as Array<string | null>);
      for (const value of values) {
        if (value === null) {
          metadataNullCount += 1;
          continue;
        }
        if (value.includes('page_index') && !value.includes('"page_index":null')) {
          metadataWithPageIndex += 1;
        }
        if (sampleMetadata.length < 10) sampleMetadata.push(value);
      }
      // Pad with `None` samples for rows whose metadata column is null.
      const nullSamples = Math.min(10, metadataNullCount);
      while (sampleMetadata.length < nullSamples) sampleMetadata.push(null);
      sampleMetadata = sampleMetadata.slice(0, 10);
    }
    diagnostics.push({
      tableName,
      dimension,
      rowCount,
      columns,
      hasMetadataColumn: hasMetadata,
      hasEmbeddingIdColumn: columns.includes('embedding_id'),
      hasResourceIdColumn: columns.includes('resource_id'),
      hasTextColumn: columns.includes('text'),
      sampleMetadata,
      metadataWithPageIndex,
      metadataNullCount,
      schemaValid: hasMetadata && columns.includes('embedding_id')
        && columns.includes('resource_id') && columns.includes('text'),
      issueDescription: !hasMetadata
        ? '缺少 metadata 列，pageIndex 将始终为 null。需要重建表或迁移 schema。'
        : metadataWithPageIndex === 0 && rowCount > 0
          ? 'metadata 列存在但所有记录的 page_index 都为 null，可能是索引时未正确设置。'
          : null,
    });
  }
  return diagnostics;
}
