/**
 * `src/cmd/ocr.rs`: OCR model-list maintenance and the settings-facing OCR
 * commands. Engine parsing, factory metadata, model validation and prompts come
 * from L01 `llm-providers/api.ts` (`ocr_adapters`); the shared model-list
 * migrations and `is_discontinued_ocr_model` come from L02 `llm/api.ts`.
 *
 * Settings stay in `ctx.settings`; LLM API configurations come from `llm@1` when
 * it is present (the discontinued-model checks are skipped when it is not, which
 * matches the Rust `if let Ok(...)` best-effort branches).
 */
import {
  LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN, OcrAdapterFactory, isDedicatedOcrEngine,
  ocrEngineInfoToJson, ocrEngineRecommendedModel, ocrEngineTypeFromStr, ocrModeFromStr,
  tryOcrEngineTypeFromStr, type OcrEngineType, type OcrMode,
} from '../../llm-providers/api.ts';
import { JsonReader } from '../../../platform/util/portable.ts';
import {
  SYSTEM_OCR_CONFIG_ID, isDiscontinuedOcrModel,
  migrateGlmOcrModels as migrateGlmOcrModelsL02,
  migratePaddleOcrModels as migratePaddleOcrModelsL02,
  type OcrModelConfig as L02OcrModelConfig,
} from '../../llm/api.ts';

export { LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN, SYSTEM_OCR_CONFIG_ID, isDedicatedOcrEngine };
export type { OcrEngineType, OcrMode };

export interface OcrModelConfig {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  enabled: boolean;
  priority: number;
}

export interface OcrEngineInfo {
  engineType: OcrEngineType;
  name: string;
  description: string;
  recommendedModel: string;
  supportsGrounding: boolean;
  isFree: boolean;
  isDedicatedOcr: boolean;
}

export interface AvailableOcrModel {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  description: string | null;
  supportsGrounding: boolean;
  enabled: boolean;
  priority: number;
}

export interface OcrSettings {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

export interface OcrApiConfig {
  id: string;
  baseUrl: string;
  model: string;
}

export interface OcrLlmConfigs {
  getApiConfigs(): Promise<OcrApiConfig[]>;
}

export class OcrSettingsError extends Error {
  readonly kind: 'database' | 'validation';
  constructor(kind: 'database' | 'validation', message: string) {
    super(message);
    this.name = 'OcrSettingsError';
    this.kind = kind;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `OcrEngineType::try_from_str`：严格解析，未知返回 null。 */
export function tryParseEngineType(value: string): OcrEngineType | null {
  return tryOcrEngineTypeFromStr(value) ?? null;
}

/** `OcrEngineType::from_str`：未知回退到 PaddleOCR-VL。 */
export const parseEngineType = ocrEngineTypeFromStr;
export const recommendedModel = ocrEngineRecommendedModel;
export const validateModelForEngine = OcrAdapterFactory.validateModelForEngine;
export const inferEngineFromModel = OcrAdapterFactory.inferEngineFromModel;
/** `OcrMode::from_str`：未知回退到 Grounding。 */
export const parseOcrMode = ocrModeFromStr;

/** `system_ocr::is_platform_supported`；`platform` 取宿主 `ctx.app.platform`。 */
export function systemOcrPlatformSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** `src/cmd/ocr.rs::system_ocr_display_name`（命令层自有）。 */
export function systemOcrDisplayName(platform: string): string {
  if (platform === 'darwin') return '系统 OCR (macOS Vision)';
  if (platform === 'win32') return '系统 OCR (Windows OCR)';
  return '系统 OCR';
}

/**
 * `OcrAdapterFactory::engine_info_list`（L01）。L01 以 `process.platform` 决定是否
 * 附加系统 OCR；这里按 `platform` 门控同一条目，避免测试宿主平台与进程平台不一致。
 */
export function engineInfoList(systemSupported: boolean): OcrEngineInfo[] {
  const list = OcrAdapterFactory.engineInfoList()
    .filter(info => info.engine_type !== 'system_ocr')
    .map(info => ocrEngineInfoToJson(info) as unknown as OcrEngineInfo);
  if (systemSupported) {
    list.push({
      engineType: 'system_ocr',
      name: '系统 OCR',
      description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
      recommendedModel: 'system',
      supportsGrounding: false,
      isFree: true,
      isDedicatedOcr: true,
    });
  }
  return list;
}

export function engineInfo(engine: OcrEngineType, systemSupported: boolean): OcrEngineInfo | null {
  return engineInfoList(systemSupported).find(info => info.engineType === engine) ?? null;
}

/** 各适配器的 `build_prompt`（L01 `OcrAdapterFactory.create(engine).buildPrompt`）。 */
export function buildOcrPrompt(engine: OcrEngineType, mode: OcrMode): string {
  return OcrAdapterFactory.create(engine).buildPrompt(mode);
}

function databaseError(detail: string, error: unknown): OcrSettingsError {
  return new OcrSettingsError('database', `${detail}: ${errorMessage(error)}`);
}

function validationError(message: string): OcrSettingsError {
  return new OcrSettingsError('validation', message);
}

const OCR_MODEL_FIELDS = ['configId', 'model', 'engineType', 'name', 'isFree', 'enabled', 'priority'] as const;
type OcrModelField = typeof OCR_MODEL_FIELDS[number];

/** `OcrModelConfig` derive (`llm_manager/mod.rs:3249-3270`): map or seq form, unknown keys ignored. */
function readModel(r: JsonReader): OcrModelConfig {
  const fields: Partial<Record<OcrModelField, string | boolean | number>> = {};
  const readField = (key: OcrModelField): void => {
    if (key === 'isFree' || key === 'enabled') fields[key] = r.readBool();
    else if (key === 'priority') fields[key] = Number(r.readUnsigned('u32', 0xffff_ffffn));
    else fields[key] = r.readString();
  };
  const required = (key: 'configId' | 'model' | 'engineType' | 'name'): string => {
    const value = fields[key];
    if (value === undefined) throw r.error(`missing field \`${key}\``);
    return value as string;
  };
  let length = 0;
  const kind = r.peekKind();
  if (kind === 'array') {
    r.beginArray();
    let closed = false;
    for (const key of OCR_MODEL_FIELDS) {
      if (!r.nextItem()) { closed = true; break; }
      readField(key);
      length += 1;
    }
    if (!closed) r.endArray();
    if (length < 4) throw r.error(`invalid length ${length}, expected struct OcrModelConfig with 7 elements`);
  } else if (kind === 'object') {
    r.beginObject();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      if (!(OCR_MODEL_FIELDS as readonly string[]).includes(key)) { r.skipIgnoredValue(); continue; }
      if (fields[key as OcrModelField] !== undefined) throw r.fieldError(`duplicate field \`${key}\``);
      readField(key as OcrModelField);
    }
  } else {
    throw r.invalidType('struct OcrModelConfig');
  }
  return {
    configId: required('configId'),
    model: required('model'),
    engineType: required('engineType'),
    name: required('name'),
    isFree: (fields.isFree as boolean | undefined) ?? false,
    enabled: (fields.enabled as boolean | undefined) ?? true,
    priority: (fields.priority as number | undefined) ?? 0,
  };
}

/** `serde_json::from_str::<Vec<OcrModelConfig>>`: serde error text and position. */
function parseModels(json: string): OcrModelConfig[] {
  const r = new JsonReader(json);
  r.beginArray();
  const models: OcrModelConfig[] = [];
  while (r.nextItem()) models.push(readModel(r));
  r.end();
  return models;
}

/** `get_setting("ocr.available_models")`；null 表示从未配置过（与空数组不同）。 */
function readModelsOrNull(settings: OcrSettings): OcrModelConfig[] | null {
  let json: string | null;
  try { json = settings.get('ocr.available_models'); }
  catch (error) { throw databaseError('读取 OCR 模型配置失败', error); }
  if (json === null) return null;
  try { return parseModels(json); }
  catch (error) { throw databaseError('解析 OCR 模型配置失败', error); }
}

function saveModels(settings: OcrSettings, models: OcrModelConfig[]): void {
  let json: string;
  try { json = JSON.stringify(models); }
  catch (error) { throw databaseError('序列化 OCR 模型配置失败', error); }
  try { settings.save('ocr.available_models', json); }
  catch (error) { throw databaseError('保存 OCR 模型配置失败', error); }
}

function renumberPriority(models: OcrModelConfig[]): void {
  models.forEach((model, index) => { model.priority = index; });
}

/**
 * Rust 在自动迁移/清理路径里用 `let _ = db.save_setting(...)` 忽略落盘失败，
 * 返回值仍反映内存中的列表；这里保持同样语义。
 */
function saveModelsBestEffort(settings: OcrSettings, models: OcrModelConfig[]): void {
  let json: string;
  try { json = JSON.stringify(models); }
  catch { return; }
  try { settings.save('ocr.available_models', json); }
  catch { return; }
}

function isSiliconflow(configs: OcrApiConfig[] | null, id: string): boolean {
  return configs?.find(config => config.id === id)?.baseUrl.toLowerCase().includes('siliconflow') ?? false;
}

function isZhipuOfficial(configs: OcrApiConfig[] | null, id: string): boolean {
  return configs?.find(config => config.id === id)?.baseUrl.toLowerCase().includes('bigmodel') ?? false;
}

function toL02(model: OcrModelConfig): L02OcrModelConfig {
  return {
    config_id: model.configId, model: model.model, engine_type: model.engineType, name: model.name,
    is_free: model.isFree, enabled: model.enabled, priority: model.priority,
  };
}

/** Runs an L02 in-place migration on the camelCase settings shape and copies the result back. */
function migrateViaL02(models: OcrModelConfig[], run: (snake: L02OcrModelConfig[]) => boolean): boolean {
  const snake = models.map(toL02);
  const changed = run(snake);
  snake.forEach((migrated, index) => {
    const target = models[index]!;
    target.model = migrated.model;
    target.engineType = migrated.engine_type;
    target.name = migrated.name;
  });
  return changed;
}

/** `migrate_paddle_ocr_models`（L02 共享迁移）。 */
export function migratePaddleOcrModels(models: OcrModelConfig[]): boolean {
  return migrateViaL02(models, migratePaddleOcrModelsL02);
}

/** `migrate_glm_ocr_models`（L02 共享迁移，含其迁移日志）。 */
export function migrateGlmOcrModels(
  models: OcrModelConfig[],
  siliconflow: (id: string) => boolean,
  zhipu: (id: string) => boolean,
): boolean {
  return migrateViaL02(models, snake => migrateGlmOcrModelsL02(snake, siliconflow, zhipu));
}

function systemModelEntry(priority: number, platform: string): OcrModelConfig {
  return {
    configId: SYSTEM_OCR_CONFIG_ID,
    model: 'system',
    engineType: 'system_ocr',
    name: systemOcrDisplayName(platform),
    isFree: true,
    enabled: true,
    priority,
  };
}

function systemModelResponse(platform: string): AvailableOcrModel {
  const entry = systemModelEntry(0, platform);
  return {
    ...entry,
    description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
    supportsGrounding: false,
  };
}

/**
 * `get_available_ocr_models`：读取/迁移/清理模型列表并合并内置引擎元数据。
 * LLM 配置读取失败时跳过依赖它的清理（与 Rust 的 `if let Ok` 一致）。
 */
export async function getAvailableOcrModels(
  settings: OcrSettings,
  llm: OcrLlmConfigs | null,
  platform: string,
  info: (message: string) => void = () => undefined,
): Promise<AvailableOcrModel[]> {
  const systemSupported = systemOcrPlatformSupported(platform);
  let models = readModelsOrNull(settings);
  if (models === null) {
    if (!systemSupported) return [];
    const entry = systemModelEntry(0, platform);
    saveModelsBestEffort(settings, [entry]);
    return [systemModelResponse(platform)];
  }

  let needsSave = migratePaddleOcrModels(models);
  if (needsSave) info('[OCR] 已自动迁移 PaddleOCR-VL 配置到 1.5 版本');
  let configs: OcrApiConfig[] | null = null;
  if (llm !== null) {
    try { configs = await llm.getApiConfigs(); }
    catch { configs = null; }
  }
  if (migrateGlmOcrModels(models,
    id => isSiliconflow(configs, id), id => isZhipuOfficial(configs, id))) {
    needsSave = true;
  }

  if (configs !== null) {
    const valid = new Set(configs.map(config => config.id));
    const before = models.length;
    models = models.filter(model =>
      model.configId === SYSTEM_OCR_CONFIG_ID || valid.has(model.configId));
    if (models.length < before) {
      needsSave = true;
      renumberPriority(models);
      info(`[OCR] 已清理 ${before - models.length} 个孤儿 OCR 引擎（对应 API 配置已删除）`);
    }

    const discontinued = new Set(configs
      .filter(isDiscontinuedOcrModel)
      .map(config => config.id));
    const beforeDiscontinued = models.length;
    models = models.filter(model =>
      model.configId === SYSTEM_OCR_CONFIG_ID || !discontinued.has(model.configId));
    if (models.length < beforeDiscontinued) {
      needsSave = true;
      renumberPriority(models);
      info(`[OCR] 已清理 ${beforeDiscontinued - models.length} 个已停服的 OCR 引擎（对应模型已下架）`);
    }
  }

  if (systemSupported && !models.some(model => model.configId === SYSTEM_OCR_CONFIG_ID)) {
    const maxPriority = models.reduce((max, model) => Math.max(max, model.priority), 0);
    models.push(systemModelEntry(maxPriority + 1, platform));
    needsSave = true;
    info('[OCR] 已自动注入系统 OCR 引擎');
  }

  // Rust ignores migration-save failures; the response below still reflects the
  // in-memory list.
  if (needsSave) saveModelsBestEffort(settings, models);

  const infoByType = new Map<string, OcrEngineInfo>(
    engineInfoList(systemSupported).map(info => [info.engineType, info]));
  models.sort((a, b) => a.priority - b.priority);
  return models.map(model => {
    // Rust keys the map by the stored `engine_type` string, so aliases and
    // unknown values intentionally get no description.
    const info = infoByType.get(model.engineType);
    return {
      configId: model.configId,
      model: model.model,
      engineType: model.engineType,
      name: model.name,
      isFree: model.isFree,
      description: info?.description ?? null,
      supportsGrounding: info?.supportsGrounding ?? false,
      enabled: model.enabled,
      priority: model.priority,
    };
  });
}

/** `add_ocr_engine`：系统引擎不可手动添加；已存在/停服模型拒绝。 */
export async function addOcrEngine(
  settings: OcrSettings,
  llm: OcrLlmConfigs | null,
  configId: string,
  model: string,
  name: string,
  engineType: string | null,
  platform: string,
): Promise<void> {
  const models = readModelsOrNull(settings) ?? [];
  if (configId === SYSTEM_OCR_CONFIG_ID) {
    throw validationError('系统 OCR 引擎由系统自动管理，无需手动添加');
  }
  if (models.some(existing => existing.configId === configId)) {
    throw validationError('该模型已在 OCR 引擎列表中');
  }
  const effective = engineType ?? inferEngineFromModel(model);

  if (llm !== null) {
    try {
      const configs = await llm.getApiConfigs();
      const config = configs.find(candidate => candidate.id === configId);
      if (config !== undefined && isDiscontinuedOcrModel(config)) {
        throw validationError(
          `模型 ${config.model} 已被服务商停服（硅基流动已下架 zai-org/GLM-4.6V），无法添加为 OCR 引擎`);
      }
    } catch (error) {
      // Validation failures must propagate; transport/config failures are ignored
      // exactly like the Rust `if let Ok(api_configs)` branch.
      if (error instanceof OcrSettingsError) throw error;
    }
  }

  const maxPriority = models.reduce((max, existing) => Math.max(max, existing.priority), 0);
  const info = engineInfo(parseEngineType(effective), systemOcrPlatformSupported(platform));
  models.push({
    configId,
    model,
    engineType: effective,
    name,
    isFree: info?.isFree ?? false,
    enabled: true,
    priority: maxPriority + 1,
  });
  saveModels(settings, models);
}

/** `remove_ocr_engine`：删除后按数组顺序重新编号。 */
export function removeOcrEngine(settings: OcrSettings, configId: string): void {
  const models = readModelsOrNull(settings) ?? [];
  if (configId === SYSTEM_OCR_CONFIG_ID) {
    throw validationError('系统 OCR 引擎由系统自动管理，无法删除');
  }
  const before = models.length;
  const remaining = models.filter(model => model.configId !== configId);
  if (remaining.length === before) throw validationError('未找到该 OCR 引擎');
  renumberPriority(remaining);
  saveModels(settings, remaining);
}

/** `update_ocr_engine_priority`：按前端数组顺序更新 priority/enabled 后排序。 */
export function updateOcrEnginePriority(
  settings: OcrSettings,
  engineList: ReadonlyArray<{ configId: string; enabled: boolean }>,
): void {
  const models = readModelsOrNull(settings) ?? [];
  engineList.forEach((item, index) => {
    const model = models.find(candidate => candidate.configId === item.configId);
    if (model !== undefined) {
      model.priority = index;
      model.enabled = item.enabled;
    }
  });
  models.sort((a, b) => a.priority - b.priority);
  saveModels(settings, models);
}

/** `set_ocr_engine_type`：严格校验后保存规范化标识。 */
export function setOcrEngineType(settings: OcrSettings, engineType: string): void {
  const parsed = tryParseEngineType(engineType);
  if (parsed === null) {
    throw validationError(`Unknown OCR engine type: '${engineType}'. `
      + 'Valid types: deepseek_ocr, paddle_ocr_vl, paddle_ocr_vl_v1, generic_vlm');
  }
  try { settings.save('ocr.engine_type', parsed); }
  catch (error) { throw databaseError('保存 OCR 引擎配置失败', error); }
}

/** `get_ocr_thinking_enabled`：DB 读取失败按关闭处理。 */
export function getOcrThinkingEnabled(settings: OcrSettings): boolean {
  try {
    return (settings.get('ocr.enable_thinking') ?? '').toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/** `get_ocr_engines`：只返回线协议字段（不含 isDedicatedOcr）。 */
export function getOcrEngines(platform: string): Array<{
  engineType: string;
  name: string;
  description: string;
  recommendedModel: string;
  supportsGrounding: boolean;
  isFree: boolean;
}> {
  return engineInfoList(systemOcrPlatformSupported(platform)).map(info => ({
    engineType: info.engineType,
    name: info.name,
    description: info.description,
    recommendedModel: info.recommendedModel,
    supportsGrounding: info.supportsGrounding,
    isFree: info.isFree,
  }));
}

/** `get_ocr_prompt_template`。 */
export function getOcrPromptTemplate(engineType: string, mode: string): string {
  // Rust 的 `from_str` 不做 trim：带空白的输入按未知值回退。
  return buildOcrPrompt(parseEngineType(engineType), parseOcrMode(mode));
}

/** `infer_ocr_engine_from_model`。 */
export function inferOcrEngineFromModel(model: string): string {
  return inferEngineFromModel(model);
}

/** `validate_ocr_model`。 */
export function validateOcrModel(model: string, engineType: string): {
  isValid: boolean;
  recommendedModel: string | null;
} {
  const engine = parseEngineType(engineType);
  const isValid = validateModelForEngine(model, engine);
  return {
    isValid,
    recommendedModel: isValid ? null : recommendedModel(engine),
  };
}
