import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';
import {
  MEMORY_BATCH_LIMIT, MEMORY_EXPORT_CONTENT_CHARS, MEMORY_EXPORT_PAGE_SIZE,
  MEMORY_LIST_PAGE_SIZE, MEMORY_TAG_CHARS,
  exportPage, exportPagination, isMemoryTool, listPagination, memoryConcurrency,
  memorySensitivity, needsRootBootstrap, parseBatchMoveArgs, parseTags,
  truncateExportContent,
} from '../src/memory-executor.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
async function setup() { current = await setupMemoryHost(); return current; }
function serviceOf(host: MemoryHost['host']): MemoryServiceImpl {
  return host.ctx.memory as unknown as MemoryServiceImpl;
}

function errorCode(action: () => unknown): string | null {
  let text: string;
  try {
    action();
    return null;
  } catch (thrown) {
    text = thrown instanceof Error ? thrown.message : String(thrown);
  }
  try {
    const parsed = JSON.parse(text) as { code?: string };
    return parsed.code ?? null;
  } catch {
    return null;
  }
}

describe('memory tool executor', () => {
  it('test_needs_root_bootstrap', () => {
    expect(needsRootBootstrap(null)).toBe(true);
    expect(needsRootBootstrap(undefined)).toBe(true);
    expect(needsRootBootstrap('folder-1')).toBe(false);
    // Rust `Some("")` is a present (if empty) root id, not a bootstrap trigger.
    expect(needsRootBootstrap('')).toBe(false);
  });

  it('phase9_memory_tools_have_explicit_sensitivity_and_concurrency', () => {
    for (const tool of [
      'builtin-memory_batch_move',
      'builtin-memory_add_relation',
      'builtin-memory_remove_relation',
      'builtin-memory_update_tags',
      'builtin-memory_log_activity',
      'builtin-memory_write',
      'builtin-memory_write_smart',
      'builtin-memory_write_batch',
      'builtin-memory_update_by_id',
    ]) {
      expect(isMemoryTool(tool)).toBe(true);
      expect(memorySensitivity(tool)).toBe('medium');
      expect(memoryConcurrency(tool)).toBe('serial');
    }
    expect(isMemoryTool('builtin-memory_export_all')).toBe(true);
    expect(memorySensitivity('builtin-memory_export_all')).toBe('high');
    expect(memoryConcurrency('builtin-memory_export_all')).toBe('read_only');
    expect(memorySensitivity('builtin-memory_delete')).toBe('medium');
    expect(memoryConcurrency('builtin-memory_delete')).toBe('serial');
    expect(isMemoryTool('builtin-memory_list')).toBe(true);
    expect(memorySensitivity('builtin-memory_list')).toBe('low');
    expect(memoryConcurrency('builtin-memory_list')).toBe('read_only');
    expect(isMemoryTool('builtin-memory_search')).toBe(true);
    expect(memoryConcurrency('builtin-memory_search')).toBe('read_only');
    expect(isMemoryTool('builtin-memory_export_all_extra')).toBe(false);
    expect(isMemoryTool('builtin-learner_profile_get')).toBe(true);
    expect(memorySensitivity('builtin-learner_profile_update')).toBe('medium');
  });

  it('batch_move_parser_requires_complete_occ_map_and_enforces_limit', () => {
    const noteIds = Array.from({ length: MEMORY_BATCH_LIMIT },
      (_, index) => `note-${index}`);
    const versions = Object.fromEntries(noteIds.map(id => [id, `version-${id}`]));
    const parsed = parseBatchMoveArgs({
      note_ids: noteIds,
      expected_updated_at_by_id: versions,
    });
    expect(parsed).toHaveLength(MEMORY_BATCH_LIMIT);
    expect(parsed[0]).toEqual(['note-0', 'version-note-0']);

    expect(errorCode(() => parseBatchMoveArgs({
      note_ids: ['note-a', 'note-b'],
      expected_updated_at_by_id: { 'note-a': 'v1' },
    }))).toBe('MEMORY_INVALID_ARGS');

    const tooMany = Array.from({ length: MEMORY_BATCH_LIMIT + 1 },
      (_, index) => `note-${index}`);
    expect(errorCode(() => parseBatchMoveArgs({
      note_ids: tooMany,
      expected_updated_at_by_id: {},
    }))).toBe('MEMORY_INVALID_ARGS');

    expect(errorCode(() => parseBatchMoveArgs({
      note_ids: ['note-a', 'note-a'],
      expected_updated_at_by_id: { 'note-a': 'v1' },
    }))).toBe('MEMORY_INVALID_ARGS');
    expect(parseBatchMoveArgs({
      noteIds: [' note-a '],
      expectedUpdatedAtById: { 'note-a': ' v1 ' },
    })).toEqual([['note-a', 'v1']]);
  });

  it('export_pagination_and_content_are_bounded', () => {
    expect(exportPagination({})).toEqual([1, MEMORY_EXPORT_PAGE_SIZE, 0]);
    expect(exportPagination({ page: 2, page_size: 3 })).toEqual([2, 3, 3]);
    expect(errorCode(() => exportPagination({
      page: 1,
      page_size: MEMORY_EXPORT_PAGE_SIZE + 1,
    }))).toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => exportPagination({ page: 0 }))).toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => exportPagination({ page: 0xffffffff, page_size: 20 })))
      .toBe('MEMORY_INVALID_ARGS');

    const content = '学'.repeat(MEMORY_EXPORT_CONTENT_CHARS + 1);
    const [bounded, truncated] = truncateExportContent(content);
    expect(truncated).toBe(true);
    expect(Array.from(bounded)).toHaveLength(MEMORY_EXPORT_CONTENT_CHARS);

    const exact = truncateExportContent('a'.repeat(MEMORY_EXPORT_CONTENT_CHARS));
    expect(exact[1]).toBe(false);
  });

  it('list_pagination_matches_global_read_limit', () => {
    expect(listPagination({})).toEqual([MEMORY_LIST_PAGE_SIZE, 0]);
    expect(listPagination({ limit: 5, offset: 12 })).toEqual([5, 12]);
    expect(errorCode(() => listPagination({ limit: MEMORY_LIST_PAGE_SIZE + 1 })))
      .toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => listPagination({ limit: 0 }))).toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => listPagination({ offset: 0x1_0000_0000 })))
      .toBe('MEMORY_INVALID_ARGS');
  });

  it('export_page_returns_real_memory_content_and_has_more', async () => {
    const { host } = await setup();
    const service = serviceOf(host);
    service.writeExplicit(null, 'Export first',
      'A'.repeat(MEMORY_EXPORT_CONTENT_CHARS + 1), 'study', null);
    service.write('Study', 'Export second', 'second content', 'create');

    const { items, hasMore } = exportPage(service, 1, 0);
    expect(items).toHaveLength(1);
    expect(hasMore).toBe(true);
    expect(typeof items[0]!.note_id).toBe('string');
    expect(typeof items[0]!.updated_at).toBe('string');
    expect(typeof items[0]!.content).toBe('string');
    expect(typeof items[0]!.content_truncated).toBe('boolean');

    const second = exportPage(service, 1, 1);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('tags_are_trimmed_deduplicated_and_bounded', () => {
    expect(parseTags({ tags: [' exam ', 'exam', 'focus'] })).toEqual(['exam', 'focus']);
    const oversized = 'x'.repeat(MEMORY_TAG_CHARS + 1);
    expect(errorCode(() => parseTags({ tags: [oversized] }))).toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => parseTags({ tags: ['  '] }))).toBe('MEMORY_INVALID_ARGS');
    expect(errorCode(() => parseTags({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })))
      .toBe('MEMORY_INVALID_ARGS');
  });
});
