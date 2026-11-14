/** Rust `dstu-memory/src/memory/daily_log.rs` pure formatting/CAS helpers. */

export const DAILY_LOG_FOLDER_TITLE = '学习日志';
export const DAILY_LOG_TAG = 'daily_log';
export const TAG_DAILY_LOG_DATE_PREFIX = '_daily_log_date:';
export const DAILY_LOG_MAX_CHARS = 4000;

export function dailyLogNoteTitle(date: string): string {
  return `__daily_log_${date}__`;
}

/** Rust `parse_date_from_title`: only the `__daily_log_`/`__` wrapper and an exactly 10-char body. */
export function parseDateFromTitle(title: string): string | null {
  if (!title.startsWith('__daily_log_') || !title.endsWith('__')) return null;
  const body = title.slice('__daily_log_'.length, title.length - 2);
  return body.length === 10 ? body : null;
}

/** Rust `strip_entry_prefix`; the `] ` search is byte-based, so only ASCII prefix forms match. */
export function stripEntryPrefix(line: string): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('- [')) return trimmed;
  const rest = trimmed.slice(3);
  const pos = rest.indexOf('] ');
  return pos < 0 ? trimmed : rest.slice(pos + 2);
}

export function linesContainEntry(content: string, entryBody: string): boolean {
  return content.split(/\r\n|\n|\r/).some(line => stripEntryPrefix(line).trim() === entryBody.trim());
}

/** Rust `enforce_log_char_limit`: drop oldest lines until under limit, then hard-truncate. */
export function enforceLogCharLimit(lines: readonly string[]): string {
  const kept = [...lines];
  for (;;) {
    const total = kept.reduce((sum, line) => sum + Array.from(line).length, 0)
      + Math.max(0, kept.length - 1);
    if (total <= DAILY_LOG_MAX_CHARS || kept.length <= 1) break;
    kept.shift();
  }
  return Array.from(kept.join('\n')).slice(0, DAILY_LOG_MAX_CHARS).join('');
}

/** Rust: `entry.replace(['\n', '\r'], " ")` then prefix-aware truncation. */
export function formatDailyLogEntry(entry: string, time: string): string {
  const singleLine = entry.trim().replace(/[\n\r]/g, ' ');
  const prefix = `- [${time}] `;
  const bodyLimit = Math.max(0, DAILY_LOG_MAX_CHARS - Array.from(prefix).length);
  return prefix + Array.from(singleLine).slice(0, bodyLimit).join('');
}

/** Rust `chrono::Local::now().format("%H:%M")` for the process time zone. */
export function localTimeHm(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
/** Rust `chrono::Local::now().format("%Y-%m-%d")`. */
export function localDate(now: Date = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
