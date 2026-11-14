/** handlers.rs:4225-4810: the resource-list and aggregate filters intentionally differ. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import { parseRfc3339, parseNaiveDateTime } from '../../../platform/time/index.ts';
import type { Commands, ResourceIndexStatus, dstu_vfs__vfs__handlers__IndexStatusSummary as Summary } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

export type IndexStatusArgs = Commands['vfs_get_all_index_status']['args'];
const states = ['indexed', 'pending', 'indexing', 'failed', 'disabled'] as const;
function empty(): Summary {
  return { totalResources: 0, indexedCount: 0, pendingCount: 0, indexingCount: 0, failedCount: 0,
    disabledCount: 0, staleCount: 0, mmTotalResources: 0, mmIndexedCount: 0, mmPendingCount: 0,
    mmIndexingCount: 0, mmFailedCount: 0, mmDisabledCount: 0, resources: [] };
}
const stale = "COALESCE(r.index_state,'pending')='indexed' AND r.index_hash IS NOT NULL AND r.index_hash!=r.hash";
const multimedia = "r.type IN ('textbook','file','exam','image')";

function timestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  return (parseRfc3339(value) ?? parseNaiveDateTime(value))?.millis ?? 0;
}

export function allIndexStatus(db: SqlExecutor, args: IndexStatusArgs, log: Context['logger']): Summary {
  const result = empty();
  if (!db.all<{ name: string }>('PRAGMA table_info(resources)').some(c => c.name === 'index_state')) {
    log.warn('[VFS::handlers] vfs_get_all_index_status: index_state column not found, migration may not have run');
    return result;
  }
  const hasUnits = db.pluck<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_units'") !== 0;
  const statsWhere = ['r.deleted_at IS NULL'];
  const listWhere = [...statsWhere];
  const statsParams: (string | number)[] = [];
  const listParams: (string | number)[] = [];
  if (args.resourceType != null) {
    statsWhere.push('r.type=?'); listWhere.push('r.type=?');
    statsParams.push(args.resourceType); listParams.push(args.resourceType);
  }
  if (args.stateFilter != null) { listWhere.push("COALESCE(r.index_state,'pending')=?"); listParams.push(args.stateFilter); }
  const folderJoin = args.folderId == null ? '' : 'JOIN folder_items fi ON r.id=fi.item_id AND fi.deleted_at IS NULL';
  if (args.folderId != null) {
    statsWhere.push('fi.folder_id=?'); listWhere.push('fi.folder_id=?');
    statsParams.push(args.folderId); listParams.push(args.folderId);
  }
  const count = hasUnits ? 'COALESCE(sa.segment_count,0)' : '0';
  const dim = hasUnits ? 'sa.first_embedding_dim' : 'NULL';
  const mode = hasUnits ? `CASE WHEN COALESCE(sa.has_text_seg,0)=1 AND COALESCE(sa.has_mm_seg,0)=1 THEN 'both'
    WHEN COALESCE(sa.has_text_seg,0)=1 THEN 'text' WHEN COALESCE(sa.has_mm_seg,0)=1 THEN 'multimodal' ELSE NULL END` : 'NULL';
  const unitCtes = hasUnits ? `unit_agg AS (
    SELECT resource_id, COALESCE(SUM(CASE WHEN text_source='native' THEN text_chunk_count ELSE 0 END),0) AS native_chunks,
    COALESCE(SUM(CASE WHEN text_source='ocr' THEN text_chunk_count ELSE 0 END),0) AS ocr_chunks FROM vfs_index_units GROUP BY resource_id),
    seg_agg AS (SELECT u.resource_id,COUNT(*) AS segment_count, MIN(s.embedding_dim) AS first_embedding_dim,
    MAX(CASE WHEN s.modality='text' THEN 1 ELSE 0 END) AS has_text_seg,
    MAX(CASE WHEN s.modality='multimodal' THEN 1 ELSE 0 END) AS has_mm_seg
    FROM vfs_index_segments s JOIN vfs_index_units u ON s.unit_id=u.id GROUP BY u.resource_id),` : '';
  const query = `WITH file_by_res AS (
    SELECT resource_id,file_name,name,ocr_pages_json,extracted_text,mm_index_state,mm_indexed_pages_json,mm_index_error
    FROM files WHERE resource_id IS NOT NULL AND status='active' GROUP BY resource_id),
    exam_by_res AS (SELECT resource_id,exam_name,preview_json,mm_index_state,mm_indexed_pages_json,mm_index_error
    FROM exam_sheets WHERE resource_id IS NOT NULL GROUP BY resource_id), ${unitCtes}
    note_names AS (SELECT resource_id,title FROM notes GROUP BY resource_id),
    tr_names AS (SELECT resource_id,title FROM translations GROUP BY resource_id),
    essay_names AS (SELECT resource_id,title FROM essays GROUP BY resource_id),
    mm_names AS (SELECT resource_id,title FROM mindmaps GROUP BY resource_id)
    SELECT r.id AS resourceId,r.source_id AS sourceId,r.type AS resourceType,
    COALESCE(nn.title,COALESCE(fr.file_name,fs.file_name),COALESCE(ei.exam_name,es_src.exam_name),tn.title,en.title,mn.title,COALESCE(fs.name,fr.name),r.id) AS name,
    CASE WHEN r.type='textbook' THEN (COALESCE(fr.ocr_pages_json,fs.ocr_pages_json) IS NOT NULL)
      WHEN r.type='image' THEN (r.ocr_text IS NOT NULL AND r.ocr_text!='')
      WHEN r.type='file' THEN ((COALESCE(fr.extracted_text,fs.extracted_text) IS NOT NULL AND COALESCE(fr.extracted_text,fs.extracted_text)!='')
        OR (COALESCE(fr.ocr_pages_json,fs.ocr_pages_json) IS NOT NULL AND COALESCE(fr.ocr_pages_json,fs.ocr_pages_json)!='')
        OR (r.ocr_text IS NOT NULL AND r.ocr_text!=''))
      WHEN r.type='exam' THEN (ei.preview_json IS NOT NULL) ELSE 0 END AS hasOcr,
    CASE WHEN r.type='textbook' THEN COALESCE(CASE WHEN json_type(COALESCE(fr.ocr_pages_json,fs.ocr_pages_json))='array'
        THEN json_array_length(COALESCE(fr.ocr_pages_json,fs.ocr_pages_json))
        WHEN json_type(COALESCE(fr.ocr_pages_json,fs.ocr_pages_json),'$.pages')='array'
        THEN json_array_length(json_extract(COALESCE(fr.ocr_pages_json,fs.ocr_pages_json),'$.pages')) ELSE 0 END,0)
      WHEN r.type='image' THEN COALESCE(LENGTH(r.ocr_text),0)
      WHEN r.type='file' THEN COALESCE(COALESCE(LENGTH(COALESCE(fr.extracted_text,fs.extracted_text)),0)+COALESCE(LENGTH(r.ocr_text),0),0)
      WHEN r.type='exam' THEN COALESCE(LENGTH(ei.preview_json),0) ELSE 0 END AS ocrCount,
    COALESCE(r.index_state,'pending') AS textIndexState,r.indexed_at AS textIndexedAt,r.index_error AS textIndexError,
    ${count} AS textChunkCount,${hasUnits ? 'COALESCE(ua.native_chunks,0)' : '0'} AS nativeTextChunkCount,
    ${hasUnits ? 'COALESCE(ua.ocr_chunks,0)' : '0'} AS ocrTextChunkCount,${dim} AS textEmbeddingDim,
    CASE WHEN COALESCE(r.index_state,'pending')='indexed' AND ${count}>0 THEN 'lance'
      WHEN COALESCE(r.index_state,'pending')='indexed' THEN 'sqlite' ELSE NULL END AS textIndexSource,
    CASE WHEN r.type IN ('textbook','file','image') THEN COALESCE(fr.mm_index_state,fs.mm_index_state,'pending')
      WHEN r.type='exam' THEN COALESCE(ei.mm_index_state,'pending') ELSE 'disabled' END AS mmIndexState,
    CASE WHEN r.type IN ('textbook','file','image') THEN COALESCE(json_array_length(COALESCE(fr.mm_indexed_pages_json,fs.mm_indexed_pages_json)),0)
      WHEN r.type='exam' THEN COALESCE(json_array_length(ei.mm_indexed_pages_json),0)
      ELSE CASE WHEN r.mm_embedding_dim IS NOT NULL THEN 1 ELSE 0 END END AS mmIndexedPages,
    CASE WHEN r.type IN ('textbook','file','image') THEN json_extract(COALESCE(fr.mm_indexed_pages_json,fs.mm_indexed_pages_json),'$[0].embedding_dim')
      WHEN r.type='exam' THEN json_extract(ei.mm_indexed_pages_json,'$[0].embedding_dim') ELSE r.mm_embedding_dim END AS mmEmbeddingDim,
    CASE WHEN r.type IN ('textbook','file','image') THEN json_extract(COALESCE(fr.mm_indexed_pages_json,fs.mm_indexed_pages_json),'$[0].indexing_mode')
      WHEN r.type='exam' THEN json_extract(ei.mm_indexed_pages_json,'$[0].indexing_mode') ELSE r.mm_indexing_mode END AS mmIndexingMode,
    CASE WHEN r.type IN ('textbook','file','image') THEN COALESCE(fr.mm_index_error,fs.mm_index_error)
      WHEN r.type='exam' THEN ei.mm_index_error ELSE r.mm_index_error END AS mmIndexError,
    ${mode} AS modality,${dim} AS embeddingDim,r.updated_at AS updatedAt,CASE WHEN ${stale} THEN 1 ELSE 0 END AS isStale
    FROM resources r LEFT JOIN note_names nn ON nn.resource_id=r.id
    LEFT JOIN file_by_res fr ON fr.resource_id=r.id LEFT JOIN files fs ON fs.id=r.source_id AND fs.status='active'
    LEFT JOIN exam_by_res ei ON ei.resource_id=r.id LEFT JOIN exam_sheets es_src ON es_src.id=r.source_id
    LEFT JOIN tr_names tn ON tn.resource_id=r.id LEFT JOIN essay_names en ON en.resource_id=r.id
    LEFT JOIN mm_names mn ON mn.resource_id=r.id
    ${hasUnits ? 'LEFT JOIN unit_agg ua ON ua.resource_id=r.id LEFT JOIN seg_agg sa ON sa.resource_id=r.id' : ''}
    ${folderJoin} WHERE ${listWhere.join(' AND ')} AND (nn.resource_id IS NOT NULL OR fr.resource_id IS NOT NULL OR fs.id IS NOT NULL
      OR ei.resource_id IS NOT NULL OR es_src.id IS NOT NULL OR tn.resource_id IS NOT NULL OR en.resource_id IS NOT NULL OR mn.resource_id IS NOT NULL)
    ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`;
  try {
    result.resources = db.all<ResourceIndexStatus>(query, [...listParams, args.limit ?? 100, args.offset ?? 0])
      .map(r => ({ ...r, hasOcr: Number(r.hasOcr) === 1, isStale: Number(r.isStale) === 1, updatedAt: timestamp(r.updatedAt) }));
  } catch (error) {
    log.error('[VFS::handlers] vfs_get_all_index_status: query error: %s', error instanceof Error ? error.message : String(error));
    throw error;
  }
  log.info('[VFS::handlers] vfs_get_all_index_status: 资源列表查询完成, 返回 %d 条记录', result.resources.length);
  const mmState = `COALESCE(CASE WHEN r.type IN ('textbook','file','image') THEN COALESCE(fm.mm_index_state,fs_mm.mm_index_state) END,
    CASE WHEN r.type='exam' THEN COALESCE(em.mm_index_state,es_mm.mm_index_state) END,COALESCE(r.mm_index_state,'pending'))`;
  const aggregates = states.map(state => `COALESCE(SUM(CASE WHEN COALESCE(r.index_state,'pending')='${state}' THEN 1 ELSE 0 END),0) AS ${state}Count`);
  const mmAggregates = states.map(state => `COALESCE(SUM(CASE WHEN ${multimedia} AND ${mmState}='${state}' THEN 1 ELSE 0 END),0) AS mm${state[0]!.toUpperCase() + state.slice(1)}Count`);
  const stats = db.one<Omit<Summary, 'resources'>>(`WITH file_mm AS (SELECT resource_id,mm_index_state FROM files
    WHERE resource_id IS NOT NULL AND status='active' GROUP BY resource_id),
    exam_mm AS (SELECT resource_id,mm_index_state FROM exam_sheets WHERE resource_id IS NOT NULL GROUP BY resource_id)
    SELECT COUNT(*) AS totalResources,${aggregates.join(',')},COALESCE(SUM(CASE WHEN ${stale} THEN 1 ELSE 0 END),0) AS staleCount,
    COALESCE(SUM(CASE WHEN ${multimedia} THEN 1 ELSE 0 END),0) AS mmTotalResources,${mmAggregates.join(',')}
    FROM resources r LEFT JOIN file_mm fm ON fm.resource_id=r.id LEFT JOIN files fs_mm ON fs_mm.id=r.source_id
    LEFT JOIN exam_mm em ON em.resource_id=r.id LEFT JOIN exam_sheets es_mm ON es_mm.id=r.source_id ${folderJoin}
    WHERE ${statsWhere.join(' AND ')} AND (fm.resource_id IS NOT NULL OR fs_mm.id IS NOT NULL OR em.resource_id IS NOT NULL OR es_mm.id IS NOT NULL
      OR EXISTS(SELECT 1 FROM notes WHERE resource_id=r.id) OR EXISTS(SELECT 1 FROM translations WHERE resource_id=r.id)
      OR EXISTS(SELECT 1 FROM essays WHERE resource_id=r.id) OR EXISTS(SELECT 1 FROM mindmaps WHERE resource_id=r.id))`, statsParams);
  log.info('[VFS::handlers] vfs_get_all_index_status: 返回结果 total=%d, indexed=%d, pending=%d, resources_len=%d, state_filter=%s',
    stats.totalResources, stats.indexedCount, stats.pendingCount, result.resources.length, args.stateFilter ?? null);
  return { ...stats, resources: result.resources };
}
