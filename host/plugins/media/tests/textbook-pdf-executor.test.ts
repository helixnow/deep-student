/**
 * Rust `textbook_pdf_executor.rs` executed for real: a migrated VFS database with
 * the L11 textbook/resource/blob repositories, the F7 image engine, and contexts
 * that record every emitted tool event and global broadcast.
 */
import fs from 'node:fs';
import { createNodeFiles } from '../../../platform/files/index.ts';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { image as nativeImage } from '../../../platform/native/image/index.ts';
import { APP_EXECUTOR_ROSTER } from '../../../kernel/agent-roster.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsTextbook } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储读写 VFS；被测对象是本 lane 的执行器
import { BlobRepo } from '../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 同上
import { ResourceRepo } from '../../vfs-repos/repository/resources.ts';
// boundary-allow cross-plugin-impl: 同上
import { TextbookRepo } from '../../vfs-repos/repository/textbooks.ts';
import {
  MAX_IMAGE_OUTPUT_BASE64_CHARS, MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_OUTPUT_DIMENSION,
  TextbookPdfToolExecutor, fitImageForTool, type TextbookPdfRepos,
} from '../src/tools/textbook-pdf-executor.ts';
import type { MediaToolContext } from '../src/tools/runtime.ts';
import { encodePngRgba } from './helpers/png.ts';

const RUST_TOOLS = ['textbook_bookmarks', 'textbook_highlights', 'pdf_page_image'];

function schemaToolNames(file: string): string[] {
  const source = fs.readFileSync(new URL(`../../../../src/features/chat/skills/builtin-tools/${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(/name:\s*'builtin-([a-z_]+)'/g)].map(match => match[1]!);
}

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
const textbooks = new TextbookRepo();
const blobs = new BlobRepo();
const resources = new ResourceRepo();
const log = { debug: () => undefined, warn: () => undefined };

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'textbook-pdf-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'textbook-pdf-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = { getConnSafe: () => conn, blobsDir: () => path.join(root, 'vfs_blobs') } as unknown as VfsDatabase;
});
afterEach(() => {
  storage.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  executor: TextbookPdfToolExecutor;
  broadcasts: Array<[string, Record<string, unknown>]>;
}

function harness(repos: TextbookPdfRepos = { textbooks, resources, blobs } as unknown as TextbookPdfRepos): Harness {
  const broadcasts: Array<[string, Record<string, unknown>]> = [];
  const executor = new TextbookPdfToolExecutor({
    repos: () => repos,
    hostFiles: () => createNodeFiles({ roots: [{ name: 'appData', path: root }] }),
    image: () => nativeImage,
    emit: (event, payload) => { broadcasts.push([event, payload]); },
    now: () => 1_700_000_000_000,
    log,
  });
  return { executor, broadcasts };
}

interface Recorded { context: MediaToolContext; events: Array<[string, ...unknown[]]>; saved: ToolResultInfo[] }

function toolContext(vfs: VfsDatabase | null = database): Recorded {
  const events: Array<[string, ...unknown[]]> = [];
  const saved: ToolResultInfo[] = [];
  return {
    events, saved,
    context: {
      session_id: 'sess_tb', block_id: 'blk_tb', vfs_db: vfs, skill_package_roots: null, cancellation_token: null,
      emitToolCallStart: (...args) => { events.push(['start', ...args]); },
      emitToolCallEnd: result => { events.push(['end', result]); },
      emitToolCallError: error => { events.push(['error', error]); },
      saveToolBlock: result => { saved.push(result); },
    },
  };
}

let seq = 0;
const call = (name: string, args: unknown) => ({ id: `call_${++seq}`, name: `builtin-${name}`, arguments: args });

async function run(h: Harness, name: string, args: unknown, recorded = toolContext()): Promise<ToolResultInfo> {
  return h.executor.execute(call(name, args), recorded.context);
}

function output(result: ToolResultInfo): Record<string, unknown> {
  expect(result.success, result.error ?? undefined).toBe(true);
  return result.output as Record<string, unknown>;
}

function failure(result: ToolResultInfo): Record<string, unknown> {
  expect(result.success).toBe(false);
  expect(result.output).toBeNull();
  return JSON.parse(result.error!) as Record<string, unknown>;
}

function textbook(pageCount: number | null = 10, sha = 'tb-hash'): VfsTextbook {
  return textbooks.createTextbookWithPreview(conn, sha, 'book.pdf', 1, null, null, null, null, pageCount);
}

function reload(id: string): VfsTextbook { return textbooks.getTextbook(conn, id)!; }

describe('TextbookPdfToolExecutor metadata', () => {
  it('handles exactly the Rust tool names, which match the frontend schema and the roster', () => {
    const { executor } = harness();
    expect(schemaToolNames('textbook-pdf-tools.ts').sort()).toEqual([...RUST_TOOLS].sort());
    for (const name of RUST_TOOLS) {
      expect(executor.canHandle(`builtin-${name}`)).toBe(true);
      expect(executor.canHandle(name)).toBe(true);
    }
    expect(executor.canHandle('builtin-textbook_notes')).toBe(false);
    expect(APP_EXECUTOR_ROSTER).toContain(executor.name());
    expect(executor.name()).toBe('TextbookPdfToolExecutor');
  });

  it('sensitivity_keeps_reads_low_and_annotation_writes_medium', () => {
    const { executor } = harness();
    expect(executor.sensitivityLevel('builtin-pdf_page_image')).toBe('low');
    expect(executor.sensitivityLevel('builtin-textbook_bookmarks')).toBe('medium');
    expect(executor.sensitivityLevel('builtin-textbook_highlights')).toBe('medium');
    expect(executor.hasDynamicSensitivity('builtin-textbook_bookmarks')).toBe(true);
    expect(executor.hasDynamicSensitivity('builtin-textbook_highlights')).toBe(true);
    expect(executor.hasDynamicSensitivity('builtin-pdf_page_image')).toBe(false);
    expect(executor.sensitivityLevelForCall('builtin-textbook_bookmarks', { action: 'get' })).toBe('low');
    expect(executor.sensitivityLevelForCall('builtin-textbook_highlights', { action: 'remove' })).toBe('medium');
    expect(executor.sensitivityLevelForCall('builtin-textbook_highlights', {})).toBe('medium');
    expect(executor.sensitivityLevelForCall('builtin-textbook_highlights', null)).toBe('medium');
    expect(executor.sensitivityLevelForCall('builtin-pdf_page_image', { action: 'add' })).toBe('low');
  });

  it('runs page images read-only and annotation tools serially', () => {
    const { executor } = harness();
    expect(executor.concurrencyClass('builtin-pdf_page_image')).toBe('read_only');
    expect(executor.concurrencyClass('builtin-textbook_bookmarks')).toBe('serial');
    expect(executor.concurrencyClass('builtin-textbook_highlights')).toBe('serial');
  });
});

describe('textbook_bookmarks', () => {
  it('adds, reads, updates and removes a bookmark under OCC, broadcasting each write', async () => {
    const h = harness();
    const book = textbook();
    const recorded = toolContext();

    const empty = output(await run(h, 'textbook_bookmarks', { action: 'get', textbook_id: book.id }, recorded));
    expect(empty).toMatchObject({ textbook_id: book.id, kind: 'bookmarks', items: [], total: 0, page: 1,
      page_size: 20, has_more: false, updated_at: book.updatedAt, truncated: false,
      message_key: 'chat.tools.textbook_pdf.annotations_get.success' });
    expect(recorded.events.map(event => event[0])).toEqual(['start', 'end']);
    expect(recorded.saved).toHaveLength(1);
    expect(h.broadcasts).toEqual([]);

    const added = output(await run(h, 'textbook_bookmarks', {
      action: 'add', textbook_id: book.id, page_number: 3, title: '  Chapter 2  ', expected_updated_at: book.updatedAt,
    }));
    const annotation = added.annotation as Record<string, unknown>;
    expect(annotation.id).toMatch(/^bm-agent-[A-Za-z0-9_-]{16}$/);
    expect(annotation).toMatchObject({ page: 3, title: 'Chapter 2', title_truncated: false, createdAt: 1_700_000_000_000 });
    const afterAdd = reload(book.id);
    expect(added).toMatchObject({ action: 'add', kind: 'bookmark', textbook_id: book.id, previous: null, count: 1,
      updated_at: afterAdd.updatedAt, event: 'pdf-annotations:changed', reversible: false, reversible_with_occ: true,
      message_key: 'chat.tools.textbook_pdf.annotation_write.success' });
    expect(afterAdd.updatedAt).not.toBe(book.updatedAt);
    expect(afterAdd.bookmarks).toEqual([{ id: annotation.id, page: 3, title: 'Chapter 2', createdAt: 1_700_000_000_000 }]);
    expect(h.broadcasts).toEqual([['pdf-annotations:changed', {
      textbook_id: book.id, resource_path: `/${book.id}`, kind: 'bookmarks', action: 'add', updated_at: afterAdd.updatedAt,
    }]]);

    const duplicate = failure(await run(h, 'textbook_bookmarks', {
      action: 'add', textbook_id: book.id, page_number: 3, title: 'again', expected_updated_at: afterAdd.updatedAt,
    }));
    expect(duplicate).toMatchObject({ code: 'BOOKMARK_PAGE_EXISTS', message: 'Page 3 already has a bookmark.',
      message_key: 'chat.tools.textbook_pdf.errors.bookmark_page_exists', retryable: false });

    const updated = output(await run(h, 'textbook_bookmarks', {
      action: 'update', textbook_id: book.id, bookmark_id: annotation.id, title: 'Renamed', expected_updated_at: afterAdd.updatedAt,
    }));
    expect(updated.previous).toMatchObject({ title: 'Chapter 2', page: 3 });
    expect(updated.annotation).toMatchObject({ title: 'Renamed', page: 3 });
    const afterUpdate = reload(book.id);

    const removed = output(await run(h, 'textbook_bookmarks', {
      action: 'remove', textbook_id: book.id, bookmark_id: annotation.id, expected_updated_at: afterUpdate.updatedAt,
    }));
    expect(removed).toMatchObject({ action: 'remove', count: 0 });
    expect(removed.annotation).toEqual(removed.previous);
    expect(reload(book.id).bookmarks).toEqual([]);
    expect(h.broadcasts.map(([, payload]) => payload.action)).toEqual(['add', 'update', 'remove']);
  });

  it('rejects a stale expected_updated_at with the bounded current value and writes nothing', async () => {
    const h = harness();
    const book = textbook();
    const long = 'x'.repeat(2_001);
    const current = textbooks.replaceBookmarksIfVersion(conn, book.id,
      [{ id: 'bm-1', page: 1, title: long, createdAt: 1 }], book.updatedAt);
    const error = failure(await run(h, 'textbook_bookmarks', {
      action: 'add', textbook_id: book.id, page_number: 2, title: 't', expected_updated_at: book.updatedAt,
    }));
    expect(error).toMatchObject({
      code: 'ANNOTATION_CONFLICT', kind: 'bookmarks', current_updated_at: current.updatedAt, current_truncated: true,
      message: `Textbook annotations changed (expected ${book.updatedAt}, current ${current.updatedAt}).`,
    });
    expect(((error.current as Array<Record<string, unknown>>)[0]!.title as string).length).toBe(2_000);
    expect(reload(book.id).updatedAt).toBe(current.updatedAt);
    expect(h.broadcasts).toEqual([]);
  });

  it('maps a repository write conflict to ANNOTATION_CONFLICT with the re-read revision', async () => {
    let raced: VfsTextbook | null = null;
    const racing = Object.create(textbooks) as TextbookRepo;
    racing.replaceBookmarksIfVersion = (c, id, values, expected) => {
      raced = textbooks.replaceBookmarksIfVersion(c, id, [], expected);
      return textbooks.replaceBookmarksIfVersion(c, id, values, expected);
    };
    const h = harness({ textbooks: racing, resources, blobs } as unknown as TextbookPdfRepos);
    const book = textbook();
    const error = failure(await run(h, 'textbook_bookmarks', {
      action: 'add', textbook_id: book.id, page_number: 2, title: 't', expected_updated_at: book.updatedAt,
    }));
    expect(error.code).toBe('ANNOTATION_CONFLICT');
    expect(error.message).toMatch(/^CONFLICT\(textbooks\.annotations_conflict\): /);
    expect(error.current_updated_at).toBe(raced!.updatedAt);
    expect(error.current).toEqual([]);
    expect(error.hint).toBe('Re-read the annotations and do not retry with the stale revision.');
    expect(h.broadcasts).toEqual([]);
  });

  it('validates arguments exactly like Rust before touching storage', async () => {
    const h = harness();
    const book = textbook(5);
    const cases: Array<[unknown, string]> = [
      [[], "Invalid 'arguments': expected a JSON object."],
      [{ textbook_id: book.id }, "Invalid 'action': expected a non-empty string."],
      [{ action: 'list', textbook_id: book.id }, "Invalid 'action': expected get, add, remove, or update."],
      [{ action: 'get', textbook_id: book.id, title: 'x' }, "Invalid 'title': unknown field; use only fields declared by the tool schema."],
      [{ action: 'get', textbook_id: 'bad id' }, "Invalid 'textbook_id': may contain only ASCII letters, digits, '_' and '-'."],
      [{ action: 'get', textbook_id: book.id, page_size: 21 }, "Invalid 'page_size': expected an integer between 1 and 20."],
      [{ action: 'add', textbook_id: book.id, page_number: 6, title: 't', expected_updated_at: book.updatedAt },
        "Invalid 'page_number': page 6 exceeds the textbook page count 5."],
      [{ action: 'add', textbook_id: book.id, page_number: 1.5, title: 't', expected_updated_at: book.updatedAt },
        "Invalid 'page_number': expected an integer between 1 and 100000."],
      [{ action: 'add', textbook_id: book.id, page_number: 1, title: 'x'.repeat(501), expected_updated_at: book.updatedAt },
        "Invalid 'title': cannot exceed 500 Unicode characters."],
      [{ action: 'update', textbook_id: book.id, bookmark_id: 'bm-x', expected_updated_at: book.updatedAt },
        "The bookmark 'bm-x' was not found."],
      [{ action: 'add', textbook_id: book.id, page_number: 1, title: 't' },
        "Invalid 'expected_updated_at': expected a non-empty string."],
    ];
    for (const [args, message] of cases) {
      const error = failure(await run(h, 'textbook_bookmarks', args));
      expect(error.message, JSON.stringify(args)).toBe(message);
    }
    expect(reload(book.id).updatedAt).toBe(book.updatedAt);
  });

  it('reports missing, inactive and corrupt textbooks and a missing VFS database', async () => {
    const h = harness();
    expect(failure(await run(h, 'textbook_bookmarks', { action: 'get', textbook_id: 'file_missing' })))
      .toMatchObject({ code: 'TEXTBOOK_NOT_FOUND', message: "Active textbook 'file_missing' was not found." });

    const book = textbook();
    conn.run("UPDATE files SET bookmarks_json = ?1 WHERE id = ?2", ['[{"id":"bm-1","page":"one","title":"t","createdAt":1}]', book.id]);
    expect(failure(await run(h, 'textbook_bookmarks', { action: 'get', textbook_id: book.id })))
      .toMatchObject({ code: 'CORRUPT_ANNOTATIONS',
        message: 'Stored bookmark data is invalid: invalid type: string "one", expected u32' });

    conn.run("UPDATE files SET status = 'deleted' WHERE id = ?1", [book.id]);
    expect(failure(await run(h, 'textbook_bookmarks', { action: 'get', textbook_id: book.id })).code)
      .toBe('TEXTBOOK_NOT_FOUND');

    const recorded = toolContext(null);
    const unavailable = failure(await run(h, 'textbook_bookmarks', { action: 'get', textbook_id: book.id }, recorded));
    expect(unavailable).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });
    expect(recorded.events.map(event => event[0])).toEqual(['start', 'error']);
    expect(recorded.saved[0]!.success).toBe(false);
  });
});

describe('textbook_highlights', () => {
  const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };

  it('adds and filters highlights, persisting only the serde fields with coordVersion 2', async () => {
    const h = harness();
    const book = textbook();
    const seeded = textbooks.replaceHighlightsIfVersion(conn, book.id, [
      { id: 'hl-legacy', pageIndex: 4, text: 'old', color: '#bbf7d0', rects: [rect], createdAt: 5, extra: 'dropped' },
    ], book.updatedAt);

    const added = output(await run(h, 'textbook_highlights', {
      action: 'add', textbook_id: book.id, page_index: 0, text: 'hello', color: '#fef08a', rects: [rect],
      expected_updated_at: seeded.updatedAt,
    }));
    const id = (added.annotation as Record<string, unknown>).id as string;
    expect(id).toMatch(/^hl-agent-/);
    expect(added.annotation).toEqual({ id, pageIndex: 0, text: 'hello', text_truncated: false, color: '#fef08a',
      rects: [rect], createdAt: 1_700_000_000_000, coordVersion: 2 });
    expect(reload(book.id).highlights).toEqual([
      { id: 'hl-legacy', pageIndex: 4, text: 'old', color: '#bbf7d0', rects: [rect], createdAt: 5 },
      { id, pageIndex: 0, text: 'hello', color: '#fef08a', rects: [rect], createdAt: 1_700_000_000_000, coordVersion: 2 },
    ]);

    const filtered = output(await run(h, 'textbook_highlights', { action: 'get', textbook_id: book.id, page_index: 4 }));
    expect(filtered.total).toBe(1);
    expect(filtered.items).toEqual([{ id: 'hl-legacy', pageIndex: 4, text: 'old', text_truncated: false,
      color: '#bbf7d0', rects: [rect], createdAt: 5, coordVersion: null }]);

    const updated = output(await run(h, 'textbook_highlights', {
      action: 'update', textbook_id: book.id, highlight_id: 'hl-legacy', color: '#fecaca',
      expected_updated_at: reload(book.id).updatedAt,
    }));
    expect(updated.previous).toMatchObject({ color: '#bbf7d0', coordVersion: null });
    expect(updated.annotation).toMatchObject({ color: '#fecaca', coordVersion: 2 });
    expect(h.broadcasts.map(([, payload]) => [payload.kind, payload.action]))
      .toEqual([['highlights', 'add'], ['highlights', 'update']]);
  });

  it('paginates_at_twenty_and_marks_long_text_truncated', async () => {
    const h = harness();
    const book = textbook(100);
    textbooks.replaceHighlightsIfVersion(conn, book.id, Array.from({ length: 21 }, (_, index) => ({
      id: `hl-${index}`, pageIndex: index, text: 'x'.repeat(2_001), color: '#fef08a', rects: [rect], createdAt: 1, coordVersion: 2,
    })), book.updatedAt);
    const page = output(await run(h, 'textbook_highlights', { action: 'get', textbook_id: book.id }));
    expect((page.items as unknown[]).length).toBe(20);
    expect(page.has_more).toBe(true);
    expect(page.truncated).toBe(true);
    expect(([...((page.items as Array<Record<string, unknown>>)[0]!.text as string)]).length).toBe(2_000);
    const second = output(await run(h, 'textbook_highlights', { action: 'get', textbook_id: book.id, page: 2 }));
    expect(second).toMatchObject({ total: 21, page: 2, has_more: false });
    expect((second.items as unknown[]).length).toBe(1);
  });

  it('rejects invalid colours, rectangles and page indexes', async () => {
    const h = harness();
    const book = textbook(3);
    const base = { action: 'add', textbook_id: book.id, page_index: 0, text: 't', color: '#fef08a', rects: [rect],
      expected_updated_at: book.updatedAt };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, color: '#000000' }, "Invalid 'color': expected one of #fef08a, #bbf7d0, #bfdbfe, #fecaca."],
      [{ ...base, rects: [] }, "Invalid 'rects': expected between 1 and 64 normalized rectangles."],
      [{ ...base, rects: [{ x: 0.9, y: 0.1, width: 0.2, height: 0.2 }] },
        "Invalid 'rects': rects[0] must fit within normalized page coordinates 0..1."],
      [{ ...base, rects: [{ x: 0.1, y: 0.1, width: 0.2 }] }, "Invalid 'rects': rects[0].height is required."],
      [{ ...base, page_index: 3 }, "Invalid 'page_index': zero-based page index 3 exceeds the textbook page count 3."],
      [{ action: 'update', textbook_id: book.id, highlight_id: 'hl-1', expected_updated_at: book.updatedAt },
        "The highlight 'hl-1' was not found."],
    ];
    for (const [args, message] of cases) {
      expect(failure(await run(h, 'textbook_highlights', args)).message, JSON.stringify(args)).toBe(message);
    }
    textbooks.replaceHighlightsIfVersion(conn, book.id,
      [{ id: 'hl-1', pageIndex: 0, text: 't', color: '#fef08a', rects: [rect], createdAt: 1 }], book.updatedAt);
    const fresh = reload(book.id);
    expect(failure(await run(h, 'textbook_highlights', {
      action: 'update', textbook_id: book.id, highlight_id: 'hl-1', expected_updated_at: fresh.updatedAt,
    })).message).toBe("Invalid 'update': provide at least one of page_index, text, color, or rects.");
  });
});

describe('pdf_page_image', () => {
  function storePreview(pages: Array<{ bytes: Uint8Array; mime: string; compressed?: Uint8Array }>): string {
    const book = textbook(pages.length, `img-${seq++}`);
    const preview = {
      pages: pages.map((page, pageIndex) => {
        const blob = blobs.storeBlob(conn, database.blobsDir(), page.bytes, page.mime, page.mime === 'image/png' ? 'png' : 'jpg');
        const compressed = page.compressed === undefined ? undefined
          : blobs.storeBlob(conn, database.blobsDir(), page.compressed, 'image/jpeg', 'jpg');
        return { pageIndex, blobHash: blob.hash, width: 1, height: 1, mimeType: page.mime,
          ...(compressed === undefined ? {} : { compressedBlobHash: compressed.hash }) };
      }),
      renderDpi: 150, totalPages: pages.length, renderedAt: '2026-01-01T00:00:00Z',
    };
    conn.run('UPDATE files SET preview_json = ?1 WHERE id = ?2', [JSON.stringify(preview), book.id]);
    return book.resourceId!;
  }

  function png(width: number, height: number): Uint8Array {
    return encodePngRgba(width, height, new Uint8Array(width * height * 4).fill(200));
  }

  it('returns a small supported preview unchanged as a data URL', async () => {
    const h = harness();
    const bytes = png(40, 30);
    const resourceId = storePreview([{ bytes, mime: 'image/png' }]);
    const result = output(await run(h, 'pdf_page_image', { resource_id: resourceId, page_index: 0 }));
    const base64 = Buffer.from(bytes).toString('base64');
    expect(result).toEqual({
      resource_id: resourceId, page_index: 0, mime_type: 'image/png', width: 40, height: 30,
      size_bytes: bytes.byteLength, original_size_bytes: bytes.byteLength, stored_size_bytes: bytes.byteLength,
      compressed: false, image_url: `data:image/png;base64,${base64}`,
      image_url_chars: base64.length + 'image/png'.length + 13, truncated: false,
      message_key: 'chat.tools.textbook_pdf.page_image.success',
    });
  });

  it('prefers the compressed preview blob and labels it image/jpeg', async () => {
    const h = harness();
    const jpeg = await nativeImage.encode({ width: 20, height: 10, rgba: new Uint8Array(800).fill(90) }, { format: 'jpeg', quality: 80 });
    const resourceId = storePreview([{ bytes: png(20, 10), mime: 'image/png', compressed: jpeg }]);
    const result = output(await run(h, 'pdf_page_image', { resource_id: resourceId, page_index: 0 }));
    expect(result).toMatchObject({ mime_type: 'image/jpeg', size_bytes: jpeg.byteLength, compressed: false });
  });

  it('compresses_large_page_images_below_output_limits', async () => {
    const bounded = await fitImageForTool(nativeImage, png(3_000, 2_500), 'image/png');
    expect(bounded.width).toBeLessThanOrEqual(MAX_IMAGE_OUTPUT_DIMENSION);
    expect(bounded.height).toBeLessThanOrEqual(MAX_IMAGE_OUTPUT_DIMENSION);
    expect([bounded.width, bounded.height]).toEqual([2_048, 1_707]);
    expect(bounded.bytes.byteLength).toBeLessThanOrEqual(MAX_IMAGE_OUTPUT_BYTES);
    expect(Buffer.from(bounded.bytes).toString('base64').length).toBeLessThanOrEqual(MAX_IMAGE_OUTPUT_BASE64_CHARS);
    expect(bounded.mimeType).toBe('image/jpeg');
    expect(bounded.compressed).toBe(true);
  }, 60_000);

  it('reports unavailable previews, bad arguments and undecodable sources', async () => {
    const h = harness();
    expect(failure(await run(h, 'pdf_page_image', { resource_id: 'file_1', page_index: 0 })).message)
      .toBe("Invalid 'resource_id': expected a VFS resource ID beginning with 'res_'.");
    expect(failure(await run(h, 'pdf_page_image', { resource_id: 'res_1', page_index: 0, scale: 2 })).message)
      .toBe("Invalid 'scale': unknown field; use only fields declared by the tool schema.");
    expect(failure(await run(h, 'pdf_page_image', { resource_id: 'res_missing', page_index: 0 })))
      .toMatchObject({ code: 'PDF_PAGE_IMAGE_NOT_AVAILABLE', message: '资源不存在: res_missing',
        hint: 'Check that the resource is a processed PDF and that page_index is zero-based.' });

    const noPreview = textbook(1, 'no-preview');
    expect(failure(await run(h, 'pdf_page_image', { resource_id: noPreview.resourceId, page_index: 0 })).message)
      .toBe('查询附件 preview_json 失败: Invalid column type Null at index: 0, name: preview_json');

    const resourceId = storePreview([{ bytes: png(4, 4), mime: 'image/png' }]);
    expect(failure(await run(h, 'pdf_page_image', { resource_id: resourceId, page_index: 1 })).message)
      .toBe('页码越界: page_index=1, total_pages=1');

    const garbage = storePreview([{ bytes: new TextEncoder().encode('not an image'), mime: 'image/png' }]);
    const invalid = failure(await run(h, 'pdf_page_image', { resource_id: garbage, page_index: 0 }));
    expect(invalid.code).toBe('PDF_PAGE_IMAGE_INVALID');
    expect(invalid.message).toMatch(/^Failed to decode PDF page preview: /);
  });
});
