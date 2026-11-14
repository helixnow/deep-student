import { expect, it } from 'vitest';
import {
  buildImageGenerationUrl, decodeBase64ImagePayload, imageSizeForAspectRatio,
  imageSizeForConfig, imageSizeForSensenova, isImageGenerationConfig,
  parseImageGenerationResponse, type ImageApiConfig,
} from '../src/image-generation.ts';

it('maps_supported_aspect_ratios_to_openai_image_sizes', () => {
  expect(imageSizeForAspectRatio('1:1')).toEqual([1024, 1024, '1024x1024']);
  expect(imageSizeForAspectRatio('4:3')).toEqual([1536, 1024, '1536x1024']);
  expect(imageSizeForAspectRatio('16:9')).toEqual([1536, 1024, '1536x1024']);
  expect(imageSizeForAspectRatio('3:4')).toEqual([1024, 1536, '1024x1536']);
  expect(imageSizeForAspectRatio('9:16')).toEqual([1024, 1536, '1024x1536']);
  expect(imageSizeForAspectRatio('unexpected')).toEqual([1024, 1024, '1024x1024']);
});

it('maps_supported_aspect_ratios_to_sensenova_image_sizes', () => {
  const config: ImageApiConfig = {
    name: 'SenseNova Image',
    model: 'sense-image-v1',
    vendorName: 'SenseNova',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
  };
  expect(imageSizeForConfig(config, '1:1')).toEqual([2048, 2048, '2048x2048']);
  expect(imageSizeForConfig(config, '4:3')).toEqual([2368, 1760, '2368x1760']);
  expect(imageSizeForConfig(config, '16:9')).toEqual([2752, 1536, '2752x1536']);
  expect(imageSizeForConfig(config, '3:4')).toEqual([1760, 2368, '1760x2368']);
  expect(imageSizeForConfig(config, '9:16')).toEqual([1536, 2752, '1536x2752']);
  expect(imageSizeForConfig(config, 'unexpected')).toEqual([2048, 2048, '2048x2048']);
  expect(imageSizeForSensenova('4:3')).toEqual([2368, 1760, '2368x1760']);
  expect(imageSizeForConfig(null, '4:3')).toEqual([1536, 1024, '1536x1024']);
});

it('builds_image_generation_endpoint_without_double_slashes', () => {
  expect(buildImageGenerationUrl('https://api.openai.com/v1'))
    .toBe('https://api.openai.com/v1/images/generations');
  expect(buildImageGenerationUrl('https://api.openai.com/v1/'))
    .toBe('https://api.openai.com/v1/images/generations');
  expect(buildImageGenerationUrl('https://proxy.example/images/generations'))
    .toBe('https://proxy.example/images/generations');
});

it('parses_b64_json_before_url_response', () => {
  const parsed = parseImageGenerationResponse({
    data: [{
      b64_json: 'aW1hZ2U=',
      url: 'https://example.com/image.png',
      revised_prompt: 'cleaned prompt',
    }],
  });
  expect(parsed.b64_json).toBe('aW1hZ2U=');
  expect(parsed.url).toBe('https://example.com/image.png');
  expect(parsed.revised_prompt).toBe('cleaned prompt');
});

it('returns_openai_error_message_when_present', () => {
  let message = '';
  try { parseImageGenerationResponse({ error: { message: 'content policy violation' } }); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('content policy violation');
});

it('decodes_data_url_base64_payloads', () => {
  const bytes = decodeBase64ImagePayload('data:image/png;base64,aW1hZ2U=');
  expect(Buffer.from(bytes).toString('utf8')).toBe('image');
});

it('recognizes_explicit_image_generation_model_flag', () => {
  const config: ImageApiConfig = {
    name: 'Learning Illustration',
    model: 'custom-render-v1',
    providerType: 'openai-compatible',
    isImageGeneration: true,
  };
  expect(isImageGenerationConfig(config)).toBe(true);
});
