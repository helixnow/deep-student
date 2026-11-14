/** handlers.rs:5473-5853. resourceId is accepted but, like Rust, does not filter diagnostics. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import { chronoStamp, civilTime, nowEpochNanos } from '../../../platform/time/index.ts';
import type { IndexDiagnosticInfo, IndexStateCounts, ResourceDiagnostic, UnitsStats, SegmentsStats,
  DimensionStats, ConsistencyCheck } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
const states = ['pending', 'indexing', 'indexed', 'failed', 'disabled'] as const;
const sum = (condition: string, alias: string) => `COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END),0) AS ${alias}`;

export function indexDiagnostics(db: SqlExecutor, log: Context['logger']): IndexDiagnosticInfo {
  const stateCounts = db.one<IndexStateCounts>(`SELECT ${states.map(s => sum(`index_state='${s}'`, s)).join(',')},
    ${sum('index_state IS NULL', 'nullState')} FROM resources`);
  const totalResources = db.pluck<number>('SELECT COUNT(*) FROM resources')!;
  const allResources = db.all<ResourceDiagnostic>(`SELECT r.id,r.source_id AS name,r.type AS resourceType,
    r.storage_mode AS storageMode,r.index_state AS indexState,r.index_error AS indexError,LENGTH(COALESCE(r.data,'')) AS dataLen,
    CASE WHEN r.ocr_text IS NOT NULL AND r.ocr_text!='' THEN 1 ELSE 0 END AS hasOcrText,
    (SELECT COUNT(*) FROM vfs_index_units WHERE resource_id=r.id) AS unitCount,
    (SELECT COUNT(*) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id=u.id WHERE u.resource_id=r.id) AS segmentCount,
    (SELECT text_state FROM vfs_index_units WHERE resource_id=r.id LIMIT 1) AS unitTextState,
    (SELECT mm_state FROM vfs_index_units WHERE resource_id=r.id LIMIT 1) AS unitMmState,
    (SELECT text_embedding_dim FROM vfs_index_units WHERE resource_id=r.id LIMIT 1) AS textEmbeddingDim,
    (SELECT text_chunk_count FROM vfs_index_units WHERE resource_id=r.id LIMIT 1) AS textChunkCount,
    r.updated_at AS updatedAt FROM resources r ORDER BY r.updated_at DESC`)
    .filter(r => {
      if (typeof r.updatedAt === 'number') return true;
      log.warn('[VfsHandlers] Skipping malformed row: Invalid column type for updated_at (%s)', r.id);
      return false;
    }).map(r => ({ ...r, hasOcrText: Number(r.hasOcrText) === 1 }));
  const unitStates = ['text', 'mm'].flatMap(modality => states.map(s => sum(`${modality}_state='${s}'`, `${modality}${s[0]!.toUpperCase() + s.slice(1)}`)));
  const unitsStats = db.one<UnitsStats>(`SELECT COUNT(*) AS totalCount,COUNT(DISTINCT resource_id) AS distinctResources,
    ${unitStates.join(',')} FROM vfs_index_units`);
  const segmentsStats = db.one<SegmentsStats>(`SELECT COUNT(*) AS totalCount,COUNT(DISTINCT unit_id) AS distinctUnits,
    ${sum("modality='text'", 'textModalityCount')},${sum("modality='multimodal'", 'mmModalityCount')},
    CASE WHEN COUNT(DISTINCT unit_id)>0 THEN CAST(COUNT(*) AS REAL)/COUNT(DISTINCT unit_id) ELSE 0.0 END AS avgSegmentsPerUnit FROM vfs_index_segments`);
  const dimensionsStats = db.all<DimensionStats>(`SELECT dimension,modality,record_count AS recordCount,
    (SELECT COUNT(*) FROM vfs_index_segments WHERE embedding_dim=d.dimension AND modality=d.modality) AS actualCount FROM vfs_embedding_dims d`);
  const consistencyChecks: ConsistencyCheck[] = [];
  const check = (name: string, sql: string, details: (count: number) => string) => {
    let count: number;
    try { count = db.pluck<number>(sql) ?? 0; } catch { count = 0; } // Rust unwrap_or(0).
    consistencyChecks.push({ checkName: name, passed: count === 0, details: details(count) });
  };
  check('resources_indexed_without_units', `SELECT COUNT(*) FROM resources r WHERE r.index_state='indexed'
    AND NOT EXISTS(SELECT 1 FROM vfs_index_units WHERE resource_id=r.id)`, n => `${n} 个资源状态为 indexed 但无 units 记录`);
  check('units_exist_but_not_indexed', `SELECT COUNT(DISTINCT u.resource_id) FROM vfs_index_units u LEFT JOIN resources r ON u.resource_id=r.id
    WHERE r.index_state IS NULL OR r.index_state!='indexed'`, n => `${n} 个资源有 units 但 resources.index_state 不是 indexed`);
  check('units_indexed_without_segments', `SELECT COUNT(*) FROM vfs_index_units u WHERE u.text_state='indexed'
    AND NOT EXISTS(SELECT 1 FROM vfs_index_segments WHERE unit_id=u.id AND modality='text')`, n => `${n} 个 unit 状态为 text_indexed 但无 text segments`);
  check('segments_exist_but_unit_not_indexed', `SELECT COUNT(DISTINCT s.unit_id) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id=u.id
    WHERE s.modality='text' AND u.text_state!='indexed'`, n => `${n} 个 unit 有 segments 但 text_state 不是 indexed`);
  check('units_mm_indexed_without_segments', `SELECT COUNT(*) FROM vfs_index_units u WHERE u.mm_state='indexed'
    AND NOT EXISTS(SELECT 1 FROM vfs_index_segments WHERE unit_id=u.id AND modality='multimodal')`, n => `${n} 个 unit 状态为 mm_indexed 但无 multimodal segments`);
  check('mm_segments_exist_but_unit_not_indexed', `SELECT COUNT(DISTINCT s.unit_id) FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id=u.id
    WHERE s.modality='multimodal' AND u.mm_state!='indexed'`, n => `${n} 个 unit 有 multimodal segments 但 mm_state 不是 indexed`);
  const mismatches = dimensionsStats.filter(d => d.recordCount !== d.actualCount)
    .map(d => `dim=${d.dimension}:${d.modality} (recorded=${d.recordCount}, actual=${d.actualCount})`);
  consistencyChecks.push({ checkName: 'dimension_record_count_match', passed: mismatches.length === 0,
    details: mismatches.length ? `${mismatches.length} 个维度不一致: ${mismatches.join(', ')}` : '所有维度 record_count 与实际数量一致' },
  { checkName: 'unified_index_architecture', passed: unitsStats.totalCount >= 0 && segmentsStats.totalCount >= 0,
    details: `统一索引架构: ${totalResources} resources → ${unitsStats.totalCount} units → ${segmentsStats.totalCount} segments` },
  { checkName: 'pending_resources_info', passed: true, details: `${stateCounts.pending} 个资源待索引` },
  { checkName: 'disabled_resources_info', passed: true, details: `${stateCounts.disabled} 个资源被标记为 disabled（不适用）` });
  return { timestamp: chronoStamp(civilTime(nowEpochNanos(), false), ':', true).replace('T', ' ') + ' UTC', architectureVersion: 'unified_index_v1',
    totalResources, stateCounts, allResources, sampleResources: allResources.slice(0, 15), unitsStats, segmentsStats, dimensionsStats, consistencyChecks };
}
