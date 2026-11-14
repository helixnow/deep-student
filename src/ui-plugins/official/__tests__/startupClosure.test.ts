// @vitest-environment node
/**
 * FE-B6: the Markdown pipeline and generative UI blocks still load with their renderers. Only the light contract
 * modules that let the startup plugins receive their contributions join the boot chunk.
 */
import { describe, expect, it } from 'vitest';
import { relative, staticClosure } from './importGraph';

const startup = new Set(relative(staticClosure(['src/main.tsx', 'src/ui-kernel/bootstrap.ts', 'src/ui-plugins/official/install.ts'])));

describe('startup closure (FE-B6)', () => {
  it('keeps MarkdownRenderer, its pipeline and the generative UI renderer and blocks lazy', () => {
    expect([
      'src/features/chat/components/renderers/MarkdownRenderer.tsx',
      'src/features/chat/components/renderers/markdownPipeline.ts',
      'src/features/chat/utils/citationRemarkPlugin.ts',
      'src/features/chat/components/renderers/rehypeSearchHighlights.ts',
      'src/features/generative-ui/GenerativeUIRenderer.tsx',
      'src/features/generative-ui/blocks/index.ts',
    ].filter((file) => startup.has(file))).toEqual([]);
  });

  it('adds only dependency-free contract modules for the lazy contributions', () => {
    for (const contract of ['src/ui-plugins/official/content/pipeline.ts', 'src/features/generative-ui/componentContributions.ts']) {
      expect(startup.has(contract)).toBe(true);
      expect(relative(staticClosure([contract]))).toEqual([contract, 'src/ui-kernel/lazy.ts', 'src/ui-sdk/lazy.ts'].sort());
    }
  });
});
