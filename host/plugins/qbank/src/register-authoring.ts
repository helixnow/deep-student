import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { ReparseDecision } from '../api.ts';
import * as authoring from './authoring-service.ts';
import { resolveAuthoringRoute } from './authoring-route.ts';
import * as legacy from './legacy-service.ts';
import * as management from './management-service.ts';
import { enumValue } from './question-enums.ts';
import { QbankServiceError } from './question-service.ts';
import * as sourceView from './source-view-service.ts';
import { serviceCall, serviceCallAsync, type QbankPluginDeps } from './plugin-deps.ts';

/** Group structure, authoring drafts, legacy migration, source view and reparse commands. */
export function registerAuthoring(deps: QbankPluginDeps): void {
  const { ctx } = deps;
  ctx.commands.register<{ examId: string }>('qbank_list_structure', ({ examId }) =>
    serviceCall(() => management.getStructure(deps.managementHost(), examId)));
  ctx.commands.register<{ groupId: string; label: string; questionIds: string[]; materialIds: string[];
    expectedVersion: number }>('qbank_update_group',
  ({ groupId, label, questionIds, materialIds, expectedVersion }) => serviceCall(() => {
    const result = management.updateGroupMembers(deps.managementHost(), groupId, label, questionIds,
      materialIds, expectedVersion);
    ctx.backendEvents.emit('qbank://changed', { exam_id: result.exam_id, reason: 'group_updated' });
    return result;
  }));
  ctx.commands.register<{ groupId: string; mode: unknown; expectedVersion: number }>('qbank_delete_group',
    ({ groupId, mode, expectedVersion }) => serviceCall(() => {
      const parsed = enumValue(mode);
      if (parsed !== 'ungroup' && parsed !== 'delete_members') {
        throw new CommandError(AppError.validation(`未知的题组删除模式: ${String(parsed)}`));
      }
      const result = management.deleteQuestionGroup(deps.managementHost(), groupId, parsed, expectedVersion);
      ctx.backendEvents.emit('qbank://changed', { exam_id: result.exam_id, reason: 'group_deleted' });
      return result;
    }));

  ctx.commands.register<{ jobId: string }>('qbank_get_authoring_draft', ({ jobId }) =>
    serviceCall(() => authoring.getDraft(deps.authoringHost(), jobId)));
  ctx.commands.register<{ examId: string }>('qbank_list_authoring_drafts', ({ examId }) =>
    serviceCall(() => authoring.listDrafts(deps.authoringHost(), examId)));
  ctx.commands.register<{ jobId: string; expectedVersion: number; coverage?: unknown[] | null;
    issues?: unknown[] | null; unmatchedAnswers?: unknown[] | null }>('qbank_review_authoring_draft',
  ({ jobId, expectedVersion, coverage, issues, unmatchedAnswers }) => serviceCall(() =>
    authoring.reviewDraft(deps.authoringHost(), jobId, expectedVersion, coverage ?? null,
      issues ?? null, unmatchedAnswers ?? null)));
  ctx.commands.register<{ materialId: string; content: string; expectedVersion: number }>(
    'qbank_update_material', ({ materialId, content, expectedVersion }) => serviceCall(() => {
      const material = authoring.updateMaterial(deps.authoringHost(), materialId, content, expectedVersion);
      ctx.backendEvents.emit('qbank://changed', { reason: 'material_updated', material_id: materialId });
      return material;
    }));
  ctx.commands.register<{ materialId: string; expectedVersion: number }>('qbank_delete_material',
    ({ materialId, expectedVersion }) => serviceCall(() => {
      authoring.deleteMaterial(deps.authoringHost(), materialId, expectedVersion);
      return null;
    }));
  ctx.commands.register<{ jobId: string; selectedLocalIds: string[]; expectedVersion: number }>(
    'qbank_commit_authoring_draft', ({ jobId, selectedLocalIds, expectedVersion }) => serviceCall(() => {
      const receipt = authoring.commitDraft(deps.authoringHost(), jobId, selectedLocalIds, expectedVersion);
      if (receipt.committed) {
        ctx.backendEvents.emit('qbank://changed', { exam_id: receipt.exam_id, reason: 'authoring_committed' });
      }
      return receipt;
    }));

  ctx.commands.register<{ modelConfigId?: string | null; requiresVision: boolean }>(
    'qbank_resolve_authoring_route', ({ modelConfigId, requiresVision }) =>
      serviceCallAsync(() => {
        const llm = ctx.get('llm');
        if (llm === undefined) {
          throw new QbankServiceError(AppError.configuration('LLM 服务未提供'));
        }
        return resolveAuthoringRoute({
          llm,
          ocr: ctx.get('llmOcrModels'),
        }, modelConfigId ?? null, requiresVision);
      }));

  ctx.commands.register<{ examId: string }>('qbank_legacy_audit', ({ examId }) =>
    serviceCall(() => legacy.audit(deps.legacyHost(), examId)));
  ctx.commands.register<{ examId: string; cardIds: string[]; expectedVersion: string }>(
    'qbank_legacy_migrate_selected', ({ examId, cardIds, expectedVersion }) => serviceCall(() => {
      const receipt = legacy.migrate(deps.legacyHost(), examId, cardIds, expectedVersion);
      ctx.backendEvents.emit('qbank://changed', { exam_id: examId, reason: 'legacy_migrated' });
      return receipt;
    }));

  ctx.commands.register<{ examId: string; sourceId: string; page?: number | null }>(
    'qbank_get_source_page', ({ examId, sourceId, page }) =>
      serviceCall(() => sourceView.sourcePage(deps.exportHost(), examId, sourceId, page ?? null)));
  ctx.commands.register<{ examId: string }>('qbank_get_source_images', ({ examId }) =>
    serviceCallAsync(() => sourceView.sourceImages(deps.exportHost(),
      (ctx.get('files') as FilesService | undefined) ?? null, examId)));

  ctx.commands.register<{ examId: string; jobId?: string | null }>('qbank_reparse_report',
    ({ examId, jobId }) => serviceCall(() =>
      legacy.reparse(deps.legacyHost(), examId, jobId ?? null)));
  ctx.commands.register<{
    examId: string; jobId: string;
    decisions: ReparseDecision[]; expectedReportVersion: string;
  }>('qbank_reparse_resolve', ({ examId, jobId, decisions, expectedReportVersion }) =>
    serviceCall(() => {
      const receipt = legacy.resolveReparse(deps.legacyHost(),
        examId, jobId, decisions, expectedReportVersion);
      ctx.backendEvents.emit('qbank://changed', { exam_id: examId, reason: 'reparse_resolved' });
      return receipt;
    }));
}
