/**
 * `question_authoring_runner.rs::attach_figures`（真实 SQLite + 真实 vfsRepo blob/文件）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import native from '../../../platform/native/index.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import qbank from '../index.ts';
import { cropImageCodecOf } from '../src/native-image.ts';
import { attachFigures, type GenerationFiguresHost } from '../src/generation-figures.ts';
import type { SourceBundle } from '../src/source-bundle.ts';

/** 10×10 PNG 页图 fixture。 */
const PAGE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGP4z8DwnxjMMKrwP12DBwCSw8c5lI9cnwAAAABJRU5ErkJggg==';

async function fixture() {
  const { storage, base } = await createMigratedStorage('qbank-gen-fig-');
  const host = await createTestHost({
    plugins: [native, qbank, vfsRepos],
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
  const page = repos.blobs.storeBlob(db, blobsDir, Buffer.from(PAGE_PNG, 'base64'), 'image/png', 'png');
  const figuresHost: GenerationFiguresHost = { db, blobsDir, repos, nativeImage: cropImageCodecOf(host.ctx) };
  const bundle: SourceBundle = {
    sources: [{ source_id: 's1', page_count: 1 }],
    pages: [{ source_id: 's1', page: 1, blob_hash: page.hash, width: 10, height: 10, text_hint: null }],
    text: '', format: 'pdf',
  };
  return {
    host, repos, db, figuresHost, bundle,
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function appErrorOf(error: unknown) {
  return (error as { appError?: { error_type?: string; message?: string } }).appError;
}

describe('attach_figures', () => {
  it('drops model-supplied images and rejects invalid page/bbox', async () => {
    const f = await fixture();
    try {
      const cases: [unknown, string][] = [
        [{ source_id: 's1', page: 2, bbox: [0, 0, 1, 1] }, '配图引用了无效源页'],
        [{ source_id: 's1', page: 1 }, '配图缺少bbox'],
        [{ source_id: 's1', page: 1, bbox: [0.5, 0, 0.5, 1] }, '配图bbox无效，未忽略必要配图'],
        [{ source_id: 's1', page: 1, bbox: [0, 0, 1.2, 1] }, '配图bbox无效，未忽略必要配图'],
      ];
      for (const [figure, message] of cases) {
        const raw = { questions: [{ local_id: 'q1', images: [{ id: 'forged' }], figures: [figure] }] };
        await expect(attachFigures(f.figuresHost, raw as never, f.bundle)).rejects.toSatisfy(
          error => appErrorOf(error)?.error_type === 'Validation' && appErrorOf(error)?.message === message);
        expect(raw.questions[0]!.images).toEqual([]);
      }
    } finally {
      await f.dispose();
    }
  });

  it('crops figures into blobs and VFS files with roles', async () => {
    const f = await fixture();
    try {
      expect(f.figuresHost.nativeImage).not.toBeNull();
      const raw = {
        questions: [{ local_id: 'q1', figures: [{ source_id: 's1', page: 1, bbox: [0, 0, 0.5, 0.5], role: 'option' }] }],
        materials: [{ local_id: 'm1', figures: [{ source_id: 's1', page: 1, bbox: [0.1, 0.1, 1, 1] }] }],
      };
      await attachFigures(f.figuresHost, raw as never, f.bundle);
      const question = (raw.questions[0] as unknown as { images: { id: string; name: string; role: string; hash: string }[] }).images;
      const material = (raw.materials[0] as unknown as { images: { name: string; role: string }[] }).images;
      expect(question).toHaveLength(1);
      expect(question[0]).toMatchObject({ name: 'figure_q1_p1.png', role: 'option' });
      expect(material[0]).toMatchObject({ name: 'figure_m1_p1.png', role: 'material' });
      expect(f.repos.blobs.getBlobPath(f.db, f.figuresHost.blobsDir, question[0]!.hash)).not.toBeNull();
    } finally {
      await f.dispose();
    }
  });
});
