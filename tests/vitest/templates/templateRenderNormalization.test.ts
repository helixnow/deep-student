import { describe, expect, it } from 'vitest';
import { TemplateRenderService } from '@/services/templateRenderService';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

const buildTemplate = (overrides: Partial<CustomAnkiTemplate> = {}): CustomAnkiTemplate => ({
  id: 'tpl-render',
  name: 'Render Template',
  description: 'Render normalization tests',
  author: 'tester',
  version: '1.0.0',
  preview_front: '',
  preview_back: '',
  note_type: 'Basic',
  fields: ['Front', 'Back', 'CommonMistakes'],
  generation_prompt: 'Generate cards',
  front_template: '<ul>{{#CommonMistakes}}<li>{{.}}</li>{{/CommonMistakes}}</ul>',
  back_template: '<div>{{Front}}</div>',
  css_style: '',
  field_extraction_rules: {},
  created_at: new Date('2026-02-08T00:00:00Z').toISOString(),
  updated_at: new Date('2026-02-08T00:00:00Z').toISOString(),
  is_active: true,
  is_built_in: false,
  ...overrides,
});

describe('TemplateRenderService normalization', () => {
  it('normalizes snake_case fields and parses JSON arrays', () => {
    const template = buildTemplate();
    const card = {
      front: 'Question',
      back: 'Answer',
      extra_fields: {
        common_mistakes: '["Alpha","Beta"]',
      },
    } as AnkiCard;

    const rendered = TemplateRenderService.renderCard(card, template);
    expect(rendered.front).toContain('<li>Alpha</li>');
    expect(rendered.front).toContain('<li>Beta</li>');
    expect(rendered.back).toContain('Question');
  });
});
