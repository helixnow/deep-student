/**
 * `LearningOverviewExecutor` — Rust `src-tauri/src/chat_v2/tools/learning_overview_executor.rs`
 * (`execute_overview` / `execute_today` / `execute_daily` and the `execute` envelope).
 * Parsing and aggregation live in `learning-overview.ts`; SQL collectors in `repository/learning.ts`.
 *
 * Every source is optional: a missing service maps onto the Rust "database not
 * initialized" branch, a throwing service onto the "unavailable: {error}" branch,
 * and both only add a `sourceErrors` entry (the overview itself still succeeds).
 */
import type { ExecutionContext, ToolCall, ToolConcurrency, ToolExecutor, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  CreatePomodoroRecordParams, PomodoroDailyStat, PomodoroRecord, PomodoroTodayStats,
} from '../../vfs-repos/api.ts';
import type { FsrsDueCard, FsrsStats, MasteryOverviewSummary, ReviewStats } from '../../review/api.ts';
import type { MediaCourseSummary } from '../../media/api.ts';
import {
  LEARNING_OVERVIEW, POMODORO_DAILY_STATS, POMODORO_RECORD_CREATE, POMODORO_RECORD_DELETE,
  POMODORO_RECORD_LIST, POMODORO_TODAY_STATS, aggregateActivities, aggregatePomodoro,
  learningOverviewCanHandle, learningOverviewConcurrency, learningOverviewSensitivity, mergeDaily, paginate,
  parseDailyRequest, parseOverviewRequest, parsePomodoroRecordCreateRequest, parsePomodoroRecordDeleteRequest,
  parsePomodoroRecordListRequest, parseTodayRequest, type ActivityTotals, type LearningActivity,
  type PomodoroRecordCreateRequest,
} from './learning-overview.ts';
import { collectLearningActivities, localDateString, qbankTotals, sourceError,
  type SourceError } from '../repository/learning.ts';
import { runResearchTool, toolErrorText, type ResearchToolLog } from './research-tool-runner.ts';
import { stripToolNamespace } from './paper-save.ts';
import { withLocalizedMessage } from './tool-errors.ts';

export interface LearningPomodoroPort {
  getTodayStats(conn: SqlExecutor): PomodoroTodayStats;
  getDailyStats(conn: SqlExecutor, days: number): PomodoroDailyStat[];
  createRecord(conn: SqlExecutor, params: CreatePomodoroRecordParams): PomodoroRecord;
  listRange(conn: SqlExecutor, startDate: string, endDate: string): PomodoroRecord[];
  deleteRecord(conn: SqlExecutor, recordId: string): void;
}

export interface LearningOverviewDeps {
  /** Rust `ctx.vfs_db`. */
  vfsDb(): SqlExecutor | null;
  /** Rust `ctx.anki_db.or(ctx.main_db)` for the Anki activity counter. */
  ankiActivityDb(): SqlExecutor | null;
  /** `VfsPomodoroRepo` over the VFS connection; throws when L11 is not installed. */
  pomodoros(): LearningPomodoroPort;
  /** `ReviewPlanService::get_review_stats`; throws when the provider is missing. */
  reviewStats(): ReviewStats;
  /** `FsrsReviewService` (Rust `ctx.anki_db`); `null` ⇔ Anki database not initialized. */
  fsrs(): { getStats(): FsrsStats; getDue(limit: number): FsrsDueCard[] } | null;
  /** `MasteryService::overview_summary`; throws when the provider is missing. */
  masterySummary(limit: number): MasteryOverviewSummary;
  /** `media::ledger::media_learning_summary` on the VFS connection. */
  mediaSummary(conn: SqlExecutor, limit: number): { recentCourses: MediaCourseSummary[] };
  now?(): Date;
  log: ResearchToolLog;
}

function learningError(code: string, zhCn: string, enUs: string): string {
  return JSON.stringify(withLocalizedMessage({ code, retryable: true },
    'chat.tools.learning.query_failed', { code }, zhCn, enUs));
}

function activityTotalsJson(totals: ActivityTotals): Record<string, number> {
  return {
    count: totals.count,
    chatSessions: totals.chatSessions,
    chatMessages: totals.chatMessages,
    notesEdited: totals.notesEdited,
    textbooksOpened: totals.textbooksOpened,
    examsCreated: totals.examsCreated,
    translationsCreated: totals.translationsCreated,
    essaysCreated: totals.essaysCreated,
    ankiCardsCreated: totals.ankiCardsCreated,
    questionsAnswered: totals.questionsAnswered,
  };
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function trimEndChar(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text.slice(end - char.length, end) === char) end -= char.length;
  return text.slice(0, end);
}

export class LearningOverviewExecutor implements ToolExecutor {
  private readonly deps: LearningOverviewDeps;

  constructor(deps: LearningOverviewDeps) {
    this.deps = deps;
  }

  name(): string { return 'LearningOverviewExecutor'; }
  canHandle(toolName: string): boolean { return learningOverviewCanHandle(toolName); }
  sensitivityLevel(toolName: string): ToolSensitivity { return learningOverviewSensitivity(toolName); }
  concurrencyClass(toolName: string): ToolConcurrency { return learningOverviewConcurrency(toolName); }

  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResultInfo> {
    return runResearchTool(call, ctx, async () => {
      const tool = stripToolNamespace(call.name);
      if (tool === LEARNING_OVERVIEW) return this.overview(call.arguments, ctx);
      if (tool === POMODORO_TODAY_STATS) return this.todayStats(call.arguments);
      if (tool === POMODORO_DAILY_STATS) return this.daily(call.arguments);
      if (tool === POMODORO_RECORD_CREATE) return this.createRecord(call.arguments);
      if (tool === POMODORO_RECORD_LIST) return this.listRecords(call.arguments);
      if (tool === POMODORO_RECORD_DELETE) return this.deleteRecord(call.arguments);
      throw new Error(learningError('UNKNOWN_TOOL', '不支持的学习统计工具',
        `Unsupported learning statistics tool: ${call.name}`));
    }, { log: this.deps.log, executorName: 'LearningOverviewExecutor', saveBlock: true });
  }

  private todayDate(): string {
    return localDateString(this.deps.now?.() ?? new Date());
  }

  private overview(argumentsValue: unknown, ctx: ExecutionContext): Record<string, unknown> {
    const today = this.todayDate();
    const request = parseOverviewRequest(argumentsValue, today);
    const { startDate, endDate } = request;
    const totalDays = daysBetween(startDate, endDate) + 1;
    const sourceErrors: SourceError[] = [];
    const vfs = this.deps.vfsDb();

    let chatDb: SqlExecutor | null = null;
    if (ctx.chat_v2_db !== null) {
      try { chatDb = ctx.chat_v2_db.getConnSafe(); }
      catch (error) { this.deps.log.warn(`[LearningOverviewExecutor] chat_v2 connection failed: ${toolErrorText(error)}`); }
    }
    const collected = collectLearningActivities(startDate, endDate, chatDb, vfs, this.deps.ankiActivityDb());
    const activities: LearningActivity[] = collected.activities;
    sourceErrors.push(...collected.sourceErrors);

    let pomodoro: PomodoroDailyStat[] = [];
    if (vfs === null) {
      sourceErrors.push(sourceError('pomodoro', 'VFS 数据库尚未初始化，番茄钟统计不可用',
        'The VFS database is not initialized, so Pomodoro statistics are unavailable.'));
    } else {
      const days = daysBetween(startDate, today) + 1;
      if (days > 366) {
        sourceErrors.push(sourceError('pomodoro', '番茄钟日统计仅支持最近 366 天',
          'Daily Pomodoro statistics are available only for the most recent 366 days.'));
      } else if (days > 0) {
        try {
          pomodoro = this.deps.pomodoros().getDailyStats(vfs, days)
            .filter(item => item.date >= startDate && item.date <= endDate);
        } catch (error) {
          sourceErrors.push(sourceError('pomodoro', '番茄钟统计暂时不可用',
            `Pomodoro statistics are unavailable: ${toolErrorText(error)}`));
        }
      }
    }

    const fromVfs = <T>(source: string, zhUnavailable: string, enUnavailable: string,
      zhMissing: string, enMissing: string, read: (conn: SqlExecutor) => T): T | null => {
      if (vfs === null) {
        sourceErrors.push(sourceError(source, zhMissing, enMissing));
        return null;
      }
      try { return read(vfs); }
      catch (error) {
        sourceErrors.push(sourceError(source, zhUnavailable, `${enUnavailable}: ${toolErrorText(error)}`));
        return null;
      }
    };

    const qbank = fromVfs('question_bank', '题库统计暂时不可用', 'Question bank statistics are unavailable',
      'VFS 数据库尚未初始化，题库统计不可用',
      'The VFS database is not initialized, so question bank statistics are unavailable.', qbankTotals);
    const sm2Review = fromVfs('sm2_review', 'SM-2 复习统计暂时不可用', 'SM-2 review statistics are unavailable',
      'VFS 数据库尚未初始化，SM-2 复习统计不可用',
      'The VFS database is not initialized, so SM-2 review statistics are unavailable.',
      () => this.deps.reviewStats());

    const fsrsService = this.deps.fsrs();
    let fsrs: FsrsStats | null = null;
    if (fsrsService === null) {
      sourceErrors.push(sourceError('fsrs', 'Anki 数据库尚未初始化，FSRS 统计不可用',
        'The Anki database is not initialized, so FSRS statistics are unavailable.'));
    } else {
      try { fsrs = fsrsService.getStats(); }
      catch (error) {
        sourceErrors.push(sourceError('fsrs', 'FSRS 复习统计暂时不可用',
          `FSRS review statistics are unavailable: ${toolErrorText(error)}`));
      }
    }

    const mastery = fromVfs('mastery', '掌握度统计暂时不可用', 'Mastery statistics are unavailable',
      'VFS 数据库尚未初始化，掌握度统计不可用',
      'The VFS database is not initialized, so mastery statistics are unavailable.',
      () => this.withDueCards(this.deps.masterySummary(5), fsrsService));

    let media: { recentCourses: MediaCourseSummary[] } | null = null;
    if (vfs !== null) {
      try { media = this.deps.mediaSummary(vfs, 5); }
      catch (error) {
        sourceErrors.push(sourceError('media', '音视频学习进度暂时不可用',
          `Media learning progress is unavailable: ${toolErrorText(error)}`));
      }
    }

    const totals = aggregateActivities(activities);
    const studySeconds = activities.reduce((sum, item) => sum + item.studySeconds, 0);
    const focusTotals = aggregatePomodoro(pomodoro);
    const daily = mergeDaily(activities, pomodoro, startDate, endDate);
    const { items: dailyPage, hasMore } = paginate(daily, request.page);
    const partial = sourceErrors.length > 0;
    return withLocalizedMessage({
      success: true,
      range: { startDate, endDate, totalDays },
      activityTotals: activityTotalsJson(totals),
      focusTotals,
      studyTime: { totalSeconds: studySeconds },
      media,
      questionBank: qbank,
      fsrsReview: fsrs,
      sm2Review,
      mastery,
      daily: dailyPage,
      page: request.page.page,
      page_size: request.page.pageSize,
      total: daily.length,
      has_more: hasMore,
      truncated: hasMore,
      partial,
      sourceErrors,
    }, 'chat.tools.learning.overview_ready', {
      startDate, endDate, focusSeconds: focusTotals.focusSeconds, partial,
    }, `已汇总 ${startDate} 至 ${endDate} 的学习情况，专注 ${focusTotals.focusSeconds} 秒${partial ? '；部分数据源不可用' : ''}`,
    `Learning activity from ${startDate} through ${endDate} is ready: ${focusTotals.focusSeconds} focus seconds${partial ? '; some sources were unavailable' : ''}.`);
  }

  /** A-P1: due flashcards per concept (first non-blank tag); `get_due` failures leave the summary as-is. */
  private withDueCards(summary: MasteryOverviewSummary,
    fsrs: { getDue(limit: number): FsrsDueCard[] } | null): MasteryOverviewSummary {
    if (fsrs === null) return summary;
    let due: FsrsDueCard[];
    try { due = fsrs.getDue(200); }
    catch (error) {
      this.deps.log.debug(`[LearningOverviewExecutor] fsrs due cards unavailable: ${toolErrorText(error)}`);
      return summary;
    }
    const byConcept = new Map<string, number>();
    for (const card of due) {
      const concept = card.tags.map(tag => tag.trim()).find(tag => tag !== '');
      if (concept !== undefined) byConcept.set(concept, (byConcept.get(concept) ?? 0) + 1);
    }
    for (const item of summary.todayPriorityReview) {
      const count = byConcept.get(item.conceptKey);
      if (count === undefined) {
        delete item.dueCardCount;
      } else {
        item.dueCardCount = count;
        item.reason = `${trimEndChar(item.reason, '。')}；今日到期 ${count} 张`;
      }
    }
    return summary;
  }

  private requireVfs(): SqlExecutor {
    const vfs = this.deps.vfsDb();
    if (vfs === null) {
      throw new Error(learningError('LEARNING_DATABASE_UNAVAILABLE', 'VFS 数据库尚未初始化',
        'The VFS database is not initialized.'));
    }
    return vfs;
  }

  private todayStats(argumentsValue: unknown): Record<string, unknown> {
    parseTodayRequest(argumentsValue);
    const vfs = this.requireVfs();
    let stats: PomodoroTodayStats;
    try { stats = this.deps.pomodoros().getTodayStats(vfs); }
    catch (error) {
      throw new Error(learningError('POMODORO_QUERY_FAILED', '无法读取今日番茄钟统计',
        `Could not read today's Pomodoro statistics: ${toolErrorText(error)}`));
    }
    const date = this.todayDate();
    return withLocalizedMessage({ success: true, date, stats }, 'chat.tools.learning.pomodoro_today_ready', {
      date, completedCount: stats.completedCount, focusSeconds: stats.totalFocusSeconds,
      interruptedCount: stats.interruptedCount,
    }, `今日完成 ${stats.completedCount} 个番茄钟，专注 ${stats.totalFocusSeconds} 秒，中断 ${stats.interruptedCount} 次`,
    `Today: ${stats.completedCount} completed Pomodoro sessions, ${stats.totalFocusSeconds} focus seconds, and ${stats.interruptedCount} interruptions.`);
  }

  private daily(argumentsValue: unknown): Record<string, unknown> {
    const request = parseDailyRequest(argumentsValue);
    const vfs = this.requireVfs();
    let items: PomodoroDailyStat[];
    try { items = this.deps.pomodoros().getDailyStats(vfs, request.days); }
    catch (error) {
      throw new Error(learningError('POMODORO_QUERY_FAILED', '无法读取番茄钟每日统计',
        `Could not read daily Pomodoro statistics: ${toolErrorText(error)}`));
    }
    const totals = aggregatePomodoro(items);
    const { items: pageItems, hasMore } = paginate(items, request.page);
    return withLocalizedMessage({
      success: true,
      days: request.days,
      daily: pageItems,
      totals,
      page: request.page.page,
      page_size: request.page.pageSize,
      total: items.length,
      has_more: hasMore,
      truncated: hasMore,
    }, 'chat.tools.learning.pomodoro_daily_ready', { days: request.days, focusSeconds: totals.focusSeconds },
    `近 ${request.days} 天累计专注 ${totals.focusSeconds} 秒`,
    `The last ${request.days} days contain ${totals.focusSeconds} focus seconds.`);
  }

  /**
   * `pomodoro_record_create`: persists one completed work record. The
   * `pomodoro_records` table has no `mode`/`note` columns, so those arguments
   * are validated and echoed back but not stored (the product schema owns them).
   */
  private createRecord(argumentsValue: unknown): Record<string, unknown> {
    const request = parsePomodoroRecordCreateRequest(argumentsValue);
    const vfs = this.requireVfs();
    const now = this.deps.now?.() ?? new Date();
    const completedAt = request.completedAt === null ? null : Date.parse(request.completedAt);
    // A supplied end time anchors the record: without a start time the planned
    // duration is subtracted so `started_at` stays consistent with `end_time`.
    const startTime = request.startedAt
      ?? (completedAt === null
        ? now.toISOString()
        : new Date(completedAt - request.duration * 1_000).toISOString());
    const endTime = request.completedAt
      ?? new Date(Date.parse(startTime) + request.duration * 1_000).toISOString();
    const startedMs = Date.parse(startTime);
    const completedMs = Date.parse(endTime);
    const actualDuration = Number.isFinite(startedMs) && Number.isFinite(completedMs)
      ? Math.max(0, Math.min(request.duration, Math.round((completedMs - startedMs) / 1_000)))
      : request.duration;
    const params: CreatePomodoroRecordParams = {
      todoItemId: request.todoId,
      startTime,
      endTime,
      duration: request.duration,
      actualDuration,
      type: 'work',
      status: 'completed',
    };
    let record: PomodoroRecord;
    try { record = this.deps.pomodoros().createRecord(vfs, params); }
    catch (error) {
      throw new Error(learningError('POMODORO_WRITE_FAILED', '无法创建番茄钟记录',
        `Could not create the Pomodoro record: ${toolErrorText(error)}`));
    }
    return withLocalizedMessage({
      success: true,
      record,
      mode: request.mode,
      note: request.note,
      persisted: { record: true, mode: false, note: false },
      message: `已记录一次 ${Math.round(request.duration / 60)} 分钟专注`,
    }, 'chat.tools.learning.pomodoro_record_created', {
      duration: request.duration, actualDuration,
    }, `已创建番茄钟专注记录（计划 ${request.duration} 秒，实际 ${actualDuration} 秒）`,
    `Created a Pomodoro focus record (${request.duration} planned seconds, ${actualDuration} actual seconds).`);
  }

  /** `pomodoro_record_list`: newest-first records in an inclusive local-date range. */
  private listRecords(argumentsValue: unknown): Record<string, unknown> {
    const request = parsePomodoroRecordListRequest(argumentsValue, this.todayDate());
    const vfs = this.requireVfs();
    let records: PomodoroRecord[];
    try { records = this.deps.pomodoros().listRange(vfs, request.startDate, request.endDate); }
    catch (error) {
      throw new Error(learningError('POMODORO_QUERY_FAILED', '无法读取番茄钟记录',
        `Could not read Pomodoro records: ${toolErrorText(error)}`));
    }
    const filtered = request.todoId === null
      ? records
      : records.filter(record => record.todoItemId === request.todoId);
    const pageItems = filtered.slice(0, request.limit);
    const hasMore = filtered.length > pageItems.length;
    return withLocalizedMessage({
      success: true,
      records: pageItems,
      total: filtered.length,
      limit: request.limit,
      has_more: hasMore,
      range: { startDate: request.startDate, endDate: request.endDate },
      todo_id: request.todoId,
    }, 'chat.tools.learning.pomodoro_records_ready', {
      startDate: request.startDate, endDate: request.endDate, count: pageItems.length,
    }, `${request.startDate} 至 ${request.endDate} 共 ${filtered.length} 条番茄钟记录`,
    `${filtered.length} Pomodoro records found from ${request.startDate} through ${request.endDate}.`);
  }

  /** `pomodoro_record_delete`: soft-deletes one record (High sensitivity). */
  private deleteRecord(argumentsValue: unknown): Record<string, unknown> {
    const request = parsePomodoroRecordDeleteRequest(argumentsValue);
    const vfs = this.requireVfs();
    try { this.deps.pomodoros().deleteRecord(vfs, request.id); }
    catch (error) {
      throw new Error(learningError('POMODORO_DELETE_FAILED', '无法删除番茄钟记录',
        `Could not delete the Pomodoro record: ${toolErrorText(error)}`));
    }
    return withLocalizedMessage({
      success: true, id: request.id, message: '已删除番茄钟记录',
    }, 'chat.tools.learning.pomodoro_record_deleted', { id: request.id },
    `已删除番茄钟记录 ${request.id}`, `Deleted Pomodoro record ${request.id}.`);
  }
}
