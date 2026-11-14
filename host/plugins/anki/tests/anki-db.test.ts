import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { hasValidClozeText, validateAnkiCardUpdate } from '../src/enhanced-anki.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const OLD = '2020-01-01T00:00:00Z';

function validationCard(front: string, back: string, text: string | null): AnkiCard {
  return {
    front,
    back,
    text,
    tags: [],
    images: [],
    id: 'card-validation',
    task_id: 'task-validation',
    is_error_card: false,
    error_content: null,
    created_at: '',
    updated_at: '',
    extra_fields: {},
    template_id: null,
  };
}

interface TaskSeed {
  id?: string;
  documentId?: string;
  segmentIndex?: number;
  status?: string;
  updatedAt?: string;
  createdAt?: string;
  sourceSessionId?: string | null;
  deletedAt?: string | null;
  documentName?: string;
}

interface CardSeed {
  id?: string;
  taskId?: string;
  front?: string;
  back?: string;
  text?: string | null;
  tags?: string[];
  images?: string[];
  isErrorCard?: boolean;
  errorContent?: string | null;
  order?: number;
  createdAt?: string;
  updatedAt?: string;
  extraFields?: Record<string, string>;
  templateId?: string | null;
  sourceType?: string;
  sourceId?: string;
  deletedAt?: string | null;
}

function insertTask(db: DatabaseHandle, seed: TaskSeed = {}): void {
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json,
        source_session_id, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '{}', ?9, ?10)`,
    [
      seed.id ?? 'task-1',
      seed.documentId ?? 'doc-1',
      seed.documentName ?? 'doc.md',
      seed.segmentIndex ?? 0,
      'segment',
      seed.status ?? 'Completed',
      seed.createdAt ?? '2026-01-01T00:00:00Z',
      seed.updatedAt ?? '2026-01-01T00:00:00Z',
      seed.sourceSessionId ?? null,
      seed.deletedAt ?? null,
    ],
  );
}

function insertCard(db: DatabaseHandle, seed: CardSeed = {}): void {
  const id = seed.id ?? 'card-1';
  db.run(
    `INSERT INTO anki_cards
       (id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id, source_type, source_id, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    [
      id,
      seed.taskId ?? 'task-1',
      seed.front ?? `front-${id}`,
      seed.back ?? `back-${id}`,
      seed.text ?? null,
      JSON.stringify(seed.tags ?? []),
      JSON.stringify(seed.images ?? []),
      seed.isErrorCard === true ? 1 : 0,
      seed.errorContent ?? null,
      seed.order ?? 0,
      seed.createdAt ?? '2026-01-01T00:00:00Z',
      seed.updatedAt ?? '2026-01-01T00:00:00Z',
      JSON.stringify(seed.extraFields ?? {}),
      seed.templateId ?? null,
      seed.sourceType ?? 'document',
      seed.sourceId ?? 'doc-1',
      seed.deletedAt ?? null,
    ],
  );
}

describe('src/cmd/enhanced_anki.rs::tests', () => {
  it('valid_cloze_text_allows_an_empty_back', () => {
    const card = validationCard(
      'The {{c1::answer}} remains editable',
      '',
      'The {{c1::answer}} remains editable',
    );
    expect(hasValidClozeText(card)).toBe(true);
    expect(validateAnkiCardUpdate(card)).toBeNull();

    const customFields = validationCard('', '', null);
    customFields.extra_fields.Text = 'Multiple {{c2::deletions::hint}} work';
    expect(hasValidClozeText(customFields)).toBe(true);
    expect(validateAnkiCardUpdate(customFields)).toBeNull();
  });

  it('malformed_or_empty_cloze_text_does_not_bypass_basic_validation', () => {
    for (const text of ['plain text', '{{c0::zero}}', '{{c1::}}', '{{c1::open']) {
      const card = validationCard(text, '', text);
      expect(hasValidClozeText(card), `unexpectedly valid: ${text}`).toBe(false);
      expect(validateAnkiCardUpdate(card), `invalid Cloze cannot bypass Basic validation: ${text}`).toBe('卡片背面不能为空');
    }
  });
});

describe('增强 Anki 卡片/任务命令（真实 mistakes 库）', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
    db.run('DELETE FROM custom_anki_templates');
    db.run('DELETE FROM settings');
    db.run('DROP TABLE IF EXISTS pending_memory_candidates');
  });

  it('import_apkg_to_library converts path validation failures into wire AppErrors', async () => {
    await expect(env.host.invoke('import_apkg_to_library', { path: '' }))
      .rejects.toMatchObject({
        error_type: 'Validation',
        message: 'APKG 文件路径不能为空',
        details: { errorCode: 'apkg_invalid_input' },
      });
    await expect(env.host.invoke('import_apkg_to_library', {
      path: `${env.dir}/missing.apkg`,
    })).rejects.toMatchObject({
      error_type: 'NotFound',
      message: expect.stringContaining('APKG 文件不存在:'),
      details: { errorCode: 'apkg_not_found' },
    });
  });

  it('get_document_tasks_uses_anki_database', async () => {
    insertTask(db, { id: 'task-b', segmentIndex: 1, status: 'Paused' });
    insertTask(db, { id: 'task-a', segmentIndex: 0, status: 'Completed' });
    insertTask(db, { id: 'task-gone', segmentIndex: 2, deletedAt: '2026-01-02T00:00:00Z' });
    const tasks = await env.host.invoke<DocumentTask[]>('get_document_tasks', { documentId: 'doc-1' });
    expect(tasks.map((task) => task.id)).toEqual(['task-a', 'task-b']);
    expect(tasks[1]?.status).toBe('Paused');
    expect(tasks[0]?.document_id).toBe('doc-1');
    expect(tasks[0]?.anki_generation_options_json).toBe('{}');
    expect(await env.host.invoke<DocumentTask[]>('get_document_tasks', { documentId: 'missing' })).toEqual([]);
  });

  it('updates a card with serde defaults and a user content provenance stamp', async () => {
    insertTask(db);
    insertCard(db, {
      id: 'card-1',
      front: 'old front',
      back: 'old back',
      extraFields: { stale: 'drop-me' },
      templateId: 'tpl-1',
      updatedAt: '2026-01-01T00:00:00Z',
      createdAt: '2025-12-31T00:00:00Z',
    });

    await expect(env.host.invoke('update_anki_card', {
      card: {
        id: 'card-1',
        front: 'new front',
        back: 'new back',
        text: '{{c1::cloze}}',
        tags: ['tag-a'],
        images: ['img.png'],
        task_id: 'task-1',
        is_error_card: false,
        extra_fields: { Subject: 'Math' },
        template_id: 'tpl-1',
      },
    })).resolves.toBeNull();

    const row = db.one<{
      front: string;
      back: string;
      text: string | null;
      tags_json: string;
      images_json: string;
      extra_fields_json: string;
      template_id: string | null;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT front, back, text, tags_json, images_json, extra_fields_json, template_id, created_at, updated_at FROM anki_cards WHERE id = ?1',
      ['card-1'],
    );
    expect(row.front).toBe('new front');
    expect(row.back).toBe('new back');
    expect(row.text).toBe('{{c1::cloze}}');
    expect(JSON.parse(row.tags_json)).toEqual(['tag-a']);
    expect(JSON.parse(row.images_json)).toEqual(['img.png']);
    expect(row.template_id).toBe('tpl-1');
    expect(row.created_at).toBe('2025-12-31T00:00:00Z');
    expect(row.updated_at).not.toBe('2026-01-01T00:00:00Z');

    const extra = JSON.parse(row.extra_fields_json) as Record<string, string>;
    expect(extra.stale).toBeUndefined();
    expect(extra.Subject).toBe('Math');
    const provenance = JSON.parse(extra._content_provenance ?? '') as Record<string, string>;
    expect(provenance.actor).toBe('user');
    expect(provenance.code).toBe('update_anki_card');
    expect(typeof provenance.at).toBe('string');
  });

  it('rejects updates that violate card validation or miss the card', async () => {
    insertTask(db);
    insertCard(db, { id: 'card-1' });
    await expect(env.host.invoke('update_anki_card', {
      card: { id: 'card-1', front: '   ', back: '', text: null },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '卡片正面不能为空' });
    await expect(env.host.invoke('update_anki_card', {
      card: { id: 'card-1', front: 'front', back: ' ', text: null },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '卡片背面不能为空' });
    await expect(env.host.invoke('update_anki_card', {
      card: { id: 'missing', front: 'front', back: 'back', text: null },
    })).rejects.toMatchObject({ error_type: 'NotFound', message: '卡片不存在或已删除: missing' });

    insertCard(db, { id: 'card-cloze', back: 'old', text: '{{c1::answer}}' });
    await expect(env.host.invoke('update_anki_card', {
      card: { id: 'card-cloze', front: '', back: '', text: '{{c1::answer}}' },
    })).resolves.toBeNull();
    expect(db.pluck<string>('SELECT back FROM anki_cards WHERE id = ?1', ['card-cloze'])).toBe('');
  });

  it('deletes a card together with its FSRS review rows', async () => {
    insertTask(db);
    insertCard(db, { id: 'card-1', front: 'unique-front' });
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
       VALUES ('state-1', 'card-1', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    db.run(
      `INSERT INTO fsrs_review_logs
         (id, card_state_id, anki_card_id, rating, state_before, state_after, review_ms, fsrs_params_version)
       VALUES ('log-1', 'state-1', 'card-1', 3, 0, 1, 1, 'rs-fsrs-1.2')`,
    );

    await expect(env.host.invoke('delete_anki_card', { cardId: '' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: '卡片ID不能为空' });
    await expect(env.host.invoke('delete_anki_card', { cardId: 'card-1' })).resolves.toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', ['card-1'])).toBe(0);
  });

  it('deletes a document task with its cards but keeps sibling tasks', async () => {
    insertTask(db, { id: 'task-1' });
    insertTask(db, { id: 'task-2', segmentIndex: 1 });
    insertCard(db, { id: 'card-1', taskId: 'task-1', front: 'unique-1' });
    insertCard(db, { id: 'card-2', taskId: 'task-2', front: 'unique-2' });

    await expect(env.host.invoke('delete_document_task', { taskId: '' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: '任务ID不能为空' });
    await expect(env.host.invoke('delete_document_task', { taskId: 'task-1' })).resolves.toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM document_tasks WHERE id = ?1', ['task-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE task_id = ?1', ['task-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-2'])).toBe(1);
  });

  it('deletes a whole document session and its FSRS rows', async () => {
    insertTask(db, { id: 'task-1', documentId: 'doc-1' });
    insertTask(db, { id: 'task-2', documentId: 'doc-2' });
    insertCard(db, { id: 'card-1', taskId: 'task-1', front: 'unique-1' });
    insertCard(db, { id: 'card-2', taskId: 'task-2', front: 'unique-2' });
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
       VALUES ('state-1', 'card-1', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    await expect(env.host.invoke('delete_document_session', { documentId: '' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: '文档ID不能为空' });
    await expect(env.host.invoke('delete_document_session', { documentId: 'doc-1' })).resolves.toBe(true);
    expect(db.pluck<number>('SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1', ['doc-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-1'])).toBe(0);
    expect(db.pluck<number>('SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1', ['doc-2'])).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-2'])).toBe(1);
  });

  it('reads document/task cards in Rust order and skips soft-deleted rows', async () => {
    insertTask(db, { id: 'task-1', segmentIndex: 1 });
    insertTask(db, { id: 'task-0', segmentIndex: 0 });
    insertTask(db, { id: 'task-deleted', segmentIndex: 2, deletedAt: '2026-01-02T00:00:00Z' });
    insertCard(db, { id: 'card-b', taskId: 'task-1', front: 'b', order: 1, createdAt: '2026-01-02T00:00:00Z' });
    insertCard(db, { id: 'card-a', taskId: 'task-1', front: 'a', order: 0, createdAt: '2026-01-03T00:00:00Z' });
    insertCard(db, { id: 'card-0', taskId: 'task-0', front: 'zero', order: 5 });
    insertCard(db, { id: 'card-deleted', taskId: 'task-0', front: 'gone', order: 6, deletedAt: '2026-01-02T00:00:00Z' });
    insertCard(db, { id: 'card-orphan', taskId: 'task-deleted', front: 'orphan' });

    const documentCards = await env.host.invoke<AnkiCard[]>('get_document_cards', { documentId: 'doc-1' });
    expect(documentCards.map((card) => card.id)).toEqual(['card-0', 'card-a', 'card-b']);
    expect(documentCards[1]).toMatchObject({
      front: 'a',
      back: 'back-card-a',
      text: null,
      tags: [],
      images: [],
      task_id: 'task-1',
      is_error_card: false,
      error_content: null,
      extra_fields: {},
      template_id: null,
    });

    const taskCards = await env.host.invoke<AnkiCard[]>('get_task_cards', { taskId: 'task-1' });
    expect(taskCards.map((card) => card.id)).toEqual(['card-a', 'card-b']);
  });

  it('returns recent cards newest first with an optional limit', async () => {
    insertTask(db);
    insertCard(db, { id: 'card-old', front: 'old', createdAt: '2026-01-01T00:00:00Z' });
    insertCard(db, { id: 'card-new', front: 'new', createdAt: '2026-01-03T00:00:00Z' });
    insertCard(db, { id: 'card-mid', front: 'mid', createdAt: '2026-01-02T00:00:00Z' });

    expect((await env.host.invoke<AnkiCard[]>('get_all_recent_cards', {})).map((card) => card.id))
      .toEqual(['card-new', 'card-mid', 'card-old']);
    expect((await env.host.invoke<AnkiCard[]>('get_all_recent_cards', { limit: 2 })).map((card) => card.id))
      .toEqual(['card-new', 'card-mid']);
    expect((await env.host.invoke<AnkiCard[]>('get_all_recent_cards', { limit: 0 }))).toEqual([]);
  });

  it('sets the document source session only when it is still empty', async () => {
    insertTask(db, { id: 'task-empty', sourceSessionId: null });
    insertTask(db, { id: 'task-owned', segmentIndex: 1, sourceSessionId: 'session-old' });
    insertTask(db, { id: 'task-deleted', segmentIndex: 2, sourceSessionId: null, deletedAt: '2026-01-02T00:00:00Z' });

    await expect(env.host.invoke('set_document_session_source', { documentId: '  ', sessionId: 's1' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: 'documentId 不能为空' });
    await expect(env.host.invoke('set_document_session_source', { documentId: 'doc-1', sessionId: '  ' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: 'sessionId 不能为空' });

    await expect(env.host.invoke('set_document_session_source', {
      documentId: ' doc-1 ',
      sessionId: ' session-1 ',
    })).resolves.toBeNull();
    expect(db.pluck<string>('SELECT source_session_id FROM document_tasks WHERE id = ?1', ['task-empty'])).toBe('session-1');
    expect(db.pluck<string>('SELECT source_session_id FROM document_tasks WHERE id = ?1', ['task-owned'])).toBe('session-old');
    expect(db.pluck<string | null>('SELECT source_session_id FROM document_tasks WHERE id = ?1', ['task-deleted'])).toBeNull();
  });

  it('lists document sessions with task/card aggregates', async () => {
    insertTask(db, { id: 't1', documentId: 'doc-1', documentName: 'one.md', status: 'Completed', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', sourceSessionId: 's1' });
    insertTask(db, { id: 't2', documentId: 'doc-1', documentName: 'one.md', segmentIndex: 1, status: 'Failed', updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', sourceSessionId: 's1' });
    insertTask(db, { id: 't3', documentId: 'doc-1', documentName: 'one.md', segmentIndex: 2, status: 'Paused', updatedAt: '2026-01-03T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', sourceSessionId: 's1' });
    insertTask(db, { id: 't4', documentId: 'doc-1', documentName: 'one.md', segmentIndex: 3, status: 'Streaming', updatedAt: '2026-01-04T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', sourceSessionId: 's1' });
    insertTask(db, { id: 't5', documentId: 'doc-2', documentName: 'two.md', status: 'Completed', updatedAt: '2025-12-31T00:00:00Z', createdAt: '2025-12-30T00:00:00Z' });
    insertCard(db, { id: 'c1', taskId: 't1', front: 'c1' });
    insertCard(db, { id: 'c2', taskId: 't2', front: 'c2' });
    insertCard(db, { id: 'c3', taskId: 't2', front: 'c3', deletedAt: '2026-01-02T00:00:00Z' });
    insertCard(db, { id: 'c4', taskId: 't5', front: 'c4' });

    const sessions = await env.host.invoke<Record<string, unknown>[]>('list_document_sessions', {});
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      documentId: 'doc-1',
      documentName: 'one.md',
      sourceSessionId: 's1',
      totalTasks: 4,
      completedTasks: 1,
      failedTasks: 1,
      activeTasks: 1,
      pausedTasks: 1,
      lastUpdated: '2026-01-04T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      totalCards: 2,
    });
    expect(sessions[1]).toMatchObject({ documentId: 'doc-2', sourceSessionId: null, totalTasks: 1, totalCards: 1 });

    const limited = await env.host.invoke<Record<string, unknown>[]>('list_document_sessions', { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.documentId).toBe('doc-1');
  });

  it('recovers stuck document tasks with the 10 minute threshold', async () => {
    insertTask(db, { id: 'stuck-processing', documentId: 'doc-1', status: 'Processing', updatedAt: OLD });
    insertTask(db, { id: 'live-processing', documentId: 'doc-2', status: 'Processing', updatedAt: '2026-01-01T00:00:00Z' });
    insertTask(db, { id: 'queued-with-live', documentId: 'doc-2', segmentIndex: 1, status: 'Pending', updatedAt: OLD });
    insertTask(db, { id: 'queued-orphan', documentId: 'doc-3', status: 'Pending', updatedAt: OLD });
    insertTask(db, { id: 'deleted-active', documentId: 'doc-4', status: 'Streaming', updatedAt: OLD, deletedAt: '2026-01-02T00:00:00Z' });
    db.run("UPDATE document_tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'live-processing'");

    await expect(env.host.invoke('recover_stuck_document_tasks')).resolves.toBe(2);
    const statuses = db.all<{ id: string; status: string; error_message: string | null }>(
      'SELECT id, status, error_message FROM document_tasks ORDER BY id',
    );
    const byId = new Map(statuses.map((row) => [row.id, row]));
    expect(byId.get('stuck-processing')?.status).toBe('Paused');
    expect(byId.get('stuck-processing')?.error_message).toBe('任务被中断（应用重启），可点击恢复继续');
    expect(byId.get('live-processing')?.status).toBe('Processing');
    expect(byId.get('queued-with-live')?.status).toBe('Pending');
    expect(byId.get('queued-orphan')?.status).toBe('Paused');
    expect(byId.get('deleted-active')?.status).toBe('Streaming');
  });

  it('computes Anki statistics over live cards and the template library', async () => {
    insertTask(db, { id: 'task-1', documentId: 'doc-1' });
    insertTask(db, { id: 'task-2', documentId: 'doc-2', segmentIndex: 1 });
    insertTask(db, { id: 'task-3', documentId: 'doc-3', segmentIndex: 2, deletedAt: '2026-01-02T00:00:00Z' });
    insertCard(db, { id: 'c1', front: 'c1', templateId: 'tpl-1' });
    insertCard(db, { id: 'c2', front: 'c2', templateId: 'tpl-1' });
    insertCard(db, { id: 'c3', front: 'c3', templateId: 'tpl-2', isErrorCard: true });
    insertCard(db, { id: 'c4', front: 'c4', templateId: null });
    insertCard(db, { id: 'c5', front: 'c5', templateId: 'tpl-3', deletedAt: '2026-01-02T00:00:00Z' });
    db.run(
      `INSERT INTO custom_anki_templates
         (id, name, description, author, version, preview_front, preview_back, note_type,
          fields_json, generation_prompt, front_template, back_template, css_style,
          field_extraction_rules_json, created_at, updated_at, is_active, is_built_in)
       VALUES ('tpl-1', 'One', '', NULL, '1.0.0', '', '', 'Basic', '[]', '', '', '', '', '{}',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 0),
              ('tpl-2', 'Two', '', NULL, '1.0.0', '', '', 'Basic', '[]', '', '', '', '', '{}',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, 0)`,
    );

    await expect(env.host.invoke('get_anki_stats')).resolves.toEqual({
      totalCards: 4,
      totalDocuments: 2,
      errorCards: 1,
      templateCount: 2,
      libraryTemplateCount: 2,
      activeLibraryTemplateCount: 1,
    });
  });

  it('keeps the Rust pending-memory table behaviour and normalizes chat- prefixes', async () => {
    await expect(env.host.invoke('get_pending_memory_candidates', { conversationId: 'c1' }))
      .rejects.toMatchObject({ error_type: 'Database', message: '数据库错误: no such table: pending_memory_candidates' });
    await expect(env.host.invoke('dismiss_pending_memory_candidates', { conversationId: 'c1' }))
      .rejects.toMatchObject({ error_type: 'Database', message: '数据库错误: no such table: pending_memory_candidates' });

    db.exec(
      `CREATE TABLE pending_memory_candidates (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         conversation_id TEXT NOT NULL,
         subject TEXT NOT NULL DEFAULT '通用',
         content TEXT NOT NULL,
         category TEXT NOT NULL,
         origin TEXT NOT NULL DEFAULT '',
         user_edited INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'pending',
         created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         expires_at TEXT
       )`,
    );
    db.run(
      `INSERT INTO pending_memory_candidates (conversation_id, subject, content, category, created_at, expires_at)
       VALUES ('c1', '通用', 'first', 'fact', '2026-01-01T00:00:00Z', '2999-01-01 00:00:00'),
              ('c1', '通用', 'second', 'pref', '2026-01-02T00:00:00Z', '2999-01-01 00:00:00'),
              ('c1', '通用', 'expired', 'fact', '2026-01-03T00:00:00Z', '2000-01-01 00:00:00'),
              ('c1', '通用', 'dismissed', 'fact', '2026-01-04T00:00:00Z', '2999-01-01 00:00:00')`,
    );
    db.run("UPDATE pending_memory_candidates SET status = 'dismissed' WHERE content = 'dismissed'");

    await expect(env.host.invoke('get_pending_memory_candidates', { conversationId: '' }))
      .rejects.toMatchObject({ error_type: 'Validation', message: 'conversation_id 不能为空' });
    expect(await env.host.invoke('get_pending_memory_candidates', { conversationId: ' chat-c1 ' })).toEqual({
      conversation_id: 'c1',
      subject: '通用',
      candidates: [
        { content: 'first', category: 'fact' },
        { content: 'second', category: 'pref' },
      ],
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(await env.host.invoke('get_pending_memory_candidates', { conversationId: 'unknown' })).toBeNull();

    await expect(env.host.invoke('dismiss_pending_memory_candidates', { conversationId: 'chat-c1' })).resolves.toBe(2);
    await expect(env.host.invoke('dismiss_pending_memory_candidates', { conversationId: 'chat-c1' })).resolves.toBe(0);
    expect(db.all<{ status: string }>('SELECT status FROM pending_memory_candidates ORDER BY id').map((row) => row.status))
      .toEqual(['dismissed', 'dismissed', 'dismissed']);

    db.run("UPDATE pending_memory_candidates SET status = 'pending'");
    await expect(env.host.invoke('mark_pending_memory_candidates_saved', { conversationId: 'chat-c1' })).resolves.toBe(3);
    expect(db.pluck<number>("SELECT COUNT(*) FROM pending_memory_candidates WHERE status = 'saved'")).toBe(3);
    await expect(env.host.invoke('mark_pending_memory_candidates_saved', { conversationId: 'chat-c1' })).resolves.toBe(0);
  });
});
