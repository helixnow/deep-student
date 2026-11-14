import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { pdfOcrConfig } from '../src/runtime-adapter.ts';
import { parseProcessingProgress } from '../src/pdf-processing.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const settings = new Map<string, string>();

beforeAll(async () => {
  root = fs.mkdtempSync('/tmp/opencode/vfs-progress-');
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({ plugins: [plugin], provide: {
    storage, settings: { get: (key: string) => settings.get(key) ?? null },
  } });
  storage.database('vfs').run(
    `INSERT INTO files (id, sha256, file_name, size, created_at, updated_at, mime_type, processing_status)
     VALUES ('file_progress', 'sha_progress', 'book.pdf', 1, 'now', 'now', 'application/pdf', 'ocr_processing')`,
  );
}, 180_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function status(progress: Record<string, unknown>) {
  return rawStatus(JSON.stringify(progress));
}

function rawStatus(progress: string) {
  storage.database('vfs').run(
    "UPDATE files SET processing_progress = ?1 WHERE id = 'file_progress'", [progress],
  );
  return host.ctx.vfsIndex.pdf.getStatus('file_progress');
}

describe('R12-08 Rust ProcessingProgress serde through vfsIndex.pdf.getStatus', () => {
  const valid = { stage: 'ocr_processing', percent: 12.3456789, readyModes: ['text'] };
  it('R12-08 raw typed f32 narrows before the serialized snapshot projection', () => {
    expect(parseProcessingProgress('{"stage":"ocr_processing","percent":33.333333333333336,"readyModes":[]}').percent)
      .toBe(Math.fround(33.333333333333336));
    const integer = (1n << 63n) + (1n << 39n) + 1n;
    expect(parseProcessingProgress(`{"stage":"ocr_processing","percent":${integer},"readyModes":[]}`).percent)
      .toBe(2 ** 63 + 2 ** 40);
    expect(parseProcessingProgress('{"stage":"ocr_processing","percent":12.3456789,"readyModes":[]}').percent)
      .toBe(Math.fround(12.3456789));
    expect(parseProcessingProgress('{"stage":"ocr_processing","percent":1e40,"readyModes":[]}').percent)
      .toBe(Infinity);
  });
  it('X6-UD-0089 rejects duplicate struct fields and usize float tokens before losing JSON lexemes', () => {
    for (const fields of [
      '"currentPage":0.0', '"currentPage":1e0', '"currentPage":-0',
      '"stage":"first","stage":"last"', '"percent":1,"percent":2',
      '"currentPage":null,"currentPage":2', '"readyModes":[],"readyModes":["text"]',
      '"failedStages":[{"stage":"ocr","message":"a","message":"b"}]',
      '"failedStages":[{"stage":"ocr","message":"a","retriable":false,"retriable":true}]',
    ]) {
      expect(rawStatus(`{"stage":"ocr_processing","percent":50,"readyModes":[],${fields}}`)?.progress, fields)
        .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
    }
  });

  it('X6-UD-0089 keeps full usize precision and allows repeated unknown fields', () => {
    expect(rawStatus('{"stage":"ocr_processing","current_page":9007199254740993,"totalPages":18446744073709551615,"percent":25,"ready_modes":["text"],"future":1,"future":2}')?.progress)
      .toEqual({ stage: 'ocr_processing', currentPage: 9007199254740993n,
        totalPages: 18446744073709551615n, percent: 25, readyModes: ['text'] });
  });

  it('R12-08 status timestamp reads retain exact SQLite i64 values until IPC', () => {
    const db = storage.database('vfs');
    db.run("UPDATE files SET processing_started_at = ?1, processing_completed_at = ?2 WHERE id = 'file_progress'",
      [-9223372036854775808n, 9223372036854775807n]);
    try {
      expect(host.ctx.vfsIndex.pdf.getStatus('file_progress')).toMatchObject({
        startedAt: -9223372036854775808n, completedAt: 9223372036854775807n,
      });
    } finally {
      db.run("UPDATE files SET processing_started_at = NULL, processing_completed_at = NULL WHERE id = 'file_progress'");
    }
  });

  it('X6-UD-0089 accepts serde struct sequences and defaults only the final defaulted fields', () => {
    expect(rawStatus('["ocr_processing",null,2,25,["text"],null]')?.progress)
      .toEqual({ stage: 'ocr_processing', totalPages: 2, percent: 25, readyModes: ['text'] });
    expect(rawStatus('["completed_with_issues",null,null,100,[],"pdf",[["ocr","failed"]]]')?.progress)
      .toEqual({ stage: 'completed_with_issues', percent: 100, readyModes: [], mediaType: 'pdf',
        failedStages: [{ stage: 'ocr', message: 'failed', retriable: false }] });
    expect(rawStatus('["ocr_processing",null,null,25,[]]')?.progress)
      .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
  });

  it('X6-UD-0089 converts integer input directly to f32 without double rounding', () => {
    // One above the f32 midpoint at 2^63: converting to f64 first loses the +1.
    // The snapshot applies serde's shortest f32 decimal; 2^63 alone would project
    // as 9223372000000000000, so this still distinguishes double rounding.
    const integer = (1n << 63n) + (1n << 39n) + 1n;
    expect(rawStatus(`{"stage":"ocr_processing","percent":${integer},"readyModes":[]}`)?.progress.percent)
      .toBe(9223373000000000000);
  });

  it('X6-UD-0089 serializes an overflowing f32 as null while f64 overflow fails decoding', () => {
    expect(rawStatus('{"stage":"ocr_processing","percent":1e40,"readyModes":[]}')?.progress)
      .toEqual({ stage: 'ocr_processing', percent: null, readyModes: [] });
    expect(rawStatus('{"stage":"ocr_processing","percent":1e400,"readyModes":[]}')?.progress)
      .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
  });
  it('rejects malformed optional usize instead of silently omitting it (pdf_processing_service.rs:229-233)', () => {
    for (const key of ['currentPage', 'current_page', 'totalPages', 'total_pages']) {
      for (const value of [-1, 1.5, '3', true, {}, [], 18446744073709551616]) {
        expect(status({ ...valid, [key]: value })?.progress, `${key}=${JSON.stringify(value)}`)
          .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
      }
    }
  });

  it('rejects duplicate camelCase and snake_case aliases even when values agree or are null', () => {
    for (const [camel, snake, value] of [
      ['currentPage', 'current_page', 2], ['totalPages', 'total_pages', 4],
      ['readyModes', 'ready_modes', ['text']], ['mediaType', 'media_type', 'pdf'],
      ['failedStages', 'failed_stages', []],
    ] as const) {
      for (const candidate of [value, null]) {
        expect(status({ ...valid, [camel]: candidate, [snake]: candidate })?.progress)
          .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
      }
    }
  });

  it('preserves valid options, ignores unknown fields and defaults only absent retriable', () => {
    expect(status({
      ...valid, current_page: 0, total_pages: 4, media_type: null,
      failed_stages: [{ stage: 'ocr', message: 'retry', extra: 'ignored' }], extra: 'ignored',
    })).toEqual({
      fileId: 'file_progress', stage: 'ocr_processing', progress: {
        ...valid, percent: 12.345679, currentPage: 0, totalPages: 4,
        failedStages: [{ stage: 'ocr', message: 'retry', retriable: false }],
      },
    });
    expect(status({ ...valid, failedStages: [{ stage: 'ocr', message: 'retry', retriable: null }] })?.progress)
      .toEqual({ stage: 'pending', percent: 0, readyModes: [] });
  });
});

it('R12-03 refuses resource state writes when the owner provider is absent', () => {
  const db = storage.database('vfs');
  db.run(`INSERT INTO resources
    (id, hash, type, storage_mode, data, ref_count, created_at, updated_at, index_state)
    VALUES ('res_no_owner', 'hash_no_owner', 'note', 'inline', 'text', 0, 1, 1, 'indexed')`);
  expect(() => host.ctx.vfsIndex.indexing.markResourcePending('res_no_owner'))
    .toThrow('L11 vfsRepo service is not available');
  expect(db.pluck("SELECT index_state FROM resources WHERE id = 'res_no_owner'")).toBe('indexed');
});

it('OcrStrategyConfig::load_from_db follows Rust usize parsing, including exact u64 maximum', () => {
  for (const invalid of [' 12', '12 ', '12suffix', '1.5', '-1', '1e2', '18446744073709551616']) {
    settings.set('ocr.pdf_text_threshold', invalid);
    expect(pdfOcrConfig(host.ctx).pdfTextThreshold, invalid).toBe(100);
  }
  settings.set('ocr.pdf_text_threshold', '+12');
  expect(pdfOcrConfig(host.ctx).pdfTextThreshold).toBe(12);
  settings.set('ocr.pdf_text_threshold', '18446744073709551615');
  expect(pdfOcrConfig(host.ctx).pdfTextThreshold).toBe(18446744073709551615n);
  settings.clear();
});
