import { describe, it, expect } from 'vitest';

import {
  CARD_JSON_END,
  PromptKit,
  buildCardGenerationSystemPrompt,
  buildContentAnalysisPrompt,
} from '@/components/anki/cardforge/prompts';
import type { TemplateInfo } from '@/components/anki/cardforge/types';

const LEGACY_START_MARKER = '<<<ANKI_CARD_JSON_START>>>';

const mockTemplate: TemplateInfo = {
  id: 'basic',
  name: 'Basic',
  description: 'Basic template',
  category: 'general',
  fields: ['front', 'back', 'tags'],
  noteType: 'Basic',
  isActive: true,
  complexityLevel: 'simple',
  useCaseDescription: 'General knowledge',
};

describe('PromptKit output protocol (END-only)', () => {
  it('system prompt requires only the END delimiter', () => {
    const prompt = buildCardGenerationSystemPrompt();

    expect(prompt).toContain(CARD_JSON_END);
    expect(prompt).not.toContain(LEGACY_START_MARKER);
  });

  it('system prompt never embeds material or placeholders', () => {
    const prompt = buildCardGenerationSystemPrompt();

    expect(prompt).not.toContain('{{DOCUMENT_CONTENT}}');
  });

  it('content analysis prompt embeds the material and template ids', () => {
    const material = '牛顿第一定律：物体在不受外力作用时保持静止或匀速直线运动。';
    const prompt = buildContentAnalysisPrompt(material, [mockTemplate]);

    expect(prompt).toContain(material);
    expect(prompt).toContain('basic');
  });

  it('PromptKit no longer exposes the legacy START marker', () => {
    expect(PromptKit).not.toHaveProperty('CARD_JSON_START');
    expect(PromptKit.CARD_JSON_END).toBe('<<<ANKI_CARD_JSON_END>>>');
  });

  it('PromptKit only exposes prompts that are wired to a real call path', () => {
    // 死 prompt（boundary/user/errorRepair/qualityAssessment）已删除：
    // - 定界 prompt：前端 LLM 定界死代码已移除（定界由后端管线执行）
    // - user prompt：学习材料由后端注入 user 消息，前端从不组装
    // - 修复/质量评估：流程从未接线
    expect(Object.keys(PromptKit).sort()).toEqual(
      ['CARD_JSON_END', 'buildCardGenerationSystemPrompt', 'buildContentAnalysisPrompt'].sort()
    );
  });
});
