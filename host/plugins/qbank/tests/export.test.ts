import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import * as authoringService from '../src/authoring-service.ts';
import * as exportService from '../src/export-service.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { buildZip } from '../repository/export.ts';
import { vfsTestAssetRepos, vfsTestPorts, vfsTestServices } from './support/vfs-ports.ts';
import type { DraftQuestion, Question, QuestionDocument } from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-export-');
  const db = storage.database('vfs');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...vfsTestServices(db),
    },
  });
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', 'reading', 'empty', 't1', '{}', '{"pages":[]}', ?1, ?1)`, [NOW]);
  return {
    host, db, storage, authoringHost: { db, ...vfsTestPorts(db) },
    blobsDir: path.join(storage.locations.activeDir, 'vfs_blobs'),
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** authoring.rs:357-368: VfsBlobRepo::store_blob + VfsFileRepo::create_file. */
function storeImage(f: Fixture, name: string): { id: string; name: string; mime: string; hash: string } {
  const repos = vfsTestAssetRepos();
  const blob = repos.blobs.storeBlob(f.db, f.blobsDir, PNG, 'image/png', 'png');
  const file = repos.files.createFile(f.db, blob.hash, name, PNG.length, 'image', 'image/png', blob.hash, null);
  return { id: file.id, name, mime: 'image/png', hash: blob.hash };
}

function draft(localId: string, overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    local_id: localId, group_id: null, original_label: null, section_path: [], content: `Question ${localId}`,
    question_type: 'short_answer', options: null, answer: null, explanation: null, structured_data: null,
    difficulty: null, tags: [], source_refs: [], answer_source_refs: [], figures: [], images: [],
    answer_origin: null, smiles: null, smiles_caption: null, parent_id: null, parent_local_id: null,
    source_ref: null, ...overrides,
  };
}

function document(overrides: Partial<QuestionDocument> = {}): QuestionDocument {
  return {
    schema_version: 2, mode: 'extract', materials: [], groups: [], questions: [],
    unmatched_answers: [], coverage: [], issues: [], ...overrides,
  };
}

describe('question_export_service/authoring.rs', () => {
  it('portable_round_trip_preserves_materials_types_and_assets_across_databases', async () => {
    const source = await fixture();
    const target = await fixture();
    try {
      const image = storeImage(source, 'condition.png');
      const doc = document({
        materials: [{ local_id: 'm1', content: 'Shared conditions', source_refs: [], figures: [],
          images: [image] }],
        groups: [{ local_id: 'g1', label: 'Conditions', material_ids: ['m1'], question_ids: ['q1', 'q2'] }],
        questions: [
          draft('q1', { group_id: 'g1', content: 'Numeric question', question_type: 'numeric',
            structured_data: { answer_value: 12.5, tolerance: 0.01 } }),
          draft('q2', { group_id: 'g1', content: 'Explain', answer: null }),
        ],
      });
      const job = authoringService.saveDraft(source.authoringHost, 'exam_1', doc, {});
      const receipt = authoringService.commitDraft(source.authoringHost, job, ['q1', 'q2'], 1);
      expect(receipt.imported_count).toBe(2);

      const packageFile = await source.host.invoke('qbank_export_portable', { examId: 'exam_1' }) as {
        base64: string; name: string;
      };
      expect(packageFile.name).toBe('question-bank-exam_1.zip');
      expect(packageFile.base64.length).toBeGreaterThan(0);

      const imported = await exportService.importPackage(
        { db: target.db, blobsDir: target.blobsDir, vfsRepo: vfsTestAssetRepos() }, packageFile.base64);
      expect(imported.document.materials[0]!.images[0]!.hash).toBe(image.hash);
      expect(imported.document.materials[0]!.images[0]!.id).not.toBe(image.id);
      expect(imported.metadata.source_format).toBe('portable_v2');

      const targetJob = authoringService.saveDraft(target.authoringHost, 'exam_1', imported.document,
        imported.metadata);
      const targetReceipt = authoringService.commitDraft(target.authoringHost, targetJob,
        imported.document.questions.map(question => question.local_id), 1);
      expect(targetReceipt.imported_count).toBe(2);

      const exported = await target.host.invoke('qbank_export_document', { examId: 'exam_1' }) as {
        materials: { images: { hash: string; id: string }[] }[];
        groups: { question_ids: string[] }[];
        questions: { question_type: string; structured_data: { answer_value: number } }[];
      };
      expect(exported.materials).toHaveLength(1);
      expect(exported.materials[0]!.images[0]!.hash).toBe(image.hash);
      expect(exported.materials[0]!.images[0]!.id).not.toBe(image.id);
      expect(exported.groups[0]!.question_ids).toHaveLength(2);
      const numeric = exported.questions.find(question => question.question_type === 'numeric')!;
      expect(numeric.structured_data.answer_value).toBe(12.5);
    } finally {
      await source.dispose();
      await target.dispose();
    }
  });

  it('export_document_hook_returns_the_same_canonical_document_as_the_command', async () => {
    const f = await fixture();
    try {
      const doc = document({
        questions: [draft('q1', { content: 'Hook question', answer: '42' })],
      });
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {});
      authoringService.commitDraft(f.authoringHost, job, ['q1'], 1);

      const command = await f.host.invoke('qbank_export_document', { examId: 'exam_1' });
      const hook = f.host.ctx.qbank.exportDocument('exam_1');
      expect(hook).toEqual(command);
      expect((hook as { questions: { content: string }[] }).questions[0]!.content)
        .toBe('Hook question');
    } finally { await f.dispose(); }
  });

  it('export_document_keeps_provenance_sources_and_omits_empty_groups', async () => {
    const f = await fixture();
    try {
      const doc = document({
        questions: [draft('q1', {
          original_label: '1', source_refs: [{ source_id: 's-local', page: 1, bbox: null }],
          section_path: ['Part A'],
        })],
      });
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {
        sources: [{ source_id: 's-local', content_hash: 'hash-1' }],
        pages: [{ source_id: 's-local', page: 1, blob_hash: 'b'.repeat(64), width: 10, height: 10 }],
      });
      authoringService.commitDraft(f.authoringHost, job, ['q1'], 1);

      const exported = await f.host.invoke('qbank_export_document', { examId: 'exam_1' }) as {
        questions: { source_refs: { source_id: string; page: number }[]; section_path: string[];
          original_label: string }[];
        groups: unknown[];
        sources: { source_id: string }[];
        source_pages: { source_id: string; page: number }[];
      };
      expect(exported.groups).toEqual([]);
      expect(exported.questions[0]!.original_label).toBe('1');
      expect(exported.questions[0]!.section_path).toEqual(['Part A']);
      expect(exported.questions[0]!.source_refs[0]!.page).toBe(1);
      expect(exported.questions[0]!.source_refs[0]!.source_id).toBe(exported.sources[0]!.source_id);
      expect(exported.source_pages).toEqual([expect.objectContaining({
        source_id: exported.sources[0]!.source_id, page: 1,
      })]);
    } finally { await f.dispose(); }
  });

  it('remove_question_image_drops_only_the_requested_image', async () => {
    const f = await fixture();
    try {
      const image = storeImage(f, 'condition.png');
      const kept = { ...image, id: 'file_kept' };
      const question = await f.host.invoke('qbank_create_question', {
        params: { exam_id: 'exam_1', content: 'With image', answer: null, options: null,
          question_type: 'short_answer', difficulty: null, tags: [], source_type: 'manual',
          images: [image, kept] },
      }) as Question;
      expect(question.images).toHaveLength(2);
      await f.host.invoke('qbank_remove_question_image', {
        questionId: question.id, imageId: image.id,
      });
      const updated = await f.host.invoke('qbank_get_question', { questionId: question.id }) as Question;
      expect(updated.images.map(item => item.id)).toEqual(['file_kept']);
    } finally { await f.dispose(); }
  });

  // authoring.rs:47,85,108：images/source_refs/descriptor/provenance 均 serde_json::from_str::<Value>
  // （arbitrary_precision + preserve_order），structured_data 来自 Question 的 Value；数字原文不变，
  // 非法 provenance_json `.ok()` 为 Null。
  it('export_document_keeps_rust_written_numbers_verbatim', async () => {
    const f = await fixture();
    try {
      const doc = document({
        materials: [{ local_id: 'm1', content: 'M', source_refs: [], figures: [], images: [] }],
        groups: [{ local_id: 'g1', label: 'G', material_ids: ['m1'], question_ids: ['q1'] }],
        questions: [
          draft('q1', { group_id: 'g1', original_label: '1',
            source_refs: [{ source_id: 's-local', page: 1, bbox: null }] }),
          draft('q2'),
        ],
      });
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', doc, {
        sources: [{ source_id: 's-local', content_hash: 'hash-1' }],
        pages: [{ source_id: 's-local', page: 1, blob_hash: 'b'.repeat(64), width: 10, height: 10 }],
      });
      authoringService.commitDraft(f.authoringHost, job, ['q1', 'q2'], 1);
      const structured = '{"answer_value":2.50,"tolerance":1e-2,"big":12345678901234567890}';
      const refs = '[{"source_id":"s","page":1,"bbox":[0.0,0.10,1.0,1.0]}]';
      f.db.run("UPDATE questions SET structured_data = ?1, provenance_json = ?2 WHERE content = 'Question q1'",
        [structured, `{"source_refs":${refs},"answer_source_refs":[],"section_path":["A"]}`]);
      f.db.run("UPDATE questions SET provenance_json = 'not json' WHERE content = 'Question q2'");
      f.db.run("UPDATE qbank_materials SET source_refs_json = ?1 WHERE exam_id = 'exam_1'", [refs]);
      f.db.run("UPDATE qbank_sources SET descriptor_json = ?1 WHERE exam_id = 'exam_1'",
        ['{"pages":[{"page":1,"width":1000.0,"scale":1.50}],"dpi":72.0}']);

      const outcome = await f.host.runtime.dispatchInvoke({
        id: 'export-lossless', cmd: 'qbank_export_document', args: { examId: 'exam_1' },
        source: { window: 'main', webview: 'main' },
      });
      if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome));
      const json = outcome.json ?? '';
      expect(json).toContain(`"source_refs":${refs}}]`);
      expect(json).toContain(`"structured_data":${structured}`);
      expect(json).toContain(`"source_refs":${refs},"answer_source_refs":[],"section_path":["A"]`);
      expect(json).toContain('"content":"Question q2","question_type":"short_answer"');
      expect(json).toMatch(/"content":"Question q2".*"source_refs":\[\],"answer_source_refs":\[\],"section_path":\[\]/);
      expect(json).toMatch(/"sources":\[\{"pages":\[\{"page":1,"width":1000\.0,"scale":1\.50\}\],"dpi":72\.0,"source_id":"[^"]+"\}\]/);
      expect(json).toMatch(/"source_pages":\[\{"page":1,"width":1000\.0,"scale":1\.50,"source_id":"[^"]+"\}\]/);
    } finally { await f.dispose(); }
  });

  // authoring.rs:221-235：manifest/document 为 serde_json::from_slice::<Value>，再 from_value 成 QuestionDocument；
  // structured_data 原文进入草稿；解析失败 map_err(error) → Database（serde_json Display）。
  it('import_package_keeps_rust_written_numbers_verbatim', async () => {
    const f = await fixture();
    try {
      const structured = '{"answer_value":2.50,"tolerance":1e-2,"big":12345678901234567890}';
      const zip = (documentJson: string) => toBase64(buildZip([
        { name: 'document.json', data: Buffer.from(documentJson, 'utf8') },
        { name: 'manifest.json', data: Buffer.from('{"schema_version":2,"assets":[]}', 'utf8') },
      ]));
      const host = { db: f.db, blobsDir: f.blobsDir, vfsRepo: vfsTestAssetRepos() };
      const imported = await exportService.importPackage(host, zip('{"schema_version":2,"mode":"extract",'
        + '"materials":[],"groups":[],"questions":[{"local_id":"q1","content":"N","question_type":"numeric",'
        + `"structured_data":${structured}}],"coverage":[],"issues":[],"unmatched_answers":[],`
        + '"sources":[],"source_pages":[]}'));
      const job = authoringService.saveDraft(f.authoringHost, 'exam_1', imported.document, imported.metadata);
      expect(f.db.pluck<string>('SELECT document_json FROM qbank_import_jobs WHERE id = ?1', [job]))
        .toContain(`"structured_data":${structured}`);

      let error: unknown;
      try { await exportService.importPackage(host, zip('not json')); } catch (caught) { error = caught; }
      expect((error as { appError: unknown }).appError)
        .toEqual({ error_type: 'Database', message: 'expected ident at line 1 column 2', details: null });
    } finally { await f.dispose(); }
  });
});
