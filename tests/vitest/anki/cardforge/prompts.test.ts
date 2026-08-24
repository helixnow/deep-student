import { describe, it, expect } from 'vitest';

import {
  CARD_JSON_END,
  PromptKit,
  buildCardGenerationSystemPrompt,
  buildCardGenerationUserPrompt,
  buildErrorRepairPrompt,
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

  it('user prompt injects the real material and uses END-only protocol', () => {
    const material = '牛顿第一定律：物体在不受外力作用时保持静止或匀速直线运动。';
    const prompt = buildCardGenerationUserPrompt(material, [mockTemplate]);

    expect(prompt).toContain(material);
    expect(prompt).toContain(CARD_JSON_END);
    expect(prompt).not.toContain(LEGACY_START_MARKER);
  });

  it('error repair prompt uses END-only protocol', () => {
    const prompt = buildErrorRepairPrompt('{"front": "截断的卡片', mockTemplate);

    expect(prompt).toContain(CARD_JSON_END);
    expect(prompt).not.toContain(LEGACY_START_MARKER);
  });

  it('PromptKit no longer exposes the legacy START marker', () => {
    expect(PromptKit).not.toHaveProperty('CARD_JSON_START');
    expect(PromptKit.CARD_JSON_END).toBe('<<<ANKI_CARD_JSON_END>>>');
  });
});
