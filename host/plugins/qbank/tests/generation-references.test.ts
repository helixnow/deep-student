/**
 * 移植 Rust 测试：`qbank_generation/reference.rs` tests 与
 * `question_authoring_runner.rs` 的 source_loader / image_bundle 用例（真实 SQLite + vfsRepo；
 * L18 栅格化与文档解析、L13b 文本策略以所有者发布签名的替身提供）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import qbank from '../index.ts';
import {
  collectReferences, decodeBase64, extension, loadSourceBundle, type ReferenceHost, type RasterizeOutput,
} from '../src/generation-references.ts';
import { referenceUsedCount } from '../src/generation-runner.ts';
import { expectedCoverage, coverageKey, userContent } from '../src/source-bundle.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwnxjMMKrwP12DBwCSw8c5lI9cnwAAAABJRU5ErkJggg==', 'base64');

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-gen-ref-');
  const host = await createTestHost({
    plugins: [qbank, vfsRepos],
    provide: {
      storage,
      paths: createPaths({
        dataDir: base,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' },
      }),
    },
  });
  const repos = host.ctx.vfsRepo as VfsReposService;
  const db = storage.database('vfs');
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  const rasterizeImages = async (content: string): Promise<RasterizeOutput> => {
    const items: string[] = content.trimStart().startsWith('[') ? JSON.parse(content) as string[] : [content];
    return { pages: items.map((item, index) => {
      const blob = repos.blobs.storeBlob(db, blobsDir, Buffer.from(item, 'base64'), 'image/png', 'png');
      return { page_index: index, blob_hash: blob.hash, text_hint: null, width: 10, height: 10 };
    }) };
  };
  let mediaText: string | null = null;
  const refHost: ReferenceHost = {
    db, blobsDir, repos,
    rasterizer: { rasterizePdfCancellable: async () => { throw new Error('unused'); }, rasterizeImages },
    docs: {
      extractDocxWithImages: async () => ({ text: '', images: [] }),
      extractTextFromBase64: async (_name, content) => Buffer.from(content, 'base64').toString('utf8'),
    },
    refText: { extractFileTextWithStrategy: async () => mediaText },
    nativeImage: null,
  };
  return {
    repos, db, blobsDir, refHost,
    setMediaText(text: string | null) { mediaText = text; },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('qbank_generation/reference.rs', () => {
  it('extension_is_lowercase_and_has_text_fallback', () => {
    expect(extension('A.PDF')).toBe('pdf');
    expect(extension('notes')).toBe('txt');
  });

  it('empty_bundle_reports_no_references', async () => {
    const f = await fixture();
    try {
      const references = await collectReferences(f.refHost, { exam_id: 'e', stream_session_id: 's' });
      expect(references.bundle.sources).toEqual([]);
      expect(references.bundle.format).toBe('none');
      expect(referenceUsedCount(references)).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it('library files, transcripts and uploads are merged with r-prefixed ids; failures are skipped', async () => {
    const f = await fixture();
    try {
      const notes = f.repos.files.createFileWithDocDataInFolder(f.db, 'sha-notes', 'notes.md', 4, 'document',
        'text/markdown', null, null, null, null, '已提取正文', null);
      const lecture = f.repos.files.createFileWithDocDataInFolder(f.db, 'sha-mp4', 'lecture.mp4', 4, 'video',
        'video/mp4', null, null, null, null, null, null);
      const silent = f.repos.files.createFileWithDocDataInFolder(f.db, 'sha-mp3', 'silent.mp3', 4, 'audio',
        'audio/mpeg', null, null, null, null, null, null);
      const references = await collectReferences({
        ...f.refHost,
        refText: { extractFileTextWithStrategy: async (_c, id) => id === lecture.id ? '[00:01] 第一句' : null },
      }, {
        exam_id: 'e', stream_session_id: 's',
        reference_file_ids: ['missing', notes.id, lecture.id, silent.id],
        reference_files_base64: [{ name: 'Answers.TXT', base64: b64('答案附录 END') }, { name: 'bad.txt', base64: '!!' }],
      });
      expect(references.skipped).toEqual([
        { name: 'missing', reason: 'file_not_found', detail: 'missing' },
        { name: silent.id, reason: 'text_extract_failed', detail: '音视频转写文本不可用' },
        { name: 'bad.txt', reason: 'read_failed', detail: '源文件 base64 无效: Invalid symbol 33, offset 0.' },
      ]);
      expect(references.bundle.sources.map(source => source.source_id)).toEqual(['r1_s1', 'r2_s1', 'r3_s1']);
      expect(references.bundle.sources[0]).toMatchObject({ format: 'media_transcript', name: 'notes.md' });
      expect(references.bundle.text).toContain('===== 参考文件 r1：notes.md =====\n已提取正文');
      expect(references.bundle.text).toContain('===== 参考文件 r3：Answers.TXT =====\n答案附录 END');
      expect(references.bundle.format).toBe('txt');
      expect(referenceUsedCount(references)).toBe(3);
    } finally {
      await f.dispose();
    }
  });
});

describe('question_authoring_runner.rs source loading', () => {
  it('source_loader_preserves_long_text_and_separate_answer_files', async () => {
    const f = await fixture();
    try {
      const text = `${'Complete question text. '.repeat(6000)}\nEND_OF_QUESTION_FILE`;
      const answers = 'Answer appendix: section B question 1 = C. END_OF_ANSWERS';
      const inputs = JSON.stringify([
        { name: 'questions.txt', format: 'txt', content: b64(text) },
        { name: 'answers.txt', format: 'txt', content: b64(answers) },
      ]);
      const bundle = await loadSourceBundle(f.refHost, inputs, 'bundle', 'test');
      expect(bundle.text).toContain('END_OF_QUESTION_FILE');
      expect(bundle.text).toContain('END_OF_ANSWERS');
      expect(bundle.sources).toHaveLength(2);
      expect(bundle.sources[0]!.source_id).not.toBe(bundle.sources[1]!.source_id);
      const content = JSON.stringify(userContent(bundle, () => new Uint8Array(), 'extract'));
      expect(content).toContain('END_OF_QUESTION_FILE');
      expect(content).toContain('END_OF_ANSWERS');
      expect(expectedCoverage(bundle).has(coverageKey('file1_s1', null))).toBe(true);
      expect(expectedCoverage(bundle).has(coverageKey('file2_s1', null))).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it('image_bundle_supplies_every_page_in_order_without_clipping_at_twenty', async () => {
    const f = await fixture();
    try {
      const page = PNG.toString('base64');
      for (const count of [1, 19, 20, 21]) {
        const bundle = await loadSourceBundle(f.refHost, JSON.stringify(Array(count).fill(page)), 'image', 'pages');
        expect(bundle.pages).toHaveLength(count);
        const parts = userContent(bundle, hash => fs.readFileSync(f.repos.blobs.getBlobPath(f.db, f.blobsDir, hash)!),
          'extract') as { type: string; image_url?: { url: string } }[];
        expect(parts.filter(part => part.type === 'image_url')).toHaveLength(count);
        expect(parts.at(-1)!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
        expect(bundle.sources[0]).toMatchObject({ source_id: 's1', format: 'image', page_count: count });
      }
    } finally {
      await f.dispose();
    }
  });

  it('decode strips data URLs and reports base64 crate errors', () => {
    expect(Buffer.from(decodeBase64(`data:text/plain;base64,${b64('hi')}`)).toString()).toBe('hi');
    expect(() => decodeBase64('abc')).toThrow(/Invalid padding/);
  });
});
