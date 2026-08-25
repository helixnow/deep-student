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
  'paper-digest',
  'research-plan',
  'research-report',
  'markdown',
  'chart',
  'steps',
  'table',
];

const SKILL_ACTION_IDS = ['start-review', 'open-qbank', 'export-plan', 'copy-report', 'copy-block', 'export-intent', 'apply-note-edit'];

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
    const intentSchema = tool?.inputSchema?.properties?.intent as {
      required?: string[];
      properties?: {
        version?: { enum?: string[] };
        layout?: {
          properties?: {
            mode?: { enum?: string[] };
            columns?: { enum?: number[] };
          };
        };
        blocks?: { maxItems?: number; items?: { properties?: { span?: { enum?: number[] } } } };
      };
    };
    expect(intentSchema?.required).toContain('blocks');
    expect(intentSchema?.properties?.version?.enum).toEqual(['1', '1.1']);
    expect(intentSchema?.properties?.layout?.properties?.mode?.enum).toEqual(['stack', 'grid']);
    expect(intentSchema?.properties?.layout?.properties?.columns?.enum).toEqual([1, 2, 3]);
    expect(intentSchema?.properties?.blocks?.items?.properties?.span?.enum).toEqual([1, 2, 3]);
    expect(intentSchema?.properties?.blocks?.maxItems).toBe(32);
    const noteEditSchema = tool?.inputSchema?.properties?.noteEdit as { properties?: Record<string, unknown> };
    expect(noteEditSchema?.properties?.operation).toBeDefined();
    const researchSessionSchema = tool?.inputSchema?.properties?.researchSessionId as { type?: string };
    expect(researchSessionSchema?.type).toBe('string');
  });

  it('skill content documents researchSessionId HPIAS bridge', () => {
    expect(generativeUiSkill.content).toContain('researchSessionId');
    expect(generativeUiSkill.content).toContain('hpias_event');
    expect(generativeUiSkill.content).toMatch(/必须.*researchSessionId|researchSessionId.*必须/);
  });

  it('skill content lists markdown/chart/steps/table usage in one line each', () => {
    expect(generativeUiSkill.content).toMatch(/markdown[^\n]*长文|摘要/);
    expect(generativeUiSkill.content).toMatch(/chart[^\n]*categories/);
    expect(generativeUiSkill.content).toMatch(/steps[^\n]*学习计划|流程/);
    expect(generativeUiSkill.content).toMatch(/table[^\n]*columns/);
  });

  it('skill example action ids are documented in content', () => {
    for (const id of SKILL_ACTION_IDS) {
      expect(generativeUiSkill.content).toContain(id);
    }
    expect(generativeUiSkill.content).toContain('copy-block');
  });

  it('skill content documents max 32 blocks and JSON Schema type constraint', () => {
    expect(generativeUiSkill.content).toMatch(/32/);
    expect(generativeUiSkill.content).toContain('MAX_GENERATIVE_UI_BLOCKS');
    expect(generativeUiSkill.content).toContain('copy-block');
    expect(generativeUiSkill.content).toMatch(/type 必须属于 registry/);
    expect(generativeUiSkill.content).toContain('markdown');
    expect(generativeUiSkill.content).toContain('chart');
    expect(generativeUiSkill.content).toContain('steps');
    expect(generativeUiSkill.content).toContain('table');
    expect(generativeUiSkill.content).toMatch(/JSON Schema enum/);
  });

  it('Rust executor tool name matches skill allowedTools mapping', () => {
    const rustSrc = fs.readFileSync(
      path.join(process.cwd(), 'src-tauri/src/chat_v2/tools/generative_ui_executor.rs'),
      'utf8',
    );
    expect(rustSrc).toContain('render_generative_ui');
    expect(rustSrc).toContain('researchSessionId');
    expect(rustSrc).toContain('fn validate_intent_version');
    expect(rustSrc).toContain('"1.1"');
    expect(rustSrc).toContain('layout');
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
