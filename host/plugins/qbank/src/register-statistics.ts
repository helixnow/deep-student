import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { MockExamConfig__De, MockExamSession__De } from '../api.ts'; // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
import { getEnhancedStatistics } from './enhanced-statistics.ts';
import { getLearningHeatmap } from './heatmap-service.ts';
import { QbankServiceError } from './question-service.ts';
import * as statistics from './statistics-service.ts';
import { serviceCall, type QbankPluginDeps } from './plugin-deps.ts';

interface GetActivityHeatmapRequest { exam_id?: string | null; year: number }
interface GetCheckInCalendarRequest {
  exam_id?: string | null; year: number; month: number; daily_target?: number | null;
}
interface GetDailyPracticeRequest { exam_id: string; count: number }
interface GetKnowledgeStatsRequest { exam_id?: string | null }
interface GetLearningTrendRequest { exam_id?: string | null; start_date: string; end_date: string }
interface StartTimedPracticeRequest { exam_id: string; duration_minutes: number; question_count: number }
interface GenerateMockExamRequest { exam_id: string; config: MockExamConfig__De } // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
interface SubmitMockExamRequest { session: MockExamSession__De }

/** Learning statistics, heatmaps, timed practice and mock exams. */
export function registerStatistics(deps: QbankPluginDeps): void {
  const { ctx } = deps;
  ctx.commands.register<{ request: GetLearningTrendRequest }>('qbank_get_learning_trend', ({ request }) =>
    serviceCall(() => statistics.getLearningTrend(deps.statisticsHost(), request.exam_id ?? null,
      request.start_date, request.end_date)));
  ctx.commands.register<{ request: GetActivityHeatmapRequest }>('qbank_get_activity_heatmap', ({ request }) =>
    serviceCall(() => statistics.getActivityHeatmap(deps.statisticsHost(), request.exam_id ?? null,
      request.year)));
  ctx.commands.register<{ request: GetKnowledgeStatsRequest }>('qbank_get_knowledge_stats', ({ request }) =>
    serviceCall(() => statistics.getKnowledgeStats(deps.statisticsHost(), request.exam_id ?? null)));
  ctx.commands.register<{ request: GetKnowledgeStatsRequest }>('qbank_get_knowledge_stats_with_comparison',
    ({ request }) => serviceCall(() =>
      statistics.getKnowledgeStatsWithComparison(deps.statisticsHost(), request.exam_id ?? null)));
  ctx.commands.register<{ request: GetCheckInCalendarRequest }>('qbank_get_check_in_calendar', ({ request }) =>
    serviceCall(() => statistics.getCheckInCalendar(deps.statisticsHost(), request.exam_id ?? null,
      request.year, request.month, request.daily_target ?? null)));
  ctx.commands.register<{ request: GetDailyPracticeRequest }>('qbank_get_daily_practice', ({ request }) =>
    serviceCall(() => statistics.getDailyPractice(deps.statisticsHost(), request.exam_id, request.count)));
  ctx.commands.register<{ request: StartTimedPracticeRequest }>('qbank_start_timed_practice', ({ request }) =>
    serviceCall(() => statistics.startTimedPractice(deps.statisticsHost(), request.exam_id,
      request.duration_minutes, request.question_count)));
  ctx.commands.register<{ request: GenerateMockExamRequest }>('qbank_generate_mock_exam', ({ request }) => // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    serviceCall(() => statistics.generateMockExam(deps.statisticsHost(), request.exam_id, request.config)));
  ctx.commands.register<{ request: SubmitMockExamRequest }>('qbank_submit_mock_exam', ({ request }) => // boundary-allow test-double: Rust 领域词 MockExam（模拟考试），非测试替身
    serviceCall(() => statistics.submitMockExam(deps.statisticsHost(), request.session)));

  ctx.commands.register<{ startDate: string; endDate: string }>('get_learning_heatmap',
    ({ startDate, endDate }) => serviceCall(() => {
      const chatV2 = ctx.storage.database('chat_v2');
      try {
        return getLearningHeatmap({
          chatV2,
          vfs: ctx.storage.database('vfs'),
          main: ctx.storage.database('mistakes'),
        }, startDate, endDate);
      } catch (failure) {
        if (failure instanceof Error && failure.message.startsWith('Invalid ')) {
          throw new QbankServiceError(AppError.validation(failure.message));
        }
        throw failure;
      }
    }));

  ctx.commands.register('get_enhanced_statistics', async () => {
    const files = ctx.get('files') as FilesService | undefined;
    if (files === undefined) throw new CommandError(AppError.configuration('文件服务不可用: files 未提供'));
    try {
      return await getEnhancedStatistics(files, ctx.paths.baseJoin('images'));
    } catch (failure) {
      const message = (failure as { message?: unknown }).message;
      throw new CommandError(AppError.database(
        `获取图片统计失败: ${typeof message === 'string' ? message : String(failure)}`));
    }
  });
}
