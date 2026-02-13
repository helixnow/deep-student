import { describe, it, expect } from 'vitest';
import { TemplateRenderService } from '@/services/templateRenderService';

describe('TemplateRenderService', () => {
  it('renders lowercase option fields from extra_fields', () => {
    const template = {
      id: 'choice-template',
      name: 'choice-template',
      description: '',
      fields: ['question', 'optiona', 'optionb', 'optionc', 'optiond'],
      front_template:
        '<div>{{question}}</div><div>A. {{optiona}}</div><div>B. {{optionb}}</div>',
      back_template: '<div>{{correct}}</div>',
      css_style: '',
      template_type: 'custom',
      created_at: '',
      updated_at: '',
      note_type: 'Basic',
      generation_prompt: '',
      field_extraction_rules: {},
      is_active: true,
      is_built_in: false,
    } as any;

    const card = {
      id: 'c1',
      front: '',
      back: '',
      tags: [],
      extra_fields: {
        question: '下列属于人体第三道防线的是：',
        optiona: '皮肤和黏膜',
        optionb: '体液中的杀菌物质',
        optionc: '吞噬细胞',
        optiond: '特异性免疫',
        correct: 'D',
      },
    } as any;

    const rendered = TemplateRenderService.renderCard(card, template);
    expect(rendered.front).toContain('A. 皮肤和黏膜');
    expect(rendered.front).toContain('B. 体液中的杀菌物质');
  });
});

