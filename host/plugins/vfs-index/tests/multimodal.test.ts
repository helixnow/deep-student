import { describe, expect, it } from 'vitest';
import {
  MultimodalInput,
  normalizeMultimodalRrfScore,
  parseMultimodalProvenance,
  unifiedMultimodalRequest,
  type VfsMultimodalPage,
} from '../src/multimodal.ts';

describe('Rust vfs/multimodal_service.rs tests', () => {
  it('legacy_multimodal_search_inputs_build_unified_profile_requests', () => {
    const folders = ['folder-a'];
    const resources = ['resource-a'];
    const types = ['textbook'];
    const text = MultimodalInput.withInstruction(MultimodalInput.text('query'), 'retrieve pages');
    const textRequest = unifiedMultimodalRequest(text, 7, folders, resources, types);
    expect(textRequest.queryModality).toBe('text');
    expect(textRequest.topK).toBe(7);
    expect(textRequest.folderIds).toEqual(folders);
    expect(textRequest.resourceIds).toEqual(resources);
    expect(textRequest.resourceTypes).toEqual(types);
    expect(textRequest.queryText).toBe('retrieve pages\n\nquery');

    const image = MultimodalInput.imageBase64('bytes', 'image/png');
    const imageRequest = unifiedMultimodalRequest(image, 3);
    expect(imageRequest.queryModality).toBe('image');
    expect(imageRequest.queryImageBase64).toBe('bytes');

    const mixed = MultimodalInput.textAndImage('query', 'bytes', 'image/webp');
    const mixedRequest = unifiedMultimodalRequest(mixed, 5);
    expect(mixedRequest.queryModality).toBe('mixed');
  });

  it('url_only_image_cannot_bypass_profile_aware_retrieval', () => {
    const input = MultimodalInput.imageUrl('https://example.invalid/image.png');
    expect(() => unifiedMultimodalRequest(input, 5)).toThrow(/Base64 image bytes/);
  });

  it('multimodal_compatibility_scores_preserve_rrf_order', () => {
    const best = 0.032;
    expect(normalizeMultimodalRrfScore(best, best)).toBe(1);
    expect(normalizeMultimodalRrfScore(best / 2, best)).toBe(0.5);
    expect(normalizeMultimodalRrfScore(Number.NaN, best)).toBe(0);
  });

  it('test_multimodal_page', () => {
    const page: VfsMultimodalPage = {
      page_index: 0,
      image_base64: 'test',
      image_mime: 'image/png',
      text_content: 'Test content',
      blob_hash: 'abc123',
    };
    expect(page.page_index).toBe(0);
    expect(page.image_base64).not.toBeNull();
  });

  it('parses_blob_and_unit_provenance_without_using_source_id', () => {
    const metadata = JSON.stringify({
      page_index: 3,
      blob_hash: 'blob_real_page_hash',
      source_id: 'resource_uuid_not_a_blob',
      unit_id: 'unit_page_3',
    });
    const [blobHash, unitId] = parseMultimodalProvenance(metadata);
    expect(blobHash).toBe('blob_real_page_hash');
    expect(unitId).toBe('unit_page_3');
  });
});
