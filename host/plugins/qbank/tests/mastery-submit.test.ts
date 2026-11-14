/**
 * `src/question_bank_service/tests.rs::submit_answer_wrong_thrice_writes_mastery_and_weak_point`。
 *
 * 组合真实 review（mastery）与 memory（masteryProfileSink）插件，验证连续三次判错后
 * mastery_events / mastery_states 与 learner_profile 薄弱点回流。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import type { SettingsService } from '../../../platform/settings/api.ts';
import notes from '../../notes/index.ts';
import memory from '../../memory/index.ts';
import review from '../../review/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import qbank from '../index.ts';
import type { CreateQuestionParams, Question, SubmitAnswerResult } from '../api.ts';

const NOW = '2020-01-01T00:00:00Z';

describe('question_bank_service/tests.rs', () => {
  it('submit_answer_wrong_thrice_writes_mastery_and_weak_point', async () => {
    const { storage, base } = await createMigratedStorage('qbank-mastery-submit-');
    const db = storage.database('vfs');
    const settings = createSettingsStore({
      db: () => db, secureStore: () => null, isSensitiveKey: () => false,
    }) as unknown as SettingsService;
    const host = await createTestHost({
      plugins: [notes, vfsRepos, review, memory, qbank],
      provide: {
        storage,
        settings,
        log: {
          logger: () => ({
            debug: () => undefined, info: () => undefined,
            warn: () => undefined, error: () => undefined,
          }),
        },
        paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
          : process.platform === 'linux' ? 'linux' : 'darwin',
          env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      },
    });
    try {
      const examId = 'exam_mastery_e2e';
      db.run(`INSERT INTO exam_sheets (
          id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
        ) VALUES (?1, 'qbank mastery e2e', 'completed', ?2, '{}', '{}', ?3, ?3)`,
      [examId, `temp_${examId}`, NOW]);
      const concept = 'qbank_闭环概念';
      const params: CreateQuestionParams = {
        exam_id: examId, card_id: null, question_label: 'Q1', content: 'Q1?',
        options: null, answer: '2', explanation: null, structured_data: null,
        question_type: 'fill_blank', difficulty: null, tags: [concept], source_type: null,
        source_ref: null, images: null, parent_id: null,
      };
      const question = await host.invoke('qbank_create_question', { params }) as Question;

      for (let index = 0; index < 3; index += 1) {
        const result = await host.invoke('qbank_submit_answer', {
          request: {
            question_id: question.id, user_answer: 'x', is_correct_override: false,
            client_request_id: `qw${index}`, regrade_submission_id: null,
          },
        }) as SubmitAnswerResult;
        expect(result.is_correct).toBe(false);
      }

      expect(db.pluck<number>(`SELECT COUNT(*) FROM mastery_events
        WHERE concept_key = ?1 AND source = 'qbank' AND outcome = 'wrong'`,
      [concept])).toBe(3);
      const state = db.one<{ score: number; total: number }>(
        'SELECT score, total FROM mastery_states WHERE concept_key = ?1', [concept]);
      // review/repository/mastery.ts: WEAK_SCORE_THRESHOLD=0.5, MIN_TOTAL_FOR_WEAK=3
      expect(state.score).toBeLessThan(0.5);
      expect(state.total).toBeGreaterThanOrEqual(3);

      const profileContent = db.pluck<string>(
        `SELECT r.data FROM notes n JOIN resources r ON r.id = n.resource_id
         WHERE n.title = '__learner_profile__' AND n.deleted_at IS NULL
         ORDER BY n.created_at DESC LIMIT 1`);
      expect(profileContent).toBeTruthy();
      const profile = JSON.parse(profileContent!) as {
        weak_points: Array<{ knowledge_point: string; source?: string }>;
      };
      expect(profile.weak_points.some(point =>
        point.knowledge_point === concept && point.source === 'mastery')).toBe(true);
    } finally {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
