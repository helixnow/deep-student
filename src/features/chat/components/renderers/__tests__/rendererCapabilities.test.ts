import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RENDERER_CAPABILITIES,
  parseRendererCapabilities,
} from '../rendererCapabilities';

describe('renderer capabilities settings', () => {
  it('keeps a minimal default and accepts only boolean overrides', () => {
    expect(DEFAULT_RENDERER_CAPABILITIES).toMatchObject({
      chemicalStructures: true,
      charts: false,
      graphviz: false,
    });
    expect(parseRendererCapabilities('{"charts":true,"music":"yes"}')).toMatchObject({
      chemicalStructures: true,
      charts: true,
      music: false,
    });
  });

  it('falls back safely for malformed persisted values', () => {
    expect(parseRendererCapabilities('{not json}')).toEqual(DEFAULT_RENDERER_CAPABILITIES);
  });
});
