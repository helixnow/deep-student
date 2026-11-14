import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPipelineHost } from './chat-host.ts';
import type {} from '../../vfs/api.ts';
import type {} from '../../vfs-repos/api.ts';
import type { ToolResultInfo } from '../../chat/api.ts';
import { MAX_RETRIEVAL_PAGE_IMAGE_BYTES } from '../src/retrieval-images.ts';

const result = (hashes: string[]): ToolResultInfo => ({
  toolName: 'builtin-rag_search', toolCallId: 'call_1', input: {}, success: true,
  output: { sources: hashes.map((hash, index) => ({ blob_hash: hash, pageIndex: index })) },
});

describe('retrieval_images.rs:288–366 production blob resolution', () => {
  it('page_image_message_marks_retrieval_hit_and_carries_labels: resolves real VFS blobs in order', async () => {
    const host = await createPipelineHost({ vfs: true });
    try {
      const { vfs, vfsRepo, chatPipeline: pipeline } = host.ctx;
      const db = vfs.database.getConnSafe();
      const dir = vfs.database.blobsDir();
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const image = vfsRepo.blobs.storeBlob(db, dir, png, 'application/pdf', null);
      const pdf = vfsRepo.blobs.storeBlob(db, dir, Buffer.from('%PDF-1.7'), 'image/png', null);
      const missing = vfsRepo.blobs.storeBlob(db, dir, Buffer.from('removed'), null, null);
      fs.unlinkSync(vfsRepo.blobs.getBlobPath(db, dir, missing.hash)!);
      const oversized = vfsRepo.blobs.storeBlob(db, dir,
        Buffer.alloc(MAX_RETRIEVAL_PAGE_IMAGE_BYTES + 1), 'image/png', null);
      const warn = vi.spyOn(host.ctx.logger, 'warn');
      const hashes = [pdf.hash, image.hash, 'unknown', missing.hash, oversized.hash];
      const candidates = pipeline.collectRetrievalPageImageCandidates([result(hashes)]);
      expect(pipeline.resolveRetrievalPageImages(candidates)).toEqual([
        null, { mimeType: 'image/png', base64: png.toString('base64') }, null, null, null,
      ]);
      expect(warn).toHaveBeenCalledWith(
        `[ChatV2::ContextCompiler] skipping oversized retrieval page image (${MAX_RETRIEVAL_PAGE_IMAGE_BYTES + 1} bytes, blob hash prefix ${oversized.hash.slice(0, 12)})`);
      const budget = pipeline.createRetrievalPageImageBudget(8, 0, new Set());
      const info = vi.spyOn(host.ctx.logger, 'info');
      const message = pipeline.buildRetrievalPageImageInjection([result(hashes)], budget)!;
      expect(message.multimodal_content).toContainEqual({
        type: 'image_url', mediaType: 'image/png', base64: png.toString('base64'),
      });
      expect(message.metadata).toMatchObject({ kind: 'retrieval_page_images', hidden: true,
        canonicalContent: [{ blob_hash: image.hash, retrieval_hit: true }] });
      expect(budget.remaining()).toBe(3);
      expect(info).toHaveBeenCalledWith(
        '[ChatV2::ContextCompiler] injecting 1 retrieval page image(s) for multimodal model (3 remaining in turn budget)');
      expect(pipeline.buildRetrievalPageImageInjection([result([image.hash])], budget)).toBeNull();
    } finally { await host.dispose(); }
  });

  it('budget_respects_total_image_budget_turn_cap_and_dedupe: probes only twice remaining and commits successes', async () => {
    const host = await createPipelineHost({ vfs: true });
    try {
      const { vfs, vfsRepo, chatPipeline: pipeline } = host.ctx;
      const db = vfs.database.getConnSafe();
      const dir = vfs.database.blobsDir();
      const image = vfsRepo.blobs.storeBlob(db, dir, Buffer.from([255, 216, 255]), null, null);
      const lookup = vi.spyOn(vfsRepo.blobs, 'getBlobPath');
      const budget = pipeline.createRetrievalPageImageBudget(2, 1, new Set());
      expect(pipeline.buildRetrievalPageImageInjection([result(['missing1', 'missing2', image.hash])], budget)).toBeNull();
      expect(lookup.mock.calls.map(call => call[2])).toEqual(['missing1', 'missing2']);
      expect(budget.remaining()).toBe(1);
      expect(pipeline.buildRetrievalPageImageInjection([result(['missing1', image.hash])], budget)).not.toBeNull();
      expect(budget.remaining()).toBe(0);
      lookup.mockClear();
      expect(pipeline.buildRetrievalPageImageInjection([result([image.hash])], budget)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      const candidates = pipeline.collectRetrievalPageImageCandidates([result([image.hash])]);
      await vfs.database.enterMaintenanceMode();
      try { expect(pipeline.resolveRetrievalPageImages(candidates)).toEqual([null]); }
      finally { await vfs.database.exitMaintenanceMode(); }
    } finally { await host.dispose(); }
  });
});
