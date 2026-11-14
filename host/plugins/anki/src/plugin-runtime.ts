/**
 * 插件命令共享的运行时类型与 Rust 错误语义辅助函数。
 */
import { CommandError, type Context } from '../../../kernel/api.ts';
import type {} from '../../../platform/paths/api.ts';
import { StorageError } from '../../../platform/storage/api.ts';
import type {
  CustomAnkiTemplate,
  CreateTemplateRequest,
  FieldExtractionRule__De,
  UpdateTemplateRequest,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { AnkiHostService } from './service.ts';
import { decodeCustomTemplateJson, decodeFieldExtractionRules, SerdeError } from './templates.ts';
import { appError, ioErrorText, type AppErrorValue } from './files.ts';
import { ankiLocalRuntime } from './local-runtime.ts';
import { type TemplateConfigTuple } from './apkg-exporter.ts';
import type { AnkiCard } from '../../../../contracts/ipc/generated/_shared.ts';
import { AnkiCardDecodeError } from './anki-cards.ts';

import type { DatabaseHandle } from '../../../platform/storage/api.ts';

export interface AnkiPluginRuntime {
  ctx: Context;
  db: () => DatabaseHandle;
  now: () => Date;
  service: AnkiHostService;
  attachFsrsProgress(cards: AnkiCard[]): void;
  loadApkgTemplate(templateId: string): { config: TemplateConfigTuple; full: CustomAnkiTemplate } | null;
  downloadsDir(): string;
  decodeExportCards(raw: readonly unknown[]): AnkiCard[];
  runApkgExport(
    rawCards: readonly unknown[],
    deckName: string,
    requestedNoteType: string,
    templateId: string | null | undefined,
  ): string;
}

export interface TemplateImportRequest {
  template_data: string;
  overwrite_existing: boolean;
}

export interface TemplateBulkImportRequest {
  template_data?: string;
  templateData?: string;
  overwrite_existing?: boolean;
  overwriteExisting?: boolean;
  strict_builtin?: boolean;
  strictBuiltin?: boolean;
}

export function isAppErrorValue(value: unknown): value is AppErrorValue {
  return typeof value === 'object' && value !== null && 'error_type' in value && 'message' in value;
}

export function messages(error: unknown): string {
  if (error instanceof CommandError) {
    return isAppErrorValue(error.value) ? error.value.message : String(error.value);
  }
  return error instanceof Error ? error.message : String(error);
}

export function throwApp(errorType: AppErrorValue['error_type'], message: string): never {
  throw new CommandError(appError(errorType, message));
}

export function dbFailure(prefix: string, error: unknown): never {
  throwApp('Database', `${prefix}: ${messages(error)}`);
}

export function validationFailure(message: string): never {
  throwApp('Validation', message);
}

/**
 * `enhanced_anki.rs:741-747,802-807,830-835` 使用 `get_conn_safe()?` / `conn.execute(...)?`：
 * 连接失败是 anyhow → `AppError::unknown`，SQL 失败经 `From<rusqlite::Error>` → `数据库错误: {}`。
 */
export function pendingMemoryDbFailure(error: unknown): never {
  if (error instanceof StorageError && error.code === 'MAINTENANCE') {
    throwApp('Unknown', '主数据库处于维护屏障（备份/恢复进行中），拒绝发放新数据库连接以防写入被静默丢弃');
  }
  throwApp('Database', `数据库错误: ${messages(error)}`);
}

/** `enhanced_anki.rs:730-739`：trim 后去掉第一个 `chat-` 前缀，空值报 `conversation_id 不能为空`。 */
export function normalizeConversationId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') validationFailure('conversation_id 不能为空');
  return trimmed.startsWith('chat-') ? trimmed.slice('chat-'.length) : trimmed;
}

/** `serde_json::from_value` 风格：把 IPC 传入的 Value 当作 `CustomAnkiTemplate` 解码。 */
export function decodeTemplateValue(value: unknown): CustomAnkiTemplate {
  return decodeCustomTemplateJson(JSON.stringify(value));
}

export function valueString(object: Record<string, unknown>, key: string, fallback: string): string {
  const value = object[key];
  return typeof value === 'string' ? value : fallback;
}

export function valueOptionalString(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

export function valueFields(object: Record<string, unknown>): string[] {
  const raw = object.fields_json;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? (parsed as string[]) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export function valueRules(object: Record<string, unknown>): Record<string, FieldExtractionRule__De> {
  const raw = object.field_extraction_rules_json;
  if (typeof raw !== 'string') return {};
  try {
    return decodeFieldExtractionRules(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SerdeError) return {};
    throw error;
  }
}

/** `src/commands.rs:5121-5182` 等处以 Value 构造 CreateTemplateRequest 的字段默认值。 */
export function createRequestFromValue(object: Record<string, unknown>, builtIn: boolean): CreateTemplateRequest {
  const version = valueOptionalString(object, 'version');
  return {
    name: valueString(object, 'name', '未命名模板'),
    description: valueString(object, 'description', ''),
    author: valueString(object, 'author', 'Anki Design'),
    version,
    preview_front: valueString(object, 'preview_front', ''),
    preview_back: valueString(object, 'preview_back', ''),
    note_type: valueString(object, 'note_type', 'Basic'),
    fields: valueFields(object),
    generation_prompt: valueString(object, 'generation_prompt', ''),
    front_template: valueString(object, 'front_template', ''),
    back_template: valueString(object, 'back_template', ''),
    css_style: valueString(object, 'css_style', ''),
    field_extraction_rules: valueRules(object),
    preview_data_json: valueOptionalString(object, 'preview_data_json'),
    is_active: true,
    is_built_in: builtIn,
  };
}

export function updateRequestFromValue(
  object: Record<string, unknown>,
  existing: CustomAnkiTemplate,
  builtinVersion: string,
): UpdateTemplateRequest {
  return {
    name: valueString(object, 'name', existing.name),
    description: valueString(object, 'description', ''),
    author: valueString(object, 'author', 'Anki Design'),
    version: builtinVersion,
    expected_version: existing.version,
    preview_front: valueString(object, 'preview_front', ''),
    preview_back: valueString(object, 'preview_back', ''),
    note_type: valueString(object, 'note_type', 'Basic'),
    fields: valueFields(object),
    generation_prompt: valueString(object, 'generation_prompt', ''),
    front_template: valueString(object, 'front_template', ''),
    back_template: valueString(object, 'back_template', ''),
    css_style: valueString(object, 'css_style', ''),
    field_extraction_rules: valueRules(object),
    is_active: existing.is_active,
    preview_data_json: valueOptionalString(object, 'preview_data_json'),
    is_built_in: true,
  };
}

export function builtinResult(
  imported: number,
  updated: number,
  skipped: number,
  preserved: string[],
  conflicts: string[],
  errors: string[],
): string {
  return `导入完成: ${imported} 个新增, ${updated} 个更新, ${skipped} 个跳过${
    preserved.length ? `, ${preserved.length} 个保留用户状态(已跳过): ${preserved.join('; ')}` : ''
  }${
    conflicts.length
      ? `, ${conflicts.length} 个冲突(已跳过): ${conflicts.join('; ')}。请先删除重名模板或修改名称后重试`
      : ''
  }${errors.length ? `, ${errors.length} 个失败: ${errors.join('; ')}` : ''}`;
}

/**
 * Tauri 先反序列化命令参数再进入函数体：`AnkiCard` 解码失败报
 * `invalid args \`<key>\` for command \`<command>\`: <serde 错误>`，不执行任何写入。
 */
export function decodeCardArg<T>(command: string, key: string, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof AnkiCardDecodeError) {
      throw new CommandError(`invalid args \`${key}\` for command \`${command}\`: ${error.message}`);
    }
    throw error;
  }
}

export function bulkResult(
  imported: number,
  skipped: number,
  conflicts: string[],
  errors: string[],
): string {
  return `导入完成: ${imported} 个成功, ${skipped} 个跳过(已存在)${
    conflicts.length
      ? `, ${conflicts.length} 个冲突(已跳过): ${conflicts.join('; ')}。请启用覆盖或修改名称后重试`
      : ''
  }${errors.length ? `, ${errors.length} 个失败: ${errors.join('; ')}` : ''}`;
}

export async function readBuiltinTemplates(): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = ankiLocalRuntime().readBundledText('builtin-templates.json');
  } catch (error) {
    throwApp('Validation', `解析内置模板 JSON 失败: ${ioErrorText(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throwApp('Validation', `解析内置模板 JSON 失败: ${messages(error)}`);
  }
  if (!Array.isArray(parsed)) validationFailure('解析内置模板 JSON 失败: invalid type: map, expected a sequence');
  return parsed as Record<string, unknown>[];
}
