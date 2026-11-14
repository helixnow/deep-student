import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { configureNotesRepository, extractNoteLinks, makeSearchSnippet, noteRepository } from '../repository/notes.ts';
import { malformedPropsTotal, propVectors } from '../repository/props.ts';
import { NoteDocumentError } from '../repository/errors.ts';
import { configureNotesLogger } from '../repository/log.ts';
import { backfillNoteLinksAtStartup } from '../src/note-links-backfill.ts';
import type { VfsNote } from '../api.ts';
import paths from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../index.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
type Storage = ReturnType<typeof createStorageService>;

let host: Host;
let storage: Storage;

// One migrated database per file: repeated WAL migrations dominate the external
// volume and made per-test temp databases flaky. Each test starts from empty tables.
beforeAll(async () => {
  host = await createTestHost();
  storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
  await storage.migrations.runAll();
  host.ctx.provide('storage', storage);
  host.ctx.provide('settings', createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  }));
  // R5 N4: the real L11 vfsRepo service, wired by the production notes plugin,
  // instead of a test copy of L11's resource/index SQL.
  await host.install(paths, vfsRepos, notes);
}, 120000);

afterAll(async () => {
  configureNotesRepository(null);
  await host.dispose();
  storage.dispose();
});

beforeEach(() => {
  const database = storage.database('vfs');
  database.exec(`PRAGMA foreign_keys=OFF;
    DELETE FROM note_document_revisions;
    DELETE FROM note_document_formats;
    DELETE FROM note_state;
    DELETE FROM note_learning_relations;
    DELETE FROM note_transfer_operations;
    DELETE FROM note_review_save_receipts;
    DELETE FROM note_review_save_operations;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM note_editor_lease_acks;
    DELETE FROM note_editor_write_grants;
    DELETE FROM note_editor_lease_notes;
    DELETE FROM note_editor_leases;
    DELETE FROM note_editor_participants;
    DELETE FROM folder_items;
    DELETE FROM notes;
    DELETE FROM vfs_index_segments;
    DELETE FROM vfs_index_units;
    DELETE FROM __lance_orphan_queue;
    DELETE FROM __change_log;
    DELETE FROM vfs_indexing_config;
    DELETE FROM resources;
    PRAGMA foreign_keys=ON;
    INSERT INTO notes_fts(notes_fts) VALUES('delete-all');`);
}, 30000);

function withNotes(run: (_host: Host, storage: Storage) => Promise<void> | void): Promise<void> | void {
  return run(host, storage);
}

function db(storage: Storage) {
  return storage.database('vfs');
}

function create(storage: Storage, title: string, content: string, tags: string[] = []): VfsNote {
  return noteRepository.createNote({ title, content, tags }, db(storage));
}

function createSimple(storage: Storage, title: string, content: string): VfsNote {
  return create(storage, title, content);
}

function countNoteResources(storage: Storage): number {
  return Number(db(storage).get<{ count: number }>("SELECT COUNT(*) AS count FROM resources WHERE type='note'")?.count ?? 0);
}

describe('note_repo', () => {
  it('test_create_note', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '测试笔记', '# 测试内容\n\n这是一个测试笔记。', ['测试', '数学']);
      expect(note.id).not.toBe('');
      expect(note.title).toBe('测试笔记');
      expect(note.tags).toEqual(['测试', '数学']);
      expect(note.isFavorite).toBe(false);
    });
  });

  it('test_get_note_content', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '测试笔记', '# 测试内容');
      expect(noteRepository.getNoteContent(note.id, db(storage))).toBe('# 测试内容');
    });
  });

  it('test_update_note_changes_resource_on_content_change', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '原始标题', '原始内容', ['v1']);
      const original = note.resourceId;
      const updated = noteRepository.updateNote(note.id, {
        content: '新内容', title: '新标题', tags: ['v2'],
      }, db(storage));
      expect(updated.resourceId).not.toBe(original);
      expect(updated.title).toBe('新标题');
      expect(updated.tags).toEqual(['v2']);
      expect(noteRepository.getNoteContent(note.id, db(storage))).toBe('新内容');
    });
  });

  it('test_update_note_keeps_resource_when_content_unchanged', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '标题', '内容');
      const updated = noteRepository.updateNote(note.id, { title: '新标题' }, db(storage));
      expect(updated.resourceId).toBe(note.resourceId);
      expect(updated.title).toBe('新标题');
      expect(noteRepository.getNoteContent(note.id, db(storage))).toBe('内容');
    });
  });

  it('test_soft_delete_and_restore', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '测试笔记', '内容');
      noteRepository.deleteNote(note.id, db(storage));
      expect(noteRepository.getNote(note.id, db(storage))).toBeNull();
      expect(noteRepository.getNoteIncludingDeleted(note.id, db(storage))?.deletedAt).not.toBeNull();
      noteRepository.restoreNote(note.id, db(storage));
      expect(noteRepository.getNote(note.id, db(storage))?.deletedAt).toBeNull();
    });
  });

  it('test_list_all_notes', async () => {
    await withNotes((_host, storage) => {
      create(storage, '数学笔记', '数学内容');
      create(storage, '物理笔记', '物理内容');
      expect(noteRepository.listNotes(null, 10, 0, db(storage))).toHaveLength(2);
    });
  });

  it('test_update_note_reclaims_old_resources', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '演进笔记', 'v1');
      for (const content of ['v2', 'v3', 'v4', 'v5']) {
        noteRepository.updateNote(note.id, { content }, db(storage));
      }
      expect(countNoteResources(storage)).toBe(1);
    });
  });

  it('test_search_notes_fts_and_like_fallback', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, 'Calculus Notes', 'The derivative measures instantaneous change. 微积分基础。');
      create(storage, 'Unrelated', 'nothing to see here');
      const hits = noteRepository.searchNotesWithSnippets('derivative', 10, db(storage));
      expect(hits).toHaveLength(1);
      expect(hits[0]![0].id).toBe(note.id);
      expect(hits[0]![1]).toContain('derivative');
      const chinese = noteRepository.searchNotesWithSnippets('微积分', 10, db(storage));
      expect(chinese).toHaveLength(1);
      expect(chinese[0]![0].id).toBe(note.id);
      expect(noteRepository.searchNotesWithSnippets('微积', 10, db(storage))).toHaveLength(1);
      const listed = noteRepository.listNotes('derivative', 10, 0, db(storage));
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(note.id);
    });
  });

  it('test_fts_index_follows_soft_delete_and_restore', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, 'Quantum', 'superposition entanglement');
      noteRepository.deleteNote(note.id, db(storage));
      expect(noteRepository.searchNotesWithSnippets('entanglement', 10, db(storage))).toHaveLength(0);
      noteRepository.restoreNote(note.id, db(storage));
      expect(noteRepository.searchNotesWithSnippets('entanglement', 10, db(storage))).toHaveLength(1);
    });
  });

  it('test_fts_index_follows_content_update', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, 'Draft', 'original wording');
      noteRepository.updateNote(note.id, { content: 'revised phrasing' }, db(storage));
      expect(noteRepository.searchNotesWithSnippets('revised', 10, db(storage))).toHaveLength(1);
      expect(noteRepository.searchNotesWithSnippets('original wording', 10, db(storage))).toHaveLength(0);
    });
  });

  it('test_list_tags_uses_normalized_table', async () => {
    await withNotes((_host, storage) => {
      for (let index = 0; index < 3; index += 1) create(storage, `math ${index}`, 'x', ['数学']);
      const physics = create(storage, 'physics', 'y', ['物理', ' 数学 ']);
      const tags = noteRepository.listTags(10, db(storage));
      expect(tags[0]).toBe('数学');
      expect(tags).toContain('物理');
      noteRepository.deleteNote(physics.id, db(storage));
      expect(noteRepository.listTags(10, db(storage))).not.toContain('物理');
    });
  });

  it('test_purge_note_removes_all_owned_resources', async () => {
    await withNotes((_host, storage) => {
      const note = create(storage, '购物清单', '牛奶');
      noteRepository.updateNote(note.id, { content: '牛奶+面包' }, db(storage));
      noteRepository.purgeNote(note.id, db(storage));
      expect(countNoteResources(storage)).toBe(0);
    });
  });

  it('test_extract_note_links_syntax_matrix', () => {
    const content = '前言 [[目标笔记]] 中段 [[Target#Section|别名]]\n还有 [标签](note://note_abc123) 与空锚点 [[#local]] 结尾';
    const links = extractNoteLinks(content);
    expect(links).toHaveLength(3);
    expect(links[0]!.raw_target).toBe('目标笔记');
    expect(links[0]!.kind).toBe('wikilink');
    expect(links[0]!.heading).toBeNull();
    expect(links[0]!.alias).toBeNull();
    expect(links[1]!.raw_target).toBe('Target');
    expect(links[1]!.heading).toBe('Section');
    expect(links[1]!.alias).toBe('别名');
    expect(links[2]!.raw_target).toBe('note_abc123');
    expect(links[2]!.kind).toBe('noteref');
    expect(links[0]!.position).toBeLessThan(links[1]!.position);
    expect(links[1]!.position).toBeLessThan(links[2]!.position);
  });

  it('test_extract_note_links_skips_code_regions', () => {
    const content = '正文 [[真实链接]]\n```rust\nlet a = "[[代码里的假链接]]"; // note://note_fake1\n```\n行内 `[[行内代码假链接]]` 与 `note://note_fake2` 之后\n又一个 [[结尾链接]] 和 note://note_real9';
    expect(extractNoteLinks(content).map((link) => link.raw_target)).toEqual(['真实链接', '结尾链接', 'note_real9']);
    const unclosed = '开头 [[可见]]\n```\n[[被吞的]] note://note_x\n';
    expect(extractNoteLinks(unclosed).map((link) => link.raw_target)).toEqual(['可见']);
    const tilde = '~~~\n[[假]]\n~~~\n[[真]]';
    expect(extractNoteLinks(tilde).map((link) => link.raw_target)).toEqual(['真']);
    const dangling = '一个 ` 反引号 [[仍是链接]]';
    expect(extractNoteLinks(dangling).map((link) => link.raw_target)).toEqual(['仍是链接']);
  });

  it('test_make_search_snippet_utf8_boundaries', () => {
    const body = `${'汉'.repeat(300)}目标关键词${'字'.repeat(300)}`;
    const snippet = makeSearchSnippet(body, '目标关键词', 40)!;
    expect(snippet).toContain('目标关键词');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect([...snippet].length).toBeLessThanOrEqual(42);
    expect(makeSearchSnippet('短正文 emoji 🎯 结尾', '🎯', 160)).toBe('短正文 emoji 🎯 结尾');
    const truncated = makeSearchSnippet('a'.repeat(500), '不存在', 10)!;
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.startsWith('…')).toBe(false);
  });

  it('test_title_and_tags_validation', async () => {
    await withNotes((_host, storage) => {
      expect(() => create(storage, '长'.repeat(501), 'x')).toThrow(NoteDocumentError);
      expect(() => create(storage, '第一行\n第二行', 'x')).toThrow(NoteDocumentError);
      expect(create(storage, 'a\tb', 'x').title).toBe('a\tb');
      expect(() => create(storage, '正常标题', 'x', ['t'.repeat(101)])).toThrow(NoteDocumentError);
    });
  });

  it('test_note_links_resolution_backlinks_and_unresolved', async () => {
    await withNotes((_host, storage) => {
      const target = createSimple(storage, '微积分基础', '目标正文');
      const sourceContent = `先看 [[微积分基础]]，再看 [[note://占位]] 之外的 note://${target.id}，最后 [[尚未创建的笔记]]`;
      const source = createSimple(storage, '复习计划', sourceContent);
      noteRepository.replaceNoteLinksFromContent(source.id, sourceContent, db(storage));
      const outgoing = noteRepository.outgoingLinksFor(source.id, db(storage));
      expect(outgoing.length).toBeGreaterThanOrEqual(3);
      const resolved = outgoing.filter((link) => link.resolved);
      expect(resolved).toHaveLength(2);
      expect(resolved.every((link) => link.targetId === target.id)).toBe(true);
      const backlinks = noteRepository.backlinksFor(target.id, db(storage));
      expect(backlinks).toHaveLength(2);
      expect(backlinks.every((link) => link.sourceId === source.id)).toBe(true);
      expect(noteRepository.unresolvedLinks(50, db(storage)).some((link) => link.sourceId === source.id && link.targetTitle === '尚未创建的笔记')).toBe(true);
      const late = createSimple(storage, '尚未创建的笔记', 'later');
      expect(noteRepository.outgoingLinksFor(source.id, db(storage)).some((link) => link.targetId === late.id)).toBe(true);
    });
  });

  it('test_note_links_purge_target_downgrades_to_unresolved', async () => {
    await withNotes((_host, storage) => {
      const target = createSimple(storage, 'Quantum', 'body');
      const source = createSimple(storage, 'Index', 'see [[Quantum]]');
      noteRepository.replaceNoteLinksFromContent(source.id, 'see [[Quantum]]', db(storage));
      noteRepository.purgeNote(target.id, db(storage));
      const outgoing = noteRepository.outgoingLinksFor(source.id, db(storage));
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.resolved).toBe(false);
      expect(outgoing[0]!.targetId).toBeNull();
      noteRepository.purgeNote(source.id, db(storage));
      expect(Number(db(storage).get<{ count: number }>('SELECT COUNT(*) AS count FROM note_links WHERE source_id=?1', [source.id])?.count)).toBe(0);
    });
  });

  it('test_rebuild_note_links_and_unlinked_mentions', async () => {
    await withNotes((_host, storage) => {
      const hub = createSimple(storage, '知识中枢', 'hub body');
      const linked = createSimple(storage, '已链接', '指向 [[知识中枢]] 的笔记');
      const mentioning = createSimple(storage, '只提及', '正文提到了知识中枢但没有加链接');
      createSimple(storage, '无关', 'nothing here');
      const rebuilt = noteRepository.rebuildNoteLinks(2);
      expect(rebuilt.noteCount).toBe(4);
      expect(rebuilt.linkCount).toBeGreaterThanOrEqual(1);
      const backlinks = noteRepository.backlinksFor(hub.id, db(storage));
      expect(backlinks).toHaveLength(1);
      expect(backlinks[0]!.sourceId).toBe(linked.id);
      const ids = noteRepository.unlinkedMentionCandidates(hub.id, 10, db(storage)).map(([note]) => note.id);
      expect(ids).toContain(mentioning.id);
      expect(ids).not.toContain(linked.id);
      expect(ids).not.toContain(hub.id);
    });
  });

  it('test_create_note_maintains_links_in_repo_layer', async () => {
    await withNotes((_host, storage) => {
      const target = createSimple(storage, '目标笔记', 'target body');
      const source = createSimple(storage, '来源笔记', `参考 [[目标笔记]] 与 note://${target.id}`);
      const outgoing = noteRepository.outgoingLinksFor(source.id, db(storage));
      expect(outgoing).toHaveLength(2);
      expect(outgoing.every((link) => link.resolved && link.targetId === target.id)).toBe(true);
      const backlinks = noteRepository.backlinksFor(target.id, db(storage));
      expect(backlinks).toHaveLength(2);
      // X6-AP-0356: note_repo.rs:3816 checks identity, not just backlink count.
      expect(backlinks.every((link) => link.sourceId === source.id)).toBe(true);
    });
  });

  it('test_update_note_refreshes_links_in_repo_layer', async () => {
    await withNotes((_host, storage) => {
      const alpha = createSimple(storage, 'Alpha', 'a');
      const beta = createSimple(storage, 'Beta', 'b');
      const source = createSimple(storage, '来源', '见 [[Alpha]]');
      noteRepository.updateNote(source.id, { content: '改为 [[Beta]]' }, db(storage));
      const outgoing = noteRepository.outgoingLinksFor(source.id, db(storage));
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.targetId).toBe(beta.id);
      expect(noteRepository.backlinksFor(alpha.id, db(storage))).toHaveLength(0);
    });
  });

  it('test_update_note_unchanged_content_and_title_only_skip_link_refresh', async () => {
    await withNotes((_host, storage) => {
      createSimple(storage, 'Alpha', 'a');
      const content = '见 [[Alpha]]';
      const source = createSimple(storage, '来源', content);
      const clear = () => db(storage).run('DELETE FROM note_links WHERE source_id=?1', [source.id]);
      clear();
      noteRepository.updateNote(source.id, { content }, db(storage));
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(0);
      noteRepository.updateNote(source.id, { title: '来源改名' }, db(storage));
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(0);
      noteRepository.updateNote(source.id, { content: '还是见 [[Alpha]] 但内容变了' }, db(storage));
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(1);
    });
  });

  it('test_soft_delete_and_restore_preserve_outgoing_links', async () => {
    await withNotes((_host, storage) => {
      const target = createSimple(storage, '被引用', 't');
      const source = createSimple(storage, '引用者', '见 [[被引用]]');
      noteRepository.deleteNote(source.id, db(storage));
      expect(Number(db(storage).get<{ count: number }>('SELECT COUNT(*) AS count FROM note_links WHERE source_id=?1', [source.id])?.count)).toBe(1);
      noteRepository.restoreNote(source.id, db(storage));
      const outgoing = noteRepository.outgoingLinksFor(source.id, db(storage));
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0]!.targetId).toBe(target.id);
    });
  });

  it('test_backfill_note_links_once_flag_and_retry_semantics', async () => {
    await withNotes((_host, storage) => {
      createSimple(storage, '枢纽', 'hub');
      const source = createSimple(storage, '来源', '见 [[枢纽]]');
      db(storage).run('DELETE FROM note_links', []);
      expect(noteRepository.backfillNoteLinksOnce(100)).toBe(true);
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(1);
      db(storage).run('DELETE FROM note_links', []);
      expect(noteRepository.backfillNoteLinksOnce(100)).toBe(false);
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(0);
    });
  });

  // The startup sweep (startup-sweep.test.ts) calls this last, under the DeletePropagation permit.
  it('test_startup_note_links_backfill_runs_once_in_batches_of_500', async () => {
    await withNotes((_host, storage) => {
      createSimple(storage, '枢纽', 'hub');
      const source = createSimple(storage, '来源', '见 [[枢纽]]');
      db(storage).run('DELETE FROM note_links', []);
      const backfill = vi.spyOn(noteRepository, 'backfillNoteLinksOnce');
      try {
        expect(backfillNoteLinksAtStartup()).toBe(true);
        expect(backfill).toHaveBeenCalledTimes(1);
        expect(backfill).toHaveBeenCalledWith(500);
      } finally {
        backfill.mockRestore();
      }
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(1);
      expect(db(storage).get<{ value: string }>(
        "SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'")?.value).toBe('true');
    });
  });

  it('test_startup_note_links_backfill_failure_warns_and_retries_next_launch', async () => {
    await withNotes((_host, storage) => {
      createSimple(storage, '枢纽', 'hub');
      const source = createSimple(storage, '来源', '见 [[枢纽]]');
      db(storage).run('DELETE FROM note_links', []);
      const warnings: string[] = [];
      configureNotesLogger({ error() {}, warn: (message) => warnings.push(message), info() {}, debug() {} });
      const backfill = vi.spyOn(noteRepository, 'backfillNoteLinksOnce')
        .mockImplementationOnce(() => { throw new Error('disk I/O error'); });
      try {
        expect(() => backfillNoteLinksAtStartup()).not.toThrow();
      } finally {
        backfill.mockRestore();
        configureNotesLogger(host.ctx.logger('notes'));
      }
      expect(warnings).toEqual(['[AppSetup] Note links backfill failed (will retry next launch): disk I/O error']);
      expect(db(storage).get<{ value: string }>(
        "SELECT value FROM vfs_indexing_config WHERE key='maintenance.note_links_backfill_done'")).toBeUndefined();
      expect(backfillNoteLinksAtStartup()).toBe(true);
      expect(noteRepository.outgoingLinksFor(source.id, db(storage))).toHaveLength(1);
    });
  });

  it('test_search_notes_by_tags_with_snippets_exact_and_keyword', async () => {
    await withNotes((_host, storage) => {
      create(storage, 'math note', 'derivative rules', ['math', 'study']);
      create(storage, 'math2 note', 'unrelated', ['math2']);
      let hits = noteRepository.searchNotesByTags(null, ['math'], 10, db(storage));
      expect(hits).toHaveLength(1);
      expect(hits[0]![0].title).toBe('math note');
      hits = noteRepository.searchNotesByTags('derivative', ['math', 'study'], 10, db(storage));
      expect(hits).toHaveLength(1);
      expect(hits[0]![1]).toContain('derivative');
      expect(noteRepository.searchNotesByTags('nonexistent', ['math'], 10, db(storage))).toHaveLength(0);
      expect(noteRepository.noteIdsWithAllTags(['math', 'study'], db(storage))).toHaveLength(1);
    });
  });

  it('test_search_note_titles_prefers_prefix', async () => {
    await withNotes((_host, storage) => {
      createSimple(storage, '线性代数', 'a');
      createSimple(storage, '高等线性代数进阶', 'b');
      createSimple(storage, '别的', 'c');
      const hits = noteRepository.searchNoteTitles('线性代数', 10, db(storage));
      expect(hits).toHaveLength(2);
      expect(hits[0]!.title).toBe('线性代数');
    });
  });

  it('test_set_note_props_roundtrip_and_updated_at', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '属性宿主', '正文');
      expect(note.props).toBeNull();
      const updated = noteRepository.setNoteProps(note.id, { ' status ': 'in progress', priority: 2, pinned: true }, db(storage));
      const props = updated.props as Record<string, unknown>;
      expect(props.status).toBe('in progress');
      expect(props.priority).toBe(2);
      expect(props.pinned).toBe(true);
      expect(updated.updatedAt > note.updatedAt).toBe(true);
      expect(noteRepository.getNote(note.id, db(storage))!.props).toEqual(updated.props);
      expect(noteRepository.listNotes(null, 10, 0, db(storage))[0]!.props).toEqual(updated.props);
      const replaced = noteRepository.setNoteProps(note.id, { status: 'done' }, db(storage));
      expect((replaced.props as Record<string, unknown>).priority).toBeUndefined();
      const cleared = noteRepository.setNoteProps(note.id, {}, db(storage));
      expect(cleared.props).toBeNull();
      expect(noteRepository.getNote(note.id, db(storage))!.props).toBeNull();
    });
  });

  it('test_set_note_props_validation', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '属性校验', '正文');
      const bad = (props: unknown) => () => noteRepository.setNoteProps(note.id, props, db(storage));
      expect(bad([1, 2])).toThrow(NoteDocumentError);
      expect(bad({ Tags: 'x' })).toThrow(NoteDocumentError);
      expect(bad({ '  ': 'x' })).toThrow(NoteDocumentError);
      expect(bad({ meta: { nested: true } })).toThrow(NoteDocumentError);
      expect(bad({ ' Status ': 'draft', status: 'done' })).toThrow(NoteDocumentError);
      expect(bad({ key: 'v'.repeat(513) })).toThrow(NoteDocumentError);
      const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 'v']));
      expect(bad(tooMany)).toThrow(NoteDocumentError);
      expect(noteRepository.getNote(note.id, db(storage))!.props).toBeNull();
    });
  });

  it('test_update_note_metadata_is_atomic_and_honors_occ', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '原标题', '正文');
      const updated = noteRepository.updateNoteMetadata(note.id, {
        title: '新标题', tags: ['math'], isFavorite: true, props: { status: 'done' },
        expectedUpdatedAt: note.updatedAt,
      }, db(storage));
      expect(updated.title).toBe('新标题');
      expect(updated.tags).toEqual(['math']);
      expect(updated.isFavorite).toBe(true);
      expect((updated.props as Record<string, unknown>).status).toBe('done');
      expect(() => noteRepository.updateNoteMetadata(note.id, {
        title: '不应写入', expectedUpdatedAt: note.updatedAt,
      }, db(storage))).toThrow(NoteDocumentError);
      expect(noteRepository.getNote(note.id, db(storage))!.title).toBe('新标题');
      expect(() => noteRepository.updateNoteMetadata(note.id, {
        title: '半成品标题', props: { nested: { bad: true } },
      }, db(storage))).toThrow(NoteDocumentError);
      expect(noteRepository.getNote(note.id, db(storage))!.title).toBe('新标题');

      db(storage).exec(`CREATE TRIGGER reject_unprovided_note_metadata
        BEFORE UPDATE OF tags, is_favorite, props ON notes
        WHEN OLD.id = '${note.id.replace(/'/g, "''")}'
        BEGIN SELECT RAISE(ABORT, 'omitted metadata column was assigned'); END;`);
      const titleOnly = noteRepository.updateNoteMetadata(note.id, { title: '仅标题更新' }, db(storage));
      expect(titleOnly.title).toBe('仅标题更新');
      expect(titleOnly.tags).toEqual(['math']);
      expect(titleOnly.isFavorite).toBe(true);
      expect((titleOnly.props as Record<string, unknown>).status).toBe('done');
    });
  });

  it('test_props_survive_metadata_and_content_updates', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '属性保持', '旧内容');
      noteRepository.setNoteProps(note.id, { status: 'done' }, db(storage));
      const updated = noteRepository.updateNote(note.id, {
        content: '新内容', title: '新标题', tags: ['t'],
      }, db(storage));
      expect((updated.props as Record<string, unknown>).status).toBe('done');
      expect(noteRepository.getNote(note.id, db(storage))!.props).toEqual(updated.props);
    });
  });

  it('test_row_to_note_malformed_props_fall_back_with_trace', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '畸形属性宿主', '正文');
      const inject = (raw: string) => db(storage).run('UPDATE notes SET props=?1 WHERE id=?2', [raw, note.id]);
      for (const raw of ['not-json{', '[1,2]', '"scalar"', '{}']) {
        inject(raw);
        const before = malformedPropsTotal();
        expect(noteRepository.getNote(note.id, db(storage))!.props).toBeNull();
        expect(malformedPropsTotal()).toBeGreaterThan(before);
      }
      inject('{"status":"done","priority":2}');
      const before = malformedPropsTotal();
      const props = noteRepository.getNote(note.id, db(storage))!.props as Record<string, unknown>;
      expect(props.priority).toBe(2);
      expect(malformedPropsTotal()).toBe(before);
    });
  });

  it('test_note_props_shared_key_vectors_round_trip_write_side', async () => {
    await withNotes((_host, storage) => {
      const note = createSimple(storage, '共享向量宿主', '正文');
      const valid: Record<string, string> = {};
      for (const key of propVectors.validOperatorKeys) valid[key] = 'v';
      for (const key of propVectors.storableButNotOperatorSearchable) valid[key] = 'v';
      delete valid.Status;
      expect(() => noteRepository.setNoteProps(note.id, valid, db(storage))).not.toThrow();
      for (const [key] of propVectors.invalidKeys) {
        expect(() => noteRepository.setNoteProps(note.id, { [key]: 'v' }, db(storage))).toThrow(NoteDocumentError);
      }
      expect(() => noteRepository.setNoteProps(note.id, { [propVectors.overlongKey()]: 'v' }, db(storage))).toThrow(NoteDocumentError);
    });
  });
});
