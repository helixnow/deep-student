import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { buildGenerativeUISystemPrompt, LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import { generativeUIIntentSchema, validateBlockProps } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

describe('generativeUI registryPromptSync contract', () => {
  it('every registered type appears in system prompt catalog line with props hint', () => {
    const prompt = buildGenerativeUISystemPrompt();
    for (const config of generativeUIRegistry.getAll()) {
      const catalogEntry = generativeUIRegistry.getCatalogForPrompt().find((c) => c.type === config.type);
      expect(catalogEntry?.propsHint.length).toBeGreaterThan(0);
      expect(prompt).toContain(`- **${config.type}**: ${config.description}`);
      expect(prompt).toContain(`props ${catalogEntry!.propsHint}`);
      expect(config.description?.length).toBeGreaterThan(0);
    }
  });

  it('LEARNING_DASHBOARD_EXAMPLE passes intent and block props schemas', () => {
    const intentResult = generativeUIIntentSchema.safeParse(LEARNING_DASHBOARD_EXAMPLE);
    expect(intentResult.success).toBe(true);
    for (const block of LEARNING_DASHBOARD_EXAMPLE.blocks) {
      const config = generativeUIRegistry.get(block.type);
      expect(config).toBeDefined();
      const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
      expect(validation.ok).toBe(true);
    }
  });

  it('blocks/index registers each type exactly once in source', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/blocks/index.ts'),
      'utf8',
    );
    const matches = src.match(/type:\s*'([^']+)'/g) ?? [];
    const types = matches.map((m) => m.replace(/type:\s*'/, '').replace(/'$/, ''));
    const unique = new Set(types);
    expect(types.length).toBe(unique.size);
    expect(generativeUIRegistry.keys().sort()).toEqual(Array.from(unique).sort());
  });
});
