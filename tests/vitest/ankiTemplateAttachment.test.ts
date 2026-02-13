import { describe, it, expect } from 'vitest';
import type { AnkiGenerationOptions, CustomAnkiTemplate } from '../../src/types';
import { buildAnkiTemplateAttachment } from '../../src/utils/ankiTemplateAttachment';
import { computeSha256Hex } from '../../src/utils/hash';

const createTemplate = (overrides: Partial<CustomAnkiTemplate> = {}): CustomAnkiTemplate => ({
  id: 'tpl-test',
  name: 'Test Template',
  description: 'Template for unit tests',
  author: 'system',
  version: '1.0.0',
  preview_front: '',
  preview_back: '',
  note_type: 'Basic',
  fields: ['Front', 'Back'],
  generation_prompt: 'Answer with JSON.',
  front_template: '{{Front}}',
  back_template: '{{Back}}',
  css_style: '',
  field_extraction_rules: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  is_active: true,
  is_built_in: true,
  ...overrides,
});

const baseOptions: AnkiGenerationOptions = {
  deck_name: 'Default',
  note_type: 'Basic',
  enable_images: true,
  max_cards_per_mistake: 5,
};

describe('buildAnkiTemplateAttachment', () => {
  it('returns full payload when size within limit', async () => {
    const template = createTemplate();
    const prompt = 'Short prompt content';

    const { attachment, trimmed, bytes } = await buildAnkiTemplateAttachment({
      template,
      prompt,
      options: baseOptions,
      customRequirements: 'Keep answers concise.',
    });

    expect(trimmed).toBe(false);
    expect(bytes).toBeGreaterThan(0);
    expect(attachment.mime_type).toBe('application/anki-template+json');
    expect(attachment.text_content).toContain('"prompt": "Short prompt content"');
    expect(attachment.text_content).toContain('"custom_requirements": "Keep answers concise."');
  });

  it('trims payload and hashes options when exceeding 50KB', async () => {
    const template = createTemplate({ id: 'tpl-large' });
    const prompt = 'x'.repeat(60 * 1024);

    const { attachment, trimmed } = await buildAnkiTemplateAttachment({
      template,
      prompt,
      options: baseOptions,
    });

    expect(trimmed).toBe(true);
    const expectedHash = await computeSha256Hex(JSON.stringify(baseOptions));
    expect(attachment.text_content).toContain(`"options_hash": "${expectedHash}"`);
    expect(attachment.text_content).not.toContain('"prompt":');
    expect(attachment.size_bytes).toBeLessThan(50 * 1024);
  });
});

