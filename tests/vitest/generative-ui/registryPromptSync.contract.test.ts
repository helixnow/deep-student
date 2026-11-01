import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  buildGenerativeUISystemPrompt,
  GENERATIVE_UI_INTERACTIVE_FEW_SHOTS,
  LEARNING_DASHBOARD_EXAMPLE,
} from '@/features/generative-ui/prompts';
import { generativeUIIntentSchema, validateBlockProps } from '@/features/generative-ui/schema';
import {
  GENERATIVE_UI_TOOL_BLOCK_TYPES,
  generativeUiSkill,
} from '@/features/chat/skills/builtin-tools/generative-ui';

import '@/features/generative-ui/blocks';

describe('generativeUI registry ↔ prompt / tool schema sync (interactive blocks)', () => {
  it('tool inputSchema type enum equals the live registry (21 types incl. choice/form/image)', () => {
    const inputSchema = generativeUiSkill.embeddedTools?.[0]?.inputSchema as {
      properties?: {
        intent?: {
          properties?: { blocks?: { items?: { properties?: { type?: { enum?: string[] } } } } };
        };
      };
    };
    const enumTypes = inputSchema.properties?.intent?.properties?.blocks?.items?.properties?.type?.enum ?? [];
    expect([...enumTypes].sort()).toEqual(generativeUIRegistry.keys().sort());
    expect([...GENERATIVE_UI_TOOL_BLOCK_TYPES].sort()).toEqual(generativeUIRegistry.keys().sort());
    for (const type of ['choice', 'form', 'image']) {
      expect(enumTypes).toContain(type);
    }
  });

  it('system prompt catalog lists choice / form / image', () => {
    const prompt = buildGenerativeUISystemPrompt();
    for (const type of ['choice', 'form', 'image']) {
      const config = generativeUIRegistry.get(type);
      expect(config, `registry missing ${type}`).toBeDefined();
      expect(prompt).toContain(`- **${type}**: ${config!.description}`);
    }
  });

  it('interactive few-shots pass intent schema and registry props schemas', () => {
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      expect(generativeUIIntentSchema.safeParse(example.intent).success, example.id).toBe(true);
      for (const block of example.intent.blocks) {
        const config = generativeUIRegistry.get(block.type);
        expect(config, `${example.id}: registry missing ${block.type}`).toBeDefined();
        const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
        expect(validation.ok, `${example.id} ${block.type}: ${JSON.stringify(validation)}`).toBe(true);
      }
    }
  });
});

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

  it('shared schema metadata declares each rendered type exactly once', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/blockSchemas.ts'),
      'utf8',
    );
    const matches = src.match(/type:\s*'([^']+)'/g) ?? [];
    const types = matches.map((m) => m.replace(/type:\s*'/, '').replace(/'$/, ''));
    const unique = new Set(types);
    expect(types.length).toBe(unique.size);
    expect(generativeUIRegistry.keys().sort()).toEqual(Array.from(unique).sort());
  });
});
