import { expect, it } from 'vitest';
import { MultimodalInput, indexingModeFromStr, indexingModeAsStr, vectorTableSuffix, toVLEmbeddingInput } from '../src/multimodal/types.ts';

it('test_multimodal_input_text_only', () => {
  const input = MultimodalInput.text('Hello world');
  expect(input.isTextOnly()).toBe(true);
  expect(input.hasImage()).toBe(false);
  expect(input.isEmpty()).toBe(false);
  expect(input.text).toBe('Hello world');
});
it('test_multimodal_input_image_only', () => {
  const input = MultimodalInput.imageBase64('base64data', 'image/png');
  expect(input.isTextOnly()).toBe(false);
  expect(input.hasImage()).toBe(true);
  expect(input.isEmpty()).toBe(false);
});
it('test_multimodal_input_mixed', () => {
  const input = MultimodalInput.textAndImage('Description', 'base64data', 'image/jpeg');
  expect(input.isTextOnly()).toBe(false);
  expect(input.hasImage()).toBe(true);
  expect(input.text).toBe('Description');
});
it('test_multimodal_input_with_instruction', () => {
  expect(MultimodalInput.text('Query').withInstruction('Represent the query').instruction).toBe('Represent the query');
});
it('test_vl_embedding_input_conversion', () => {
  const input = toVLEmbeddingInput(MultimodalInput.textAndImage('Test', 'abc123', 'image/png'));
  expect(input.text).toBe('Test');
  expect(input.image).toBe('data:image/png;base64,abc123');
});
it('test_indexing_mode_roundtrip', () => {
  expect(indexingModeFromStr('vl_embedding')).toBe('vl_embedding');
  expect(indexingModeFromStr('vl-summary-then-text-embed')).toBe('vl_summary_then_text_embed');
  expect(indexingModeAsStr('vl_embedding')).toBe('vl_embedding');
  expect(vectorTableSuffix()).toBe('vl');
});
