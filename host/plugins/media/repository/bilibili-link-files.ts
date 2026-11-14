/**
 * `dstu-media/src/media/bilibili.rs::find_link_item`: candidate scan for
 * `.bilibili` link files. Descriptor parsing stays in `src/bilibili-link-items.ts`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { BILIBILI_LINK_MIME } from '../src/media-types.ts';

export interface LinkFileCandidate {
  id: string;
  size: number;
}

export function linkFileCandidates(conn: SqlExecutor): LinkFileCandidate[] {
  return conn.all<LinkFileCandidate>(
    `SELECT id, size FROM files
      WHERE deleted_at IS NULL AND COALESCE(status, 'active') = 'active'
        AND lower(COALESCE(mime_type, '')) = ?1
      ORDER BY created_at`,
    [BILIBILI_LINK_MIME],
  );
}
