/**
 * Learning activity and Pomodoro persistence — TS mirror of
 * `learning_overview_executor.rs::collect_learning_activities` and
 * `dstu-vfs/src/vfs/repos/pomodoro_repo.rs` read paths.
 *
 * Only the columns consumed by the learning overview are touched. Every source
 * failure is reported as a `SOURCE_UNAVAILABLE` entry while other sources keep
 * contributing, matching the Rust partial-source contract.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { withLocalizedMessage } from '../src/tool-errors.ts';
import type {
  DailyActivityDetails, LearningActivity, PomodoroDailyStat,
} from '../src/learning-overview.ts';

export const MAX_STUDY_SECONDS_PER_DAY = 86_400;

export interface SourceError {
  source: string;
  code: 'SOURCE_UNAVAILABLE';
  retryable: true;
  messageKey: string;
  messageParams: { source: string };
  messageFallback: { 'zh-CN': string; 'en-US': string };
  message: string;
}

/** Rust `source_error`. */
export function sourceError(source: string, zhCn: string, enUs: string): SourceError {
  return withLocalizedMessage({
    source, code: 'SOURCE_UNAVAILABLE', retryable: true,
  }, 'chat.tools.learning.source_unavailable', { source }, zhCn, enUs) as unknown as SourceError;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day);
}

export function addLocalDays(value: string, days: number): string {
  const date = parseLocalDate(value);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

/** Rust `local_date_start_utc`: local midnight rendered as `...Z` with millis. */
export function localDateStartUtc(value: string): string {
  return parseLocalDate(value).toISOString();
}

export function emptyActivityDetails(): DailyActivityDetails {
  return {
    chatSessions: 0, chatMessages: 0, notesEdited: 0, textbooksOpened: 0,
    examsCreated: 0, translationsCreated: 0, essaysCreated: 0, ankiCardsCreated: 0,
    questionsAnswered: 0,
  };
}

type CountRow = { date: string; count: number };

/**
 * Rust `collect_learning_activities` (no Anki handle in the Host; callers pass
 * `null` and receive the documented `learning_activity.anki` source error).
 */
export function collectLearningActivities(startDate: string, endDate: string,
  chatDb: SqlExecutor | null, vfsDb: SqlExecutor | null,
  ankiDb: SqlExecutor | null = null): { activities: LearningActivity[]; sourceErrors: SourceError[] } {
  const daily = new Map<string, DailyActivityDetails>();
  let date = startDate;
  while (date <= endDate) {
    daily.set(date, emptyActivityDetails());
    date = addLocalDays(date, 1);
  }

  const sourceErrors: SourceError[] = [];
  const applyRows = (conn: SqlExecutor, sql: string, source: string,
    assign: (details: DailyActivityDetails, count: number) => void): void => {
    try {
      for (const row of conn.all<CountRow>(sql, [startDate, endDate])) {
        const details = daily.get(row.date);
        if (details !== undefined) assign(details, row.count);
      }
    } catch (error) {
      sourceErrors.push(sourceError(source, `学习活动数据源 ${source} 暂时不可用`,
        `Learning activity source ${source} is unavailable: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  if (chatDb !== null) {
    applyRows(chatDb,
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM chat_v2_sessions
       WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
         AND json_extract(metadata_json, '$.superagent') IS NULL
       GROUP BY DATE(created_at)`,
      'learning_activity.chat_sessions',
      (details, count) => { details.chatSessions = count; });
    applyRows(chatDb,
      `SELECT DATE(datetime(timestamp/1000, 'unixepoch')) AS date, COUNT(*) AS count
       FROM chat_v2_messages
       WHERE DATE(datetime(timestamp/1000, 'unixepoch')) >= ?1
         AND DATE(datetime(timestamp/1000, 'unixepoch')) <= ?2
       GROUP BY DATE(datetime(timestamp/1000, 'unixepoch'))`,
      'learning_activity.chat_messages',
      (details, count) => { details.chatMessages = count; });
  } else {
    sourceErrors.push(sourceError('learning_activity.chat_v2',
      'ChatV2 数据库尚未初始化', 'The ChatV2 database is not initialized.'));
  }

  if (vfsDb !== null) {
    applyRows(vfsDb,
      `SELECT DATE(updated_at) AS date, COUNT(*) AS count FROM notes
       WHERE deleted_at IS NULL AND DATE(updated_at) >= ?1 AND DATE(updated_at) <= ?2
       GROUP BY DATE(updated_at)`,
      'learning_activity.notes',
      (details, count) => { details.notesEdited = count; });
    applyRows(vfsDb,
      `SELECT DATE(last_opened_at) AS date, COUNT(*) AS count FROM files
       WHERE last_opened_at IS NOT NULL
         AND DATE(last_opened_at) >= ?1 AND DATE(last_opened_at) <= ?2
       GROUP BY DATE(last_opened_at)`,
      'learning_activity.textbooks',
      (details, count) => { details.textbooksOpened = count; });
    applyRows(vfsDb,
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM exam_sheets
       WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
       GROUP BY DATE(created_at)`,
      'learning_activity.exams',
      (details, count) => { details.examsCreated = count; });
    applyRows(vfsDb,
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM translations
       WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
       GROUP BY DATE(created_at)`,
      'learning_activity.translations',
      (details, count) => { details.translationsCreated = count; });
    applyRows(vfsDb,
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM essays
       WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
       GROUP BY DATE(created_at)`,
      'learning_activity.essays',
      (details, count) => { details.essaysCreated = count; });
    applyRows(vfsDb,
      `SELECT DATE(submitted_at) AS date, COUNT(*) AS count FROM answer_submissions
       WHERE DATE(submitted_at) >= ?1 AND DATE(submitted_at) <= ?2
       GROUP BY DATE(submitted_at)`,
      'learning_activity.questions',
      (details, count) => { details.questionsAnswered = count; });
  } else {
    sourceErrors.push(sourceError('learning_activity.vfs',
      'VFS 学习活动暂时不可用', 'VFS learning activity is unavailable.'));
  }

  if (ankiDb !== null) {
    applyRows(ankiDb,
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM anki_cards
       WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
       GROUP BY DATE(created_at)`,
      'learning_activity.anki',
      (details, count) => { details.ankiCardsCreated = count; });
  } else {
    sourceErrors.push(sourceError('learning_activity.anki',
      'Anki 数据库尚未初始化', 'The Anki database is not initialized.'));
  }

  const studySecondsByDate = new Map<string, number>();
  if (vfsDb !== null) {
    try {
      const rows = vfsDb.all<{ date: string; seconds: number }>(
        `SELECT date, seconds FROM study_time_daily
         WHERE date >= ?1 AND date <= ?2 AND seconds > 0 ORDER BY date ASC`,
        [startDate, endDate]);
      for (const row of rows) {
        studySecondsByDate.set(row.date, Math.min(MAX_STUDY_SECONDS_PER_DAY,
          Math.max(0, row.seconds)));
      }
    } catch {
      // Rust `study_time::range` failures are silently ignored: keep the empty map.
      studySecondsByDate.clear();
    }
  }

  const activities: LearningActivity[] = [...daily.entries()].map(([activityDate, details]) => ({
    date: activityDate,
    count: details.chatSessions + details.chatMessages + details.notesEdited
      + details.textbooksOpened + details.examsCreated + details.translationsCreated
      + details.essaysCreated + details.ankiCardsCreated + details.questionsAnswered,
    details,
    studySeconds: studySecondsByDate.get(activityDate) ?? 0,
  }));
  activities.sort((left, right) => left.date.localeCompare(right.date));
  return { activities, sourceErrors };
}

/** Rust `learning_overview_executor.rs::qbank_totals` (read-only over `exam_sheets`/`questions`). */
export function qbankTotals(conn: SqlExecutor): Record<string, unknown> {
  const banks = conn.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM exam_sheets WHERE deleted_at IS NULL');
  const row = conn.get<{ total: number; new_count: number; in_progress: number; mastered: number;
    review: number; attempts: number; correct: number }>(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0) AS new_count,
       COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
       COALESCE(SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END), 0) AS mastered,
       COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS review,
       COALESCE(SUM(attempt_count), 0) AS attempts,
       COALESCE(SUM(correct_count), 0) AS correct
     FROM questions
     WHERE deleted_at IS NULL`);
  const attempts = row?.attempts ?? 0;
  const correct = row?.correct ?? 0;
  return {
    questionBanks: banks?.count ?? 0,
    totalQuestions: row?.total ?? 0,
    new: row?.new_count ?? 0,
    inProgress: row?.in_progress ?? 0,
    mastered: row?.mastered ?? 0,
    review: row?.review ?? 0,
    totalAttempts: attempts,
    totalCorrect: correct,
    correctRate: attempts > 0 ? correct / attempts : 0,
    source: 'questions_table_read_only',
  };
}

/** Rust `PomodoroRepo::get_daily_stats` (local-date buckets, zero-filled). */
export function pomodoroDailyStats(db: SqlExecutor, days: number,
  now = new Date()): PomodoroDailyStat[] {
  const clamped = Math.min(366, Math.max(1, Math.trunc(days)));
  const today = localDateString(now);
  const rangeStartLocal = addLocalDays(today, -(clamped - 1));
  const rangeStartUtc = localDateStartUtc(rangeStartLocal);
  const rows = db.all<{ created_at: string; status: string; actual_duration: number }>(
    `SELECT created_at, status, actual_duration FROM pomodoro_records
     WHERE type = 'work' AND created_at >= ?1 AND deleted_at IS NULL`,
    [rangeStartUtc]);

  const buckets: PomodoroDailyStat[] = Array.from({ length: clamped }, (_, index) => ({
    date: addLocalDays(rangeStartLocal, index),
    completedCount: 0,
    focusSeconds: 0,
    interruptedCount: 0,
  }));
  for (const row of rows) {
    const parsed = new Date(row.created_at);
    if (Number.isNaN(parsed.getTime())) continue;
    const index = Math.round((parseLocalDate(localDateString(parsed)).getTime()
      - parseLocalDate(rangeStartLocal).getTime()) / 86_400_000);
    if (index < 0 || index >= clamped) continue;
    const bucket = buckets[index]!;
    if (row.status === 'completed') {
      bucket.completedCount += 1;
      bucket.focusSeconds += Math.max(0, row.actual_duration);
    } else if (row.status === 'interrupted') {
      bucket.interruptedCount += 1;
      bucket.focusSeconds += Math.max(0, row.actual_duration);
    }
  }
  return buckets;
}
