/** WP-165: registered grading + real L11/F3, with SQLite (not repository doubles) failing writes. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { streamingHost } from '../../../e2e/streaming/__fixtures__/host.ts';
import { providerScripts, startLlmService } from '../../../e2e/streaming/wave0/llm-service.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import review from '../../review/index.ts';
import qbank from '../index.ts';
import type { Question, QbankGradingResponse, SubmitAnswerResult } from '../api.ts';
import { AppErrorThrow, persistGradingResult } from '../src/grading-service.ts';
import type { QuestionServiceHost } from '../src/question-service.ts';

const scripts = providerScripts(JSON.parse(readFileSync(new URL(
  '../equivalence/pending-provider/ai-grading-scripted.provider.json', import.meta.url), 'utf8')));
const scriptId = 'qbank.ai_grade.scripted.correct_verdict';
const feedback = '答案要点正确。<verdict>correct</verdict><score value="92"/>';
const oldTime = '2000-01-01T00:00:00+00:00';

async function fixture() {
  const provider = await startLlmService({ extraScripts: scripts });
  const f = await streamingHost('answer', { realProviders: true });
  const { host } = f;
  const db = host.ctx.storage.database('vfs');
  const records: unknown[] = [];
  await host.install(review, qbank);
  const exam = await host.invoke<{ id: string }>('dstu_create', { path: '/', options: {
    type: 'exam', name: 'WP-165', metadata: { status: 'empty', pageCount: 0, questionCount: 0 },
  } });
  await host.invoke('save_api_configurations', { configs: [{
    id: 'wp165', name: 'WP165', apiKey: 'sk-local', baseUrl: provider.baseUrl(scriptId),
    model: 'wp165-model', isMultimodal: false, isReasoning: false, isEmbedding: false,
    isReranker: false, enabled: true, modelAdapter: 'general', maxOutputTokens: 1024, temperature: 0,
  }] });
  const questionHost: QuestionServiceHost = {
    db, questions: host.ctx.vfsRepo.questions, mastery: () => host.ctx.mastery,
  };
  return {
    host, db, provider, questionHost, records,
    async seed(explanation: string | null = null) {
      const question = await host.invoke<Question>('qbank_create_question', { params: {
        exam_id: exam.id, content: '简述光合作用的能量转化。', question_type: 'short_answer',
        answer: '光能转化为化学能。', explanation, tags: ['生物'], difficulty: 'easy',
      } });
      const submission = await host.invoke<SubmitAnswerResult>('qbank_submit_answer', { request: {
        question_id: question.id, user_answer: '光能变成化学能',
      } });
      db.run(`UPDATE questions SET ai_score=37, ai_feedback='old feedback', ai_graded_at=?1,
        updated_at=?1, sync_status='synced', content_hash='stale' WHERE id=?2`, [oldTime, question.id]);
      return { question, submissionId: submission.submission_id! };
    },
    invoke(question: Question, submissionId: string | null, mode: 'grade' | 'analyze', streamId: string) {
      return host.invoke<QbankGradingResponse>('qbank_ai_grade', { request: {
        question_id: question.id, submission_id: submissionId, stream_session_id: streamId,
        mode, model_config_id: 'wp165',
      } });
    },
    async dispose() {
      const dir = mkdtempSync('/tmp/opencode/qbank-wp165-');
      writeFileSync(`${dir}/raw.json`, JSON.stringify({ records, requests: provider.requests, events: host.events }, null, 2));
      console.log(`WP-165 raw: ${dir}/raw.json`);
      await f.dispose();
      await provider.stop();
    },
  };
}

function state(conn: SqlExecutor, id: string) {
  return {
    question: conn.one('SELECT * FROM questions WHERE id=?1', [id]),
    submissions: conn.all('SELECT * FROM answer_submissions WHERE question_id=?1 ORDER BY id', [id]),
    stats: conn.all('SELECT * FROM question_bank_stats ORDER BY exam_id'),
    mastery: conn.all('SELECT * FROM mastery_events ORDER BY id'),
    history: conn.all("SELECT * FROM question_history WHERE question_id=?1 AND field_name!='ai_grading_draft' ORDER BY id", [id]),
  };
}

// TEMP objects belong to the caller's connection. Their rows also roll back with the real transaction.
function traceWrites(conn: SqlExecutor) {
  conn.exec(`CREATE TEMP TABLE wp165_trace(stage TEXT, feedback TEXT, score INTEGER,
    graded_at TEXT, updated_at TEXT, sync_status TEXT, hash TEXT)`);
  for (const [stage, column] of [['ai', 'ai_feedback'], ['mark', 'sync_status'], ['hash', 'content_hash']]) {
    conn.exec(`CREATE TEMP TRIGGER wp165_trace_${stage} AFTER UPDATE OF ${column} ON questions
      BEGIN INSERT INTO wp165_trace VALUES ('${stage}', NEW.ai_feedback, NEW.ai_score,
        NEW.ai_graded_at, NEW.updated_at, NEW.sync_status, NEW.content_hash); END`);
  }
}

it.each(['grade', 'analyze'] as const)('registered %s writes through the owner in AI → mark → hash order', async mode => {
  const f = await fixture();
  try {
    const { question, submissionId } = await f.seed();
    // This raw Value distinguishes the real WP-178 hash reader from the removed JSON.parse copy.
    const structured = '{"b":1,"10":9007199254740993,"2":1.50,"b":4,"exp":1e400}';
    f.db.run('UPDATE questions SET structured_data=?1 WHERE id=?2', [structured, question.id]);
    const ownerHash = f.questionHost.questions.updateContentHash(f.db, question.id);
    f.db.run("UPDATE questions SET content_hash='stale',sync_status='synced' WHERE id=?1", [question.id]);
    const before = state(f.db, question.id);
    traceWrites(f.db);
    const streamId = `wp165-success-${mode}`;
    const response = await f.invoke(question, submissionId, mode, streamId);
    const after = state(f.db, question.id);
    const trace = f.db.all<{ stage: string; graded_at: string; updated_at: string }>('SELECT * FROM wp165_trace ORDER BY rowid');
    f.records.push({ mode, before, response, after, trace, ownerHash });
    expect(trace.map(row => row.stage)).toEqual(['ai', 'mark', 'hash']);
    expect(trace[0]).toMatchObject({ feedback, score: mode === 'grade' ? 92 : 37, sync_status: 'synced', hash: 'stale' });
    expect(trace[0]!.graded_at).not.toBe(oldTime);
    expect(trace[0]!.updated_at).toBe(trace[0]!.graded_at);
    expect(trace[1]).toMatchObject({ sync_status: 'modified', hash: 'stale' });
    expect(trace[2]).toMatchObject({ sync_status: 'modified', hash: ownerHash });
    expect(after.question).toMatchObject({ ai_feedback: feedback, ai_score: mode === 'grade' ? 92 : 37,
      ai_graded_at: trace[0]!.graded_at, explanation: null, content_hash: ownerHash, structured_data: structured });
    expect(response).toMatchObject({ feedback, explanation_written: false, verdict: mode === 'grade' ? 'correct' : null,
      score: mode === 'grade' ? 92 : null, diagnostics: { status: 'completed', max_output_tokens: 1024 } });
    if (mode === 'grade') {
      expect(after.submissions[0]).toMatchObject({ is_correct: 1, grading_method: 'ai' });
      expect(after.question).toMatchObject({ correct_count: 1, attempt_count: before.question.attempt_count });
      expect(after.mastery).toHaveLength(before.mastery.length + 1);
      expect(after.stats[0]).toMatchObject({ total_correct: 1 });
    } else {
      expect(after.submissions).toEqual(before.submissions);
      expect(after.mastery).toEqual(before.mastery);
      expect(after.stats).toEqual(before.stats);
      expect(after.question).toMatchObject({ correct_count: before.question.correct_count, attempt_count: before.question.attempt_count });
    }
    expect(f.host.eventsNamed(`qbank_grading_stream_${streamId}`).at(-1)).toMatchObject({ type: 'complete', feedback });
    expect(f.provider.requests).toHaveLength(1);
    expect(f.provider.requests[0]).toMatchObject({ scriptId, stream: true, body: { max_tokens: 1024 } });
  } finally { await f.dispose(); }
}, 60_000);

it.each([null, ' \t\r\n ', 'teacher explanation'])(
  'standalone Analyze preserves fillEmptyExplanation semantics: %j', async explanation => {
    const f = await fixture();
    try {
      const { question } = await f.seed(explanation);
      const before = state(f.db, question.id);
      const response = await f.invoke(question, null, 'analyze', 'wp165-fill');
      const after = state(f.db, question.id);
      f.records.push({ explanation, before, response, after });
      const written = explanation !== 'teacher explanation';
      expect(response).toMatchObject({ explanation_written: written, submission_id: null, verdict: null, score: null });
      expect(after.question).toMatchObject({ explanation: written ? feedback : explanation, ai_feedback: feedback, ai_score: 37 });
      expect(after.history.filter(row => row.field_name === 'explanation')).toHaveLength(written ? 1 : 0);
      if (written) expect(after.history.find(row => row.field_name === 'explanation')).toMatchObject({
        old_value: null, new_value: feedback, operator: 'ai', reason: 'AI 解析填充空解析',
      });
      expect(after.submissions).toEqual(before.submissions);
      expect(after.stats).toEqual(before.stats);
      expect(after.mastery).toEqual(before.mastery);
    } finally { await f.dispose(); }
  }, 60_000);

it.each([
  ['grade', 'ai_feedback', '', '保存 AI 反馈失败: wp165 ai_feedback rejected'],
  ['analyze', 'ai_feedback', '', '保存 AI 反馈失败: wp165 ai_feedback rejected'],
  ['analyze', 'sync_status', 'ai', '标记同步状态失败: Database error: wp165 sync_status rejected'],
  ['analyze', 'content_hash', 'ai,mark', '更新内容哈希失败: Database error: wp165 content_hash rejected'],
] as const)('registered %s / %s failure preserves exact prefix, order, rollback and draft', async (mode, column, prior, message) => {
  const f = await fixture();
  try {
    const { question, submissionId } = await f.seed();
    const before = state(f.db, question.id);
    traceWrites(f.db);
    f.db.exec(`CREATE TEMP TRIGGER wp165_reject BEFORE UPDATE OF ${column} ON questions
      BEGIN SELECT CASE WHEN COALESCE((SELECT group_concat(stage, ',') FROM wp165_trace), '')='${prior}'
        THEN RAISE(ABORT, 'wp165 ${column} rejected') ELSE RAISE(ABORT, 'wp165 wrong write order') END; END`);
    const streamId = `wp165-${mode}-${column}`;
    const outcome = await f.invoke(question, submissionId, mode, streamId).then(
      value => ({ ok: true, value }), error => ({ ok: false, error }));
    const after = state(f.db, question.id);
    const events = f.host.eventsNamed(`qbank_grading_stream_${streamId}`);
    const drafts = f.db.all<{ new_value: string }>(
      "SELECT new_value FROM question_history WHERE question_id=?1 AND field_name='ai_grading_draft'", [question.id]);
    f.records.push({ mode, column, before, outcome, after, events, drafts });
    expect(outcome).toEqual({ ok: false, error: { error_type: 'Database', message, details: null } });
    expect(after).toEqual(before);
    expect(f.db.all('SELECT * FROM wp165_trace')).toEqual([]);
    expect(events).toHaveLength(4);
    expect(events).toMatchObject([{ type: 'data' }, { type: 'data' }, { type: 'data' }, { type: 'error', message,
      feedback, diagnostics: { status: 'persistence_error', error_message: message, max_output_tokens: 1024 } }]);
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0]!.new_value)).toMatchObject({ feedback,
      diagnostics: { status: 'persistence_error', error_message: message } });
    expect(f.provider.requests).toHaveLength(1);
    expect(await f.host.ctx.llm.consumePendingCancel(`qbank_grading_stream_${streamId}`)).toBe(false);
  } finally { await f.dispose(); }
}, 60_000);

it.each(['grade', 'analyze'] as const)('%s missing/deleted rows reject before later writes at command and persistence boundaries', async mode => {
  const f = await fixture();
  try {
    const { question, submissionId } = await f.seed();
    f.db.run('UPDATE questions SET deleted_at=?1 WHERE id=?2', [oldTime, question.id]);
    traceWrites(f.db);
    for (const target of [question, { ...question, id: 'wp165-missing' }]) {
      const before = state(f.db, question.id);
      await expect(f.invoke(target, submissionId, mode, `wp165-missing-${target.id}`)).rejects.toEqual({
        error_type: 'NotFound', message: `题目不存在: ${target.id}`, details: null,
      });
      expect(() => f.db.transaction(tx => persistGradingResult(tx, f.questionHost, target, mode,
        submissionId, feedback, 'correct', 92, true))).toThrowError(`题目不存在或已删除: ${target.id}`);
      expect(state(f.db, question.id)).toEqual(before);
    }
    expect(f.db.all('SELECT * FROM wp165_trace')).toEqual([]);
    expect(f.provider.requests).toEqual([]);
  } finally { await f.dispose(); }
}, 60_000);

it.each(['grade', 'analyze'] as const)('%s persistence uses the supplied independent transaction and rolls every owner write back', async mode => {
  const f = await fixture();
  try {
    const { question, submissionId } = await f.seed();
    const before = state(f.db, question.id);
    const tx = await f.db.begin();
    try {
      traceWrites(tx);
      const result = persistGradingResult(tx, f.questionHost, question, mode, submissionId,
        feedback, 'correct', 92, false);
      const inside = state(tx, question.id);
      const trace = tx.all<{ stage: string }>('SELECT * FROM wp165_trace ORDER BY rowid');
      f.records.push({ mode, result, before, inside, trace });
      expect(trace.map(row => row.stage)).toEqual(['ai', 'mark', 'hash']);
      expect(inside.question).toMatchObject({ ai_feedback: feedback, ai_score: mode === 'grade' ? 92 : 37, sync_status: 'modified' });
      expect(inside.question.content_hash).not.toBe('stale');
      expect(result.outcome === null).toBe(mode === 'analyze');
      expect(state(f.db, question.id)).toEqual(before);
    } finally { await tx.rollback(); }
    expect(state(f.db, question.id)).toEqual(before);
  } finally { await f.dispose(); }
}, 60_000);

it('Grade guards preserve their order and roll back the preceding AI cache write', async () => {
  const f = await fixture();
  try {
    const { question, submissionId } = await f.seed();
    const other = await f.seed();
    const cases = [
      { verdict: null, id: null, type: 'LLM', message: '缺少评判 verdict' },
      { verdict: 'correct', id: null, type: 'Validation', message: 'AI 评判需要作答记录：请先提交答案' },
      { verdict: 'correct', id: 'missing-submission', type: 'NotFound', message: '作答记录不存在: missing-submission' },
      { verdict: 'correct', id: other.submissionId, type: 'Validation', message: `作答记录 ${other.submissionId} 不属于题目 ${question.id}` },
    ] as const;
    const before = state(f.db, question.id);
    for (const test of cases) {
      let error: unknown;
      try {
        f.db.transaction(tx => persistGradingResult(tx, f.questionHost, question, 'grade', test.id,
          feedback, test.verdict, 92, false));
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AppErrorThrow);
      expect(error).toMatchObject({ appError: { error_type: test.type, message: test.message, details: null } });
      expect(state(f.db, question.id)).toEqual(before);
      f.records.push({ test, error });
    }
    // Option<i32>::None must clear a prior score, not retain it as Analyze does.
    f.db.transaction(tx => persistGradingResult(tx, f.questionHost, question, 'grade', submissionId,
      feedback, 'correct', null, false));
    expect(state(f.db, question.id).question.ai_score).toBeNull();
  } finally { await f.dispose(); }
}, 60_000);

it.each(["deleted_at='2000-01-01'", "attempt_count='invalid'"])(
  'Analyze preserves owner hash lookup NotFound after SQL mutation: %s', async mutation => {
    const f = await fixture();
    try {
      const { question, submissionId } = await f.seed();
      const before = state(f.db, question.id);
      // Mutate only after the earlier command/context reads have succeeded.
      // The nested soft-delete already maintains FTS. End the outer trigger chain
      // after that completed UPDATE so its stale OLD row is not deleted from FTS twice.
      // RAISE(IGNORE) in an AFTER trigger retains the completed AI write / changes=1.
      f.db.exec(`CREATE TEMP TRIGGER wp165_break_hash_row AFTER UPDATE OF ai_feedback ON questions
        BEGIN UPDATE questions SET ${mutation} WHERE id=NEW.id;
        ${mutation.startsWith('deleted_at') ? 'SELECT RAISE(IGNORE);' : ''} END`);
      const message = `更新内容哈希失败: question not found: ${question.id}`;
      const outcome = await f.invoke(question, submissionId, 'analyze', 'wp165-hash-read').then(
        value => ({ ok: true, value }), error => ({ ok: false, error }));
      const after = state(f.db, question.id);
      f.records.push({ mutation, before, outcome, after });
      expect(outcome).toEqual({ ok: false, error: { error_type: 'Database', message, details: null } });
      expect(after).toEqual(before);
      expect(f.host.eventsNamed('qbank_grading_stream_wp165-hash-read').at(-1)).toMatchObject({
        type: 'error', message, diagnostics: { status: 'persistence_error' },
      });
    } finally { await f.dispose(); }
  }, 60_000);
