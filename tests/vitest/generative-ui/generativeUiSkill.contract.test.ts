import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generativeUiSkill } from '@/features/chat/skills/builtin-tools/generative-ui';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { generativeUIIntentSchema, validateBlockProps } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

const SKILL_BLOCK_TYPES = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
];

const SKILL_ACTION_IDS = ['start-review', 'open-qbank', 'export-plan', 'apply-note-edit', 'save-to-library'];

describe('generativeUiSkill contract', () => {
  it('skill content lists every registered block type', () => {
    const registered = new Set(generativeUIRegistry.keys());
    for (const type of SKILL_BLOCK_TYPES) {
      expect(generativeUiSkill.content).toContain(type);
      expect(registered.has(type), `registry missing ${type}`).toBe(true);
    }
  });

  it('embedded tool schema requires intent.blocks array', () => {
    const tool = generativeUiSkill.embeddedTools?.[0];
    expect(tool?.name).toBe('builtin-render_generative_ui');
    const intentSchema = tool?.inputSchema?.properties?.intent as { required?: string[] };
    expect(intentSchema?.required).toContain('blocks');
    const noteEditSchema = tool?.inputSchema?.properties?.noteEdit as { properties?: Record<string, unknown> };
    expect(noteEditSchema?.properties?.operation).toBeDefined();
  });

  it('skill example action ids are documented in content', () => {
    for (const id of SKILL_ACTION_IDS) {
      expect(generativeUiSkill.content).toContain(id);
    }
  });

  it('Rust executor tool name matches skill allowedTools mapping', () => {
    const rustSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs'),
      'utf8',
    );
    expect(rustSrc).toContain('render_generative_ui');
    expect(generativeUiSkill.allowedTools).toContain('builtin-render_generative_ui');
  });

  it('minimal skill-shaped intent passes frontend schema', () => {
    const intent = {
      version: '1',
      blocks: SKILL_BLOCK_TYPES.slice(0, 3).map((type) => ({
        type,
        props: type === 'stat-card'
          ? { title: 'Test', value: 1 }
          : type === 'alert'
            ? { title: 'Notice', description: 'ok', variant: 'info' }
            : { title: 'List', items: [{ label: 'a' }] },
      })),
    };
    const parsed = generativeUIIntentSchema.safeParse(intent);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      for (const block of parsed.data.blocks) {
        const config = generativeUIRegistry.get(block.type);
        expect(config).toBeDefined();
        const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
        expect(validation.ok).toBe(true);
      }
    }
  });
});
