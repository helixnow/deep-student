import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: real table-owner repositories exercised through the production service
import reposPlugin from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { UnitBuilderService } from '../api.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

type TestStorage = ReturnType<typeof createStorageService>;

interface Harness {
  host: TestHost;
  db: DatabaseHandle;
  base: string;
  storage: TestStorage;
  repositories: VfsReposService;
  unitBuilder: UnitBuilderService;
}

let templateDir = '';
const roots: string[] = [];
const storages: TestStorage[] = [];
const hosts: TestHost[] = [];

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-unit-source-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'vfs migration failed');
  } finally {
    storage.dispose();
  }
}, 180_000);

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.dispose();
  while (storages.length > 0) storages.pop()!.dispose();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

async function harness(pdfium: NativePdfium): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-unit-source-'));
  roots.push(base);
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  storages.push(storage);
  const host = await createTestHost({
    plugins: [reposPlugin, plugin],
    provide: { storage, nativePdfium: pdfium, paths: pathsServiceDouble(),
      files: createNodeFiles({ roots: [{ name: 'appData', path: base }] }) },
  });
  hosts.push(host);
  return {
    host,
    db: storage.database('vfs'),
    base,
    storage,
    repositories: host.ctx.get('vfsRepo') as VfsReposService,
    unitBuilder: host.ctx.get('vfsUnitBuilder') as UnitBuilderService,
  };
}

function fakePdfium(extracted: string): NativePdfium & {
  diagnostics(): Promise<Record<string, string>>;
} {
  return {
    async diagnostics() { throw new Error('legacy PDF fixture does not exercise native diagnostics'); },
    async extractText() { return extracted; },
    async open() { throw new Error('only extractText is used by legacy PDF repair'); },
  };
}

describe('Rust indexing.rs legacy PDF page re-extraction', () => {
  it('reextracts a multi-page PDF without page separators and builds page units', async () => {
    const { db, storage, repositories, unitBuilder } = await harness(fakePdfium('Page one\fPage two'));
    const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
    const bytes = new TextEncoder().encode('%PDF-1.4 fake body');
    const blob = repositories.blobs.storeBlob(db, blobsDir, bytes, 'application/pdf');
    const file = repositories.files.createFileWithDocDataInFolder(
      db, 'legacy-sha', 'legacy.pdf', bytes.length, 'file', 'application/pdf',
      blob.hash, null, null, null, 'whole document without page breaks', 2,
    );
    const resourceId = file.resourceId!;

    const units = await unitBuilder.syncResourceUnitsForResourceAsync!(resourceId);

    expect(units).toHaveLength(2);
    expect(units.map((unit) => unit.unitIndex)).toEqual([0, 1]);
    expect(units.map((unit) => unit.textContent)).toEqual(['Page one', 'Page two']);
    expect(units.map((unit) => unit.textSource)).toEqual(['native', 'native']);
  });

  it('keeps the stored whole-document text when pdfium fails', async () => {
    const failing = fakePdfium('one page only');
    failing.extractText = async () => { throw new Error('pdfium decode failed'); };
    const { db, storage, repositories, unitBuilder } = await harness(failing);
    const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
    const bytes = new TextEncoder().encode('%PDF-1.4 fake body');
    const blob = repositories.blobs.storeBlob(db, blobsDir, bytes, 'application/pdf');
    const file = repositories.files.createFileWithDocDataInFolder(
      db, 'legacy-failed-sha', 'legacy-failed.pdf', bytes.length, 'file', 'application/pdf',
      blob.hash, null, null, null, 'whole document without page breaks', 2,
    );

    const units = await unitBuilder.syncResourceUnitsForResourceAsync!(file.resourceId!);

    expect(units).toHaveLength(1);
    expect(units[0]!.textContent).toBe('whole document without page breaks');
    expect(units[0]!.textSource).toBe('native');
  });
});

describe('Rust indexing.rs exam canonical context', () => {
  it('indexes the L11 canonical question text instead of the inline resource data', async () => {
    const { db, repositories, unitBuilder } = await harness(fakePdfium('unused'));
    const exam = repositories.exams.createExamSheet(db, {
      examName: 'Canonical exam',
      tempId: 'temp-canonical',
      metadataJson: { question_document_version: 2 },
      previewJson: {},
    });
    repositories.questions.createQuestion(db, {
      exam_id: exam.id,
      content: '规范题目内容',
      question_type: 'short_answer',
      answer: '规范答案',
      explanation: '规范解析',
    });

    const units = await unitBuilder.syncResourceUnitsForResourceAsync!(exam.resourceId!);

    expect(units).toHaveLength(1);
    expect(units[0]!.textContent).toContain('规范题目内容');
    expect(units[0]!.textContent).toContain('规范答案');
    expect(units[0]!.textSource).toBe('ocr');
  });
});
