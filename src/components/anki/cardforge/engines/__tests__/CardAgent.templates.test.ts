import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
let defaultTemplateId: string | null = null;

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/services/ankiApiAdapter', () => ({ ankiApiAdapter: {} }));
vi.mock('@/utils/fileManager', () => ({ fileManager: {} }));
vi.mock('@/data/ankiTemplates', () => {
  const make = (id: string, noteType: string, fields: string[]) => ({
    id, name: id, description: id, fields, note_type: noteType, is_active: true,
    field_extraction_rules: {}, generation_prompt: `prompt ${id}`,
  });
  const templates = [make('design-lab', 'Basic', ['Question', 'correct']), make('design-glass', 'Cloze', ['Text', 'Extra'])];
  return {
    templateManager: {
      loadTemplates: vi.fn(async () => {}),
      getActiveTemplates: () => templates,
      getAllTemplates: () => templates,
    },
  };
});

import { CardAgent } from '../CardAgent';

const sentOptions = () => {
  const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'start_enhanced_document_processing');
  return (call?.[1] as { options: Record<string, unknown> }).options;
};

describe('CardAgent template selection', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_default_template_id') return defaultTemplateId;
      if (cmd === 'start_enhanced_document_processing') return 'doc-1';
      return null;
    });
  });

  it('lets the model choose among all active templates when no default is set', async () => {
    defaultTemplateId = null;
    await new CardAgent().startGeneration({ content: '拉格朗日中值定理的条件与结论' });
    const options = sentOptions();
    expect(options.template_ids).toEqual(['design-lab', 'design-glass']);
    expect(options.note_type).toBe('Basic');
  });

  it('uses only the default template (and its note type) when one is set', async () => {
    defaultTemplateId = 'design-glass';
    await new CardAgent().startGeneration({ content: '拉格朗日中值定理的条件与结论' });
    const options = sentOptions();
    expect(options.template_ids).toEqual(['design-glass']);
    expect(options.template_id).toBe('design-glass');
    expect(options.note_type).toBe('Cloze');
  });
});
