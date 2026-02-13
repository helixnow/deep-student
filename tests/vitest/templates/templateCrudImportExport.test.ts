import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomAnkiTemplate, FieldExtractionRule } from '@/types';

const templateStore = vi.hoisted(() => ({
  templates: [] as CustomAnkiTemplate[],
  defaultTemplateId: null as string | null,
  nextId: 1,
}));

const mockTemplateManager = vi.hoisted(() => ({
  getAllTemplates: vi.fn(() => templateStore.templates),
  getDefaultTemplate: vi.fn(() => {
    if (templateStore.defaultTemplateId) {
      const selected = templateStore.templates.find(t => t.id === templateStore.defaultTemplateId);
      if (selected) return selected;
    }
    return templateStore.templates[0];
  }),
  createTemplate: vi.fn(async (templateData: Omit<CustomAnkiTemplate, 'id' | 'created_at' | 'updated_at'>) => {
    const id = `tpl-${templateStore.nextId++}`;
    const now = new Date('2026-02-08T00:00:00Z').toISOString();
    templateStore.templates.push({
      ...templateData,
      id,
      created_at: now,
      updated_at: now,
    });
    return id;
  }),
  updateTemplate: vi.fn(async (templateId: string, updates: Partial<CustomAnkiTemplate>) => {
    const index = templateStore.templates.findIndex(t => t.id === templateId);
    if (index === -1) return;
    templateStore.templates[index] = {
      ...templateStore.templates[index],
      ...updates,
      updated_at: new Date('2026-02-08T00:10:00Z').toISOString(),
    };
  }),
  deleteTemplate: vi.fn(async (templateId: string) => {
    templateStore.templates = templateStore.templates.filter(t => t.id !== templateId);
  }),
  setDefaultTemplate: vi.fn(async (templateId: string) => {
    templateStore.defaultTemplateId = templateId;
  }),
}));

vi.mock('@/data/ankiTemplates', () => ({
  templateManager: mockTemplateManager,
}));

import { TemplateService } from '@/services/templateService';

const buildTemplate = (overrides: Partial<CustomAnkiTemplate> = {}): CustomAnkiTemplate => ({
  id: 'tpl-base',
  name: 'Base Template',
  description: 'Base template for tests',
  author: 'tester',
  version: '1.0.0',
  preview_front: '',
  preview_back: '',
  note_type: 'Basic',
  fields: ['Front', 'Back'],
  generation_prompt: 'Generate cards',
  front_template: '{{Front}}',
  back_template: '{{Back}}',
  css_style: '',
  field_extraction_rules: {},
  created_at: new Date('2026-02-08T00:00:00Z').toISOString(),
  updated_at: new Date('2026-02-08T00:00:00Z').toISOString(),
  is_active: true,
  is_built_in: false,
  ...overrides,
});

const createTemplatePayload = (overrides: Partial<CustomAnkiTemplate> = {}) => {
  const template = buildTemplate(overrides);
  const { id, created_at, updated_at, ...payload } = template;
  return payload;
};

describe('TemplateService template CRUD/import/export', () => {
  beforeEach(() => {
    templateStore.templates = [];
    templateStore.defaultTemplateId = null;
    templateStore.nextId = 1;
    mockTemplateManager.getAllTemplates.mockClear();
    mockTemplateManager.getDefaultTemplate.mockClear();
    mockTemplateManager.createTemplate.mockClear();
    mockTemplateManager.updateTemplate.mockClear();
    mockTemplateManager.deleteTemplate.mockClear();
    mockTemplateManager.setDefaultTemplate.mockClear();
  });

  it('creates, updates, and deletes templates', async () => {
    const service = TemplateService.getInstance();
    const created = await service.createTemplate(createTemplatePayload({ name: 'Physics Template' }));

    expect(created.id).toMatch(/^tpl-/);
    expect(created.name).toBe('Physics Template');
    expect(mockTemplateManager.createTemplate).toHaveBeenCalledTimes(1);

    const updated = await service.updateTemplate(created.id, { description: 'Updated description' });
    expect(updated.description).toBe('Updated description');
    expect(mockTemplateManager.updateTemplate).toHaveBeenCalledTimes(1);

    await service.deleteTemplate(created.id);
    expect(mockTemplateManager.deleteTemplate).toHaveBeenCalledTimes(1);
    expect(templateStore.templates.find(t => t.id === created.id)).toBeUndefined();
  });

  it('fails update/delete when template does not exist', async () => {
    const service = TemplateService.getInstance();
    await expect(service.updateTemplate('missing', { name: 'Nope' })).rejects.toThrow('not found');
    await expect(service.deleteTemplate('missing')).rejects.toThrow('not found');
  });

  it('exports all templates or selected templates', async () => {
    const service = TemplateService.getInstance();
    const first = await service.createTemplate(createTemplatePayload({ name: 'One' }));
    const second = await service.createTemplate(createTemplatePayload({ name: 'Two' }));

    const exportAll = JSON.parse(await service.exportTemplates());
    expect(exportAll).toHaveLength(2);

    const exportSingle = JSON.parse(await service.exportTemplates([second.id]));
    expect(exportSingle).toHaveLength(1);
    expect(exportSingle[0].name).toBe('Two');
    expect(exportSingle[0].id).toBe(second.id);
  });

  it('imports templates with name suffix and handles failures', async () => {
    const service = TemplateService.getInstance();
    const payload = [
      buildTemplate({ id: 'import-1', name: 'Imported A' }),
      buildTemplate({ id: 'import-2', name: 'Imported B' }),
    ];

    mockTemplateManager.createTemplate.mockImplementationOnce(async () => {
      throw new Error('Import failure');
    });

    const result = await service.importTemplates(JSON.stringify(payload));
    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(mockTemplateManager.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Imported A (Imported)', is_built_in: false })
    );
  });

  it('reports invalid JSON during import', async () => {
    const service = TemplateService.getInstance();
    const result = await service.importTemplates('not-json');
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Invalid JSON format');
  });
});

describe('TemplateService.validateFieldRules', () => {
  it('detects missing required rule fields', () => {
    const service = TemplateService.getInstance();
    const rule = { field_type: '', description: '' } as FieldExtractionRule;
    const result = service.validateFieldRules('Front', rule);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Field type is required for Front');
    expect(result.errors).toContain('Description is required for Front');
  });

  it('flags invalid validation ranges', () => {
    const service = TemplateService.getInstance();
    const rule = {
      field_type: 'Text',
      description: 'Range',
      validation: { min: 5, max: 2 },
    } as FieldExtractionRule;
    const result = service.validateFieldRules('Length', rule);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('min cannot be greater than max for Length');
  });
});
