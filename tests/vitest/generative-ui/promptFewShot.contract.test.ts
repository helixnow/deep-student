import { describe, it, expect } from 'vitest';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  buildGenerativeUISystemPrompt,
  formatInteractiveFewShotJson,
  GENERATIVE_UI_FEW_SHOT_EXAMPLES,
  GENERATIVE_UI_INTERACTIVE_FEW_SHOTS,
  GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS,
  GENERATIVE_UI_NEGATIVE_EXAMPLES,
  IMAGE_CHOICE_EXAMPLE,
  LEARNING_ANALYTICS_EXAMPLE,
  LEARNING_DASHBOARD_EXAMPLE,
  LEARNING_PREFERENCE_FORM_EXAMPLE,
  MISTAKE_DIAGNOSIS_EXAMPLE,
  NOTES_HITL_EXAMPLE,
  QUIZ_CHOICE_EXAMPLE,
  RESEARCH_BRIEFING_EXAMPLE,
  RESEARCH_COMPARISON_EXAMPLE,
  STUDY_PLAN_EXAMPLE,
} from '@/features/generative-ui/prompts';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
import {
  MAX_GENERATIVE_UI_BLOCKS,
  parseGenerativeUIIntent,
  validateBlockProps,
} from '@/features/generative-ui/schema';
import { generativeUiSkill } from '@/features/chat/skills/builtin-tools/generative-ui';

import '@/features/generative-ui/blocks';

function expectValidFewShot(example: (typeof GENERATIVE_UI_FEW_SHOT_EXAMPLES)[number], label: string) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(example));
  expect(parsed.ok, `${label} parseGenerativeUIIntent`).toBe(true);
  if (!parsed.ok) return;

  expect(parsed.intent.blocks.length).toBeGreaterThan(0);
  for (const block of parsed.intent.blocks) {
    const config = generativeUIRegistry.get(block.type);
    expect(config, `${label} registry missing type ${block.type}`).toBeDefined();
    const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
    expect(validation.ok, `${label} ${block.type} props`).toBe(true);
  }
}

describe('generativeUI promptFewShot contract', () => {
  it('exports at least 7 few-shot intents covering required scenarios', () => {
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(7);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(LEARNING_DASHBOARD_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(MISTAKE_DIAGNOSIS_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(RESEARCH_BRIEFING_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(NOTES_HITL_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(LEARNING_ANALYTICS_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(STUDY_PLAN_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(RESEARCH_COMPARISON_EXAMPLE);

    const learningTypes = LEARNING_DASHBOARD_EXAMPLE.blocks.map((b) => b.type);
    expect(learningTypes).toEqual(expect.arrayContaining(['stat-card', 'progress', 'action-bar']));

    const mistakeTypes = MISTAKE_DIAGNOSIS_EXAMPLE.blocks.map((b) => b.type);
    expect(mistakeTypes).toEqual(expect.arrayContaining(['mistake-analysis', 'list']));

    const researchTypes = RESEARCH_BRIEFING_EXAMPLE.blocks.map((b) => b.type);
    expect(researchTypes).toEqual(
      expect.arrayContaining(['research-plan', 'research-report', 'paper-digest']),
    );

    const notesTypes = NOTES_HITL_EXAMPLE.blocks.map((b) => b.type);
    expect(notesTypes).toEqual(expect.arrayContaining(['text', 'action-bar']));
    const notesActions =
      (NOTES_HITL_EXAMPLE.blocks.find((b) => b.type === 'action-bar')?.props as {
        actions?: Array<{ id: string; riskLevel?: string }>;
      })?.actions ?? [];
    expect(notesActions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['apply-note-edit', 'dismiss-note-suggestion']),
    );
    expect(notesActions.some((a) => a.id === 'apply-note-edit' && a.riskLevel === 'high')).toBe(true);

    const analyticsTypes = LEARNING_ANALYTICS_EXAMPLE.blocks.map((b) => b.type);
    expect(analyticsTypes).toEqual(expect.arrayContaining(['chart', 'table', 'action-bar']));

    const planTypes = STUDY_PLAN_EXAMPLE.blocks.map((b) => b.type);
    expect(planTypes).toEqual(expect.arrayContaining(['steps', 'markdown']));

    const comparisonTypes = RESEARCH_COMPARISON_EXAMPLE.blocks.map((b) => b.type);
    expect(comparisonTypes).toEqual(expect.arrayContaining(['paper-digest', 'table']));
    expect(comparisonTypes.some((type) => type === 'table' || type === 'chart')).toBe(true);

    expect(JSON.stringify(GENERATIVE_UI_FEW_SHOT_EXAMPLES)).toContain('copy-block');
  });

  it('every few-shot passes parseGenerativeUIIntent + registry validateBlockProps', () => {
    GENERATIVE_UI_FEW_SHOT_EXAMPLES.forEach((example, index) => {
      expectValidFewShot(example, `few-shot[${index}] ${example.meta?.title ?? ''}`);
    });
  });

  it('few-shot types are a subset of the live registry catalog', () => {
    const catalog = new Set(generativeUIRegistry.keys());
    for (const example of GENERATIVE_UI_FEW_SHOT_EXAMPLES) {
      for (const block of example.blocks) {
        expect(catalog.has(block.type), `unregistered few-shot type ${block.type}`).toBe(true);
      }
    }
  });

  it('system prompt contains catalog types, streaming constraints, and negative keywords', () => {
    const prompt = buildGenerativeUISystemPrompt();
    const catalog = generativeUIRegistry.getCatalogForPrompt();

    expect(catalog.length).toBeGreaterThanOrEqual(14);
    for (const entry of catalog) {
      expect(prompt).toContain(entry.type);
      expect(prompt).toContain(`- **${entry.type}**: ${entry.description}`);
      expect(prompt).toContain(`props ${entry.propsHint}`);
    }

    expect(prompt).toContain('流式约束');
    expect(prompt).toContain('先输出完整 JSON 结构');
    expect(prompt).toContain('围栏外');
    expect(prompt).toContain('riskLevel');
    expect(prompt).toContain('researchSessionId');
    expect(prompt).toContain('edit-apply');
    expect(prompt).toContain('edit-reject');

    expect(GENERATIVE_UI_NEGATIVE_EXAMPLES.length).toBeGreaterThanOrEqual(7);
    expect(GENERATIVE_UI_NEGATIVE_EXAMPLES.map((ex) => ex.id)).toEqual(
      expect.arrayContaining(['chart-series-mismatch', 'table-no-columns']),
    );
    for (const keyword of GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS) {
      expect(prompt, `missing negative keyword: ${keyword}`).toContain(keyword);
    }
  });

  it('system prompt default block limit matches the schema contract', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(MAX_GENERATIVE_UI_BLOCKS).toBe(32);
    expect(prompt).toContain(`最多 ${MAX_GENERATIVE_UI_BLOCKS} 个 blocks`);
    expect(prompt).not.toContain('最多 12 个 blocks');
    expect(buildGenerativeUISystemPrompt({ maxBlocks: 8 })).toContain('最多 8 个 blocks');
    expect(buildGenerativeUISystemPrompt({ maxBlocks: 64 })).toContain(
      `最多 ${MAX_GENERATIVE_UI_BLOCKS} 个 blocks`,
    );
  });

  it('system prompt embeds all few-shot JSON documents', () => {
    const prompt = buildGenerativeUISystemPrompt();
    for (const example of GENERATIVE_UI_FEW_SHOT_EXAMPLES) {
      expect(prompt).toContain(JSON.stringify(example, null, 2));
    }
  });

  it('system prompt injects JSON Schema type constraints from the registered enum', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('chart');
    expect(prompt).toContain('steps');
    expect(prompt).toContain('table');
    expect(prompt).toContain('stat-card');
    expect(prompt).toMatch(/32|maxItems/);
  });

  it('system prompt does not dump the full JSON Schema object', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(prompt).toContain('JSON Schema 类型约束');
    expect(prompt).not.toContain('$schema');
    expect(prompt).not.toContain('x-registered-block-types');
  });

  it('skill content stays synced with registry types and HITL / research / no-HTML rules', () => {
    const registered = generativeUIRegistry.keys();
    expect(registered.length).toBeGreaterThanOrEqual(14);
    for (const type of registered) {
      expect(generativeUiSkill.content).toContain(type);
    }
    expect(generativeUiSkill.content).toMatch(/禁止[\s\S]*HTML/);
    expect(generativeUiSkill.content).toContain('researchSessionId');
    expect(generativeUiSkill.content).toContain('hpias_event');
    expect(generativeUiSkill.content).toContain('HITL');
    expect(generativeUiSkill.content).toContain('apply-note-edit');
    expect(generativeUiSkill.content).toContain('canvas:ai-edit-request');
    expect(generativeUiSkill.content).toContain('riskLevel');
    expect(generativeUiSkill.content).toMatch(/markdown[^\n]*长文|摘要/);
    expect(generativeUiSkill.content).toMatch(/chart[^\n]*categories/);
    expect(generativeUiSkill.content).toMatch(/steps[^\n]*学习计划|流程/);
    expect(generativeUiSkill.content).toMatch(/table[^\n]*columns/);
    expect(generativeUiSkill.content).toContain('chart + table + action-bar');
    expect(generativeUiSkill.content).toContain('steps + markdown');
  });

  it('system prompt injects JSON Schema type constraints from the registered enum', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('chart');
    expect(prompt).toContain('steps');
    expect(prompt).toContain('table');
    expect(prompt).toContain('stat-card');
    expect(prompt).toMatch(/32|maxItems/);
  });

  it('system prompt does not dump the full JSON Schema object', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(prompt).toContain('JSON Schema 类型约束');
    expect(prompt).not.toContain('$schema');
    expect(prompt).not.toContain('x-registered-block-types');
  });
});

// ============================================================================
// 交互作答 few-shot（awaitAnswer=true + choice / form / image）
// 结构断言直接按方案第 1.2–1.3 节契约手写，不依赖 WP-D 的 schema 实现；
// 末尾两条再用 schema.ts 的 zod schema 与 validateIntentRules 交叉校验。
// ============================================================================

const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FOLLOWUP_ID_RE = /^followup:[a-z0-9-]{1,40}$/;
const RESOURCE_ID_RE = /^(att|file|img|res)_[A-Za-z0-9_-]{1,120}$/;
const PDF_RESOURCE_ID_RE = /^res_[A-Za-z0-9_-]{1,120}$/;
const FORM_FIELD_KINDS = ['text', 'number', 'slider', 'rating', 'switch'];
const INTERACTIVE_TYPES = new Set(['choice', 'form']);

type Rec = Record<string, unknown>;

function collectImageSources(intent: GenerativeUIIntent): Rec[] {
  const sources: Rec[] = [];
  for (const block of intent.blocks) {
    const props = (block.props ?? {}) as Rec;
    if (block.type === 'image') sources.push(props.source as Rec);
    if (block.type === 'choice') {
      for (const option of (props.options as Rec[]) ?? []) {
        if (option.image) sources.push(option.image as Rec);
      }
    }
  }
  return sources;
}

function expectValidImageSource(source: Rec, label: string) {
  expect(source, `${label} image source`).toBeTruthy();
  switch (source.kind) {
    case 'resource':
      expect(String(source.resourceId), label).toMatch(RESOURCE_ID_RE);
      break;
    case 'pdf-page':
      expect(String(source.resourceId), label).toMatch(PDF_RESOURCE_ID_RE);
      expect(Number.isInteger(source.page), label).toBe(true);
      expect(source.page as number).toBeGreaterThanOrEqual(1);
      expect(source.page as number).toBeLessThanOrEqual(10000);
      break;
    case 'url':
      expect(String(source.url), label).toMatch(/^https:\/\//);
      expect(String(source.url).length).toBeLessThanOrEqual(2048);
      break;
    default:
      throw new Error(`${label}: unknown image source kind ${String(source.kind)}`);
  }
}

function expectInteractiveFewShotContract(intent: GenerativeUIIntent, label: string) {
  const parsed = parseGenerativeUIIntent(JSON.stringify(intent));
  expect(parsed.ok, `${label} parseGenerativeUIIntent`).toBe(true);

  const interactive = intent.blocks.filter((b) => INTERACTIVE_TYPES.has(b.type));
  expect(interactive.length, `${label} interactive count`).toBeGreaterThanOrEqual(1);
  expect(interactive.length, `${label} interactive count`).toBeLessThanOrEqual(4);

  const blockIds = interactive.map((b) => b.id);
  for (const id of blockIds) {
    expect(id, `${label} interactive block id required`).toBeDefined();
    expect(id!, label).toMatch(BLOCK_ID_RE);
  }
  expect(new Set(blockIds).size, `${label} interactive ids unique`).toBe(blockIds.length);

  for (const block of interactive) {
    const props = (block.props ?? {}) as Rec;
    if (block.type === 'choice') {
      expect(typeof props.question).toBe('string');
      expect((props.question as string).length).toBeGreaterThan(0);
      expect((props.question as string).length).toBeLessThanOrEqual(300);
      expect(['single', 'multiple', undefined]).toContain(props.mode);
      const options = props.options as Rec[];
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(12);
      const optionIds = options.map((o) => o.id as string);
      for (const id of optionIds) expect(id).toMatch(OPTION_ID_RE);
      expect(new Set(optionIds).size).toBe(optionIds.length);
      for (const option of options) {
        expect((option.label as string).length).toBeGreaterThan(0);
        expect((option.label as string).length).toBeLessThanOrEqual(120);
      }
      if (props.mode === 'multiple') {
        const min = (props.minSelect as number | undefined) ?? 1;
        const max = (props.maxSelect as number | undefined) ?? options.length;
        expect(min).toBeLessThanOrEqual(max);
        expect(max).toBeLessThanOrEqual(options.length);
      }
    } else {
      const fields = props.fields as Rec[];
      expect(fields.length).toBeGreaterThanOrEqual(1);
      expect(fields.length).toBeLessThanOrEqual(12);
      const names = fields.map((f) => f.name as string);
      for (const name of names) expect(name).toMatch(FIELD_NAME_RE);
      expect(new Set(names).size).toBe(names.length);
      for (const field of fields) {
        expect(FORM_FIELD_KINDS).toContain(field.kind);
        expect((field.label as string).length).toBeLessThanOrEqual(80);
        if (field.kind === 'slider') {
          const step = (field.step as number | undefined) ?? 1;
          expect(typeof field.min).toBe('number');
          expect(typeof field.max).toBe('number');
          expect(((field.max as number) - (field.min as number)) / step).toBeLessThanOrEqual(1000);
        }
        if (field.kind === 'rating' && field.max !== undefined) {
          expect(field.max as number).toBeGreaterThanOrEqual(3);
          expect(field.max as number).toBeLessThanOrEqual(10);
        }
        if (field.kind === 'text' && field.maxLength !== undefined) {
          expect(field.maxLength as number).toBeLessThanOrEqual(2000);
        }
      }
    }
  }

  const images = collectImageSources(intent);
  expect(images.length, `${label} image refs`).toBeLessThanOrEqual(8);
  images.forEach((source, i) => expectValidImageSource(source, `${label} image[${i}]`));
  for (const block of intent.blocks.filter((b) => b.type === 'image')) {
    const alt = (block.props as Rec).alt as string;
    expect(alt.length).toBeGreaterThan(0);
    expect(alt.length).toBeLessThanOrEqual(200);
  }

  const actions = intent.blocks
    .filter((b) => b.type === 'action-bar')
    .flatMap((b) => ((b.props as Rec).actions as Rec[]) ?? []);
  const followups = actions.filter((a) => String(a.id).startsWith('followup:'));
  expect(followups.length).toBeLessThanOrEqual(4);
  for (const action of actions) {
    if (String(action.id).startsWith('followup:')) {
      expect(String(action.id)).toMatch(FOLLOWUP_ID_RE);
      expect(typeof action.prompt).toBe('string');
      expect((action.prompt as string).length).toBeGreaterThan(0);
      expect((action.prompt as string).length).toBeLessThanOrEqual(500);
    } else {
      expect(action.prompt, `${label} non-followup action must not carry prompt`).toBeUndefined();
    }
  }
}

/** validateIntentRules 返回形态由 WP-D 决定；兼容 {ok} / {errors} / string[] / true。 */
function rulesResultOk(result: unknown): boolean {
  if (result === true || result === undefined || result === null) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === 'object') {
    const r = result as { ok?: unknown; errors?: unknown; error?: unknown };
    if (typeof r.ok === 'boolean') return r.ok;
    if (Array.isArray(r.errors)) return r.errors.length === 0;
    if (r.error !== undefined) return !r.error;
  }
  return false;
}

describe('generativeUI interactive few-shot contract (awaitAnswer)', () => {
  it('exports exactly the 3 interactive few-shots, all with awaitAnswer=true', () => {
    expect(GENERATIVE_UI_INTERACTIVE_FEW_SHOTS.map((e) => e.id)).toEqual([
      'quiz-choice',
      'learning-preference-form',
      'image-choice',
    ]);
    expect(GENERATIVE_UI_INTERACTIVE_FEW_SHOTS.map((e) => e.intent)).toEqual([
      QUIZ_CHOICE_EXAMPLE,
      LEARNING_PREFERENCE_FORM_EXAMPLE,
      IMAGE_CHOICE_EXAMPLE,
    ]);
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      expect(example.awaitAnswer).toBe(true);
    }
    // 展示类 few-shot 不得混入交互块（choice/form 只能配 awaitAnswer）
    for (const example of GENERATIVE_UI_FEW_SHOT_EXAMPLES) {
      for (const block of example.blocks) {
        expect(INTERACTIVE_TYPES.has(block.type), `display few-shot uses ${block.type}`).toBe(false);
      }
    }
  });

  it('covers choice (single + multiple), form (all 5 field kinds), image (pdf-page + resource) and followup', () => {
    const quizChoices = QUIZ_CHOICE_EXAMPLE.blocks.filter((b) => b.type === 'choice');
    expect(quizChoices.map((b) => (b.props as Rec).mode)).toEqual(['single', 'multiple']);

    const form = LEARNING_PREFERENCE_FORM_EXAMPLE.blocks.find((b) => b.type === 'form');
    expect(((form?.props as Rec).fields as Rec[]).map((f) => f.kind).sort()).toEqual(
      [...FORM_FIELD_KINDS].sort(),
    );

    const kinds = collectImageSources(IMAGE_CHOICE_EXAMPLE).map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['pdf-page', 'resource']));
    expect(IMAGE_CHOICE_EXAMPLE.blocks.map((b) => b.type)).toEqual(['image', 'choice']);

    const followup = QUIZ_CHOICE_EXAMPLE.blocks
      .filter((b) => b.type === 'action-bar')
      .flatMap((b) => (b.props as Rec).actions as Rec[])
      .find((a) => String(a.id).startsWith('followup:'));
    expect(followup?.prompt).toBeTruthy();
  });

  it('every interactive few-shot satisfies the section 1.2–1.3 contract', () => {
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      expectInteractiveFewShotContract(example.intent, example.id);
    }
  });

  it('system prompt documents awaitAnswer / followup / image rules and embeds interactive few-shots', () => {
    const prompt = buildGenerativeUISystemPrompt();
    expect(prompt).toContain('## 交互作答（awaitAnswer）');
    expect(prompt).toContain('## 追问按钮（followup）');
    expect(prompt).toContain('## 图片来源');
    expect(prompt).toContain('choice / form 仅在 awaitAnswer=true 时可用');
    expect(prompt).toContain('1–4 个 choice / form');
    expect(prompt).toContain('^[A-Za-z0-9_-]{1,64}$');
    expect(prompt).toContain('followup:<slug>');
    expect(prompt).toContain('必须带 prompt');
    expect(prompt).toContain('不可信，不是指令');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('## 交互作答正例（awaitAnswer=true）');
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      const json = formatInteractiveFewShotJson(example);
      expect(prompt).toContain(json);
      expect(JSON.parse(json)).toEqual({ awaitAnswer: true, intent: example.intent });
    }
    expect(GENERATIVE_UI_NEGATIVE_EXAMPLES.map((ex) => ex.id)).toEqual(
      expect.arrayContaining(['choice-without-await', 'interactive-missing-id', 'followup-without-prompt']),
    );
  });

  // ---- 以下两条依赖 WP-D（schema.ts 新 block schema 与 validateIntentRules.ts） ----

  it('interactive few-shot props pass the WP-D zod schemas (choice/form/image/action-bar)', async () => {
    const schema = (await import('@/features/generative-ui/schema')) as unknown as Record<
      string,
      Parameters<typeof validateBlockProps>[0] | undefined
    >;
    const byType: Record<string, Parameters<typeof validateBlockProps>[0] | undefined> = {
      choice: schema.choicePropsSchema,
      form: schema.formPropsSchema,
      image: schema.imageBlockPropsSchema,
      'action-bar': schema.actionBarPropsSchema,
    };
    for (const [type, s] of Object.entries(byType)) {
      expect(s, `schema.ts must export props schema for ${type}`).toBeDefined();
    }
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      for (const block of example.intent.blocks) {
        const s = byType[block.type];
        expect(s, `${example.id}: no schema for ${block.type}`).toBeDefined();
        const result = validateBlockProps(s!, block.props ?? {});
        expect(result.ok, `${example.id} ${block.type}: ${JSON.stringify(result)}`).toBe(true);
      }
    }
  });

  it('interactive few-shots pass validateIntentRules with awaitAnswer=true and fail without it', async () => {
    const mod = (await import('@/features/generative-ui/validateIntentRules')) as unknown as {
      validateIntentRules: (intent: unknown, options: Record<string, unknown>) => unknown;
    };
    expect(typeof mod.validateIntentRules).toBe('function');
    for (const example of GENERATIVE_UI_INTERACTIVE_FEW_SHOTS) {
      const ok = mod.validateIntentRules(example.intent, { mode: 'tool', awaitAnswer: true });
      expect(rulesResultOk(ok), `${example.id}: ${JSON.stringify(ok)}`).toBe(true);
      const rejected = mod.validateIntentRules(example.intent, { mode: 'tool', awaitAnswer: false });
      expect(rulesResultOk(rejected), `${example.id} must be rejected without awaitAnswer`).toBe(false);
    }
    // 展示类 few-shot 在非 await 模式下也必须通过（followup/action 规则不误伤）
    for (const example of GENERATIVE_UI_FEW_SHOT_EXAMPLES) {
      const result = mod.validateIntentRules(example, { mode: 'tool', awaitAnswer: false });
      expect(rulesResultOk(result), `${example.meta?.title}: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});
