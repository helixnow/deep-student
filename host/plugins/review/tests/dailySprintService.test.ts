import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_CALL_COMMAND } from '../../../kernel/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { LlmRawPrompt, StandardModel2Output } from '../../llm/api.ts';
import type { QbankService } from '../../qbank/api.ts';
import type {
  CreateQuestionParams,
  Question,
  QuestionFilters,
  VfsMindMap,
  VfsReposService,
} from '../../vfs-repos/api.ts';
import type {
  DailySprintPlan,
  ExamHorizonConfig,
  ExamReadinessSnapshot,
  SprintSessionSettlement,
} from '../api.ts';
import review from '../index.ts';
import { FsrsReviewService } from '../src/review.ts';
import { DailySprintService } from '../src/dailySprintService.ts';
import { MistakeVariantGenerator } from '../src/mistakeVariantGenerator.ts';
import { ReviewPlanService } from '../src/review-plan.ts';
import type { SettleSprintSessionRequest } from '../api.ts';
import { localDateKey } from '../src/local-date.ts';
import { totalSeconds as totalStudyTimeSeconds } from '../repository/study-time.ts';
import { mistakesFixture } from './storage.ts';
import { createReviewPlanStore } from './vfs-repo-double.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  vi.restoreAllMocks();
});

function installVfsReviewAndMasterySchema(conn: SqlExecutor): void {
  for (const name of [
    'V20260130__init.sql',
    'V20260131__add_change_log.sql',
    'V20260718__add_mastery_tables.sql',
    'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql',
    'V20260909__mastery_events_insight_source.sql',
  ]) {
    conn.exec(readFileSync(join('resources/app/migrations/vfs', name), 'utf8'));
  }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS study_time_daily (
      date TEXT PRIMARY KEY,
      seconds INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function makeQuestionRow(params: {
  id: string;
  examId: string;
  content: string;
  answer: string;
  tags: string[];
  parentId?: string | null;
  sourceType?: Question['source_type'];
  sourceRef?: string | null;
}): Question {
  return {
    id: params.id,
    exam_id: params.examId,
    card_id: null,
    question_label: 'Q1',
    content: params.content,
    options: [
      { key: 'A', content: 'Option A' },
      { key: 'B', content: 'Option B' },
      { key: 'C', content: 'Option C' },
      { key: 'D', content: 'Option D' },
    ],
    answer: params.answer,
    explanation: 'Detailed step-by-step derivation.',
    structured_data: null,
    question_type: 'single_choice',
    difficulty: 'medium',
    tags: params.tags,
    status: 'review',
    user_answer: 'A',
    is_correct: false,
    attempt_count: 3,
    correct_count: 1,
    last_attempt_at: '2026-11-05T08:00:00Z',
    user_note: null,
    is_favorite: false,
    is_bookmarked: false,
    source_type: params.sourceType ?? 'imported',
    source_ref: params.sourceRef ?? null,
    images: [],
    parent_id: params.parentId ?? null,
    created_at: '2026-11-01T08:00:00Z',
    updated_at: '2026-11-05T08:00:00Z',
    ai_feedback: null,
    ai_score: null,
    ai_graded_at: null,
    group_id: null,
    group_position: null,
    group_label: null,
    materials: [],
    answer_origin: null,
    source_refs: [],
    answer_source_refs: [],
    source_key: null,
  };
}

async function mistakeSprintHarness(count: number) {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const db = fixture.storage.database('vfs');
  installVfsReviewAndMasterySchema(db);
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at)
    VALUES ('exam', 'Exam', 'completed', 'temp', '{}', '{"pages":[]}', '2026-01-01', '2026-01-01')`);
  const plans = createReviewPlanStore();
  const questions = new Map<string, Question>();
  for (let i = 0; i < count; i += 1) {
    const q = makeQuestionRow({ id: `question_${i}`, examId: 'exam', content: `Question number ${i}`, answer: 'A', tags: ['concept'] });
    questions.set(q.id, q);
    db.run('INSERT INTO questions (id, exam_id, content, tags, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
      [q.id, q.exam_id, q.content, JSON.stringify(q.tags), '2026-01-01']);
    const plan = plans.reviewPlans.createPlan(db, { question_id: q.id, exam_id: q.exam_id });
    db.run("UPDATE review_plans SET consecutive_failures = 3, next_review_date = '2020-01-01' WHERE id = ?1", [plan.id]);
  }
  const repos = { ...plans, questions: { ...plans.questions,
    getQuestion: (_db: SqlExecutor, id: string) => questions.get(id) ?? null,
    getQuestionsByIds: (_db: SqlExecutor, ids: string[]) => ids.map((id) => questions.get(id)!),
  } } as unknown as VfsReposService;
  const host = await createTestHost({ plugins: [review], provide: { storage: fixture.storage, vfsRepo: repos } });
  hosts.push(host);
  const generator = new MistakeVariantGenerator({ getVfsDb: () => null, getVfsRepos: () => null,
    getRawPrompt: () => null, getQbank: () => null });
  return { db, plans, questions, host, generator, sprint: new DailySprintService(host.ctx, generator) };
}

describe('DailySprintService & dstu.review remote integration', () => {
  it('keeps cloze offsets relative to untrimmed text and caps decoding before traversing a large mindmap', async () => {
    const { sprint, host } = await mistakeSprintHarness(0);
    const repos = host.ctx.get('vfsRepo') as VfsReposService;
    const hugeRoot = { id: 'root', text: 'Root', children: [
      { id: 'a_spaced', text: '  alpha beta  ', priority: 1, blankedRanges: [{ start: 8, end: 12 }] },
      ...Array.from({ length: 600 }, (_, i) => ({ id: `n_${i}`, text: `Concept value ${i}`, priority: 1 })),
    ] };
    Object.assign(repos, { mindmaps: {
      listMindmaps: () => [{ id: 'mm_1', resourceId: 'res_mm_1', title: 'Map' }],
      getMindmapContent: () => JSON.stringify({ root: hugeRoot }),
    } });
    const plan = await sprint.buildDailySprintPlan({ spaceId: null, sprintBudgetMinutesOverride: 120 });
    const spaced = plan.items.find((item) => item.kind === 'mindmap_cloze' && item.nodeId === 'a_spaced');
    expect(spaced?.kind === 'mindmap_cloze' && spaced.fullText).toBe('  alpha beta  ');
    expect(spaced?.kind === 'mindmap_cloze' && spaced.maskedText).toBe('  alpha ［ ？ ］  ');
    expect(plan.readinessBefore.totalActiveItems).toBe(499);
  });

  it('recomputes budget and deferrals after cached variants lengthen choice mistakes', async () => {
    const { sprint, generator } = await mistakeSprintHarness(10);
    vi.spyOn(generator, 'getCachedVariant').mockImplementation((q) => ({ ...q, id: `variant_${q.id}` }));
    const plan = await sprint.buildDailySprintPlan({ spaceId: null, sprintBudgetMinutesOverride: 5 });
    expect(plan.items).toHaveLength(6);
    expect(plan.generatedVariantsCount).toBe(6);
    expect(plan.items.reduce((sum, item) => sum + item.triage.estimatedSeconds, 0)).toBe(300);
    expect(plan.readinessBefore.estimatedSprintSeconds).toBe(300);
    expect(plan.readinessBefore.selectedSprintCount).toBe(6);
    expect(plan.readinessBefore.deferredBacklogCount).toBe(4);
    expect(plan.deferredBacklogCount).toBe(4);
  });

  it('limits failed live variant attempts and advances each root plan once even without a session receipt', async () => {
    const { sprint, generator, host, db, plans } = await mistakeSprintHarness(10);
    const generate = vi.spyOn(generator, 'resolveOrGenerateVariant').mockImplementation(async ({ originalQuestion: q }) => ({
      variantQuestionId: q.id, originalQuestionId: q.id, isVariant: false, fromCache: false,
      content: q.content, options: q.options, answer: q.answer, explanation: q.explanation,
      structuredData: null, questionType: q.question_type, fallbackReason: 'timeout',
    }));
    const plan = await sprint.buildDailySprintPlan({ spaceId: null, sprintBudgetMinutesOverride: 5, maxLiveVariants: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
    const item = plan.items[0]!;
    if (item.kind !== 'mistake_question') throw new Error('Expected mistake');
    const mastery = host.ctx.get('mastery') as import('../api.ts').MasteryService;
    const service = new ReviewPlanService(db, plans, mastery);
    service.processReview(item.planId, 4, null, 30, 'sprint:test:root');
    service.processReview(item.planId, 4, null, 30, 'sprint:test:root');
    expect(plans.reviewPlans.getPlan(db, item.planId)!.total_reviews).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM review_history')).toBe(1);
    const before = plans.reviewPlans.getPlan(db, item.planId);
    db.exec(`CREATE TRIGGER fail_sprint_receipt BEFORE INSERT ON mastery_events BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
    expect(() => service.processReview(item.planId, 4, null, 30, 'sprint:test:other')).toThrow();
    expect(plans.reviewPlans.getPlan(db, item.planId)).toEqual(before);
    expect(db.pluck<number>('SELECT COUNT(*) FROM review_history')).toBe(1);
  });

  it('executes end-to-end buildDailySprintPlan -> settleSprintSession over plugin:host|call with real mistakes + vfs DBs and raises predictedExamRetrievability', async () => {
    const fixture = mistakesFixture();
    fixtures.push(fixture);

    const mistakesDb = fixture.db;
    const vfsDb = fixture.storage.database('vfs');
    installVfsReviewAndMasterySchema(vfsDb);

    // 1. Seed due FSRS card in mistakes DB (Cloze card with concept tag)
    mistakesDb.run(
      `INSERT INTO document_tasks (
        id, document_id, original_document_name, segment_index,
        content_segment, status, anki_generation_options_json
      ) VALUES ('task_1', 'note_calc_1', 'Calculus Notes', 0, 'seg', 'Completed', ?1)`,
      [JSON.stringify({ deck_name: 'Calculus::Limits' })],
    );
    mistakesDb.run(
      `INSERT INTO anki_cards (
        id, task_id, front, back, text, template_id, source_type, source_id, tags_json
      ) VALUES (?1, 'task_1', ?2, ?3, ?2, 'cloze', 'note', 'note_calc_1', ?4)`,
      [
        'card_cloze_1',
        'If f is continuous on [a,b], {{c1::Intermediate Value Theorem}} holds.',
        'Applies to closed bounded intervals.',
        JSON.stringify(['calculus.ivt']),
      ],
    );

    const fsrsSvc = new FsrsReviewService(mistakesDb);
    const enqueued = fsrsSvc.enqueueCards(['card_cloze_1']);
    const cardStateId = enqueued.states[0]!.id;
    const nowMs = Date.now();
    // Put card into overdue review state with low stability so reviewing it strongly boosts exam retrievability
    mistakesDb.run(
      `UPDATE fsrs_card_states
       SET state = 2, stability = 1.2, difficulty = 6.0,
           elapsed_days = 5, scheduled_days = 1, reps = 2, lapses = 2,
           due_ms = ?1, last_review_ms = ?2
       WHERE id = ?3`,
      [nowMs - 4 * 86_400_000, nowMs - 5 * 86_400_000, cardStateId],
    );

    // 2. Seed due high-lapses SM-2 Mistake in vfs DB + in-memory question bank
    const basePlanStore = createReviewPlanStore();
    const questions = new Map<string, Question>();
    const rootMistake = makeQuestionRow({
      id: 'q_lhospital_1',
      examId: 'exam_calc_1',
      content: 'Evaluate lim_{x->0} (sin x)/x.',
      answer: 'B',
      tags: ['calculus.lhospital'],
    });
    questions.set(rootMistake.id, rootMistake);

    vfsDb.run(
      `INSERT INTO exam_sheets (
        id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
      ) VALUES ('exam_calc_1', 'Calculus Diagnostic', 'completed', 'tmp_calc_1', '{}', '{"pages":[]}', ?1, ?1)`,
      ['2026-11-01T08:00:00Z'],
    );
    vfsDb.run(
      `INSERT INTO questions (
        id, exam_id, content, tags, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      [
        rootMistake.id,
        rootMistake.exam_id,
        rootMistake.content,
        JSON.stringify(rootMistake.tags),
        '2026-11-01T08:00:00Z',
      ],
    );

    const seededPlan = basePlanStore.reviewPlans.createPlan(vfsDb, {
      question_id: rootMistake.id,
      exam_id: rootMistake.exam_id,
      initial_ease_factor: 2.3,
    });
    const yesterday = '2020-01-01';
    vfsDb.run(
      `UPDATE review_plans
       SET status = 'learning', interval_days = 1, repetitions = 0,
           consecutive_failures = 3, is_difficult = 1,
           next_review_date = ?1, last_review_date = ?1
       WHERE id = ?2`,
      [yesterday, seededPlan.id],
    );

    // 3. Seed MindMap with a weak Cloze node + outbound PDF anchor edge in vfs DB
    vfsDb.exec(`
      CREATE TABLE IF NOT EXISTS vfs_anchor_edges (
        edge_id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_resource_id TEXT NOT NULL,
        source_sub_id TEXT NOT NULL DEFAULT '',
        source_anchor_uri TEXT NOT NULL,
        source_label TEXT NOT NULL DEFAULT '',
        target_kind TEXT NOT NULL,
        target_resource_id TEXT NOT NULL,
        target_locator_key TEXT NOT NULL DEFAULT '',
        target_page INTEGER,
        target_start_ms INTEGER,
        target_end_ms INTEGER,
        target_rect_json TEXT,
        target_anchor_uri TEXT NOT NULL,
        study_space_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    vfsDb.run(
      `INSERT INTO vfs_anchor_edges (
        edge_id, source_kind, source_resource_id, source_sub_id, source_anchor_uri,
        source_label, target_kind, target_resource_id, target_page, target_anchor_uri,
        created_at, updated_at
      ) VALUES (
        'edge_mm_1', 'mindmap', 'mm_calc_1', 'node_rolle',
        'ds-anchor://v1/mindmap/mm_calc_1?node=node_rolle',
        'Textbook p.42', 'pdf', 'tb_stewart_1', 42,
        'ds-anchor://v1/pdf/tb_stewart_1?page=42',
        1000, 2000
      )`,
    );

    const mindmapMeta: VfsMindMap = {
      id: 'mm_calc_1',
      resourceId: 'res_mm_calc_1',
      title: 'Differential Theorems',
      isFavorite: false,
      defaultView: 'mindmap',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      contentUpdatedAt: '2026-11-01T00:00:00Z',
    };
    const mindmapJson = JSON.stringify({
      root: {
        id: 'node_root',
        text: 'Mean Value Theorems',
        children: [
          {
            id: 'node_rolle',
            text: 'Rolle Theorem requires f(a) = f(b)',
            blankedRanges: [{ start: 23, end: 34 }],
            note: 'Also continuous on [a,b] and differentiable on (a,b).',
            children: [],
          },
          {
            id: 'node_lagrange',
            text: 'Lagrange Mean Value Theorem',
            children: [],
          },
        ],
      },
    });

    let variantSeq = 1;
    const vfsRepoDouble = {
      ...basePlanStore,
      questions: {
        ...basePlanStore.questions,
        getQuestion: (_conn: SqlExecutor, id: string) => questions.get(id) ?? null,
        getQuestionsByIds: (_conn: SqlExecutor, ids: readonly string[]) =>
          ids.map((id) => questions.get(id)).filter((q): q is Question => q !== undefined),
        listQuestions: (
          _conn: SqlExecutor,
          examId: string,
          _filters: QuestionFilters,
          _page: number,
          _pageSize: number,
        ) => {
          const list = [...questions.values()].filter((q) => q.exam_id === examId);
          return { questions: list, total: list.length, page: 1, page_size: 100, has_more: false };
        },
      },
      exams: {
        getExamSheet: () => ({
          id: 'exam_calc_1',
          examName: 'Calculus Diagnostic',
          status: 'completed',
          tempId: 't1',
          metadataJson: null,
          previewJson: null,
          isFavorite: false,
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-01T00:00:00Z',
        }),
      },
      mindmaps: {
        listMindmaps: () => [mindmapMeta],
        getMindmapContent: (_conn: SqlExecutor, id: string) =>
          id === mindmapMeta.id ? mindmapJson : null,
      },
    } as unknown as VfsReposService;

    const qbankDouble = {
      getQuestion: (id: string) => questions.get(id) ?? null,
      createQuestion: (params: CreateQuestionParams) => {
        const created = makeQuestionRow({
          id: `q_ai_var_${variantSeq++}`,
          examId: params.exam_id,
          content: params.content,
          answer: params.answer ?? 'D',
          tags: params.tags ? [...params.tags] : [],
          parentId: params.parent_id ?? null,
          sourceType: params.source_type ?? 'ai_generated',
          sourceRef: params.source_ref ?? null,
        });
        created.options = params.options ?? null;
        created.explanation = params.explanation ?? null;
        questions.set(created.id, created);
        return created;
      },
    } as unknown as QbankService;

    const llmRawPromptDouble = {
      callModel2RawPromptOpts: async (): Promise<StandardModel2Output> => ({
        assistant_message: JSON.stringify({
          content: 'Evaluate lim_{t->0} (tan 2t)/(2t).',
          options: [
            { key: 'A', content: '0' },
            { key: 'B', content: '2' },
            { key: 'C', content: '1/2' },
            { key: 'D', content: '1' },
          ],
          answer: 'D',
          explanation: 'Substitute u = 2t; lim_{u->0} tan(u)/u = 1.',
        }),
        raw_response: null,
        chain_of_thought_details: null,
        cancelled: false,
      }),
    } as unknown as LlmRawPrompt;

    const host = await createTestHost({
      plugins: [review],
      provide: {
        storage: fixture.storage,
        vfsRepo: vfsRepoDouble,
        qbank: qbankDouble,
        llmRawPrompt: llmRawPromptDouble,
      },
    });
    hosts.push(host);

    let settlementArgs: unknown[] = [];
    const callReview = <T>(method: string, args: unknown[]): Promise<T> => {
      if (method === 'settleSprintSession') settlementArgs = args;
      return host.invoke(HOST_CALL_COMMAND, {
        caller: 'dstu.review',
        service: 'review',
        method,
        args,
      }) as Promise<T>;
    };

    // 4. Configure Exam Horizon (12 days from local today -> 'reinforce' phase)
    const todayDate = new Date();
    const examDateObj = new Date(
      Date.UTC(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() + 12),
    );
    const examDateStr = `${examDateObj.getUTCFullYear()}-${String(examDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(examDateObj.getUTCDate()).padStart(2, '0')}`;

    const savedConfig = await callReview<ExamHorizonConfig>('updateExamHorizonConfig', [
      {
        spaceId: 'space_calc',
        examDate: examDateStr,
        sprintBudgetMinutes: 15,
        baseTargetRetention: 0.88,
      },
    ]);
    expect(savedConfig.spaceId).toBe('space_calc');
    expect(savedConfig.examDate).toBe(examDateStr);
    expect(savedConfig.sprintBudgetMinutes).toBe(15);

    const readinessBefore = await callReview<ExamReadinessSnapshot>('getExamReadiness', [
      'space_calc',
    ]);
    expect(readinessBefore.phase).toBe('reinforce');
    expect(readinessBefore.totalActiveItems).toBe(3);
    expect(readinessBefore.predictedExamRetrievability).not.toBeNull();

    // 5. Build Daily Sprint Plan (generates AI isomorphic variant for high-lapses mistake)
    const sprintPlan = await callReview<DailySprintPlan>('buildDailySprintPlan', [
      {
        spaceId: 'space_calc',
        clientMindmapSignals: [
          {
            mindmapId: 'mm_calc_1',
            nodeId: 'node_rolle',
            attempts: 3,
            misses: 2,
            lastReviewedAtMs: nowMs - 2 * 86_400_000,
          },
        ],
        enableAiVariants: true,
        maxLiveVariants: 2,
      },
    ]);

    expect(sprintPlan.items).toHaveLength(3);
    expect(sprintPlan.generatedVariantsCount).toBe(1);

    const fsrsItem = sprintPlan.items.find((i) => i.kind === 'fsrs_card')!;
    const mistakeItem = sprintPlan.items.find((i) => i.kind === 'mistake_question')!;
    const mindmapItem = sprintPlan.items.find((i) => i.kind === 'mindmap_cloze')!;

    expect(fsrsItem.kind === 'fsrs_card' && fsrsItem.cardFormat).toBe('cloze');
    expect(fsrsItem.sourceAnchor?.kind).toBe('note');

    expect(mistakeItem.kind === 'mistake_question' && mistakeItem.isVariant).toBe(true);
    if (mistakeItem.kind === 'mistake_question') {
      expect(mistakeItem.originalQuestionId).toBe('q_lhospital_1');
      expect(mistakeItem.questionId).toBe('q_ai_var_1');
      expect(mistakeItem.variantBadgeReason).toBe('high_lapses');
      expect(mistakeItem.originalPromptPreview).toContain('sin x');
    }

    if (mindmapItem.kind === 'mindmap_cloze') {
      expect(mindmapItem.maskedText).toContain('［ ？ ］');
      expect(mindmapItem.ancestorPath).toEqual(['Mean Value Theorems']);
      expect(mindmapItem.siblingHints).toEqual(['Lagrange Mean Value Theorem']);
      // Outbound edge from vfs_anchor_edges resolved straight to cited PDF page 42!
      expect(mindmapItem.sourceAnchor.kind).toBe('pdf');
      expect(mindmapItem.sourceAnchor.page).toBe(42);
    }

    // 6. Settle Sprint Session across all 3 modalities
    const settlement = await callReview<SprintSessionSettlement>('settleSprintSession', [
      {
        planSessionId: sprintPlan.planSessionId,
        spaceId: 'space_calc',
        readinessBefore: sprintPlan.readinessBefore,
        totalElapsedSeconds: 420,
        completedItems: [
          {
            sprintItemId: fsrsItem.sprintItemId,
            kind: 'fsrs_card',
            rating: 4,
            passed: true,
            elapsedMs: 12000,
            conceptTags: fsrsItem.triage.conceptTags,
            cardStateId: fsrsItem.kind === 'fsrs_card' ? fsrsItem.cardStateId : null,
            ankiCardId: fsrsItem.kind === 'fsrs_card' ? fsrsItem.ankiCardId : null,
            planId: null,
            questionId: null,
            originalQuestionId: null,
            isVariant: false,
            mindmapId: null,
            nodeId: null,
            alreadyCommittedInline: false,
          },
          {
            sprintItemId: mistakeItem.sprintItemId,
            kind: 'mistake_question',
            rating: 3,
            passed: true,
            elapsedMs: 35000,
            conceptTags: mistakeItem.triage.conceptTags,
            cardStateId: null,
            ankiCardId: null,
            planId: mistakeItem.kind === 'mistake_question' ? mistakeItem.planId : null,
            questionId: mistakeItem.kind === 'mistake_question' ? mistakeItem.questionId : null,
            originalQuestionId:
              mistakeItem.kind === 'mistake_question' ? mistakeItem.originalQuestionId : null,
            isVariant: true,
            mindmapId: null,
            nodeId: null,
            alreadyCommittedInline: false,
          },
          {
            sprintItemId: mindmapItem.sprintItemId,
            kind: 'mindmap_cloze',
            rating: 4,
            passed: true,
            elapsedMs: 18000,
            conceptTags: mindmapItem.triage.conceptTags,
            cardStateId: null,
            ankiCardId: null,
            planId: null,
            questionId: null,
            originalQuestionId: null,
            isVariant: false,
            mindmapId: mindmapItem.kind === 'mindmap_cloze' ? mindmapItem.mindmapId : null,
            nodeId: mindmapItem.kind === 'mindmap_cloze' ? mindmapItem.nodeId : null,
            alreadyCommittedInline: false,
          },
        ],
        clientMindmapSignalsAfter: [
          {
            mindmapId: 'mm_calc_1',
            nodeId: 'node_rolle',
            attempts: 4,
            misses: 2,
            lastReviewedAtMs: Date.now(),
          },
        ],
      },
    ]);

    // Verify FSRS card state updated
    const updatedCardState = fsrsSvc.getCardState(cardStateId);
    expect(updatedCardState).not.toBeNull();
    expect(updatedCardState!.reps).toBe(3);
    expect(updatedCardState!.stability).toBeGreaterThan(1.2);

    // Verify SM-2 root mistake ReviewPlan advanced despite answering AI variant
    const updatedPlan = basePlanStore.reviewPlans.getPlan(vfsDb, seededPlan.id);
    expect(updatedPlan).not.toBeNull();
    expect(updatedPlan!.repetitions).toBe(1);
    expect(updatedPlan!.consecutive_failures).toBe(0);
    expect(updatedPlan!.total_reviews).toBe(1);
    expect(updatedPlan!.total_correct).toBe(1);

    // Verify mastery_events written across all 3 sources: 'fsrs', 'qbank', and 'insight'
    const masterySources = vfsDb
      .all<{ source: string }>(
        'SELECT DISTINCT source FROM mastery_events WHERE deleted_at IS NULL ORDER BY source',
      )
      .map((r) => r.source);
    expect(masterySources).toEqual(['fsrs', 'insight', 'qbank']);
    expect(settlement.masteryEventsWritten).toBeGreaterThanOrEqual(3);
    expect(settlement.conceptDeltas.length).toBeGreaterThanOrEqual(3);

    // Verify study_time recorded
    const todayKey = localDateKey();
    expect(settlement.studyTimeRecordedSeconds).toBe(420);
    expect(totalStudyTimeSeconds(vfsDb, todayKey, todayKey)).toBe(420);

    // Verify settlement summary & strictly improved Exam Readiness
    expect(settlement.totalCompleted).toBe(3);
    expect(settlement.passedCount).toBe(3);
    expect(settlement.againCount).toBe(0);
    expect(settlement.byKind).toEqual({
      fsrsCards: 1,
      mistakes: 1,
      variantsSolved: 1,
      mindmapNodes: 1,
    });
    expect(settlement.readinessAfter.predictedExamRetrievability).not.toBeNull();
    expect(settlement.readinessBefore.predictedExamRetrievability).not.toBeNull();
    expect(settlement.readinessAfter.predictedExamRetrievability!).toBeGreaterThan(
      settlement.readinessBefore.predictedExamRetrievability!,
    );
    expect(settlement.readinessDeltaPctPoints).toBeGreaterThan(0);

    // Duplicate transport delivery and a fresh service instance must not repeat any write.
    const logCount = mistakesDb.pluck<number>('SELECT COUNT(*) FROM fsrs_review_logs');
    const eventCount = vfsDb.pluck<number>('SELECT COUNT(*) FROM mastery_events');
    expect(await callReview('settleSprintSession', settlementArgs)).toEqual(settlement);
    expect(new DailySprintService(host.ctx).settleSprintSession(settlementArgs[0] as SettleSprintSessionRequest)).toEqual(settlement);
    expect(fsrsSvc.getCardState(cardStateId)!.reps).toBe(3);
    expect(basePlanStore.reviewPlans.getPlan(vfsDb, seededPlan.id)!.total_reviews).toBe(1);
    expect(mistakesDb.pluck<number>('SELECT COUNT(*) FROM fsrs_review_logs')).toBe(logCount);
    expect(vfsDb.pluck<number>('SELECT COUNT(*) FROM mastery_events')).toBe(eventCount);
    expect(totalStudyTimeSeconds(vfsDb, todayKey, todayKey)).toBe(420);
  });

  it('syncs defaults from vfs_study_space_profiles, handles D-Day / post-exam / unscheduled configs, and skips image questions in generateMistakeVariant', async () => {
    const fixture = mistakesFixture();
    fixtures.push(fixture);
    const vfsDb = fixture.storage.database('vfs');
    installVfsReviewAndMasterySchema(vfsDb);

    vfsDb.exec(`
      CREATE TABLE IF NOT EXISTS vfs_study_space_profiles (
        space_id TEXT PRIMARY KEY,
        root_folder_id TEXT NOT NULL,
        exam_date TEXT,
        daily_budget_minutes INTEGER NOT NULL DEFAULT 45,
        target_retention REAL NOT NULL DEFAULT 0.90,
        default_deck_id TEXT,
        deleted_at TEXT
      );
    `);

    const todayStr = localDateKey();
    vfsDb.run(
      `INSERT INTO vfs_study_space_profiles (
        space_id, root_folder_id, exam_date, daily_budget_minutes, target_retention, default_deck_id
      ) VALUES ('space_dday', 'fld_dday', ?1, 20, 0.91, 'Physics')`,
      [todayStr],
    );

    const imgQuestion = makeQuestionRow({
      id: 'q_geom_img',
      examId: 'exam_geom',
      content: 'Find angle alpha in the attached triangle.',
      answer: 'A',
      tags: ['geometry.triangle'],
    });
    imgQuestion.images = [{ id: 'img_tri', name: 'tri.png', mime: 'image/png', hash: 'h1' }];

    const host = await createTestHost({
      plugins: [review],
      provide: {
        storage: fixture.storage,
        qbank: {
          getQuestion: (id: string) => (id === imgQuestion.id ? imgQuestion : null),
          createQuestion: () => {
            throw new Error('must not be called for image question');
          },
        } as unknown as QbankService,
      },
    });
    hosts.push(host);

    const callReview = <T>(method: string, args: unknown[]): Promise<T> =>
      host.invoke(HOST_CALL_COMMAND, {
        caller: 'dstu.review',
        service: 'review',
        method,
        args,
      }) as Promise<T>;

    // 1. Syncs D-Day config from vfs_study_space_profiles
    const ddayCfg = await callReview<ExamHorizonConfig>('getExamHorizonConfig', ['space_dday']);
    expect(ddayCfg.rootFolderId).toBe('fld_dday');
    expect(ddayCfg.examDate).toBe(todayStr);
    expect(ddayCfg.sprintBudgetMinutes).toBe(20);
    expect(ddayCfg.baseTargetRetention).toBe(0.91);
    expect(ddayCfg.defaultDeckId).toBe('Physics');

    const ddayReadiness = await callReview<ExamReadinessSnapshot>('getExamReadiness', [
      'space_dday',
    ]);
    expect(ddayReadiness.daysUntilExam).toBe(0);
    expect(ddayReadiness.phase).toBe('sprint');
    expect(ddayReadiness.effectiveTargetRetention).toBe(0.94);
    expect(ddayReadiness.newIntakeFrozen).toBe(true);
    expect(ddayReadiness.predictedExamRetrievability).toBeNull();
    const cleared = await callReview<ExamHorizonConfig>('updateExamHorizonConfig', [
      { spaceId: 'space_dday', defaultDeckId: null, rootFolderId: null },
    ]);
    expect(cleared.defaultDeckId).toBeNull();
    expect(cleared.rootFolderId).toBeNull();

    // 2. Post-exam maintenance (D < 0) and Unscheduled (examDate = null)
    await callReview('updateExamHorizonConfig', [
      { spaceId: 'space_past', examDate: '2020-05-01', sprintBudgetMinutes: 12 },
    ]);
    const pastReadiness = await callReview<ExamReadinessSnapshot>('getExamReadiness', [
      'space_past',
    ]);
    expect(pastReadiness.phase).toBe('maintenance');
    expect(pastReadiness.daysUntilExam).toBeLessThan(0);
    expect(pastReadiness.effectiveTargetRetention).toBe(0.88);
    expect(pastReadiness.newIntakeFrozen).toBe(false);

    const unscheduledReadiness = await callReview<ExamReadinessSnapshot>('getExamReadiness', [
      null,
    ]);
    expect(unscheduledReadiness.phase).toBe('unscheduled');
    expect(unscheduledReadiness.daysUntilExam).toBeNull();

    // 3. generateMistakeVariant skips image-dependent questions cleanly
    const variantRes = await callReview<{
      isVariant: boolean;
      variantQuestionId: string;
      fallbackReason: string | null;
    }>('generateMistakeVariant', [{ questionId: 'q_geom_img', forceRegenerate: true }]);
    expect(variantRes.isVariant).toBe(false);
    expect(variantRes.variantQuestionId).toBe('q_geom_img');
    expect(variantRes.fallbackReason).toBe('image_question_unsupported');
  });
});
