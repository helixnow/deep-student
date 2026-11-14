import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import review from '../index.ts';
import type { ReviewPlanPort } from '../api.ts';
import { ReviewPlanService } from '../src/review-plan.ts';
import { createReviewPlanStore } from './vfs-repo-double.ts';

interface Fixture {
  storage: ReturnType<typeof createStorageService>;
  db: ReturnType<ReturnType<typeof createStorageService>['database']>;
  dispose(): void;
}

const fixtures: Fixture[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

function vfsFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'review-plan-tests-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  const dir = 'resources/app/migrations/vfs';
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  const fixture: Fixture = {
    storage, db,
    dispose() { storage.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function insertExam(db: Fixture['db'], id: string, name: string): void {
  db.run(`INSERT INTO exam_sheets (
    id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
  ) VALUES (?1, ?2, 'completed', ?3, '{}', '{"pages":[]}', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`,
  [id, name, `tmp_${id}`]);
}

function insertQuestion(
  db: Fixture['db'], id: string, examId: string, tags: string[] | null,
): void {
  db.run(`INSERT INTO questions (
    id, exam_id, content, tags, created_at, updated_at
  ) VALUES (?1, ?2, '2 + 2 = ?', ?3, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`,
  [id, examId, tags === null ? null : JSON.stringify(tags)]);
}

it('test_create_review_plan_rejects_exam_question_mismatch', async () => {
  const fixture = vfsFixture();
  const db = fixture.db;
  insertExam(db, 'exam_a', 'Exam A');
  insertExam(db, 'exam_b', 'Exam B');
  insertQuestion(db, 'q_1', 'exam_a', null);
  const host = await createTestHost({
    plugins: [review],
    provide: { storage: fixture.storage, vfsRepo: createReviewPlanStore() },
  });
  hosts.push(host);
  const service = new ReviewPlanService(db, createReviewPlanStore());
  let message = '';
  try {
    service.createReviewPlan('q_1', 'exam_b');
    throw new Error('expected mismatch rejection');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('belongs to exam_id');
});

it('RF-W03-review-plan-batch-skip-by-input-text: only an existing plan counts as skipped, never caller text that spells AlreadyExists', () => {
  const fixture = vfsFixture();
  insertExam(fixture.db, 'exam_rf', 'Exam');
  insertQuestion(fixture.db, 'q_rf_planned', 'exam_rf', null);
  insertQuestion(fixture.db, 'q_rf_open', 'exam_rf', null);
  const service = new ReviewPlanService(fixture.db, createReviewPlanStore());
  service.createReviewPlan('q_rf_planned', 'exam_rf');
  const result = service.batchCreateFromQuestions(['q_rf_planned', 'already exists', 'q_AlreadyExists'], 'exam_rf');
  expect([result.created, result.skipped, result.failed]).toEqual([0, 1, 2]);
  const mismatch = service.batchCreateFromQuestions(['q_rf_open'], 'AlreadyExists');
  expect([mismatch.created, mismatch.skipped, mismatch.failed]).toEqual([0, 0, 1]);
});

it('review_writes_mastery_once_and_practice_advance_does_not_double_count', async () => {
  const fixture = vfsFixture();
  insertExam(fixture.db, 'exam_mastery', 'Exam');
  insertQuestion(fixture.db, 'q_mastery', 'exam_mastery', ['导数']);
  const host = await createTestHost({
    plugins: [review],
    provide: { storage: fixture.storage, vfsRepo: createReviewPlanStore() },
  });
  hosts.push(host);
  const service = new ReviewPlanService(fixture.db, createReviewPlanStore(), host.ctx.mastery);
  const plan = service.getOrCreatePlan('q_mastery', 'exam_mastery');
  const countEvents = (): number => Number(fixture.db.pluck(
    'SELECT COUNT(*) FROM mastery_events WHERE deleted_at IS NULL',
  ));
  expect(countEvents()).toBe(0);
  service.processReview(plan.id, 4, null, null);
  expect(countEvents()).toBe(1);
  const before = service.getPlanByQuestion('q_mastery')!;
  service.advanceFromPractice(plan.id);
  const after = service.getPlanByQuestion('q_mastery')!;
  expect(countEvents()).toBe(1);
  expect(after.total_reviews).toBe(before.total_reviews + 1);
});

it('review_plan_commands_round_trip_through_host', async () => {
  const fixture = vfsFixture();
  insertExam(fixture.db, 'exam_cmd', 'Exam');
  insertQuestion(fixture.db, 'q_cmd', 'exam_cmd', ['函数']);
  const host = await createTestHost({
    plugins: [review],
    provide: { storage: fixture.storage, vfsRepo: createReviewPlanStore() },
  });
  hosts.push(host);
  const created = await host.invoke<{ id: string; status: string; question_id: string }>(
    'review_plan_create', { questionId: 'q_cmd', examId: 'exam_cmd' },
  );
  expect(created.question_id).toBe('q_cmd');
  expect(created.status).toBe('new');
  const dueBefore = await host.invoke<{ total: number; plans: unknown[] }>(
    'review_plan_get_due', { examId: 'exam_cmd' },
  );
  expect(dueBefore.total).toBe(1);
  expect(dueBefore.plans).toHaveLength(1);
  const processed = await host.invoke<{ passed: boolean; new_interval: number }>(
    'review_plan_process', { planId: created.id, quality: 5 },
  );
  expect(processed.passed).toBe(true);
  expect(processed.new_interval).toBe(1);
  const got = await host.invoke<{ total_reviews: number }>('review_plan_get', { planId: created.id });
  expect(got.total_reviews).toBe(1);
  const dueAfter = await host.invoke<{ total: number; plans: unknown[] }>(
    'review_plan_get_due', { examId: 'exam_cmd' },
  );
  expect(dueAfter.total).toBe(0);
  expect(dueAfter.plans).toHaveLength(0);
  await host.invoke('review_plan_delete', { planId: created.id });
  expect(await host.invoke('review_plan_get', { planId: created.id })).toBeNull();
});

it('review_plan_command_surface_preserves_string_errors_and_stats', async () => {
  const fixture = vfsFixture();
  insertExam(fixture.db, 'exam_surface', 'Exam');
  insertQuestion(fixture.db, 'q_surface_1', 'exam_surface', ['函数']);
  insertQuestion(fixture.db, 'q_surface_2', 'exam_surface', []);
  const host = await createTestHost({
    plugins: [review],
    provide: { storage: fixture.storage, vfsRepo: createReviewPlanStore() },
  });
  hosts.push(host);

  const batch = await host.invoke<{ created: number; skipped: number; failed: number; plans: Array<{ id: string; question_id: string }> }>(
    'review_plan_create_for_exam', { examId: 'exam_surface' },
  );
  expect([batch.created, batch.skipped, batch.failed]).toEqual([2, 0, 0]);
  expect(batch.plans).toHaveLength(2);
  const repeated = await host.invoke<{ created: number; skipped: number }>(
    'review_plan_batch_create', { questionIds: ['q_surface_1', 'q_surface_2'], examId: 'exam_surface' },
  );
  expect([repeated.created, repeated.skipped]).toEqual([0, 2]);

  const byQuestion = await host.invoke<{ id: string; question_id: string }>(
    'review_plan_get_by_question', { questionId: 'q_surface_1' },
  );
  const orCreate = await host.invoke<{ id: string }>(
    'review_plan_get_or_create', { questionId: 'q_surface_1', examId: 'exam_surface' },
  );
  expect(orCreate.id).toBe(byQuestion.id);

  try {
    await host.invoke('review_plan_create', { questionId: 'q_surface_1', examId: 'exam_surface' });
    throw new Error('expected duplicate rejection');
  } catch (error) {
    expect(error).toBe('Failed to create review plan for question_id=q_surface_1');
  }

  try {
    await host.invoke('review_plan_process', { planId: byQuestion.id, quality: 6 });
    throw new Error('expected quality rejection');
  } catch (error) {
    expect(error).toBe('Quality must be between 0 and 5');
  }

  const processed = await host.invoke<{ plan: { id: string; repetitions: number }; passed: boolean }>(
    'review_plan_process', { planId: byQuestion.id, quality: 4, userAnswer: '答案', timeSpentSeconds: 12 },
  );
  expect(processed.passed).toBe(true);
  expect(processed.plan.repetitions).toBe(1);

  const history = await host.invoke<Array<{ plan_id: string; quality: number; user_answer: string | null }>>(
    'review_plan_get_history', { planId: byQuestion.id },
  );
  expect(history).toHaveLength(1);
  expect(history[0]!.plan_id).toBe(byQuestion.id);
  expect(history[0]!.quality).toBe(4);
  expect(history[0]!.user_answer).toBe('答案');

  const stats = await host.invoke<{ total_plans: number; new_count: number; learning_count: number; total_reviews: number }>(
    'review_plan_get_stats', { examId: 'exam_surface' },
  );
  expect(stats.total_plans).toBe(2);
  expect(stats.total_reviews).toBe(1);
  expect(stats.new_count).toBe(1);
  expect(stats.learning_count).toBe(1);
  const refreshed = await host.invoke<{ total_plans: number }>(
    'review_plan_refresh_stats', { examId: 'exam_surface' },
  );
  expect(refreshed.total_plans).toBe(2);
  const cached = fixture.db.get<{ total_plans: number }>(
    'SELECT total_plans FROM review_stats WHERE exam_id = ?1', ['exam_surface'],
  );
  expect(cached!.total_plans).toBe(2);

  const listed = await host.invoke<{ total: number; plans: unknown[] }>(
    'review_plan_list_by_exam', { examId: 'exam_surface' },
  );
  expect(listed.total).toBe(2);
  expect(listed.plans).toHaveLength(2);

  const calendar = await host.invoke<Array<{ date: string; count: number; passed: number }>>(
    'review_plan_get_calendar_data', { examId: 'exam_surface' },
  );
  expect(calendar).toHaveLength(1);
  expect(calendar[0]!.count).toBe(1);
  expect(calendar[0]!.passed).toBe(1);

  const suspended = await host.invoke<{ status: string }>(
    'review_plan_suspend', { planId: byQuestion.id },
  );
  expect(suspended.status).toBe('suspended');
  const filtered = await host.invoke<{ total: number }>(
    'review_plan_get_due_with_filter', { filter: { exam_id: 'exam_surface', limit: 10 } },
  );
  expect(filtered.total).toBe(1);
  const resumed = await host.invoke<{ status: string; next_review_date: string }>(
    'review_plan_resume', { planId: byQuestion.id },
  );
  expect(resumed.status).toBe('learning');
  expect(resumed.next_review_date).toBe(fixture.db.pluck(
    "SELECT DATE('now', 'localtime')",
  ));

  try {
    await host.invoke('review_plan_delete', { planId: 'rp_missing' });
    throw new Error('expected delete rejection');
  } catch (error) {
    expect(error).toBe('Failed to delete review plan: rp_missing');
  }
});

it('l14_review_plan_port_resolves_published_service_and_advances_plan', async () => {
  const fixture = vfsFixture();
  insertExam(fixture.db, 'exam_l14_port', 'Exam L14');
  insertQuestion(fixture.db, 'q_l14_port', 'exam_l14_port', ['导数']);
  const host = await createTestHost({
    plugins: [review],
    provide: { storage: fixture.storage, vfsRepo: createReviewPlanStore() },
  });
  hosts.push(host);

  // 与 L14 `gradingHostOf` 的取值方式一致；服务必须由 review 插件真实提供。
  // 不对 Cordis 服务对象本身做 matcher 断言：服务代理会拦截非接口属性访问。
  const port = host.ctx.get('reviewPlan') as ReviewPlanPort | undefined;
  if (port === undefined) throw new Error('reviewPlan service is not published');

  const plan = port.getOrCreatePlan('q_l14_port', 'exam_l14_port');
  expect(port.getPlanByQuestion('q_l14_port')?.id).toBe(plan.id);
  const advanced = port.advanceFromPractice(plan.id);
  expect(advanced.plan.total_reviews).toBe(1);
  expect(advanced.passed).toBe(true);
  expect(advanced.plan.next_review_date).not.toBe(plan.next_review_date);
});
