import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { buildGenerativeUISystemPrompt } from '@/features/generative-ui/prompts';

import '@/features/generative-ui/blocks';

describe('generativeUI registryPromptSync contract', () => {
  it('every registered type appears in system prompt catalog', () => {
    const prompt = buildGenerativeUISystemPrompt();
    for (const config of generativeUIRegistry.getAll()) {
      expect(prompt).toContain(config.type);
      expect(config.description?.length).toBeGreaterThan(0);
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
