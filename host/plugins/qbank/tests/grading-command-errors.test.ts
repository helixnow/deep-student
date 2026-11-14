/** WP-207: real registered command → grading → L02/L01 → X5 HTTP sidecar → SQLite. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { streamingHost } from '../../../e2e/streaming/__fixtures__/host.ts';
import { providerScripts, startLlmService } from '../../../e2e/streaming/wave0/llm-service.ts';
import review from '../../review/index.ts';
import qbank from '../index.ts';
import type { Question, SubmitAnswerResult } from '../api.ts';

const scripts = providerScripts(JSON.parse(readFileSync(new URL(
  '../equivalence/pending-provider/ai-grading-scripted.provider.json', import.meta.url), 'utf8')));
const providerMessage = '批改供应商错误：HTTP 500: wp052 scripted failure；正式成绩未更新';

it.each(['http500', 'draft-write-failure', 'verdict-write-failure'] as const)(
  'qbank_ai_grade preserves structured errors and SQLite state: %s', async kind => {
    const llm = await startLlmService({ extraScripts: scripts });
    const fixture = await streamingHost('answer', { realProviders: true });
    const { host } = fixture;
    const db = host.ctx.storage.database('vfs');
    const scriptId = `qbank.ai_grade.scripted.${kind === 'verdict-write-failure' ? 'correct_verdict' : 'http_500'}`;
    const streamId = `wp207-${kind}`;
    const eventName = `qbank_grading_stream_${streamId}`;
    const record: Record<string, unknown> = { kind };
    try {
      await host.install(review, qbank);
      const exam = await host.invoke<{ id: string }>('dstu_create', { path: '/', options: {
        type: 'exam', name: 'WP-207', metadata: { status: 'empty', pageCount: 0, questionCount: 0 },
      } });
      const question = await host.invoke<Question>('qbank_create_question', { params: {
        exam_id: exam.id, content: '简述光合作用的能量转化。', question_type: 'short_answer',
        options: null, answer: '光合作用把光能转化为化学能。', structured_data: null,
        explanation: null, difficulty: 'easy', tags: ['生物'], question_label: null,
        card_id: null, source_type: 'manual', source_ref: null, images: null, parent_id: null,
      } });
      const submission = await host.invoke<SubmitAnswerResult>('qbank_submit_answer', { request: {
        question_id: question.id, user_answer: '把光能变成化学能', client_request_id: streamId,
      } });
      await host.invoke('save_api_configurations', { configs: [{
        id: 'wp052-mock', name: 'WP052 wp052-mock', apiKey: 'sk-wp052-local', baseUrl: llm.baseUrl(scriptId),
        model: 'wp052-model', isMultimodal: false, isReasoning: false, isEmbedding: false,
        isReranker: false, enabled: true, modelAdapter: 'general', maxOutputTokens: 1024, temperature: 0,
      }] });
      // SQLite itself fails; no replaced repositories, grading functions or provider clients.
      if (kind === 'draft-write-failure') db.exec(`CREATE TEMP TRIGGER wp207_reject_draft
        BEFORE INSERT ON question_history WHEN NEW.field_name = 'ai_grading_draft'
        BEGIN SELECT RAISE(ABORT, 'wp207 draft write rejected'); END`);
      if (kind === 'verdict-write-failure') db.exec(`CREATE TEMP TRIGGER wp207_reject_feedback
        BEFORE UPDATE OF ai_feedback ON questions
        BEGIN SELECT RAISE(ABORT, 'wp207 verdict write rejected'); END`);
      const state = () => ({
        question: db.one('SELECT * FROM questions WHERE id = ?1', [question.id]),
        submission: db.one('SELECT * FROM answer_submissions WHERE id = ?1', [submission.submission_id!]),
        stats: db.all('SELECT * FROM question_bank_stats'),
        mastery: db.all('SELECT * FROM mastery_events'),
      });
      const before = state();
      record.before = before;
      const outcome = await host.invoke('qbank_ai_grade', { request: {
        question_id: question.id, submission_id: submission.submission_id, stream_session_id: streamId,
        mode: 'grade', model_config_id: 'wp052-mock',
      } }).then(value => ({ ok: true, value, eventsAtSettlement: host.eventsNamed(eventName) }),
        error => ({ ok: false, error, eventsAtSettlement: host.eventsNamed(eventName) }));
      record.outcome = outcome;
      const after = state();
      record.after = after;
      const drafts = db.all<{ new_value: string }>(
        "SELECT new_value FROM question_history WHERE question_id = ?1 AND field_name = 'ai_grading_draft' ORDER BY rowid",
        [question.id]);
      record.drafts = drafts;
      expect(after).toEqual(before);
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]).toMatchObject({ scriptId, stream: true,
        status: kind === 'verdict-write-failure' ? 200 : 500,
        body: { model: 'wp052-model', temperature: 0.3, max_tokens: 1024 },
        raw: { chunks: scripts[scriptId]!.responses[0]!.chunks },
      });
      expect(fixture.fake.created).toEqual([]);
      const originalMessage = kind === 'verdict-write-failure'
        ? '保存 AI 反馈失败: wp207 verdict write rejected' : providerMessage;
      const message = kind === 'draft-write-failure'
        // VfsError::Database Display prefix (dstu-vfs/src/vfs/error.rs:173).
        ? `${originalMessage}；反馈草稿保存失败：保存批改草稿失败：Database error: wp207 draft write rejected` : originalMessage;
      const diagnostics = { status: kind === 'verdict-write-failure' ? 'persistence_error' : 'provider_error',
        http_status: kind === 'verdict-write-failure' ? 200 : 500,
        error_message: originalMessage, max_output_tokens: 1024 };
      const feedback = kind === 'verdict-write-failure'
        ? '答案要点正确。<verdict>correct</verdict><score value="92"/>' : '';
      expect(outcome.eventsAtSettlement).toHaveLength(kind === 'verdict-write-failure' ? 4 : 1);
      expect(outcome.eventsAtSettlement).toMatchObject(kind === 'verdict-write-failure'
        ? [{ type: 'data', chunk: '答案要点正确。' }, { type: 'data', chunk: '<verdict>correct</verdict>' },
          { type: 'data', chunk: '<score value="92"/>' }, { type: 'error' }] : [{ type: 'error' }]);
      expect(outcome.eventsAtSettlement.at(-1)).toMatchObject({ type: 'error', message,
        feedback, diagnostics });
      expect(drafts).toHaveLength(kind === 'draft-write-failure' ? 0 : 1);
      if (kind !== 'draft-write-failure') {
        expect(JSON.parse(drafts[0]!.new_value)).toMatchObject({ feedback, diagnostics });
      }
      expect(await llm.whenIdle(1000)).toBe(true);
      expect(await host.ctx.llm.consumePendingCancel(eventName)).toBe(false);
      expect(outcome).toMatchObject({ ok: false, error: {
        error_type: kind === 'verdict-write-failure' ? 'Database' : 'LLM', message, details: null,
      } });
      if ('error' in outcome) expect(outcome.error).toEqual({
        error_type: kind === 'verdict-write-failure' ? 'Database' : 'LLM', message, details: null,
      });
    } finally {
      const dir = mkdtempSync('/tmp/opencode/qbank-wp207-');
      writeFileSync(`${dir}/raw.json`, JSON.stringify({ ...record, requests: llm.requests, events: host.events }, null, 2));
      console.log(`WP-207 raw: ${dir}/raw.json`);
      await fixture.dispose();
      await llm.stop();
    }
  }, 60_000);
