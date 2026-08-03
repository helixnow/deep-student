/**
 * A45-1 — templates 应用 Agent 写能力执行器（docs/dev/acr/ACR-4.5.md）
 *
 * 模板域没有独立 zustand store：TemplateManagementApp 的真实落库路径是
 * `@/data/ankiTemplates` 的 templateManager 单例（create/update/delete 内部
 * invoke Tauri 命令并 loadTemplates() 重读 + 广播订阅者）。本文件全部写路径
 * 走同一单例（动态 import 避免打包耦合），禁止绕过它直写存储。
 *
 * 契约要点（ACR-4.5 §2 统一纪律）：
 * - execute 前后 re-read templateManager 权威状态，`changed` 如实；
 *   no-op 一律 `changed:false` + 结构化 code/hint；
 * - OCC：可选 expectedUpdatedAt 前置校验 + 后端 update_custom_template 的
 *   expected_version CAS（通过 templateManager.updateTemplate 传 version 触发）；
 * - 撤销诚实：rename/updateContent 注册 inverse；create 注册 deleteTemplate
 *   inverse（精确逆操作）；delete 无回收站（自定义物理删除 / 内置停用墓碑，
 *   界面无恢复入口），不注册 inverse。
 */
import type { CreateTemplateRequest, CustomAnkiTemplate, FieldExtractionRule } from '@/types';
import type { AgentActionResult } from '../../core/types';
import { stableAgentRef } from '../agentManifestUtils';

/** 与 agentManifests.ts templates 段保持同一 ref 编码 */
export function templatesEntityRef(id: string): string {
  return stableAgentRef('templates', 'template', id);
}

/** undo inverse 携带旧内容超过该字符数时，在回执里如实标注体量 */
const LARGE_INVERSE_SNAPSHOT_CHARS = 20_000;

type TemplateManagerModule = typeof import('@/data/ankiTemplates');

async function loadTemplateManager(): Promise<TemplateManagerModule['templateManager']> {
  const mod = await import('@/data/ankiTemplates');
  return mod.templateManager;
}

/**
 * undo 标签是用户可见文案，走 workbench ns 的 agent.apps.templates.* 两语 key；
 * i18n 动态加载失败（如纯逻辑测试环境）时降级为中文回退并保持功能可用。
 */
async function undoLabel(key: string, fallback: string): Promise<string> {
  try {
    const { default: i18n } = await import('@/i18n');
    const fullKey = `workbench:${key}`;
    const value = i18n.t(fullKey);
    return typeof value === 'string' && value !== fullKey ? value : fallback;
  } catch {
    return fallback;
  }
}

function invalidArgs(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'INVALID_ARGS', hint };
}

function entityNotFound(templateId: string): AgentActionResult {
  return {
    handled: false,
    changed: false,
    code: 'ENTITY_NOT_FOUND',
    hint: `模板 ${templateId} 不存在于模板域，请重新 observe 获取最新清单`,
  };
}

function actionNoop(hint: string): AgentActionResult {
  return { handled: false, changed: false, code: 'ACTION_UNAVAILABLE', hint };
}

/** 后端 OCC / 校验错误映射为结构化回执，禁止 "Error: failed" 式裸错误 */
function failureFromError(actionName: string, error: unknown): AgentActionResult {
  const message = error instanceof Error ? error.message : String(error);
  const conflict = /optimistic_lock_failed|已被更新|请刷新/.test(message);
  return {
    handled: false,
    changed: false,
    code: conflict ? 'REVISION_CONFLICT' : 'ACTION_FAILED',
    hint: conflict
      ? `${actionName} 版本冲突：${message}；请重新 observe 拿到最新 updatedAt 后重试`
      : `${actionName} 失败：${message}`,
  };
}

/** 可选 expectedUpdatedAt 前置 OCC 校验（后端 CAS 之外的一道诚实防线） */
function occConflict(
  current: CustomAnkiTemplate,
  expectedUpdatedAt: unknown,
): AgentActionResult | null {
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) return null;
  if (current.updated_at === expectedUpdatedAt) return null;
  return {
    handled: false,
    changed: false,
    code: 'REVISION_CONFLICT',
    hint: `模板已被其他修改更新（当前 updatedAt=${current.updated_at}），请重新 observe 后重试`,
  };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ============================================================================
// createTemplate
// ============================================================================

/** 后端 validate_template_request 要求全字段齐备；未提供的用安全默认值补全 */
function buildCreateRequest(args: Record<string, unknown>): CreateTemplateRequest {
  const rawFields = Array.isArray(args.fields)
    ? args.fields.filter((field): field is string => typeof field === 'string' && field.trim() !== '')
    : [];
  const fields = rawFields.length > 0 ? rawFields.map((field) => field.trim()) : ['Front', 'Back'];
  const primary = fields[0];
  const secondary = fields[1] ?? fields[0];
  const frontTemplate = stringArg(args.frontTemplate)
    ?? `<div class="card-front">{{${primary}}}</div>`;
  const backTemplate = stringArg(args.backTemplate)
    ?? `<div class="card-back">{{${primary}}}<hr>{{${secondary}}}</div>`;
  // 每个字段必须有提取规则，否则后端校验直接拒绝
  const fieldExtractionRules: Record<string, FieldExtractionRule> = {};
  fields.forEach((field, index) => {
    fieldExtractionRules[field] = {
      field_type: 'Text',
      is_required: index === 0,
      description: field,
    };
  });
  return {
    name: String(args.name ?? '').trim(),
    description: stringArg(args.description) ?? '',
    note_type: stringArg(args.noteType)?.trim() || 'Basic',
    fields,
    generation_prompt: stringArg(args.generationPrompt)
      ?? '请根据给定学习材料，为每个字段生成简洁准确的内容。',
    front_template: frontTemplate,
    back_template: backTemplate,
    css_style: stringArg(args.cssStyle)
      ?? '.card { font-family: arial; font-size: 20px; text-align: center; }',
    preview_front: frontTemplate,
    preview_back: backTemplate,
    field_extraction_rules: fieldExtractionRules,
    is_active: true,
  };
}

export async function executeCreateTemplate(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const name = stringArg(args.name)?.trim() ?? '';
  if (!name) return invalidArgs('createTemplate 需要非空 name');
  const manager = await loadTemplateManager();
  const request = buildCreateRequest(args);
  let templateId: string;
  try {
    templateId = await manager.createTemplate(request);
  } catch (error) {
    return failureFromError('createTemplate', error);
  }
  // 落库后重读权威状态确认（createTemplate 内部已 loadTemplates 重载）
  const created = manager.getTemplateById(templateId);
  if (!created) {
    return {
      handled: false,
      changed: false,
      code: 'RESULT_UNKNOWN',
      hint: `创建返回 id=${templateId} 但重读未找到该模板，请重新 observe 确认`,
    };
  }
  const ref = templatesEntityRef(templateId);
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [ref],
    message: `已创建模板「${created.name}」（id=${templateId}，${created.fields.length} 个字段）`,
    details: {
      templateId,
      name: created.name,
      version: created.version,
      updatedAt: created.updated_at,
    },
    postconditions: [{ kind: 'ref_exists', ref }],
    // create 的精确逆操作是删除刚创建的自定义模板（物理删除，undo 统一 High 确认）
    undo: {
      inverse: {
        name: 'deleteTemplate',
        args: { templateId },
        targetRef: ref,
        expect: [{ kind: 'ref_absent', ref }],
      },
      label: await undoLabel('agent.apps.templates.undoCreate', '删除刚创建的模板'),
    },
  };
}

// ============================================================================
// renameTemplate
// ============================================================================

export async function executeRenameTemplate(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const templateId = stringArg(args.templateId)?.trim() ?? '';
  const name = stringArg(args.name)?.trim() ?? '';
  if (!templateId || !name) return invalidArgs('renameTemplate 需要非空 templateId 和 name');
  const manager = await loadTemplateManager();
  const current = manager.getTemplateById(templateId);
  if (!current) return entityNotFound(templateId);
  const conflict = occConflict(current, args.expectedUpdatedAt);
  if (conflict) return conflict;
  if (current.name === name) {
    return actionNoop(`模板名称已是「${name}」，renameTemplate 为 no-op`);
  }
  const previousName = current.name;
  try {
    // version 作为 expected_version 传入后端 CAS（templateManager 内部拆出）
    await manager.updateTemplate(templateId, { name, version: current.version });
  } catch (error) {
    return failureFromError('renameTemplate', error);
  }
  const after = manager.getTemplateById(templateId);
  if (!after) {
    return {
      handled: false,
      changed: false,
      code: 'RESULT_UNKNOWN',
      hint: '重命名后重读未找到模板，请重新 observe 确认',
    };
  }
  if (after.name !== name) {
    return {
      handled: false,
      changed: false,
      code: 'ACTION_FAILED',
      hint: `重命名写入后名称未确认（当前为「${after.name}」）`,
    };
  }
  const ref = templatesEntityRef(templateId);
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [ref],
    message: `模板「${previousName}」已重命名为「${name}」`,
    details: { templateId, previousName, name, updatedAt: after.updated_at },
    postconditions: [{ kind: 'ref_exists', ref }],
    undo: {
      inverse: {
        name: 'renameTemplate',
        args: { templateId, name: previousName },
        targetRef: ref,
        expect: [{ kind: 'ref_exists', ref }],
      },
      label: await undoLabel('agent.apps.templates.undoRename', '恢复模板名称'),
    },
  };
}

// ============================================================================
// updateTemplateContent
// ============================================================================

/** camelCase 能力参数 → 模板域 snake_case 字段 */
const CONTENT_FIELD_MAP = {
  frontTemplate: 'front_template',
  backTemplate: 'back_template',
  cssStyle: 'css_style',
  generationPrompt: 'generation_prompt',
  description: 'description',
} as const;

type ContentArgKey = keyof typeof CONTENT_FIELD_MAP;

export async function executeUpdateTemplateContent(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const templateId = stringArg(args.templateId)?.trim() ?? '';
  if (!templateId) return invalidArgs('updateTemplateContent 需要非空 templateId');
  const providedKeys = (Object.keys(CONTENT_FIELD_MAP) as ContentArgKey[])
    .filter((key) => typeof args[key] === 'string');
  if (providedKeys.length === 0) {
    return invalidArgs(
      'updateTemplateContent 至少需要 frontTemplate / backTemplate / cssStyle / generationPrompt / description 之一',
    );
  }
  const manager = await loadTemplateManager();
  const current = manager.getTemplateById(templateId);
  if (!current) return entityNotFound(templateId);
  const conflict = occConflict(current, args.expectedUpdatedAt);
  if (conflict) return conflict;

  const patch: Record<string, string> = {};
  const previous: Record<string, string> = {};
  let changedFieldCount = 0;
  for (const key of providedKeys) {
    const domainKey = CONTENT_FIELD_MAP[key];
    const nextValue = args[key] as string;
    const currentValue = (current as unknown as Record<string, unknown>)[domainKey];
    patch[domainKey] = nextValue;
    previous[key] = typeof currentValue === 'string' ? currentValue : '';
    if (previous[key] !== nextValue) changedFieldCount += 1;
  }
  if (changedFieldCount === 0) {
    return actionNoop('提供的内容与当前模板完全一致，updateTemplateContent 为 no-op');
  }

  try {
    await manager.updateTemplate(templateId, { ...patch, version: current.version });
  } catch (error) {
    return failureFromError('updateTemplateContent', error);
  }
  const after = manager.getTemplateById(templateId);
  if (!after) {
    return {
      handled: false,
      changed: false,
      code: 'RESULT_UNKNOWN',
      hint: '更新内容后重读未找到模板，请重新 observe 确认',
    };
  }
  // 写后确认三种情形：完全一致（干净落库）/ 与旧值不同但和请求不同（域层
  // sanitize 归一化，属真实变更，需在回执如实告知）/ 与旧值相同（写入未生效）
  const normalizedKeys: ContentArgKey[] = [];
  let anyChangedAfterWrite = false;
  for (const key of providedKeys) {
    const domainKey = CONTENT_FIELD_MAP[key];
    const afterValue = (after as unknown as Record<string, unknown>)[domainKey];
    if (afterValue !== previous[key]) anyChangedAfterWrite = true;
    if (afterValue !== patch[domainKey]) normalizedKeys.push(key);
  }
  if (!anyChangedAfterWrite) {
    return {
      handled: false,
      changed: false,
      code: 'ACTION_FAILED',
      hint: '内容写入后重读与写入前一致，未生效；请重新 observe 核对',
    };
  }

  const ref = templatesEntityRef(templateId);
  // 旧内容完整保存在 inverse args 中保证可逆；体量大时如实标注（不静默）
  const inverseArgs: Record<string, string> = { templateId };
  for (const key of providedKeys) inverseArgs[key] = previous[key];
  const snapshotChars = providedKeys.reduce((sum, key) => sum + previous[key].length, 0);
  const snapshotLarge = snapshotChars > LARGE_INVERSE_SNAPSHOT_CHARS;
  return {
    handled: true,
    changed: true,
    acknowledged: true,
    entityRefs: [ref],
    message: `模板「${after.name}」内容已更新（字段：${providedKeys.join('、')}）`
      + (normalizedKeys.length > 0
        ? `；注意：${normalizedKeys.join('、')} 经域层 sanitize 归一化，落库值与请求值不完全一致，请重新 observe 核对`
        : '')
      + (snapshotLarge
        ? `；撤销负载较大（旧内容共 ${snapshotChars} 字符，已完整保存在 undo inverse 中）`
        : ''),
    details: {
      templateId,
      updatedFields: [...providedKeys],
      normalizedFields: [...normalizedKeys],
      version: after.version,
      updatedAt: after.updated_at,
      inverseSnapshotChars: snapshotChars,
      inverseSnapshotLarge: snapshotLarge,
    },
    postconditions: [{ kind: 'ref_exists', ref }],
    undo: {
      inverse: {
        name: 'updateTemplateContent',
        args: inverseArgs,
        targetRef: ref,
        expect: [{ kind: 'ref_exists', ref }],
      },
      label: await undoLabel('agent.apps.templates.undoUpdateContent', '恢复模板内容'),
    },
  };
}

// ============================================================================
// deleteTemplate
// ============================================================================

/**
 * 删除语义与后端 delete_custom_template 一致：
 * - 自定义模板：物理删除，无回收站 → 不可撤销，不注册 inverse；
 * - 内置模板：停用 + user_deleted 墓碑（不会随内置升级复活），界面无恢复入口
 *   → 同样按不可撤销处理（诚实原则），回执明说是停用而非删除。
 */
export async function executeDeleteTemplate(
  args: Record<string, unknown>,
): Promise<AgentActionResult> {
  const templateId = stringArg(args.templateId)?.trim() ?? '';
  if (!templateId) return invalidArgs('deleteTemplate 需要非空 templateId');
  const manager = await loadTemplateManager();
  const current = manager.getTemplateById(templateId);
  if (!current) return entityNotFound(templateId);
  const conflict = occConflict(current, args.expectedUpdatedAt);
  if (conflict) return conflict;
  if (current.is_built_in && !current.is_active) {
    return actionNoop(`内置模板「${current.name}」已处于停用状态，deleteTemplate 为 no-op`);
  }
  const wasBuiltIn = current.is_built_in;
  const previousName = current.name;
  try {
    await manager.deleteTemplate(templateId);
  } catch (error) {
    return failureFromError('deleteTemplate', error);
  }
  const after = manager.getTemplateById(templateId);
  const ref = templatesEntityRef(templateId);

  if (wasBuiltIn && after && !after.is_active) {
    // 内置：软删墓碑（行保留、is_active=false），非物理删除
    return {
      handled: true,
      changed: true,
      acknowledged: true,
      entityRefs: [ref],
      message: `内置模板「${previousName}」已停用（内置模板不可物理删除；停用后不会随升级导入复活，界面无恢复入口，本操作不可撤销）`,
      details: { templateId, deleted: false, deactivated: true, isBuiltIn: true },
      postconditions: [{ kind: 'ref_exists', ref }],
    };
  }
  if (!after) {
    return {
      handled: true,
      changed: true,
      acknowledged: true,
      entityRefs: [ref],
      message: `模板「${previousName}」已永久删除（模板域无回收站，本操作不可撤销）`,
      details: { templateId, deleted: true, deactivated: false, isBuiltIn: wasBuiltIn },
      postconditions: [{ kind: 'ref_absent', ref }],
    };
  }
  return {
    handled: false,
    changed: false,
    code: 'RESULT_UNKNOWN',
    hint: `删除后模板「${after.name}」仍存在且未停用，请重新 observe 确认实际状态`,
  };
}
