/**
 * A45-1 — templates 全写 CRUD manifest 单测（docs/dev/acr/ACR-4.5.md）
 *
 * mock 模板域 templateManager（templatesAgentActions 动态 import 同样被拦截），
 * 覆盖：create/rename/update/delete 的 changed 语义、no-op 诚实回执、
 * undo inverse 结构、delete 不注册 inverse（域无回收站）、OCC 冲突与 targetRef 纪律。
 *
 * 注意：本轮（ACR 4.5）约束为「测试只写不跑」，本文件未在本轮执行过。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  created_at: string;
  updated_at: string;
  is_built_in: boolean;
  is_active: boolean;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules: Record<string, unknown>;
}

/** vi.mock 工厂会被提升到 import 之前执行，共享状态必须走 vi.hoisted */
const harness = vi.hoisted(() => {
  const state = {
    templates: [] as FakeTemplate[],
    tick: 0,
  };
  const nextStamp = () => {
    state.tick += 1;
    return `2026-07-20T00:00:${String(state.tick).padStart(2, '0')}Z`;
  };
  const bumpVersion = (version: string) => {
    const parts = version.split('.').map((part) => Number.parseInt(part, 10));
    return parts.length === 3 && parts.every(Number.isFinite)
      ? `${parts[0]}.${parts[1]}.${parts[2] + 1}`
      : '1.0.1';
  };
  const find = (id: string) => state.templates.find((template) => template.id === id);
  const templateManager = {
    getAllTemplates: () => state.templates,
    getTemplateById: (id: string) => find(id),
    // 模拟真实 templateManager.createTemplate：落库 + 重读后可查
    createTemplate: vi.fn(async (request: Record<string, unknown>) => {
      const id = `tpl-created-${state.templates.length + 1}`;
      const stamp = nextStamp();
      state.templates.push({
        id,
        name: String(request.name ?? ''),
        description: String(request.description ?? ''),
        version: '1.0.0',
        created_at: stamp,
        updated_at: stamp,
        is_built_in: false,
        is_active: true,
        note_type: String(request.note_type ?? 'Basic'),
        fields: Array.isArray(request.fields) ? (request.fields as string[]) : [],
        generation_prompt: String(request.generation_prompt ?? ''),
        front_template: String(request.front_template ?? ''),
        back_template: String(request.back_template ?? ''),
        css_style: String(request.css_style ?? ''),
        field_extraction_rules: (request.field_extraction_rules ?? {}) as Record<string, unknown>,
      });
      return id;
    }),
    // 模拟真实 updateTemplate：version 拆出做 expected_version CAS，其余字段合并
    updateTemplate: vi.fn(async (templateId: string, templateData: Record<string, unknown>) => {
      const template = find(templateId);
      if (!template) throw new Error('模板不存在');
      const { version, id: _id, created_at: _c, updated_at: _u, ...rest } = templateData ?? {};
      if (typeof version === 'string' && version !== template.version) {
        throw new Error('optimistic_lock_failed');
      }
      Object.assign(template, rest);
      template.version = bumpVersion(template.version);
      template.updated_at = nextStamp();
    }),
    // 模拟后端 delete_custom_template：内置软删墓碑（停用），自定义物理删除
    deleteTemplate: vi.fn(async (templateId: string) => {
      const template = find(templateId);
      if (!template) throw new Error('模板不存在');
      if (template.is_built_in) {
        template.is_active = false;
        template.updated_at = nextStamp();
      } else {
        state.templates = state.templates.filter((item) => item.id !== templateId);
      }
    }),
  };
  return { state, templateManager, nextStamp };
});

vi.mock('@/data/ankiTemplates', () => ({ templateManager: harness.templateManager }));
// undoLabel 动态 import '@/i18n'：mock 掉避免真实 i18n 初始化；
// t(key) 原样返回 key 时执行器按约定回退到中文 fallback 文案
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

import { templatesAgentManifest } from '../agentManifests';
import {
  registerTemplateAgentSurface,
  type TemplateAgentSurface,
} from '../agentSurfaceRegistry';

const WINDOW_ID = 'templates-crud-window';
const ctx = { windowId: WINDOW_ID, typeId: 'templates', instanceKey: null };

function templateRef(id: string): string {
  return `templates:template:${id}`;
}

function makeTemplate(overrides: Partial<FakeTemplate> & { id: string }): FakeTemplate {
  return {
    name: overrides.id,
    description: '',
    version: '1.0.0',
    created_at: '2026-07-19T00:00:00Z',
    updated_at: '2026-07-19T00:00:00Z',
    is_built_in: false,
    is_active: true,
    note_type: 'Basic',
    fields: ['Front', 'Back'],
    generation_prompt: '生成卡片',
    front_template: '<div>{{Front}}</div>',
    back_template: '<div>{{Front}}<hr>{{Back}}</div>',
    css_style: '.card {}',
    field_extraction_rules: {},
    ...overrides,
  };
}

/** 表面快照直接投影自 mock 域状态（截断语义与真实 App 一致：前 50 条） */
function buildSurface(): TemplateAgentSurface {
  return {
    snapshot: () => ({
      activeTab: 'browse',
      selectedTemplateId: null,
      searchQuery: '',
      loading: false,
      error: null,
      templates: harness.state.templates.slice(0, 50).map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        updatedAt: template.updated_at,
      })),
      totalTemplates: harness.state.templates.length,
    }),
    openTemplate: () => true,
    search: () => true,
  };
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  harness.state.templates = [
    makeTemplate({ id: 'tpl-custom', name: '我的模板', description: '自定义' }),
    makeTemplate({ id: 'tpl-builtin', name: '内置问答', is_built_in: true }),
  ];
  harness.state.tick = 0;
  cleanups.push(registerTemplateAgentSurface(WINDOW_ID, buildSurface()));
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});

describe('templates manifest 能力表契约', () => {
  it('风险与可逆性如实标注：delete 为 high 且 reversible:false', () => {
    const byName = new Map(templatesAgentManifest.capabilities.map((cap) => [cap.name, cap]));
    expect(byName.get('createTemplate')).toMatchObject({ risk: 'medium', mutates: true, reversible: true });
    expect(byName.get('renameTemplate')).toMatchObject({ risk: 'medium', mutates: true, reversible: true, idempotent: true });
    expect(byName.get('updateTemplateContent')).toMatchObject({ risk: 'medium', mutates: true, reversible: true });
    expect(byName.get('deleteTemplate')).toMatchObject({ risk: 'high', mutates: true, reversible: false, idempotent: false });
  });

  it('observe 暴露模板实体的写动作与 OCC 令牌 updatedAt', async () => {
    const observation = (await templatesAgentManifest.observe?.(ctx)) as unknown as {
      entities: Array<{ ref: string; actions: string[]; state: { updatedAt: string | null } }>;
      availableActions: string[];
    };
    expect(observation.availableActions).toEqual(
      expect.arrayContaining(['createTemplate', 'renameTemplate', 'updateTemplateContent', 'deleteTemplate']),
    );
    const entity = observation.entities.find((item) => item.ref === templateRef('tpl-custom'));
    expect(entity?.actions).toEqual(
      expect.arrayContaining(['openTemplate', 'renameTemplate', 'updateTemplateContent', 'deleteTemplate']),
    );
    expect(entity?.state.updatedAt).toBe('2026-07-19T00:00:00Z');
  });
});

describe('createTemplate', () => {
  it('真实落库、changed:true，并注册 deleteTemplate 作为精确逆操作', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'createTemplate',
      args: { name: '新模板' },
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    const createdId = result?.details?.templateId as string;
    expect(createdId).toBeTruthy();
    expect(harness.templateManager.getTemplateById(createdId)?.name).toBe('新模板');
    expect(result?.entityRefs).toEqual([templateRef(createdId)]);
    expect(result?.postconditions).toEqual([{ kind: 'ref_exists', ref: templateRef(createdId) }]);
    expect(result?.undo?.inverse).toMatchObject({
      name: 'deleteTemplate',
      args: { templateId: createdId },
      targetRef: templateRef(createdId),
      expect: [{ kind: 'ref_absent', ref: templateRef(createdId) }],
    });
    expect(result?.undo?.label).toBe('删除刚创建的模板');
  });

  it('未提供内容字段时用安全默认值补全（后端校验必需的全字段）', async () => {
    await templatesAgentManifest.execute?.(ctx, {
      name: 'createTemplate',
      args: { name: '默认模板' },
    });
    const request = harness.templateManager.createTemplate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(request.fields).toEqual(['Front', 'Back']);
    expect(request.front_template).toContain('{{Front}}');
    expect(request.back_template).toContain('{{Back}}');
    expect(String(request.generation_prompt)).not.toBe('');
    expect(Object.keys(request.field_extraction_rules as Record<string, unknown>)).toEqual(['Front', 'Back']);
  });

  it('缺少 name 时返回结构化 INVALID_ARGS 且不落库', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'createTemplate',
      args: {},
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'INVALID_ARGS' });
    expect(harness.templateManager.createTemplate).not.toHaveBeenCalled();
  });
});

describe('renameTemplate', () => {
  it('重命名真实落库并注册回改原名的 inverse', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'renameTemplate',
      args: { templateId: 'tpl-custom', name: '改名后' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(harness.templateManager.getTemplateById('tpl-custom')?.name).toBe('改名后');
    expect(result?.undo?.inverse).toMatchObject({
      name: 'renameTemplate',
      args: { templateId: 'tpl-custom', name: '我的模板' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result?.undo?.label).toBe('恢复模板名称');
  });

  it('名称未变化时诚实 no-op：changed:false + 结构化 code/hint，且不写库', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'renameTemplate',
      args: { templateId: 'tpl-custom', name: '我的模板' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(result?.hint).toContain('no-op');
    expect(harness.templateManager.updateTemplate).not.toHaveBeenCalled();
  });

  it('expectedUpdatedAt 不匹配时报 REVISION_CONFLICT 且不写库', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'renameTemplate',
      args: { templateId: 'tpl-custom', name: '改名后', expectedUpdatedAt: '2020-01-01T00:00:00Z' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'REVISION_CONFLICT' });
    expect(harness.templateManager.updateTemplate).not.toHaveBeenCalled();
    expect(harness.templateManager.getTemplateById('tpl-custom')?.name).toBe('我的模板');
  });

  it('缺少 targetRef 时按纪律拒绝（TARGET_REQUIRED）', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'renameTemplate',
      args: { templateId: 'tpl-custom', name: '改名后' },
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'TARGET_REQUIRED' });
  });

  it('未截断清单中不存在的模板拒绝 ENTITY_NOT_FOUND', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'renameTemplate',
      args: { templateId: 'tpl-ghost', name: '改名后' },
      targetRef: templateRef('tpl-ghost'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ENTITY_NOT_FOUND' });
  });
});

describe('updateTemplateContent', () => {
  it('更新内容落库，inverse 完整携带旧内容可恢复', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'updateTemplateContent',
      args: { templateId: 'tpl-custom', frontTemplate: '<div>{{Front}} v2</div>', cssStyle: '.card { color: red; }' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(harness.templateManager.getTemplateById('tpl-custom')?.front_template).toBe('<div>{{Front}} v2</div>');
    expect(result?.undo?.inverse).toMatchObject({
      name: 'updateTemplateContent',
      args: {
        templateId: 'tpl-custom',
        frontTemplate: '<div>{{Front}}</div>',
        cssStyle: '.card {}',
      },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result?.undo?.label).toBe('恢复模板内容');
    expect(result?.details).toMatchObject({
      updatedFields: ['frontTemplate', 'cssStyle'],
      inverseSnapshotLarge: false,
    });
  });

  it('提供内容与当前完全一致时诚实 no-op，不写库', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'updateTemplateContent',
      args: { templateId: 'tpl-custom', frontTemplate: '<div>{{Front}}</div>' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(harness.templateManager.updateTemplate).not.toHaveBeenCalled();
  });

  it('未提供任何内容字段时返回 INVALID_ARGS', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'updateTemplateContent',
      args: { templateId: 'tpl-custom' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'INVALID_ARGS' });
  });

  it('旧内容体量大时在回执里如实标注（仍完整保存在 inverse）', async () => {
    const bigFront = `<div>${'x'.repeat(30_000)}</div>`;
    harness.state.templates[0]!.front_template = bigFront;
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'updateTemplateContent',
      args: { templateId: 'tpl-custom', frontTemplate: '<div>small</div>' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: true, changed: true });
    expect(result?.details).toMatchObject({ inverseSnapshotLarge: true });
    expect(result?.message).toContain('撤销负载较大');
    expect((result?.undo?.inverse as { args: { frontTemplate: string } }).args.frontTemplate).toBe(bigFront);
  });
});

describe('deleteTemplate（域无回收站，诚实不可逆）', () => {
  it('自定义模板物理删除：changed:true、postcondition ref_absent、不注册 inverse', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'deleteTemplate',
      args: { templateId: 'tpl-custom' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(result?.undo).toBeUndefined();
    expect(result?.postconditions).toEqual([{ kind: 'ref_absent', ref: templateRef('tpl-custom') }]);
    expect(result?.details).toMatchObject({ deleted: true, deactivated: false, isBuiltIn: false });
    expect(result?.message).toContain('不可撤销');
    expect(harness.templateManager.getTemplateById('tpl-custom')).toBeUndefined();
  });

  it('内置模板转停用墓碑：回执明说是停用而非删除，同样不注册 inverse', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'deleteTemplate',
      args: { templateId: 'tpl-builtin' },
      targetRef: templateRef('tpl-builtin'),
    });
    expect(result).toMatchObject({ handled: true, changed: true, acknowledged: true });
    expect(result?.undo).toBeUndefined();
    expect(result?.details).toMatchObject({ deleted: false, deactivated: true, isBuiltIn: true });
    expect(result?.postconditions).toEqual([{ kind: 'ref_exists', ref: templateRef('tpl-builtin') }]);
    const builtin = harness.templateManager.getTemplateById('tpl-builtin');
    expect(builtin?.is_active).toBe(false);
  });

  it('内置模板已停用时诚实 no-op，不重复写库', async () => {
    harness.state.templates[1]!.is_active = false;
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'deleteTemplate',
      args: { templateId: 'tpl-builtin' },
      targetRef: templateRef('tpl-builtin'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'ACTION_UNAVAILABLE' });
    expect(harness.templateManager.deleteTemplate).not.toHaveBeenCalled();
  });

  it('expectedUpdatedAt 不匹配时报 REVISION_CONFLICT，模板保留', async () => {
    const result = await templatesAgentManifest.execute?.(ctx, {
      name: 'deleteTemplate',
      args: { templateId: 'tpl-custom', expectedUpdatedAt: '2020-01-01T00:00:00Z' },
      targetRef: templateRef('tpl-custom'),
    });
    expect(result).toMatchObject({ handled: false, changed: false, code: 'REVISION_CONFLICT' });
    expect(harness.templateManager.getTemplateById('tpl-custom')).toBeDefined();
  });
});
