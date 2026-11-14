import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMigratedStorage } from './support/storage.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import * as authoring from '../src/authoring-service.ts';
import { vfsTestPorts } from './support/vfs-ports.ts';
import { contextText, contextWithConn } from '../repository/qbank-read.ts';
import type { DraftQuestion, QuestionDocument } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';

function draft(localId: string, overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    local_id: localId, group_id: null, original_label: null, section_path: [], content: `Question ${localId}`,
    question_type: 'short_answer', options: null, answer: null, explanation: null, structured_data: null,
    difficulty: null, tags: [], source_refs: [], answer_source_refs: [], figures: [], images: [],
    answer_origin: null, smiles: null, smiles_caption: null, parent_id: null, parent_local_id: null,
    source_ref: null, ...overrides,
  };
}

async function fixture(): Promise<{ db: DatabaseHandle; dispose(): void }> {
  const { storage, base } = await createMigratedStorage('qbank-read-');
  const db = storage.database('vfs');
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', 'test', 'empty', 'tmp', '{}',
      '{"pages":[{"cards":[{"ocr_text":"STALE SNAPSHOT"}]}]}', ?1, ?1)`, [NOW]);
  return {
    db,
    dispose() {
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('qbank_read/tests.rs', () => {
  it('canonical_context_reads_current_questions_and_deduplicates_materials', async () => {
    const f = await fixture();
    try {
      const document: QuestionDocument = {
        schema_version: 2, mode: 'extract',
        materials: [{ local_id: 'm1', content: 'Shared passage', source_refs: [], figures: [], images: [] }],
        groups: [{ local_id: 'g1', label: 'Reading', material_ids: ['m1'], question_ids: ['q1', 'q2'] }],
        questions: [
          draft('q1', { group_id: 'g1', content: 'First' }),
          draft('q2', { group_id: 'g1', content: 'Second' }),
        ],
        unmatched_answers: [], coverage: [], issues: [],
      };
      const receipt = authoring.submitDocument({ db: f.db, ...vfsTestPorts(f.db) }, 'exam_1', document, 'seed');
      expect(receipt.question_ids).toHaveLength(2);
      f.db.run('UPDATE questions SET content = ?1 WHERE id = ?2',
        ['CURRENT EDIT', receipt.question_ids[0]!]);
      const context = contextWithConn(f.db, 'exam_1');
      expect(context).not.toBeNull();
      expect(context!.materials).toHaveLength(1);
      expect(context!.questions).toHaveLength(2);
      const text = contextText(context!);
      expect(text).toContain('CURRENT EDIT');
      expect(text).not.toContain('STALE SNAPSHOT');
      expect(text.split('Shared passage')).toHaveLength(2);
    } finally { f.dispose(); }
  });
});
