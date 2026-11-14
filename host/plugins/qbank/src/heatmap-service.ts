/**
 * `commands.rs:8244 get_learning_heatmap`：聚合 Chat V2、VFS 与 Anki 的每日学习活动。
 *
 * 语义（Rust 源码 commands.rs:8244-8457）：
 * - 日期区间两端都包含；非法日期返回 `AppError::validation("Invalid start_date: ...")`。
 * - 每个数据源的聚合查询失败一律当作 0（`query_date_counts` 的 `unwrap_or_default`）。
 * - Chat V2 / VFS / main 三个库分别读取；Chat V2 库缺失时跳过。
 * - `count` 为九项明细之和；`studySeconds` 单独来自 `study_time_daily`，不计入 `count`。
 * - 结果按日期升序。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DailyActivityDetails, LearningActivity } from '../api.ts';
import {
  ANKI_CARDS_CREATED_SQL, CHAT_MESSAGES_SQL, CHAT_SESSIONS_SQL, ESSAYS_CREATED_SQL,
  EXAMS_CREATED_SQL, NOTES_EDITED_SQL, QUESTIONS_ANSWERED_SQL, STUDY_SECONDS_SQL,
  TEXTBOOKS_OPENED_SQL, TRANSLATIONS_CREATED_SQL, queryDateCounts,
} from '../repository/heatmap.ts';

export interface HeatmapHost {
  chatV2: DatabaseHandle | null;
  vfs: DatabaseHandle;
  main: DatabaseHandle;
}

function emptyDetails(): DailyActivityDetails {
  return {
    chatSessions: 0,
    chatMessages: 0,
    notesEdited: 0,
    textbooksOpened: 0,
    examsCreated: 0,
    translationsCreated: 0,
    essaysCreated: 0,
    ankiCardsCreated: 0,
    questionsAnswered: 0,
  };
}

function formatDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** chrono `NaiveDate::parse_from_str(s, "%Y-%m-%d")` 的校验与错误文案。 */
export function parseHeatmapDate(raw: string, field: string): Date {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match === null) {
    throw new Error(`Invalid ${field}: input contains invalid characters`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid ${field}: input is out of range`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid ${field}: input is out of range`);
  }
  return date;
}

function applyCounts(
  rows: Array<[string, number]>,
  daily: Map<string, DailyActivityDetails>,
  field: keyof DailyActivityDetails,
): void {
  for (const [date, count] of rows) {
    const details = daily.get(date);
    if (details !== undefined) details[field] = count;
  }
}

export function getLearningHeatmap(host: HeatmapHost, startDate: string, endDate: string): LearningActivity[] {
  const start = parseHeatmapDate(startDate, 'start_date');
  const end = parseHeatmapDate(endDate, 'end_date');

  const daily = new Map<string, DailyActivityDetails>();
  for (let current = start.getTime(); current <= end.getTime(); current += 86_400_000) {
    daily.set(formatDate(new Date(current)), emptyDetails());
  }

  if (host.chatV2 !== null) {
    applyCounts(queryDateCounts(host.chatV2, CHAT_SESSIONS_SQL, startDate, endDate), daily, 'chatSessions');
    applyCounts(queryDateCounts(host.chatV2, CHAT_MESSAGES_SQL, startDate, endDate), daily, 'chatMessages');
  }

  applyCounts(queryDateCounts(host.vfs, NOTES_EDITED_SQL, startDate, endDate), daily, 'notesEdited');
  applyCounts(queryDateCounts(host.vfs, TEXTBOOKS_OPENED_SQL, startDate, endDate), daily, 'textbooksOpened');
  applyCounts(queryDateCounts(host.vfs, EXAMS_CREATED_SQL, startDate, endDate), daily, 'examsCreated');
  applyCounts(queryDateCounts(host.vfs, TRANSLATIONS_CREATED_SQL, startDate, endDate), daily, 'translationsCreated');
  applyCounts(queryDateCounts(host.vfs, ESSAYS_CREATED_SQL, startDate, endDate), daily, 'essaysCreated');
  applyCounts(queryDateCounts(host.vfs, QUESTIONS_ANSWERED_SQL, startDate, endDate), daily, 'questionsAnswered');
  applyCounts(queryDateCounts(host.main, ANKI_CARDS_CREATED_SQL, startDate, endDate), daily, 'ankiCardsCreated');

  const studySeconds = new Map<string, number>();
  for (const [date, seconds] of queryDateCounts(host.vfs, STUDY_SECONDS_SQL, startDate, endDate)) {
    studySeconds.set(date, seconds);
  }

  const result: LearningActivity[] = [];
  for (const [date, details] of daily) {
    const count = details.chatSessions + details.chatMessages + details.notesEdited
      + details.textbooksOpened + details.examsCreated + details.translationsCreated
      + details.essaysCreated + details.ankiCardsCreated + details.questionsAnswered;
    result.push({ date, count, details, studySeconds: studySeconds.get(date) ?? 0 });
  }
  result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return result;
}
