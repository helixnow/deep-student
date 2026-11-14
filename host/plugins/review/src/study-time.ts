import type { Context } from '@deepseek-ai/cordis';
import { ymd } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { utcNow } from './clock.ts';
import { appError, errorText } from './errors.ts';
import { localDateKey } from './local-date.ts';
import { addSeconds, range } from '../repository/study-time.ts';

export function parseDate(field: string, raw: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rustTrim(raw));
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    if (date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day)) {
      return ymd({
        year: Number(year), month: Number(month), day: Number(day),
        hour: 0, minute: 0, second: 0, nanos: 0, offsetMinutes: 0,
      });
    }
  }
  throw appError('Validation', `${field} must be YYYY-MM-DD, got ${JSON.stringify(raw)}`);
}
export function validateAdd(seconds: number, date: string, today: string): void {
  if (seconds < 1 || seconds > 3600) throw appError('Validation', `seconds must be within 1..=3600, got ${seconds}`);
  if (Math.abs(Date.parse(date) - Date.parse(today)) > 2 * 86400000) throw appError('Validation', `date ${date} is too far from today (${today})`);
}
function localToday(): string {
  return localDateKey();
}
export function studyTimeAdd(ctx: Context, seconds: number, raw?: string | null) {
  const today = localToday();
  const trimmed = raw === null || raw === undefined ? '' : rustTrim(raw);
  const date = trimmed ? parseDate('date', trimmed) : today;
  validateAdd(seconds, date, today);
  const db = ctx.storage.database('vfs');
  try { return addSeconds(db, date, seconds, utcNow().ms); }
  catch (error) { throw appError('Database', `study_time_add failed: ${errorText(error)}`); }
}
export function studyTimeRange(ctx: Context, from: string, to: string) {
  const fromDate = parseDate('from', from), toDate = parseDate('to', to);
  if (toDate < fromDate) throw appError('Validation', 'to must not be earlier than from');
  if (Date.parse(toDate) - Date.parse(fromDate) > 3700 * 86400000) throw appError('Validation', 'range must not exceed 3700 days');
  const db = ctx.storage.database('vfs');
  try { return range(db, fromDate, toDate); }
  catch (error) { throw appError('Database', `study_time_range failed: ${errorText(error)}`); }
}
