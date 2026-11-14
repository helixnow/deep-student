import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost, HandlerPanic } from '../../../kernel/testing.ts';
import { CommandError } from '../../../kernel/api.ts';
import type * as Wire from '../../../../contracts/ipc/generated/L15-review-analytics.ts';
import type { InsightCommandService } from '../../memory/api.ts';
import review from '../index.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const disposables: Array<{ dispose(): void }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const item of disposables.splice(0)) item.dispose();
});

const CARD: Wire.InsightCard = {
  id: 'insight_1', title: 'card', ownership: 'self_reported', verification_state: 'unverified',
  status: 'active', recall_count: 0, shown_count: 0, useful_count: 0, last_recalled_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: null, current_revision: null,
};

function service(overrides: Partial<InsightCommandService>): InsightCommandService {
  return {
    async createDraft() { return CARD; },
    async confirm() { return CARD; },
    async correct() { return CARD; },
    async delete() { return undefined; },
    async getInsight() { return CARD; },
    async listInsights() { return []; },
    async listRevisions() { return []; },
    async listEvidence() { return []; },
    async listRelations() { return []; },
    async listEvents() { return []; },
    async recordFeedback() { return undefined; },
    async addRelation() { return 'relation_1'; },
    async runJobs() { return 0; },
    ...overrides,
  };
}

async function setup(insight: InsightCommandService) {
  const dir = mkdtempSync(join(tmpdir(), 'review-insight-errors-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  disposables.push(storage, { dispose: () => rmSync(dir, { recursive: true, force: true }) });
  const host = await createTestHost({ plugins: [review], provide: { storage, insight } });
  hosts.push(host);
  return host;
}

const DRAFT: Wire.InsightDraftInput = {
  title: '', situation: '', stuck_point: '', turning_point: '', rule: '',
  validity_conditions: '', ownership: 'self_reported', evidence: [],
};

it('insight_ipc_boundary_converts_structured_business_app_errors_without_panic', async () => {
  const expected = {
    create: AppError.validation('灵感卡标题不能为空'),
    confirm: AppError.not_found('灵感卡不存在: missing'),
    correct: AppError.not_found('灵感卡不存在: missing'),
    feedback: AppError.validation('未知反馈类型: bogus'),
    relation: AppError.validation('未知关系类型: bogus'),
  };
  const host = await setup(service({
    async createDraft() {
      throw Object.assign(new Error(expected.create.message), { appError: expected.create });
    },
    async confirm() {
      throw Object.assign(new Error(expected.confirm.message), { appError: expected.confirm });
    },
    async correct() {
      throw Object.assign(new Error(expected.correct.message), { appError: expected.correct });
    },
    async recordFeedback() {
      throw Object.assign(new Error(expected.feedback.message), { appError: expected.feedback });
    },
    async addRelation() {
      throw Object.assign(new Error(expected.relation.message), { appError: expected.relation });
    },
  }));

  const cases = [
    ['insight_create_draft', { input: DRAFT }, expected.create],
    ['insight_confirm', { insightId: 'missing' }, expected.confirm],
    ['insight_correct', { insightId: 'missing', input: {} }, expected.correct],
    ['insight_record_feedback', { insightId: 'missing', feedback: 'bogus' }, expected.feedback],
    ['insight_add_relation', { fromId: '', toId: '', relationType: 'bogus' }, expected.relation],
  ] as const;

  for (const [command, args, appError] of cases) {
    const error = await host.invoke(command, args).catch(value => value);
    expect(error).not.toBeInstanceOf(HandlerPanic);
    expect(error).toEqual(appError);
  }
});

it('insight_ipc_boundary_preserves_existing_command_error_and_details', async () => {
  const detail = { insight_id: 'missing', field: 'title' };
  const appError = AppError.with_details('Conflict', 'REVIEW_CONFLICT', detail);
  const host = await setup(service({
    async getInsight() { throw new CommandError(appError); },
  }));

  const error = await host.invoke('insight_get', { insightId: 'missing' }).catch(value => value);
  expect(error).not.toBeInstanceOf(HandlerPanic);
  expect(error).toEqual(appError);
});

it('insight_ipc_boundary_does_not_swallow_unknown_errors', async () => {
  const host = await setup(service({
    async listInsights() { throw new Error('unclassified repository failure'); },
  }));

  await expect(host.invoke('insight_list', {})).rejects.toBeInstanceOf(HandlerPanic);
});
