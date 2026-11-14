// dstu/handler_utils/node_converters.rs::note_to_dstu_node.
import type { DstuNode } from '../../../../contracts/ipc/generated/_shared.ts';
import type { VfsNote } from '../api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { now, parseNaiveDateTime, parseRfc3339 } from '../../../platform/time/index.ts';
import { notesLog } from '../repository/log.ts';

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(\.\d{1,9})?$/;
const INTEGER = /^[+-]?\d+$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** node_converters.rs::parse_timestamp: RFC3339, SQLite datetime (with optional
 * fraction), or a bare unix timestamp; anything else logs and falls back to now. */
export function parseTimestamp(value: string): number {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0) return now().millis;

  const rfc = parseRfc3339(trimmed);
  if (rfc !== null) return rfc.millis;

  const sqlite = SQLITE_TIMESTAMP.exec(trimmed);
  if (sqlite !== null) {
    const base = parseNaiveDateTime(sqlite[1] as string);
    if (base !== null) {
      const fraction = sqlite[2];
      if (fraction === undefined) return base.millis;
      // chrono `%.f` keeps nanoseconds; `timestamp_millis` truncates to ms.
      return base.millis + Number(fraction.slice(1, 4).padEnd(3, '0'));
    }
  }

  if (INTEGER.test(trimmed)) {
    const raw = BigInt(trimmed);
    if (raw >= I64_MIN && raw <= I64_MAX) {
      const absolute = raw < 0n ? -raw : raw;
      // parse_timestamp: values below 1e11 are seconds, everything else millis.
      return Number(absolute < 100_000_000_000n ? raw * 1000n : raw);
    }
  }

  const fallback = now().millis;
  notesLog.warn(
    `[DSTU::node_converters] Failed to parse timestamp '${value}', fallback to now: ${fallback}`);
  return fallback;
}

export function noteToDstuNode(note: VfsNote): DstuNode {
  return {
    id: note.id,
    path: `/${note.id}`,
    name: note.title,
    type: 'note',
    createdAt: parseTimestamp(note.createdAt),
    updatedAt: parseTimestamp(note.updatedAt),
    resourceId: note.resourceId,
    sourceId: note.id,
    previewType: 'markdown',
    metadata: {
      isFavorite: note.isFavorite,
      tags: note.tags,
      props: note.props ?? {},
    },
  };
}
