import type { CreatePracticeRequest, PaperConfig__De, SavePracticeRequest } from '../api.ts';
import * as practice from './practice-service.ts';
import { createPracticeRuntime } from './practice-runtime.ts';
import { serviceCallAsync, type QbankPluginDeps } from './plugin-deps.ts';

/** Practice drafts, papers and the background grading/deadline runtime. */
export function registerPractice(deps: QbankPluginDeps): void {
  const { ctx } = deps;
  const runtime = createPracticeRuntime(ctx, () => deps.practiceHost());
  const { startGrading, resumeDeadlines, scheduleDeadline } = runtime;
  ctx.effect(() => () => runtime.dispose());
  // 官方 profile 中 qbank 先于 vfs-repos、llm 安装（这两者不在顶层 inject 里，拓扑排序不调序），
  // apply 时启动会因取不到 vfsRepo 而失败。Rust 的 AppState 里数据库与 llm_manager 总是就绪，
  // 因此启动恢复挂在这两个必需依赖的子作用域上：就绪后执行，缺失时不启动、任务保持排队，
  // 不会被判成"服务未提供"失败。掌握度、复习计划、索引仍是调用时取的尽力而为副作用。
  ctx.inject(['vfsRepo', 'llm', 'llmStreaming'], () => runtime.start());

  ctx.commands.register('qbank_resume_practice_grading', () => serviceCallAsync(async () => {
    await resumeDeadlines();
    startGrading();
    return null;
  }));
  ctx.commands.register<{ request: CreatePracticeRequest }>('qbank_create_practice', ({ request }) =>
    serviceCallAsync(async () => {
      const draft = practice.createDraft(await deps.practiceHost(), request);
      scheduleDeadline(draft);
      return draft;
    }));
  ctx.commands.register<{ request: SavePracticeRequest }>('qbank_save_practice', ({ request }) =>
    serviceCallAsync(async () => practice.saveDraft(await deps.practiceHost(), request)));
  ctx.commands.register<{ id: string; submitted: boolean }>('qbank_get_practice', ({ id, submitted }) =>
    serviceCallAsync(async () => practice.getPractice(await deps.practiceHost(), id, submitted)));
  ctx.commands.register<{ scopeId: string; submitted: boolean; offset: number | null }>('qbank_list_practices',
    ({ scopeId, submitted, offset }) => serviceCallAsync(async () =>
      practice.listPractices(await deps.practiceHost(), scopeId, submitted, offset)));
  ctx.commands.register<{ id: string; revision: number }>('qbank_submit_practice', ({ id, revision }) =>
    serviceCallAsync(async () => {
      const submitted = practice.submitDraft(await deps.practiceHost(), id, revision);
      ctx.backendEvents.emit('qbank-practice-updated', submitted.attempt.id);
      startGrading();
      return submitted.attempt;
    }));
  ctx.commands.register<{ id: string; submitted: boolean }>('qbank_delete_practice', ({ id, submitted }) =>
    serviceCallAsync(async () => {
      practice.deletePractice(await deps.practiceHost(), id, submitted);
      return null;
    }));
  ctx.commands.register<{ examId: string }>('qbank_list_papers', ({ examId }) =>
    serviceCallAsync(async () => practice.listPapers(await deps.practiceHost(), examId)));
  ctx.commands.register<{ id: string }>('qbank_get_paper', ({ id }) =>
    serviceCallAsync(async () => practice.getPaper(await deps.practiceHost(), id)));
  ctx.commands.register<{ id: string; title: string | null; deleted: boolean }>('qbank_update_paper',
    ({ id, title, deleted }) => serviceCallAsync(async () => {
      practice.updatePaper(await deps.practiceHost(), id, title, deleted);
      return null;
    }));
  ctx.commands.register<{ id: string; questionId: string }>('qbank_retry_practice_grading', ({ id, questionId }) =>
    serviceCallAsync(async () => {
      const attempt = practice.retryPracticeGrading(await deps.practiceHost(), id, questionId);
      startGrading();
      return attempt;
    }));
  ctx.commands.register<{ id: string; questionId: string; correct: boolean }>('qbank_grade_practice_manually',
    ({ id, questionId, correct }) => serviceCallAsync(async () =>
      practice.gradePracticeManually(await deps.practiceHost(), id, questionId, correct).attempt));
  ctx.commands.register<{ request: { exam_id: string; config: PaperConfig__De } }>('qbank_generate_paper',
    ({ request }) => serviceCallAsync(async () =>
      practice.generatePaper(await deps.practiceHost(), request.exam_id, request.config)));
}
