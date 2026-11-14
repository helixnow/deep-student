/**
 * FTP listing/date decoding (ftp.rs:99-380).
 *
 * Pure parsing extracted from `ftp.ts` so the transport/session module stays focused
 * on wire behaviour. `ftp.ts` re-exports this surface, so existing importers and the
 * production `FtpStorage` listing path keep using the same implementation.
 */

import { parseRfc3339, type ParsedDateTime } from '../../../platform/time/index.ts';

export interface FtpListEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** Epoch milliseconds. */
  modified: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * suppaftp `ListParser::parse_mlsx` (list.rs:96): split on `;`, read the facts, then
 * take the last token as the name. Missing facts keep the defaults (file, 0, epoch).
 */
export function parseMlsxLine(line: string): FtpListEntry | null {
  const tokens = line.split(';');
  let isDir = false;
  let size = 0;
  let modified = 0;
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals < 0) continue;
    const key = token.slice(0, equals).toLowerCase();
    const value = token.slice(equals + 1);
    if (key === 'type') {
      const normalized = value.toLowerCase();
      if (normalized === 'dir') isDir = true;
      else if (normalized === 'file') isDir = false;
      else if (normalized === 'link') isDir = false;
      else return null;
    } else if (key === 'size') {
      if (!/^\d+$/.test(value)) return null;
      size = Number(value);
    } else if (key === 'modify') {
      const parsed = parseMlsxDateTime(value);
      if (parsed === null) return null;
      // suppaftp projects chrono timestamp() (whole seconds) into SystemTime;
      // negative seconds cast to u64 overflow checked_add and fall back to epoch.
      const timestampMillis = (parsed.epochNanos - BigInt(parsed.nanos)) / 1_000_000n;
      modified = timestampMillis < 0n ? 0 : Number(timestampMillis);
    }
  }
  return { name: tokens[tokens.length - 1]!.trimStart(), isDir, size, modified };
}

/** Decode the existing compact UTC syntax through the shared chrono primitive. */
function parseMlsxDateTime(value: string): ParsedDateTime | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  return parseRfc3339(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
}

/** Compact UTC timestamp reduced to epoch milliseconds for MDTM. */
export function parseMlsxTimestamp(value: string): number | null {
  return parseMlsxDateTime(value)?.millis ?? null;
}

const POSIX_LS_RE = /^([-ld])([-rwxsStT]{9})\s+(\d+)\s+([^ ]+)\s+([^ ]+)\s+(\d+)\s+([^ ]+\s+\d{1,2}\s+(?:\d{1,2}:\d{1,2}|\d{4}))\s+(.+)$/;
const DOS_LS_RE = /^(\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*[AP]M)\s+(<DIR>)?([\d,]*)\s+(.+)$/;

/** suppaftp `ListParser::parse_posix` (list.rs:196). */
export function parsePosixLine(line: string): FtpListEntry | null {
  const match = POSIX_LS_RE.exec(line);
  if (!match) return null;
  const type = match[1]!;
  if (type !== '-' && type !== 'd' && type !== 'l') return null;
  const size = Number(match[6]);
  if (!Number.isFinite(size)) return null;
  const modified = parseLsTime(match[7]!.trim());
  if (modified === null) return null;
  let name = match[8]!;
  if (type === 'l') {
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) name = name.slice(0, arrow);
  }
  return { name, isDir: type === 'd', size, modified };
}

/** suppaftp `parse_lstime`: `%b %d %Y`, else `%b %d %H:%M` with the current UTC year. */
export function parseLsTime(value: string): number | null {
  const parts = value.split(/\s+/);
  if (parts.length !== 3) return null;
  const month = MONTHS.indexOf(parts[0]!.toLowerCase());
  if (month < 0) return null;
  const day = Number(parts[1]);
  if (!Number.isFinite(day)) return null;
  const last = parts[2]!;
  if (/^\d{4}$/.test(last)) return Date.UTC(Number(last), month, day);
  const clock = /^(\d{1,2}):(\d{1,2})$/.exec(last);
  if (!clock) return null;
  return Date.UTC(new Date().getUTCFullYear(), month, day, Number(clock[1]), Number(clock[2]));
}

/** suppaftp `ListParser::parse_dos` (list.rs:280). */
export function parseDosLine(line: string): FtpListEntry | null {
  const match = DOS_LS_RE.exec(line);
  if (!match) return null;
  const modified = parseDosTime(match[1]!);
  if (modified === null) return null;
  const isDir = match[2] !== undefined;
  const size = isDir ? 0 : Number((match[3] ?? '0').replace(/,/g, ''));
  if (!Number.isFinite(size)) return null;
  return { name: match[4]!, isDir, size, modified };
}

export function parseDosTime(value: string): number | null {
  const match = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*([AP]M)$/.exec(value.trim());
  if (!match) return null;
  const year = 2000 + Number(match[3]);
  let hour = Number(match[4]) % 12;
  if (match[6] === 'PM') hour += 12;
  return Date.UTC(year, Number(match[1]) - 1, Number(match[2]), hour, Number(match[5]));
}

/**
 * ftp.rs:367 `parse_list_entry`: MLSD first, then the generic LIST parser.
 *
 * NOTE: `suppaftp::File::from_mlsx_line` accepts *any* line (the name becomes the whole
 * line), so a LIST fallback line is parsed as an MLSD entry with size 0 and epoch mtime.
 * That is what the Rust code does; see the migration report for this inherited bug.
 */
export function parseListEntry(line: string): FtpListEntry | null {
  return parseMlsxLine(line) ?? parsePosixLine(line) ?? parseDosLine(line);
}
