import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { StudyTimeDay } from '../api.ts';

export function addSeconds(db: SqlExecutor, date: string, seconds: number, nowMs: number): StudyTimeDay {
  db.run(`INSERT INTO study_time_daily (date, seconds, updated_at)
    VALUES (?1, MIN(?2, ?4), ?3)
    ON CONFLICT(date) DO UPDATE SET
      seconds = MIN(?4, study_time_daily.seconds + excluded.seconds),
      updated_at = excluded.updated_at`, [date, Math.max(0, seconds), nowMs, 86400]);
  return { date, seconds: db.pluck<number>('SELECT seconds FROM study_time_daily WHERE date = ?1', [date]) ?? 0 };
}
export function range(db: SqlExecutor, from: string, to: string): StudyTimeDay[] {
  return db.all<StudyTimeDay>(`SELECT date, seconds FROM study_time_daily
    WHERE date >= ?1 AND date <= ?2 AND seconds > 0 ORDER BY date ASC`, [from, to]);
}
export function totalSeconds(db: SqlExecutor, from: string, to: string): number {
  return db.pluck<number>('SELECT COALESCE(SUM(seconds), 0) FROM study_time_daily WHERE date >= ?1 AND date <= ?2', [from, to])!;
}
