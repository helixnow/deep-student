/**
 * `tests/anki_new_wiring_tests.rs`（3 条）的移植。
 *
 * 覆盖偏好记忆设置往返、Image Occlusion 扩展字段入库回读、
 * `_original_generation` 二次编码落库后编辑不改变快照。
 */
import { describe, expect, it } from 'vitest';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import {
  OCCLUSION_FIELD,
  OCCLUSION_TAG,
  buildOcclusionDraftMarker,
  defaultOcclusionConfig,
  extractOcclusionDraftFields,
  parseOcclusionField,
} from '../api.ts';
import { decodeAnkiCardRow } from '../src/anki-cards.ts';
import {
  createPreferenceStore,
  consolidate,
  extractPreferences,
  retrievePreferencePrompt,
  type PreferenceStore,
  type SessionObservation,
} from '../src/preference-memory.ts';
import {
  extractOriginalFromExtras,
  extractOriginalGeneration,
  insertOriginalGenerationOnce,
} from '../src/anki-gold-set.ts';
import {
  listCardsForTask,
  saveDocumentTaskWithCardsAtomic,
  updateCardRows,
} from '../repository/anki-cards.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const PREFERENCE_STORE_KEY = 'chatanki_preference_memory_store';

function task(id: string, documentId: string): DocumentTask {
  const now = '2026-08-24T00:00:00+00:00';
  return {
    id,
    document_id: documentId,
    original_document_name: 'wiring-test.md',
    segment_index: 0,
    content_segment: 'integration fixture',
    status: 'Streaming',
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: '{}',
  };
}

function card(
  id: string,
  taskId: string,
  front: string,
  back: string,
  text: string | null,
  tags: string[],
  extraFields: Record<string, string>,
): AnkiCard {
  const now = '2026-08-24T00:00:00+00:00';
  return {
    id,
    task_id: taskId,
    front,
    back,
    text,
    tags,
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: now,
    updated_at: now,
    extra_fields: extraFields,
    template_id: null,
  };
}

describe('tests/anki_new_wiring_tests.rs', () => {
  it('preference_write_round_trip_reinforces_and_retrieves', async () => {
    const env: AnkiTestEnv = await createAnkiTestEnv();
    try {
      const observation: SessionObservation = {
        extra_requirements:
          '请用中文回答，不要翻译专业术语，每份材料最多 7 张卡，请用学术填空题模板',
        template_used: '学术填空题',
        generated_count: 7,
        edits: [],
        deletions: [],
      };
      const candidates = extractPreferences(observation);
      expect(candidates).toHaveLength(4);

      const store = createPreferenceStore();
      const first = consolidate(store, candidates, 1_000);
      expect(first.added).toHaveLength(4);
      env.host.ctx.anki.settings.saveSetting(PREFERENCE_STORE_KEY, JSON.stringify(store));

      const persisted = env.host.ctx.anki.settings.getSetting(PREFERENCE_STORE_KEY);
      expect(persisted).not.toBeNull();
      const reloaded = JSON.parse(persisted!) as PreferenceStore;
      expect(reloaded.entries).toHaveLength(4);
      expect(reloaded.entries.every((entry) => entry.evidence_count === 1)).toBe(true);

      const second = consolidate(reloaded, candidates, 2_000);
      expect(second.reinforced).toHaveLength(4);
      expect(second.added).toHaveLength(0);
      env.host.ctx.anki.settings.saveSetting(PREFERENCE_STORE_KEY, JSON.stringify(reloaded));

      const persistedAgain = env.host.ctx.anki.settings.getSetting(PREFERENCE_STORE_KEY);
      expect(persistedAgain).not.toBeNull();
      const finalStore = JSON.parse(persistedAgain!) as PreferenceStore;
      expect(
        finalStore.entries.every(
          (entry) => entry.evidence_count === 2 && entry.last_seen_ms === 2_000,
        ),
      ).toBe(true);

      const hint = retrievePreferencePrompt(finalStore, '把讲义做成学术填空题', ['学术填空题'], 400);
      expect(hint).toContain('中文');
      expect(hint).toContain('不要翻译');
      expect(hint).toContain('7 张');
      expect(hint).toContain('学术填空题');
    } finally {
      await env.dispose();
    }
  });

  it('occlusion_extra_fields_survive_anki_database_round_trip', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const marker = buildOcclusionDraftMarker(
        'vfs://images/neural-network.png',
        '[IMAGE_DESC: 输入层；隐藏层；输出层]',
        defaultOcclusionConfig(),
      );
      expect(marker).not.toBeNull();
      const fields = extractOcclusionDraftFields(marker!);
      expect(fields).not.toBeNull();

      const extras: Record<string, string> = {
        ...fields!.extraFields,
        model_note: '模型原有扩展字段',
      };
      const seeded = card(
        'card-occlusion-wiring',
        'task-occlusion-wiring',
        '神经网络有哪些层？',
        '输入层、隐藏层、输出层',
        null,
        ['模型标签', OCCLUSION_TAG],
        extras,
      );
      saveDocumentTaskWithCardsAtomic(
        db,
        task('task-occlusion-wiring', 'doc-occlusion-wiring'),
        [seeded],
      );

      const rows = listCardsForTask(db, 'task-occlusion-wiring');
      expect(rows).toHaveLength(1);
      const loaded = decodeAnkiCardRow(rows[0]!);
      expect(loaded.extra_fields.model_note).toBe('模型原有扩展字段');
      expect(Object.hasOwn(loaded.extra_fields, OCCLUSION_FIELD)).toBe(true);
      expect(loaded.tags).toContain(OCCLUSION_TAG);

      const parsed = parseOcclusionField(loaded.extra_fields);
      expect(parsed).not.toBeNull();
      expect(parsed!.imageRef).toBe('vfs://images/neural-network.png');
      expect(parsed!.boxes.map((item) => item.label)).toEqual(['输入层', '隐藏层', '输出层']);
      expect(parsed!.boxes.map((item) => item.clozeIndex)).toEqual([1, 2, 3]);
    } finally {
      await env.dispose();
    }
  });

  it('original_generation_snapshot_survives_card_edits', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = env.storage.database('mistakes');
      const extras: Record<string, string> = {};
      const inserted = insertOriginalGenerationOnce(extras, '什么是栈？', '一种数据结构', null);
      expect(inserted.ok && inserted.inserted).toBe(true);
      extras.source = 'generator';
      const seeded = card(
        'card-original-wiring',
        'task-original-wiring',
        '什么是栈？',
        '一种数据结构',
        null,
        ['数据结构'],
        extras,
      );
      saveDocumentTaskWithCardsAtomic(
        db,
        task('task-original-wiring', 'doc-original-wiring'),
        [seeded],
      );

      const loadedRows = listCardsForTask(db, 'task-original-wiring');
      expect(loadedRows.length).toBeGreaterThan(0);
      const loaded = decodeAnkiCardRow(loadedRows[loadedRows.length - 1]!);
      const snapshot = extractOriginalFromExtras(loaded.extra_fields);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.front).toBe('什么是栈？');
      expect(snapshot!.back).toBe('一种数据结构');
      expect(snapshot!.text).toBeNull();

      loaded.front = '栈遵循什么访问顺序？';
      loaded.back = '后进先出（LIFO）';
      loaded.text = '用户补充说明';
      expect(updateCardRows(db, loaded, '2026-08-24T01:00:00+00:00')).toBe(1);

      const editedRows = listCardsForTask(db, 'task-original-wiring');
      const edited = decodeAnkiCardRow(editedRows[editedRows.length - 1]!);
      expect(edited.front).toBe('栈遵循什么访问顺序？');
      expect(edited.back).toBe('后进先出（LIFO）');
      const unchanged = extractOriginalFromExtras(edited.extra_fields);
      expect(unchanged).not.toBeNull();
      expect(unchanged!.front).toBe('什么是栈？');
      expect(unchanged!.back).toBe('一种数据结构');
      expect(edited.extra_fields.source).toBe('generator');

      const rawExtraFieldsJson = db.pluck<string>(
        'SELECT extra_fields_json FROM anki_cards WHERE id = ?1',
        ['card-original-wiring'],
      );
      expect(rawExtraFieldsJson).not.toBeNull();
      const rawSnapshot = extractOriginalGeneration(rawExtraFieldsJson!);
      expect(rawSnapshot).toEqual(unchanged);
    } finally {
      await env.dispose();
    }
  });
});
