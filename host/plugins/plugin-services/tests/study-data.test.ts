/**
 * `studyData` facade against the real official services of the desktop profile (temp data dir):
 * notes / anki / review / qbank / vfs-repos todos / vfs resource library.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createStudyDataService, noteExcerpt } from '../src/study-data.ts';
import type { StudyDataService } from '../api.ts';

vi.mock('@/utils/platform', () => ({ getPlatform: () => 'macos' }));

let root = '';
let host: TestHost | undefined;
let study: StudyDataService;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-study-data-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), debug: true } });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(root, 'app/plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  // The studyData facade is built directly below; only the official data services must be healthy.
  expect(loaded.degraded.filter((entry) => !String(JSON.stringify(entry)).includes('plugin-services'))).toEqual([]);
  for (const name of ['notes', 'anki', 'review', 'qbank', 'vfsRepo', 'vfsDatabase']) {
    expect(host.ctx.get(name as never), `${name} service`).toBeDefined();
  }
  study = createStudyDataService(host.ctx);
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function eventsNamed(name: string): unknown[] {
  return host!.eventsNamed(name);
}

describe('studyData.notes', () => {
  it('creates, reads, lists, searches, updates and appends through the notes service', async () => {
    const saved: unknown[] = [];
    const off = host!.ctx.on('study/note-saved' as never, ((event: unknown) => { saved.push(event); }) as never);
    host!.events.length = 0;

    const created = await study.notes.create({ title: '  光合作用  ', content: '叶绿体 吸收 zebraquartz 光能', tags: ['生物', '生物', ' '] });
    expect(created).toMatchObject({ title: '光合作用', content: '叶绿体 吸收 zebraquartz 光能', tags: ['生物'], favorite: false });
    expect(created.id).toMatch(/^note_/);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    const changes = eventsNamed('dstu:change') as { type: string; node: { id: string } }[];
    expect(changes.some((event) => event.type === 'created' && event.node.id === created.id)).toBe(true);

    expect(await study.notes.get(created.id)).toEqual(created);
    expect(await study.notes.get('note_does_not_exist')).toBeNull();
    expect((await study.notes.list()).map((note) => note.id)).toContain(created.id);
    expect(await study.notes.list({ updatedSince: '2999-01-01T00:00:00Z' })).toEqual([]);

    const hits = await study.notes.search('zebraquartz');
    expect(hits.map((hit) => hit.id)).toEqual([created.id]);
    expect(hits[0]!.excerpt).toContain('zebraquartz');

    const updated = await study.notes.update(created.id, { title: '光合作用（整理）', tags: ['生物', '必修一'] });
    expect(updated).toMatchObject({ title: '光合作用（整理）', tags: ['生物', '必修一'], content: created.content });

    const appended = await study.notes.append(created.id, '## 暗反应\n卡尔文循环');
    expect(appended.content).toBe('叶绿体 吸收 zebraquartz 光能\n\n## 暗反应\n卡尔文循环');
    expect((await study.notes.get(created.id))!.content).toBe(appended.content);
    expect((eventsNamed('dstu:change') as { type: string }[]).filter((event) => event.type === 'updated').length).toBeGreaterThanOrEqual(2);

    await vi.waitFor(() => expect(saved.length).toBe(3));
    expect(saved[0]).toMatchObject({ noteId: created.id, created: true });
    expect(saved[2]).toMatchObject({ noteId: created.id, created: false });
    off();
  });

  it('validates input and reports missing notes', async () => {
    await expect(study.notes.create({ title: '   ' })).rejects.toThrow(/STUDY_DATA_INVALID: title/);
    await expect(study.notes.create({ title: 'x', tags: 'a' as never })).rejects.toThrow(/STUDY_DATA_INVALID: tags/);
    await expect(study.notes.update('note_missing', { title: 'x' })).rejects.toThrow(/STUDY_DATA_NOT_FOUND/);
    await expect(study.notes.append('note_missing', 'x')).rejects.toThrow(/STUDY_DATA_NOT_FOUND/);
    await expect(study.notes.list({ limit: 0 })).rejects.toThrow(/limit/);
    const note = await study.notes.create({ title: 'CAS' });
    await expect(study.notes.update(note.id, {})).rejects.toThrow(/STUDY_DATA_INVALID/);
    await expect(study.notes.update(note.id, { content: 'new', expectedUpdatedAt: '2000-01-01T00:00:00Z' })).rejects.toThrow();
  });
});

describe('studyData.cards and studyData.review', () => {
  it('creates a library card, enqueues it and reads it back from the library and the due queue', async () => {
    host!.events.length = 0;
    const card = await study.cards.create({ front: '细胞膜的主要成分？', back: '磷脂和蛋白质', tags: ['生物'] });
    expect(card).toMatchObject({ front: '细胞膜的主要成分？', back: '磷脂和蛋白质', tags: ['生物'], templateId: null });
    expect(card.review.enqueued).toBe(true);
    expect(card.review.stateId).not.toBeNull();
    const fsrs = eventsNamed('fsrs://changed') as { action: string; entityIds: string[] }[];
    expect(fsrs.map((event) => event.action)).toEqual(['cards_persisted', 'enqueue']);
    expect(fsrs[1]!.entityIds).toEqual([card.id]);

    expect(await study.cards.get(card.id)).toEqual(card);
    expect(await study.cards.get('missing-card')).toBeNull();
    expect((await study.cards.list({ search: '磷脂' })).map((item) => item.id)).toContain(card.id);

    const loose = await study.cards.create({ front: 'Q2', back: 'A2', enqueue: false });
    expect(loose.review.enqueued).toBe(false);
    expect((await study.cards.list({ status: 'notEnqueued' })).map((item) => item.id)).toContain(loose.id);
    expect(await study.review.enqueue([loose.id])).toEqual({ enqueued: 1, skipped: 0 });
    expect(await study.review.enqueue([loose.id])).toMatchObject({ enqueued: 0 });

    const stats = await study.review.stats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(typeof stats.reviewsToday).toBe('number');
    const due = await study.review.due({ limit: 50 });
    const entry = due.find((item) => item.cardId === card.id);
    expect(entry).toMatchObject({ stateId: card.review.stateId, front: card.front, state: 'new' });

    await expect(study.cards.create({ front: '', back: 'x' })).rejects.toThrow(/STUDY_DATA_INVALID: front/);
    await expect(study.cards.create({ front: 'x', back: 'y', templateId: 'no-such-template' })).rejects.toThrow(/STUDY_DATA_NOT_FOUND/);
    await expect(study.review.enqueue([])).rejects.toThrow(/STUDY_DATA_INVALID/);
  });

  it('pages the card library with offset/limit', async () => {
    for (let index = 0; index < 5; index += 1) await study.cards.create({ front: `page-${index}`, back: 'b', enqueue: false });
    const all = await study.cards.list({ search: 'page-', limit: 5 });
    expect(all).toHaveLength(5);
    const middle = await study.cards.list({ search: 'page-', limit: 2, offset: 1 });
    expect(middle.map((item) => item.id)).toEqual(all.slice(1, 3).map((item) => item.id));
  });
});

describe('studyData.questions', () => {
  it('lists question sets and creates, reads, lists and searches questions', async () => {
    const repos = host!.ctx.get('vfsRepo')!;
    const conn = host!.ctx.get('vfsDatabase')!.getConn();
    const sheet = repos.exams.createExamSheet(conn, {
      examName: '期中复习', tempId: 'temp_study_data', metadataJson: { status: 'empty', pageCount: 0, questionCount: 0 },
      previewJson: { temp_id: 'temp_study_data', exam_name: '期中复习', pages: [] }, status: 'empty',
    });
    expect((await study.questions.sets()).map((set) => set.id)).toContain(sheet.id);
    expect((await study.questions.sets({ search: '期中' }))[0]).toMatchObject({ id: sheet.id, title: '期中复习' });

    host!.events.length = 0;
    const question = await study.questions.create({
      setId: sheet.id, content: '下列哪项属于 mitochondrionxyz 的功能？', type: 'single_choice',
      options: [{ key: 'A', content: '有氧呼吸' }, { key: 'B', content: '光合作用' }], answer: 'A', tags: ['生物'],
    });
    expect(question).toMatchObject({ setId: sheet.id, type: 'single_choice', answer: 'A', status: 'new', attemptCount: 0 });
    expect(question.options).toHaveLength(2);
    expect(eventsNamed('qbank://changed')).toEqual([expect.objectContaining({ entityIds: [question.id] })]);

    expect(await study.questions.get(question.id)).toEqual(question);
    expect(await study.questions.get('missing-question')).toBeNull();
    expect((await study.questions.list({ setId: sheet.id })).map((item) => item.id)).toEqual([question.id]);
    expect((await study.questions.list()).map((item) => item.id)).toContain(question.id);
    expect((await study.questions.search('mitochondrionxyz')).map((item) => item.id)).toEqual([question.id]);
    expect((await study.questions.list({ search: 'mitochondrionxyz' })).map((item) => item.id)).toEqual([question.id]);

    await expect(study.questions.create({ setId: 'exam_missing', content: 'x' })).rejects.toThrow(/STUDY_DATA_NOT_FOUND/);
    await expect(study.questions.create({ setId: sheet.id, content: 'x', type: 'bogus' as never })).rejects.toThrow(/STUDY_DATA_INVALID: type/);
  });
});

describe('studyData.todos', () => {
  it('adds, lists, searches and completes user todos in the Todo app store', async () => {
    host!.events.length = 0;
    const todo = await study.todos.add({ title: '复习第三章', note: '重点看例题', dueDate: '2026-12-01', dueTime: '09:30', priority: 'high', tags: ['数学'] });
    expect(todo).toMatchObject({ title: '复习第三章', note: '重点看例题', done: false, priority: 'high', dueDate: '2026-12-01', dueTime: '09:30', tags: ['数学'] });
    const lists = await study.todos.lists();
    expect(lists.find((list) => list.id === todo.listId)?.isDefault).toBe(true);
    expect((await study.todos.list()).map((item) => item.id)).toContain(todo.id);
    expect((await study.todos.search('第三章')).map((item) => item.id)).toEqual([todo.id]);

    const done = await study.todos.complete(todo.id);
    expect(done.done).toBe(true);
    expect(done.completedAt).not.toBeNull();
    expect(await study.todos.complete(todo.id)).toEqual(done);
    expect((await study.todos.list()).map((item) => item.id)).not.toContain(todo.id);
    expect((await study.todos.list({ includeDone: true })).map((item) => item.id)).toContain(todo.id);
    expect((eventsNamed('todo://changed') as { action: string }[]).map((event) => event.action)).toEqual(['create', 'toggle']);

    await expect(study.todos.add({ title: 'x', dueDate: '12/01/2026' })).rejects.toThrow(/dueDate/);
    await expect(study.todos.add({ title: 'x', dueTime: '09:00' })).rejects.toThrow(/dueTime needs dueDate/);
    await expect(study.todos.complete('todo_missing')).rejects.toThrow(/STUDY_DATA_NOT_FOUND/);
  });
});

describe('studyData.resources', () => {
  it('lists, searches and reads resource library items', async () => {
    const note = await study.notes.create({ title: 'quokkaresource 笔记', content: '资料库正文 quokkaresource' });
    const notes = await study.resources.list({ type: 'note', limit: 200 });
    expect(notes.find((item) => item.id === note.id)).toMatchObject({ type: 'note', title: note.title });
    expect((await study.resources.list()).some((item) => item.id === note.id)).toBe(true);
    expect((await study.resources.search('quokkaresource')).map((item) => item.id)).toContain(note.id);
    expect(await study.resources.readText(note.id)).toBe('资料库正文 quokkaresource');
    await expect(study.resources.readText('fld_anything')).rejects.toThrow(/STUDY_DATA_INVALID/);
    await expect(study.resources.list({ type: 'bogus' as never })).rejects.toThrow(/STUDY_DATA_INVALID: type/);
  });
});

describe('studyData without the official services', () => {
  it('reports the missing service instead of failing obscurely', async () => {
    const bare = await createTestHost({ contracts: { only: [] } });
    try {
      const facade = createStudyDataService(bare.ctx);
      await expect(facade.notes.list()).rejects.toThrow('STUDY_DATA_UNAVAILABLE: notes service is not running');
      await expect(facade.cards.get('x')).rejects.toThrow('STUDY_DATA_UNAVAILABLE: anki service is not running');
      await expect(facade.review.stats()).rejects.toThrow('STUDY_DATA_UNAVAILABLE: review service is not running');
      await expect(facade.todos.lists()).rejects.toThrow('STUDY_DATA_UNAVAILABLE: vfsRepo service is not running');
      await expect(facade.resources.readText('note_x')).rejects.toThrow('STUDY_DATA_UNAVAILABLE: vfsDatabase service is not running');
    } finally {
      await bare.dispose();
    }
  });
});

describe('noteExcerpt', () => {
  it('strips markdown and centres on the first matching token', () => {
    expect(noteExcerpt('# 标题\n\n**粗体** 正文', '正文')).toBe('标题 粗体 正文');
    const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    const excerpt = noteExcerpt(long, 'needle');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt).toContain('needle');
  });
});
