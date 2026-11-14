import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMaxSizeBytes, validateFileSize, type SearchAllInput } from '../src/resources.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const repos = () => vfs.host.ctx.vfsRepo;
const db = () => vfs.storage.database('vfs');

describe('vfs/handlers.rs resource commands', { timeout: 120_000 }, () => {
  it('test_file_size_validation', () => {
    expect(() => validateFileSize('image', 'x'.repeat(1024))).not.toThrow();

    // #221：Image 上限已放宽到 50MB，10MB 级别的数据应当成功
    expect(() => validateFileSize('image', 'x'.repeat(10 * 1024 * 1024))).not.toThrow();

    // 超过 Image 上限（随常量走，避免上限调整时测试失真）
    expect(() => validateFileSize('image', 'x'.repeat(getMaxSizeBytes('image') + 1)))
      .toThrow('File too large: image type max 50MB');

    expect(() => validateFileSize('file', 'x'.repeat(20 * 1024 * 1024))).not.toThrow();
    // File 也有上限
    expect(() => validateFileSize('file', 'x'.repeat(getMaxSizeBytes('file') + 1)))
      .toThrow('File too large: file type max 200MB');
  });

  it('test_compute_hash', () => {
    // Rust 的私有 compute_hash 只被测试使用；命令层经 L11 resources.computeHash 生成
    // 去重哈希，语义相同（sha2::Sha256 十六进制小写）。
    const resources = repos().resources;
    const hash1 = resources.computeHash('hello world');
    const hash2 = resources.computeHash('hello world');
    const hash3 = resources.computeHash('hello world!');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test_max_size_bytes', () => {
    expect(getMaxSizeBytes('image')).toBe(50 * 1024 * 1024);
    expect(getMaxSizeBytes('file')).toBe(200 * 1024 * 1024);
    expect(getMaxSizeBytes('note')).toBe(50 * 1024 * 1024);
    expect(getMaxSizeBytes('translation')).toBe(10 * 1024 * 1024);
    expect(getMaxSizeBytes('retrieval')).toBe(10 * 1024 * 1024);
    expect(getMaxSizeBytes('exam')).toBe(50 * 1024 * 1024);
    expect(getMaxSizeBytes('textbook')).toBe(50 * 1024 * 1024);
    expect(getMaxSizeBytes('essay')).toBe(10 * 1024 * 1024);
    expect(getMaxSizeBytes('mindmap')).toBe(50 * 1024 * 1024);
    expect(getMaxSizeBytes('insightcard')).toBe(10 * 1024 * 1024);
  });

  it('test_create_resource_input_deserialization', async () => {
    const result = await invoke<{ resourceId: string; hash: string; isNew: boolean }>(
      'vfs_create_or_reuse',
      { params: { type: 'note', data: 'test content', sourceId: 'note_123' } },
    );
    expect(result.resourceId.startsWith('res_')).toBe(true);
    expect(result.hash).toHaveLength(64);
    expect(result.isNew).toBe(true);
    expect(db().get(
      'SELECT type, source_id, data FROM resources WHERE id = ?1', [result.resourceId],
    )).toEqual({ type: 'note', source_id: 'note_123', data: 'test content' });

    const reused = await invoke<{ resourceId: string; hash: string; isNew: boolean }>(
      'vfs_create_or_reuse',
      { params: { type: 'note', data: 'test content' } },
    );
    expect(reused).toMatchObject({ resourceId: result.resourceId, hash: result.hash, isNew: false });
  });

  it('rejects unknown resource types and preserves reference counts', async () => {
    const error = await invoke('vfs_create_or_reuse', {
      params: { type: 'unknown-kind', data: 'x' },
    }).catch((problem: unknown) => problem);
    expect(error).toBe("Invalid argument 'type': Invalid resource type: unknown-kind");

    const created = await invoke<{ resourceId: string }>('vfs_create_or_reuse', {
      params: { type: 'image', data: 'refcount-data' },
    });
    expect(await invoke('vfs_resource_exists', { resourceId: created.resourceId })).toBe(true);
    expect(await invoke('vfs_increment_ref', { resourceId: created.resourceId })).toBeNull();
    expect(await invoke('vfs_increment_ref', { resourceId: created.resourceId })).toBeNull();
    expect(await invoke('vfs_get_resource', { resourceId: created.resourceId }))
      .toMatchObject({ id: created.resourceId, type: 'image', refCount: 2 });
    expect(await invoke('vfs_decrement_ref', { resourceId: created.resourceId })).toBeNull();
    expect(await invoke('vfs_get_resource', { resourceId: created.resourceId }))
      .toMatchObject({ refCount: 1 });
    expect(await invoke('vfs_resource_exists', { resourceId: 'res_missing' })).toBe(false);
  });

  it('test_resource_id_format_validation', async () => {
    // 有效的资源 ID 前缀
    expect(await invoke('vfs_get_resource', { resourceId: 'res_abc123' })).toBeNull();
    expect(await invoke('vfs_get_resource', { resourceId: 'res_1234567890' })).toBeNull();
    // 无效的资源 ID 前缀
    await expect(invoke('vfs_get_resource', { resourceId: 'note_abc123' }))
      .rejects.toBe("Invalid argument 'resource_id': Invalid resource_id format: note_abc123");
    await expect(invoke('vfs_get_resource', { resourceId: 'abc123' }))
      .rejects.toBe("Invalid argument 'resource_id': Invalid resource_id format: abc123");
    await expect(invoke('vfs_increment_ref', { resourceId: 'note_abc123' }))
      .rejects.toBe("Invalid argument 'resource_id': Invalid resource_id format: note_abc123");
  });

  it('vfs_resource_exists returns false without touching the database for foreign ids', async () => {
    // Rust: `if !resource_id.starts_with("res_") { return Ok(false); }`
    expect(await invoke('vfs_resource_exists', { resourceId: 'note_abc123' })).toBe(false);
    expect(await invoke('vfs_resource_exists', { resourceId: 'abc123' })).toBe(false);
  });

  it('insight_card resources serialize with the serde spelling', async () => {
    const created = await invoke<{ resourceId: string }>('vfs_create_or_reuse', {
      params: { type: 'insight_card', data: '{"snapshot":true}' },
    });
    expect(await invoke('vfs_get_resource', { resourceId: created.resourceId }))
      .toMatchObject({ type: 'insightcard' });
    expect(db().pluck('SELECT type FROM resources WHERE id = ?1', [created.resourceId]))
      .toBe('insight_card');
  });
});

describe('vfs/handlers.rs list and search commands', { timeout: 120_000 }, () => {
  async function seedLibrary(): Promise<{
    noteId: string; examId: string; translationId: string; essayId: string; textbookId: string;
  }> {
    const note = await invoke<{ id: string }>('vfs_create_note', {
      params: { title: '期末复习笔记', content: '函数与导数' },
    });
    const exam = repos().exams.createExamSheet(db(), {
      examName: '期末复习卷', tempId: 'temp_l13b', metadataJson: {}, previewJson: { pages: [] },
      status: 'completed', folderId: null,
    });
    const translation = repos().translations.createTranslation(db(), {
      source: '期末复习', translated: 'final review', srcLang: 'zh', tgtLang: 'en',
    });
    const essay = repos().essays.createEssay(db(), { title: '期末复习作文', content: '期末复习' });
    const textbook = repos().textbooks.createTextbook(db(), 'sha_l13b', '数学教材.pdf', 1024, null, null);
    return {
      noteId: note.id, examId: exam.id, translationId: translation.id,
      essayId: essay.id, textbookId: textbook.id,
    };
  }

  it('test_list_input_defaults', async () => {
    const seeded = await seedLibrary();
    // params 缺省 = ListInput::default(): search=None, limit=50, offset=0
    const byDefault = await invoke<Array<{ id: string }>>('vfs_list_notes');
    expect(byDefault.map(note => note.id)).toContain(seeded.noteId);
    expect(await invoke('vfs_list_notes', { params: null })).toHaveLength(byDefault.length);
    expect(await invoke('vfs_list_notes', { params: {} })).toHaveLength(byDefault.length);
    expect(await invoke('vfs_list_notes', { params: { limit: 50, offset: 0 } })).toHaveLength(byDefault.length);
    expect(await invoke('vfs_list_textbooks', { params: {} })).toHaveLength(1);

    // offset 在 limit 之前生效
    await invoke('vfs_create_note', { params: { title: '第二篇', content: 'b' } });
    const firstPage = await invoke<Array<{ id: string }>>('vfs_list_notes', { params: { limit: 1 } });
    const secondPage = await invoke<Array<{ id: string }>>('vfs_list_notes', { params: { limit: 1, offset: 1 } });
    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]!.id).not.toBe(firstPage[0]!.id);
  });

  it('vfs_list_* maps the Rust search argument per repository', async () => {
    const seeded = await seedLibrary();
    expect((await invoke<Array<{ id: string }>>('vfs_list_textbooks', { params: { search: '  数学  ' } }))
      .map(row => row.id)).toEqual([seeded.textbookId]);
    expect(await invoke('vfs_list_textbooks', { params: { search: '   ' } })).toHaveLength(1);
    expect((await invoke<Array<{ id: string }>>('vfs_list_exam_sheets', { params: { search: '期末' } }))
      .map(row => row.id)).toEqual([seeded.examId]);
    expect((await invoke<Array<{ id: string }>>('vfs_list_translations', { params: { search: '期末' } }))
      .map(row => row.id)).toEqual([seeded.translationId]);
    expect((await invoke<Array<{ id: string }>>('vfs_list_essays', { params: { search: '期末' } }))
      .map(row => row.id)).toEqual([seeded.essayId]);
    expect(await invoke('vfs_list_exam_sheets', { params: { search: '不存在' } })).toEqual([]);
  });

  it('test_search_all_input_deserialization', async () => {
    const seeded = await seedLibrary();
    const input: SearchAllInput = { query: '期末复习', types: ['note', 'exam'], limit: 20 };
    const results = await invoke<Array<{ id: string; type: string }>>('vfs_search_all', { params: input });
    expect(results.map(row => row.id).sort()).toEqual([seeded.noteId, seeded.examId].sort());
    expect(new Set(results.map(row => row.type))).toEqual(new Set(['note', 'exam']));
  });

  it('test_search_all_cross_type_params', async () => {
    const seeded = await seedLibrary();
    // 不指定 types = 搜索全部类型
    const all = await invoke<Array<{ id: string; type: string; title: string; updatedAt?: number }>>(
      'vfs_search_all', { params: { query: '期末复习' } },
    );
    expect(new Set(all.map(row => row.type)))
      .toEqual(new Set(['note', 'exam', 'translation', 'essay']));
    // 标题与更新时间映射
    expect(all.find(row => row.type === 'translation')!.title).toBe('翻译 (zh→en)');
    expect(all.find(row => row.type === 'translation')!.updatedAt).toBeUndefined();
    expect(all.find(row => row.type === 'note')!.title).toBe('期末复习笔记');
    // 单一类型
    expect((await invoke<Array<{ id: string }>>('vfs_search_all', { params: { query: '期末复习', types: ['translation'] } }))
      .map(row => row.id)).toEqual([seeded.translationId]);
    // 多类型
    const multi = await invoke<Array<{ type: string }>>('vfs_search_all', {
      params: { query: '语法', types: ['note', 'essay'] },
    });
    expect(multi).toEqual([]);
  });

  it('test_empty_query_validation', async () => {
    await expect(invoke('vfs_search_all', { params: { query: '' } }))
      .rejects.toBe("Invalid argument 'query': Search query cannot be empty");
    await expect(invoke('vfs_search_all', { params: { query: '   ' } }))
      .rejects.toBe("Invalid argument 'query': Search query cannot be empty");
  });

  it('vfs_search_all caps per-type results and sorts by updatedAt fallback', async () => {
    for (let index = 0; index < 3; index += 1) {
      await invoke('vfs_create_note', { params: { title: `批量搜索 ${index}`, content: '批量搜索' } });
    }
    const limited = await invoke<Array<{ type: string }>>('vfs_search_all', {
      params: { query: '批量搜索', types: ['note'], limit: 2 },
    });
    expect(limited).toHaveLength(2);
    const dumped = await invoke<Array<{ updatedAt?: number; createdAt: number }>>('vfs_search_all', {
      params: { query: '批量搜索', types: ['note'], limit: 50 },
    });
    const times = dumped.map(row => row.updatedAt ?? row.createdAt);
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });
});
