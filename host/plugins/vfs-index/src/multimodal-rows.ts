/**
 * `multimodal_service.rs` Lance rows for page embeddings, and the provenance
 * search reads back out of the `metadata_json` those rows carry.
 */
import { nanoid } from 'nanoid';
import type { VfsIndexUnit } from '../../vfs-repos/api.ts';
import type { VfsLanceRow } from '../api.ts';
import { MODALITY_MULTIMODAL } from '../repository/index-units.ts';
import type { VfsMultimodalPage } from './multimodal.ts';

export interface MultimodalRowTarget {
  resourceId: string;
  resourceType: string;
  folderId: string | null;
  profileId: string;
  /** Called once per page, in page order, after its embedding and Unit are found. */
  nextGeneration(unitId: string): number | bigint;
}

/** Step 6 of `index_resource_pages_with_options`: one row per page with a fresh per-Unit generation. */
export function buildMultimodalLanceRows(
  pages: readonly VfsMultimodalPage[],
  embeddings: readonly number[][],
  unitByIndex: ReadonlyMap<number, VfsIndexUnit>,
  target: MultimodalRowTarget,
): VfsLanceRow[] {
  const { resourceId, resourceType, folderId, profileId } = target;
  const now = new Date().toISOString();
  const rows: VfsLanceRow[] = [];
  for (const [index, page] of pages.entries()) {
    const embedding = embeddings[index];
    if (embedding === undefined) throw new Error(`页面 ${page.page_index} 缺少索引 Unit`);
    const unit = unitByIndex.get(page.page_index);
    if (unit === undefined) throw new Error(`页面 ${page.page_index} 缺少索引 Unit`);
    const generation = target.nextGeneration(unit.id);
    const metadata = JSON.stringify({
      page_index: page.page_index,
      blob_hash: page.blob_hash,
      source_id: resourceId,
      unit_id: unit.id,
      content_hash: unit.contentHash,
      modality: MODALITY_MULTIMODAL,
      index_profile_id: profileId,
      generation: typeof generation === 'bigint'
        ? (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(generation.toString())
        : generation,
    });
    const contentSuffix = (unit.contentHash ?? 'nohash').slice(0, 12);
    const profileSuffix = profileId.slice(-12);
    rows.push({
      embedding_id: `${resourceId}_mm_p${page.page_index}_g${generation}_${profileSuffix}_${contentSuffix}_${nanoid(8)}`,
      resource_id: resourceId,
      unit_id: unit.id,
      resource_type: resourceType,
      folder_id: folderId,
      chunk_index: page.page_index,
      text: page.text_content ?? '',
      metadata_json: metadata,
      created_at: now,
      index_profile_id: profileId,
      generation,
      embedding,
    });
  }
  return rows;
}

/** `[blob_hash, unit_id]` from a hit's metadata (object or JSON text). */
export function provenance(value: unknown): [string | null, string | null] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [null, null];
    }
  }
  if (parsed === null || typeof parsed !== 'object') return [null, null];
  const record = parsed as Record<string, unknown>;
  return [
    typeof record['blob_hash'] === 'string' ? record['blob_hash'] : null,
    typeof record['unit_id'] === 'string' ? record['unit_id'] : null,
  ];
}
