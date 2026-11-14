/**
 * 自定义模板 CRUD、导入导出与默认模板命令。
 */
import { type CommandHandler } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import type { CustomAnkiTemplate, CreateTemplateRequest, UpdateTemplateRequest } from '../../../../contracts/ipc/generated/L16-anki.ts';
import {
  buildTemplateRequestForUpdate,
  decodeCustomTemplateJson,
  decodeTemplateRow,
  decideBuiltinImportAction,
  prettyTemplateJson,
  validateTemplateRequest,
  type BuiltinImportAction,
  type TemplateRow,
} from './templates.ts';
import { nowRfc3339 } from './time.ts';
import {
  countCardsReferencingTemplate,
  createTemplateWithId,
  getTemplateById,
  getTemplateUserStates,
  insertTemplate,
  listTemplates,
  markTemplateUserModified,
  replaceTemplateContent,
  updateTemplate,
} from '../repository/templates.ts';

import { DEFAULT_TEMPLATE_SETTING_KEY, requireSettingsOwner } from './settings-owner.ts';
import type { AnkiPluginRuntime } from './plugin-runtime.ts';
import {
  builtinResult,
  bulkResult,
  createRequestFromValue,
  dbFailure,
  decodeTemplateValue,
  messages,
  readBuiltinTemplates,
  throwApp,
  updateRequestFromValue,
  validationFailure,
  valueString,
  type TemplateBulkImportRequest,
  type TemplateImportRequest,
} from './plugin-runtime.ts';

export function createTemplateHandlers(rt: AnkiPluginRuntime): Record<string, CommandHandler> {
  const { ctx, db, now } = rt;
  return {
      // ---------------------------------------------------------------- 模板 CRUD
      get_all_custom_templates: async () => rt.service.templates.list(),

      get_custom_template_by_id: async (args) => {
        const { templateId } = args as { templateId: string };
        return rt.service.templates.get(templateId);
      },

      create_custom_template: async (args) => {
        const { request } = args as { request: CreateTemplateRequest };
        return rt.service.templates.create(request);
      },

      update_custom_template: async (args) => {
        const { templateId, request } = args as { templateId: string; request: UpdateTemplateRequest };
        return rt.service.templates.update(templateId, request);
      },

      delete_custom_template: async (args) => {
        const { templateId } = args as { templateId: string };
        return rt.service.templates.delete(templateId);
      },

      count_custom_template_references: async (args) => {
        const { templateId } = args as { templateId: string };
        try {
          return countCardsReferencingTemplate(db(), templateId);
        } catch (error) {
          dbFailure('统计模板引用卡片失败', error);
        }
      },

      export_template: async (args) => {
        const { templateId } = args as { templateId: string };
        let row: TemplateRow | undefined;
        try {
          row = getTemplateById(db(), templateId);
        } catch (error) {
          dbFailure('查询模板失败', error);
        }
        if (row === undefined) validationFailure('模板不存在');
        return { template_data: prettyTemplateJson(decodeTemplateRow(row, now)) };
      },

      import_template: async (args) => {
        const { request } = args as unknown as { request: TemplateImportRequest };
        let template: CustomAnkiTemplate;
        try {
          template = decodeCustomTemplateJson(request.template_data);
        } catch (error) {
          validationFailure(`解析模板数据失败: ${messages(error)}`);
        }
        let existingTemplates: CustomAnkiTemplate[];
        try {
          existingTemplates = listTemplates(db()).map((row) => decodeTemplateRow(row, now));
        } catch (error) {
          dbFailure('查询现有模板失败', error);
        }
        const existing = existingTemplates.find((candidate) => candidate.name === template.name);
        const createRequest: CreateTemplateRequest = {
          name: template.name,
          description: template.description,
          author: template.author,
          version: template.version,
          preview_front: template.preview_front,
          preview_back: template.preview_back,
          note_type: template.note_type,
          fields: template.fields,
          generation_prompt: template.generation_prompt,
          front_template: template.front_template,
          back_template: template.back_template,
          css_style: template.css_style,
          field_extraction_rules: template.field_extraction_rules,
          preview_data_json: template.preview_data_json,
          is_active: template.is_active,
          is_built_in: template.is_built_in,
        };
        const invalid = validateTemplateRequest(createRequest);
        if (invalid !== null) validationFailure(invalid);
        if (existing !== undefined) {
          if (!request.overwrite_existing) {
            validationFailure(`模板 '${createRequest.name}' 已存在，请启用覆盖或修改名称后重试`);
          }
          try {
            replaceTemplateContent(db(), existing.id, createRequest, nowRfc3339());
          } catch (error) {
            dbFailure('覆盖导入模板失败', error);
          }
          if (existing.is_built_in) {
            try {
              markTemplateUserModified(db(), existing.id);
            } catch (error) {
              ctx.logger.warn(`标记内置模板 user_modified 失败: ${existing.id} (${messages(error)})`);
            }
          }
          return existing.id;
        }
        const templateId = globalThis.crypto.randomUUID();
        try {
          insertTemplate(db(), templateId, createRequest, nowRfc3339());
        } catch (error) {
          dbFailure('导入模板失败', error);
        }
        return templateId;
      },

      import_custom_templates_bulk: async (args) => {
        const { request } = args as unknown as { request: TemplateBulkImportRequest };
        const templateData = request.template_data ?? request.templateData ?? '';
        const overwrite = request.overwrite_existing ?? request.overwriteExisting ?? false;
        const strictBuiltin = request.strict_builtin ?? request.strictBuiltin ?? false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(templateData) as unknown;
        } catch (error) {
          validationFailure(`解析模板数据失败: ${messages(error)}`);
        }
        let templateValues: unknown[];
        if (Array.isArray(parsed)) templateValues = parsed;
        else if (typeof parsed === 'object' && parsed !== null) templateValues = [parsed];
        else validationFailure('模板数据必须是对象或数组');

        let existingTemplates: CustomAnkiTemplate[];
        try {
          existingTemplates = listTemplates(db()).map((row) => decodeTemplateRow(row, now));
        } catch (error) {
          dbFailure('查询现有模板失败', error);
        }

        let imported = 0;
        let skipped = 0;
        const errors: string[] = [];
        const conflicts: string[] = [];

        if (strictBuiltin) {
          const existingIds = new Set(existingTemplates.map((template) => template.id));
          const createdIds = new Set<string>();
          const builtinIds = new Set(
            existingTemplates.filter((template) => template.is_built_in).map((template) => template.id),
          );
          const existingByName = new Map(existingTemplates.map((template) => [template.name, template.id]));
          for (const raw of templateValues) {
            const value = (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
              ? raw as Record<string, unknown>
              : {};
            const templateId = valueString(value, 'id', 'unknown');
            const templateName = valueString(value, 'name', '未命名模板');
            const targetExistingId =
              existingIds.has(templateId) || createdIds.has(templateId)
                ? templateId
                : existingByName.get(templateName);
            const createRequest = createRequestFromValue(value, true);
            const invalid = validateTemplateRequest(createRequest);
            if (invalid !== null) {
              errors.push(`${templateName}: ${invalid}`);
              continue;
            }
            if (targetExistingId !== undefined) {
              if (!overwrite) {
                skipped += 1;
                conflicts.push(templateName);
                continue;
              }
              try {
                replaceTemplateContent(db(), targetExistingId, createRequest, nowRfc3339());
                imported += 1;
                existingByName.set(templateName, targetExistingId);
                if (builtinIds.has(targetExistingId)) {
                  try {
                    markTemplateUserModified(db(), targetExistingId);
                  } catch (error) {
                    ctx.logger.warn(`标记内置模板 user_modified 失败: ${targetExistingId} (${messages(error)})`);
                  }
                }
              } catch (error) {
                errors.push(`${templateName}: ${messages(error)}`);
              }
              continue;
            }
            try {
              createTemplateWithId(db(), templateId, createRequest, nowRfc3339());
              imported += 1;
              createdIds.add(templateId);
              existingByName.set(templateName, templateId);
            } catch (error) {
              errors.push(`${templateName}: ${messages(error)}`);
            }
          }
          return bulkResult(imported, skipped, conflicts, errors);
        }

        const existingByName = new Map(existingTemplates.map((template) => [template.name, template.id]));
        const builtinIds = new Set(
          existingTemplates.filter((template) => template.is_built_in).map((template) => template.id),
        );
        for (const raw of templateValues) {
          let template: CustomAnkiTemplate;
          try {
            template = decodeTemplateValue(raw);
          } catch (error) {
            errors.push(`解析模板数据失败: ${messages(error)}`);
            continue;
          }
          const templateName = template.name;
          const createRequest: CreateTemplateRequest = {
            name: template.name,
            description: template.description,
            author: template.author,
            version: template.version,
            preview_front: template.preview_front,
            preview_back: template.preview_back,
            note_type: template.note_type,
            fields: template.fields,
            generation_prompt: template.generation_prompt,
            front_template: template.front_template,
            back_template: template.back_template,
            css_style: template.css_style,
            field_extraction_rules: template.field_extraction_rules,
            preview_data_json: template.preview_data_json,
            is_active: template.is_active,
            is_built_in: template.is_built_in,
          };
          const invalid = validateTemplateRequest(createRequest);
          if (invalid !== null) {
            errors.push(`${templateName}: ${invalid}`);
            continue;
          }
          const existingId = existingByName.get(templateName);
          if (existingId !== undefined) {
            if (!overwrite) {
              skipped += 1;
              conflicts.push(templateName);
              continue;
            }
            try {
              replaceTemplateContent(db(), existingId, createRequest, nowRfc3339());
              imported += 1;
              if (builtinIds.has(existingId)) {
                try {
                  markTemplateUserModified(db(), existingId);
                } catch (error) {
                  ctx.logger.warn(`标记内置模板 user_modified 失败: ${existingId} (${messages(error)})`);
                }
              }
            } catch (error) {
              errors.push(`${templateName}: ${messages(error)}`);
            }
            continue;
          }
          const templateId = globalThis.crypto.randomUUID();
          try {
            insertTemplate(db(), templateId, createRequest, nowRfc3339());
            imported += 1;
            existingByName.set(templateName, templateId);
          } catch (error) {
            errors.push(`${templateName}: ${messages(error)}`);
          }
        }
        return bulkResult(imported, skipped, conflicts, errors);
      },

      import_builtin_templates: async () => {
        const templates = await readBuiltinTemplates();
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];
        const conflicts: string[] = [];
        const preserved: string[] = [];
        let existingTemplates: CustomAnkiTemplate[];
        try {
          existingTemplates = listTemplates(db()).map((row) => decodeTemplateRow(row, now));
        } catch (error) {
          dbFailure('查询现有模板失败', error);
        }
        const existingById = new Map(existingTemplates.map((template) => [template.id, template]));
        const existingNames = new Set(existingTemplates.map((template) => template.name));
        let userStates: Map<string, { userModified: boolean; userDeleted: boolean }>;
        try {
          userStates = getTemplateUserStates(db());
        } catch (error) {
          dbFailure('读取模板用户态标记失败', error);
        }
        for (const value of templates) {
          const templateId = valueString(value, 'id', 'unknown');
          const templateName = valueString(value, 'name', '未命名模板');
          const builtinVersion = valueString(value, 'version', '1.0.0');
          const existing = existingById.get(templateId);
          if (existing !== undefined) {
            if (!existing.is_built_in) {
              skipped += 1;
              conflicts.push(`${templateName}(ID ${templateId} 已被非内置模板占用)`);
              continue;
            }
            const state = userStates.get(templateId) ?? { userModified: false, userDeleted: false };
            const action: BuiltinImportAction = decideBuiltinImportAction(
              state.userModified,
              state.userDeleted,
              existing.version,
              builtinVersion,
            );
            if (action.kind === 'preserve') {
              skipped += 1;
              preserved.push(`${templateName}(${action.reason})`);
              continue;
            }
            if (action.kind === 'skip') {
              skipped += 1;
              continue;
            }
            const updateRequest = updateRequestFromValue(value, existing, builtinVersion);
            const merged = buildTemplateRequestForUpdate(existing, updateRequest);
            const invalid = validateTemplateRequest(merged);
            if (invalid !== null) {
              errors.push(`${templateName}: ${invalid}`);
              continue;
            }
            try {
              const ok = updateTemplate(db(), templateId, updateRequest, existing.version, nowRfc3339());
              if (!ok) throw new Error('optimistic_lock_failed');
              updated += 1;
              existingById.set(templateId, { ...existing, version: builtinVersion, name: templateName });
            } catch (error) {
              errors.push(`${templateName}: ${messages(error)}`);
            }
            continue;
          }
          if (existingNames.has(templateName)) {
            skipped += 1;
            conflicts.push(templateName);
            continue;
          }
          const createRequest = createRequestFromValue(value, true);
          try {
            createTemplateWithId(db(), templateId, createRequest, nowRfc3339());
            imported += 1;
            existingNames.add(templateName);
          } catch (error) {
            errors.push(`${templateName}: ${messages(error)}`);
          }
        }
        return builtinResult(imported, updated, skipped, preserved, conflicts, errors);
      },

      // ---------------------------------------------------------------- 默认模板
      get_default_template_id: async () => {
        const settings = requireSettingsOwner(ctx);
        try {
          return settings.getWithConn(db(), DEFAULT_TEMPLATE_SETTING_KEY);
        } catch (error) {
          throwApp('Unknown', messages(error));
        }
      },

      set_default_template: async (args) => {
        const { templateId } = args as { templateId: string };
        const settings = requireSettingsOwner(ctx);
        try {
          settings.saveWithConn(db(), DEFAULT_TEMPLATE_SETTING_KEY, templateId);
        } catch (error) {
          throwApp('Unknown', messages(error));
        }
        return null;
      },

  };
}
