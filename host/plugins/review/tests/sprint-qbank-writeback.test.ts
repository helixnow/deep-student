import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbankPlugin from '../../qbank/index.ts';
import type { QbankService } from '../../qbank/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import vfsReposPlugin from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { MasteryService, SettleSprintSessionRequest } from '../api.ts';
import review from '../index.ts';
import { DailySprintService } from '../src/dailySprintService.ts';
import { ReviewPlanService } from '../src/review-plan.ts';

describe('Sprint writeback with real QBank and VFS repositories', () => {
  it('updates question counters, submissions and root SM-2 exactly once without double mastery', async () => {
    const base = mkdtempSync(join(tmpdir(), 'review-sprint-qbank-'));
    const storage = createStorageService({ baseDir: base, dataLocalDir: base });
    const migration = await storage.migrations.runAll();
    expect(migration.success, String(migration.error)).toBe(true);
    const host = await createTestHost({ plugins: [vfsReposPlugin, review, qbankPlugin], provide: {
      storage, paths: createPaths({ dataDir: base, platform: 'linux', env: { DEVICE_ID: 'sprint-test' } }),
    } });
    try {
      const db = storage.database('vfs');
      db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
        VALUES ('exam_sprint', 'Sprint', 'completed', 'temp_sprint', '{}', '{}', '2026-01-01', '2026-01-01')`);
      const qbank = host.ctx.get('qbank') as QbankService;
      const question = qbank.createQuestion({ exam_id: 'exam_sprint', content: 'Recall the theorem.',
        answer: 'The theorem', question_type: 'short_answer', tags: ['sprint.concept'] });
      const mastery = host.ctx.get('mastery') as MasteryService;
      const repos = host.ctx.get('vfsRepo') as VfsReposService;
      const reviewPlan = new ReviewPlanService(db, repos, mastery).createReviewPlan(question.id, question.exam_id);
      const sprint = new DailySprintService(host.ctx);
      const plan = await sprint.buildDailySprintPlan({ spaceId: null, enableAiVariants: false });
      const item = plan.items.find((entry) => entry.kind === 'mistake_question');
      if (item?.kind !== 'mistake_question') throw new Error('Expected due mistake');
      const record = { sprintItemId: item.sprintItemId, kind: item.kind, rating: 3 as const, passed: true,
        elapsedMs: 32000, conceptTags: item.triage.conceptTags, cardStateId: null, ankiCardId: null,
        planId: item.planId, questionId: item.questionId, originalQuestionId: item.originalQuestionId,
        isVariant: false, mindmapId: null, nodeId: null, alreadyCommittedInline: false };
      const request: SettleSprintSessionRequest = { planSessionId: plan.planSessionId, spaceId: null,
        readinessBefore: plan.readinessBefore, totalElapsedSeconds: 32, completedItems: [record, record] };
      const settled = sprint.settleSprintSession(request);
      expect(settled.totalCompleted).toBe(1);
      expect(qbank.getQuestion(question.id)?.attempt_count).toBe(1);
      expect(qbank.getQuestion(question.id)?.correct_count).toBe(1);
      expect(repos.reviewPlans.getPlan(db, reviewPlan.id)?.total_reviews).toBe(1);
      expect(db.pluck<number>('SELECT COUNT(*) FROM answer_submissions WHERE question_id = ?1', [question.id])).toBe(1);
      expect(mastery.getState('sprint.concept')?.total).toBe(1);
      expect(new DailySprintService(host.ctx).settleSprintSession(request)).toEqual(settled);
      expect(qbank.getQuestion(question.id)?.attempt_count).toBe(1);
      expect(repos.reviewPlans.getPlan(db, reviewPlan.id)?.total_reviews).toBe(1);
      expect(db.pluck<number>('SELECT SUM(seconds) FROM study_time_daily')).toBe(32);
    } finally {
      await host.dispose();
      storage.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
