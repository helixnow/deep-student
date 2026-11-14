/** External L11 metadata seam fixture until the owner publishes translation_executor.rs:1293–1311.
 * Creation/get in integration tests use the real L11 plugin. This fixture is not production wiring.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { JsonValue } from '../../vfs-repos/api.ts';

export function updateTranslationMetadata(conn: SqlExecutor, id: string, metadata: JsonValue): void {
  const result = conn.run('UPDATE translations SET metadata_json = ?1 WHERE id = ?2', [JSON.stringify(metadata), id]);
  if (result.changes === 0) throw new Error(`translation row ${id} not found for metadata update`);
}
