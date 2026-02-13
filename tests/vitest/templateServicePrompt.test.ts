import { describe, it, expect } from 'vitest';
import { TemplateService } from '../../src/services/templateService';
import type { CustomAnkiTemplate } from '../../src/types';

const createTemplate = (overrides: Partial<CustomAnkiTemplate> = {}): CustomAnkiTemplate => ({
  id: 'tpl-streaming',
  name: 'Streaming Prompt Template',
  description: 'Template for streaming prompt test',
  author: 'system',
  version: '1.0.0',
  preview_front: '',
  preview_back: '',
  note_type: 'Basic',
  fields: ['Front', 'Back', 'Tags'],
  generation_prompt: '按照JSON输出卡片',
  front_template: '{{Front}}',
  back_template: '{{Back}}',
  css_style: '',
  field_extraction_rules: {
    Front: { field_type: 'Text', is_required: true, description: '问题内容' },
    Back: { field_type: 'Text', is_required: true, description: '答案内容' },
    Tags: { field_type: 'Array', is_required: false, description: '标签列表' },
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  is_active: true,
  is_built_in: true,
  ...overrides,
});

describe('TemplateService.generatePrompt', () => {
  it('includes ANKI_CARD delimiter and avoids Markdown fences', () => {
    const template = createTemplate();
    const service = TemplateService.getInstance();
    const prompt = service.generatePrompt(template);
    expect(prompt).toContain('<<<ANKI_CARD_JSON_END>>>');
    expect(prompt).not.toContain('```');
  });
});

