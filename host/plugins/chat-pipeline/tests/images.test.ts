import { describe, expect, it } from 'vitest';
import type { CanonicalContentPart } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import {
  appendPreviewImages, applyExistingDerivedArtifacts, appendObservation,
  canonicalContentFromMessageMetadata, collectRuntimeImages, imageSlotKey,
  overrideMessageImagesWithCanonical, retainSelectedImagesForMultimodal,
  selectImagesWithBudget, sniffImageMime, stripAllImages,
  type CanonicalVfsImage, type ImageBudgetCandidate, type RuntimeImage,
} from '../src/images.ts';
import { contextImageCompileStrategy } from '../src/preprocess.ts';
import type { LegacyChatMessage, MultimodalContentPart } from '../src/microcompact.ts';

function candidate(message: number, image: number, turn: number, current: boolean,
  pinned: boolean): ImageBudgetCandidate {
  return {
    messageIndex: message,
    imageIndex: image,
    turnIndex: turn,
    isCurrentTurn: current,
    pinned,
    retrievalHit: false,
  };
}

function canonicalUserMessage(content: string,
  canonical: CanonicalContentPart[]): LegacyChatMessage {
  return {
    role: 'user',
    content,
    image_base64: [`bytes-${content}`],
    metadata: { canonicalContent: canonical },
  };
}

function canonicalImage(overrides: Partial<Extract<CanonicalContentPart,
  { type: 'image_ref' }>> = {}): Extract<CanonicalContentPart, { type: 'image_ref' }> {
  return {
    type: 'image_ref', image_id: 'img-1', name: 'source.png', resource_id: 'res-1',
    source_id: 'source-1', blob_hash: 'blob-original', content_hash: 'content-original',
    mime_type: 'image/png', pinned: false, retrieval_hit: false, ...overrides,
  };
}

function imageParts(message: LegacyChatMessage): Array<{ mediaType: string; base64: string }> {
  return (message.multimodal_content ?? [])
    .filter((part): part is Extract<MultimodalContentPart, { type: 'image_url' }> =>
      part.type === 'image_url')
    .map(part => ({ mediaType: part.mediaType, base64: part.base64 }));
}

function textParts(message: LegacyChatMessage): string[] {
  return (message.multimodal_content ?? [])
    .filter((part): part is Extract<MultimodalContentPart, { type: 'text' }> =>
      part.type === 'text')
    .map(part => part.text);
}

describe('chat_v2/pipeline/context_compiler/images.rs::tests', () => {
  it('image_budget_prioritizes_current_pinned_and_recent_history', () => {
    const candidates = [
      candidate(0, 0, 0, false, false),
      candidate(1, 0, 1, false, true),
      candidate(2, 0, 2, false, false),
      candidate(3, 0, 3, true, false),
      candidate(3, 1, 3, true, false),
    ];
    const selected = selectImagesWithBudget(candidates, 3, 1);
    expect(selected.has(imageSlotKey(3, 0))).toBe(true);
    expect(selected.has(imageSlotKey(3, 1))).toBe(true);
    expect(selected.has(imageSlotKey(1, 0))).toBe(true);
    expect(selected.has(imageSlotKey(2, 0))).toBe(false);
  });

  it('multimodal_compiler_keeps_raw_images_without_ocr_text', () => {
    expect(contextImageCompileStrategy(true, true)).toBe('multimodalDirect');
    const messages: LegacyChatMessage[] = [{
      role: 'user',
      content: 'look',
      image_base64: ['raw'],
    }];
    retainSelectedImagesForMultimodal(messages, new Set([imageSlotKey(0, 0)]));
    expect(messages[0]!.image_base64).toBeNull();
    const parts = messages[0]!.multimodal_content!;
    expect(parts.some(part => part.type === 'image_url' && part.base64 === 'raw')).toBe(true);
    expect(messages[0]!.content).not.toContain('OCR');
  });

  it('canonical_blob_payload_overrides_different_preview_base64_for_mm', () => {
    const message: LegacyChatMessage = {
      role: 'user',
      content: 'inspect',
      image_base64: ['compressed-preview'],
    };
    expect(overrideMessageImagesWithCanonical(message, [{
      mimeType: 'image/png', base64: 'original-blob',
    }])).toBe(1);
    expect(message.image_base64).toBeNull();
    expect(imageParts(message)).toEqual([{ mediaType: 'image/png', base64: 'original-blob' }]);
  });

  it('tm_mm_alternating_turns_recompile_the_same_original_image', () => {
    const canonical: CanonicalContentPart[] = [canonicalImage()];
    for (const activeMm of [false, true, false, true]) {
      // Each turn starts from persisted canonical metadata and resolves the same
      // Blob payload; it never clones the previous turn's flattened request shape.
      const message: LegacyChatMessage = {
        role: 'user',
        content: 'question',
        image_base64: ['compressed-preview'],
        metadata: { canonicalContent: canonical },
      };
      const recovered = canonicalContentFromMessageMetadata(message)!;
      expect(recovered[0]).toMatchObject({
        type: 'image_ref', blob_hash: 'blob-original',
      });

      overrideMessageImagesWithCanonical(message, [{
        mimeType: 'image/png', base64: 'original-image',
      }]);
      const messages = [message];
      if (activeMm) {
        retainSelectedImagesForMultimodal(messages, new Set([imageSlotKey(0, 0)]));
        expect(imageParts(messages[0]!)).toEqual([
          { mediaType: 'image/png', base64: 'original-image' },
        ]);
        expect(messages[0]!.content).not.toContain('visual observation');
        expect(messages[0]!.content).not.toContain('OCR');
      } else {
        appendObservation(messages[0]!, 'visual observation');
        stripAllImages(messages, new Set([imageSlotKey(0, 0)]), true);
        expect(messages[0]!.image_base64).toBeNull();
        expect(messages[0]!.multimodal_content).toBeNull();
        expect(messages[0]!.content).toContain('visual observation');
      }
    }
  });

  it('repeated_canonical_image_ids_reuse_each_turns_own_artifact', () => {
    const canonicalFor = (artifactId: string, observation: string): CanonicalContentPart[] => [
      canonicalImage({ image_id: 'stable-image-id', name: 'stable.png',
        blob_hash: 'same-blob', content_hash: 'same-content' }),
      {
        type: 'derived_artifact_ref', artifact_id: artifactId,
        artifact_type: 'visual_observation', source_image_ids: ['stable-image-id'],
        producer_model_id: 'observer-mm', content: observation, created_at: 1,
      },
    ];
    const messages = [
      canonicalUserMessage('first', canonicalFor('artifact-first', 'first observation')),
      canonicalUserMessage('second', canonicalFor('artifact-second', 'second observation')),
    ];
    const images: RuntimeImage[] = [
      {
        messageIndex: 0, imageIndex: 0, turnIndex: 0, isCurrentTurn: false,
        imageId: 'stable-image-id', mimeType: 'image/png', base64: 'bytes-first',
        pinned: false, retrievalHit: false,
      },
      {
        messageIndex: 1, imageIndex: 0, turnIndex: 1, isCurrentTurn: true,
        imageId: 'stable-image-id', mimeType: 'image/png', base64: 'bytes-second',
        pinned: false, retrievalHit: false,
      },
    ];

    const reused = applyExistingDerivedArtifacts(messages, images);

    expect(reused.coveredImages).toEqual(new Set([imageSlotKey(0, 0), imageSlotKey(1, 0)]));
    expect(messages[0]!.content).toContain('first observation');
    expect(messages[0]!.content).not.toContain('second observation');
    expect(messages[1]!.content).toContain('second observation');
    expect(messages[1]!.content).not.toContain('first observation');
    expect(reused.usedVisualObservation).toBe(true);
    expect(reused.usedOcr).toBe(false);
  });

  it('legacy_image_without_canonical_ref_still_compiles', () => {
    const message: LegacyChatMessage = {
      role: 'user',
      content: 'legacy',
      image_base64: ['legacy-base64'],
    };
    const images = collectRuntimeImages([message], 0, []);
    expect(images).toHaveLength(1);
    expect(images[0]!.base64).toBe('legacy-base64');
    expect(images[0]!.imageId).toBe('current:image:0');
    expect(images[0]!.mimeType).toBe('image/jpeg');
  });

  // 2026-09 PDF-bytes-as-image regression.
  it('sniff_image_mime_rejects_pdf_bytes', () => {
    expect(sniffImageMime(new TextEncoder().encode('%PDF-1.4\n...'))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode('<html></html>'))).toBeNull();
  });

  it('sniff_image_mime_detects_real_image_headers', () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46])))
      .toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])))
      .toBe('image/png');
    expect(sniffImageMime(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]))).toBe('image/webp');
  });

  it('append_preview_images_dedupes_by_blob_and_uses_page_fallbacks', () => {
    const images: CanonicalVfsImage[] = [];
    const seen = new Set<string>();
    const preview = JSON.stringify({
      pages: [
        { blobHash: 'blob_a', pageIndex: 4, mimeType: 'image/jpeg' },
        { blob_hash: 'blob_a', page_index: 5 },
        { blobHash: 'blob_b' },
      ],
    });
    appendPreviewImages(images, seen, 'res_1', 'file_1', '电路基础', 'fallback', preview);
    expect(images.map(image => image.imageId)).toEqual([
      'res_1:file_1:page:4', 'res_1:file_1:page:2',
    ]);
    expect(images[0]!.name).toBe('电路基础 (page 5)');
    expect(images[1]!.mimeType).toBe('image/png');
    expect(images[1]!.contentHash).toBe('blob_b');

    appendPreviewImages(images, seen, 'res_1', 'file_1', '电路基础', 'fallback', 'not-json');
    appendPreviewImages(images, seen, 'res_1', 'file_1', '电路基础', 'fallback', null);
    expect(images).toHaveLength(2);
  });
});
