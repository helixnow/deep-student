import { describe, it, expect } from 'vitest';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import {
  buildGenerativeUISystemPrompt,
  GENERATIVE_UI_FEW_SHOT_EXAMPLES,
  GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS,
  GENERATIVE_UI_NEGATIVE_EXAMPLES,
  LEARNING_DASHBOARD_EXAMPLE,
  MISTAKE_DIAGNOSIS_EXAMPLE,
  NOTES_HITL_EXAMPLE,
  RESEARCH_BRIEFING_EXAMPLE,
} from '@/features/generative-ui/prompts';
import { parseGenerativeUIIntent, validateBlockProps } from '@/features/generative-ui/schema';
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
  it('exports at least 4 few-shot intents covering required scenarios', () => {
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(LEARNING_DASHBOARD_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(MISTAKE_DIAGNOSIS_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(RESEARCH_BRIEFING_EXAMPLE);
    expect(GENERATIVE_UI_FEW_SHOT_EXAMPLES).toContain(NOTES_HITL_EXAMPLE);

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

    expect(GENERATIVE_UI_NEGATIVE_EXAMPLES.length).toBeGreaterThanOrEqual(5);
    for (const keyword of GENERATIVE_UI_NEGATIVE_EXAMPLE_KEYWORDS) {
      expect(prompt, `missing negative keyword: ${keyword}`).toContain(keyword);
    }
  });

  it('system prompt embeds all few-shot JSON documents', () => {
    const prompt = buildGenerativeUISystemPrompt();
    for (const example of GENERATIVE_UI_FEW_SHOT_EXAMPLES) {
      expect(prompt).toContain(JSON.stringify(example, null, 2));
    }
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
  });
});
