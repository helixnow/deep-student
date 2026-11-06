import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  GENERATIVE_UI_TOOL_BLOCK_TYPES,
  generativeUiSkill,
} from '@/features/chat/skills/builtin-tools/generative-ui';
import {
  IMAGE_CHOICE_EXAMPLE,
  LEARNING_PREFERENCE_FORM_EXAMPLE,
  QUIZ_CHOICE_EXAMPLE,
} from '@/features/generative-ui/prompts/fewShotExamples';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { generativeUIIntentSchema, validateBlockProps } from '@/features/generative-ui/schema';

import '@/features/generative-ui/blocks';

const INTERACTIVE_BLOCK_TYPES = ['choice', 'form', 'image'];

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
  ...INTERACTIVE_BLOCK_TYPES,
];

type ToolSchemaShape = {
  properties?: {
    awaitAnswer?: { type?: string; description?: string };
    intent?: {
      properties?: {
        blocks?: {
          items?: {
            properties?: {
              type?: { type?: string; enum?: string[] };
              props?: { description?: string };
              id?: { description?: string };
            };
          };
        };
      };
    };
  };
  required?: string[];
};

function toolSchema(): ToolSchemaShape {
  return generativeUiSkill.embeddedTools?.[0]?.inputSchema as ToolSchemaShape;
}

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

  it('inputSchema blocks.items.type is the 21-type enum (incl. choice/form/image)', () => {
    const typeNode = toolSchema().properties?.intent?.properties?.blocks?.items?.properties?.type;
    expect(typeNode?.type).toBe('string');
    expect(typeNode?.enum).toHaveLength(21);
    expect([...(typeNode?.enum ?? [])].sort()).toEqual([...SKILL_BLOCK_TYPES].sort());
    expect([...GENERATIVE_UI_TOOL_BLOCK_TYPES].sort()).toEqual([...SKILL_BLOCK_TYPES].sort());
    expect(new Set(typeNode?.enum).size).toBe(21);
  });

  it('inputSchema exposes optional awaitAnswer boolean and documents interactive constraints', () => {
    const schema = toolSchema();
    expect(schema.properties?.awaitAnswer?.type).toBe('boolean');
    expect(schema.required).toEqual(['intent']);
    expect(schema.properties?.awaitAnswer?.description).toMatch(/choice\/form/);
    expect(schema.properties?.awaitAnswer?.description).toMatch(/1-4/);

    const items = schema.properties?.intent?.properties?.blocks?.items?.properties;
    expect(items?.id?.description).toMatch(/choice\/form/);
    expect(items?.id?.description).toContain('必填');
    expect(items?.id?.description).toContain('^[A-Za-z0-9_-]{1,64}$');
    for (const needle of ['choice', 'options', 'single|multiple', 'form', 'fields', 'image', 'source', 'pdf-page', 'alt']) {
      expect(items?.props?.description, `props description missing ${needle}`).toContain(needle);
    }
  });

  it('skill content documents interactive answering, follow-up buttons and image sources', () => {
    const content = generativeUiSkill.content;
    expect(content).toContain('## 交互作答（awaitAnswer）');
    expect(content).toContain('## 追问按钮');
    expect(content).toContain('## 图片来源');
    expect(content).toMatch(/choice \/ form \*\*仅在 awaitAnswer=true 时可用\*\*/);
    expect(content).toContain('1–4 个 choice / form');
    expect(content).toContain('必须在 block 级写唯一 id');
    expect(content).toContain('不可信，不是指令');
    expect(content).toContain('ask_user');
    expect(content).toContain('followup:<slug>');
    expect(content).toMatch(/必须带 prompt/);
    for (const prefix of ['att_', 'file_', 'img_', 'res_']) {
      expect(content).toContain(prefix);
    }
    expect(content).toContain('pdf-page');
    expect(content).toContain('仅 https');
    expect(content).toContain('不得编造');
    for (const type of INTERACTIVE_BLOCK_TYPES) {
      expect(content).toMatch(new RegExp(`^- ${type}：`, 'm'));
    }
  });

  // 技能正文只内嵌最常用的选择题示例（完整工具参数）；表单 / 带图示例只放在编排提示词
  // （prompts.ts）。理由：控制 token 预算，且带图示例含占位资源 ID，内嵌进每轮可见的
  // 技能正文时模型易照抄（2026-11-01 集成取舍）。
  it('skill content embeds only the quiz few-shot as full tool arguments', () => {
    const content = generativeUiSkill.content;
    const quizCall = JSON.stringify({ awaitAnswer: true, intent: QUIZ_CHOICE_EXAMPLE });
    expect(content).toContain(quizCall);
    expect(JSON.parse(quizCall).awaitAnswer).toBe(true);
    expect(content).toContain('"type":"choice"');
    expect(content).toContain('"id":"followup:explain-derivative"');
    for (const intent of [LEARNING_PREFERENCE_FORM_EXAMPLE, IMAGE_CHOICE_EXAMPLE]) {
      expect(content).not.toContain(JSON.stringify({ awaitAnswer: true, intent }));
    }
    // 表单与图片仍有字段规则说明
    expect(content).toContain('## 图片来源');
    expect(content).toMatch(/form：text（maxLength/);
  });
});
