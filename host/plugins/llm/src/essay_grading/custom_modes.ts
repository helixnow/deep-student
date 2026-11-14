/**
 * 自定义模式 JSON 存储（移植 `dstu-tutor/src/essay_grading/custom_modes.rs`）。
 *
 * 使用 JSON 文件存储用户自定义的批改模式，简单轻量；写入采用
 * 「临时文件 + rename」原子替换，避免进程崩溃或断电后留下半截 JSON。
 * 文件读写经 `ctx.files`（移动端同一套异步接口），由调用方提供端口。
 * 文件格式保持 Rust serde 的 snake_case 形态（`custom_grading_modes.json`），
 * 以便与既有用户数据互通。
 */
import { dirname, join } from '../../../../platform/util/path.ts';
import type { FilesService } from '../../../../platform/files/api.ts';
import { canonicalModeId, getBuiltinGradingModes } from './types.ts';
import type { GradingMode, ScoreDimension } from './types.ts';
import { logWarn } from '../logging.ts';
import { toRfc3339 } from '../../../../platform/time/index.ts';
import type { JsonValue } from '../../../../platform/errors/api.ts';
import { customModesConfigJson } from './score_json.ts';

const randomUUID = () => globalThis.crypto.randomUUID();

/** 自定义模式落盘用到的 `ctx.files` 操作。 */
export type CustomModeFiles = Pick<FilesService, 'exists' | 'mkdir' | 'readText' | 'rename' | 'rm' | 'writeText'>;

/** 自定义模式存储文件名 */
const CUSTOM_MODES_FILE = 'custom_grading_modes.json';

/** 模式名称最大字符数 */
const MAX_MODE_NAME_CHARS = 60;
/** 模式描述最大字符数 */
const MAX_MODE_DESCRIPTION_CHARS = 2000;
/** 系统提示词最大字符数 */
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
/** 评分维度数量上限 */
const MAX_SCORE_DIMENSIONS = 20;
/** 单维度描述最大字符数 */
const MAX_DIMENSION_DESCRIPTION_CHARS = 500;
/** 分数上限（总分/维度满分的合理上界，防御性校验） */
const MAX_SCORE_VALUE = 100_000;

export interface CustomModesConfig {
  modes: GradingMode[];
}

export interface CreateModeInput {
  name: string;
  description: string;
  systemPrompt: string;
  scoreDimensions: ScoreDimension[];
  totalMaxScore: number;
}

export interface UpdateModeInput {
  id: string;
  name?: string;
  description?: string;
  systemPrompt?: string;
  scoreDimensions?: ScoreDimension[];
  totalMaxScore?: number;
}

export interface SaveBuiltinOverrideInput {
  builtinId: string;
  name: string;
  description: string;
  systemPrompt: string;
  scoreDimensions: ScoreDimension[];
  totalMaxScore: number;
}

// ============================================================================
// 磁盘格式（Rust serde snake_case）
// ============================================================================

interface ScoreDimensionWire {
  name: string;
  max_score: number;
  description: string | null;
}

interface GradingModeWire {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  score_dimensions: ScoreDimensionWire[];
  total_max_score: number;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

function dimensionToWire(dim: ScoreDimension): ScoreDimensionWire {
  return { name: dim.name, max_score: dim.maxScore, description: dim.description };
}

export function modeToWire(mode: GradingMode): GradingModeWire {
  return {
    id: mode.id,
    name: mode.name,
    description: mode.description,
    system_prompt: mode.systemPrompt,
    score_dimensions: mode.scoreDimensions.map(dimensionToWire),
    total_max_score: mode.totalMaxScore,
    is_builtin: mode.isBuiltin,
    created_at: mode.createdAt,
    updated_at: mode.updatedAt,
  };
}

function dimensionFromWire(value: unknown): ScoreDimension {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('score_dimensions 条目必须是对象');
  }
  const wire = value as Record<string, unknown>;
  const { name, max_score: maxScore, description } = wire;
  if (typeof name !== 'string' || typeof maxScore !== 'number') {
    throw new TypeError('score_dimensions 条目缺少 name/max_score');
  }
  if (description !== null && description !== undefined && typeof description !== 'string') {
    throw new TypeError('score_dimensions.description 必须是字符串或 null');
  }
  return { name, maxScore, description: description ?? null };
}

function modeFromWire(value: unknown): GradingMode {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('模式记录必须是对象');
  }
  const wire = value as Record<string, unknown>;
  const {
    id, name, description, system_prompt: systemPrompt, score_dimensions: scoreDimensions,
    total_max_score: totalMaxScore, is_builtin: isBuiltin, created_at: createdAt,
    updated_at: updatedAt,
  } = wire;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof description !== 'string'
    || typeof systemPrompt !== 'string' || typeof totalMaxScore !== 'number'
    || typeof isBuiltin !== 'boolean' || typeof createdAt !== 'string'
    || typeof updatedAt !== 'string' || !Array.isArray(scoreDimensions)) {
    throw new TypeError('模式记录字段不完整');
  }
  return {
    id,
    name,
    description,
    systemPrompt,
    scoreDimensions: scoreDimensions.map(dimensionFromWire),
    totalMaxScore,
    isBuiltin,
    createdAt,
    updatedAt,
  };
}

function cloneMode(mode: GradingMode): GradingMode {
  return { ...mode, scoreDimensions: mode.scoreDimensions.map((dim) => ({ ...dim })) };
}

function cloneConfig(config: CustomModesConfig): CustomModesConfig {
  return { modes: config.modes.map(cloneMode) };
}

function emptyConfig(): CustomModesConfig {
  return { modes: [] };
}

// ============================================================================
// 管理器
// ============================================================================

/** 自定义模式管理器 */
export class CustomModeManager {
  private readonly configPath: string;
  private readonly files: CustomModeFiles;
  private cache: CustomModesConfig | null = null;

  constructor(dataDir: string, files: CustomModeFiles) {
    this.configPath = join(dataDir, CUSTOM_MODES_FILE);
    this.files = files;
  }

  /** 获取所有自定义模式 */
  async listModes(): Promise<GradingMode[]> {
    return (await this.loadConfig()).modes;
  }

  /** 获取单个自定义模式 */
  async getMode(modeId: string): Promise<GradingMode | undefined> {
    return (await this.loadConfig()).modes.find((mode) => mode.id === modeId);
  }

  /** 创建自定义模式 */
  async createMode(input: CreateModeInput): Promise<GradingMode> {
    const name = input.name.trim();
    validateModeName(name);
    validateDescription(input.description);
    validateSystemPrompt(input.systemPrompt);
    validateScoreDimensions(input.scoreDimensions);
    validateTotalMaxScore(input.totalMaxScore);

    // 与预置模式重名会造成 UI 无法区分，直接拒绝
    if (getBuiltinGradingModes().some((mode) => modeNamesEqual(mode.name, name))) {
      throw new Error(`模式名称与预置模式重复: ${name}`);
    }

    const config = await this.loadConfig();

    // 检查名称是否重复（trim + 大小写不敏感）
    if (config.modes.some((mode) => modeNamesEqual(mode.name, name))) {
      throw new Error(`模式名称已存在: ${name}`);
    }

    const now = toRfc3339();
    const mode: GradingMode = {
      id: `custom_${randomUUID().replace(/-/g, '')}`,
      name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      scoreDimensions: input.scoreDimensions.map((dim) => ({ ...dim })),
      totalMaxScore: input.totalMaxScore,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    };

    config.modes.push(mode);
    await this.saveConfig(config);
    return cloneMode(mode);
  }

  /** 更新自定义模式 */
  async updateMode(input: UpdateModeInput): Promise<GradingMode> {
    // 校验提供的字段（未提供的字段保持原值，不校验）
    const newName = input.name === undefined ? undefined : input.name.trim();
    if (newName !== undefined) validateModeName(newName);
    if (input.description !== undefined) validateDescription(input.description);
    if (input.systemPrompt !== undefined) validateSystemPrompt(input.systemPrompt);
    if (input.scoreDimensions !== undefined) validateScoreDimensions(input.scoreDimensions);
    if (input.totalMaxScore !== undefined) validateTotalMaxScore(input.totalMaxScore);

    const config = await this.loadConfig();
    const index = config.modes.findIndex((mode) => mode.id === input.id);
    if (index < 0) throw new Error(`模式不存在: ${input.id}`);

    if (newName !== undefined) {
      if (config.modes.some((mode) => mode.id !== input.id && modeNamesEqual(mode.name, newName))) {
        throw new Error(`模式名称已存在: ${newName}`);
      }
      // 纯自定义模式改名不得与预置模式重名；预置覆盖（同 ID）不受此限
      const isBuiltinOverride = builtinModeIds().has(input.id);
      if (!isBuiltinOverride && getBuiltinGradingModes().some((mode) => modeNamesEqual(mode.name, newName))) {
        throw new Error(`模式名称与预置模式重复: ${newName}`);
      }
    }

    const mode = config.modes[index] as GradingMode;
    if (newName !== undefined) mode.name = newName;
    if (input.description !== undefined) mode.description = input.description;
    if (input.systemPrompt !== undefined) mode.systemPrompt = input.systemPrompt;
    if (input.scoreDimensions !== undefined) {
      mode.scoreDimensions = input.scoreDimensions.map((dim) => ({ ...dim }));
    }
    if (input.totalMaxScore !== undefined) mode.totalMaxScore = input.totalMaxScore;
    mode.updatedAt = toRfc3339();

    await this.saveConfig(config);
    return cloneMode(mode);
  }

  /**
   * 保存预置模式的自定义覆盖（编辑预置模式时保存为同 ID 的自定义版本）。
   */
  async saveBuiltinOverride(input: SaveBuiltinOverrideInput): Promise<GradingMode> {
    if (input.builtinId.trim().length === 0) {
      throw new Error('预置模式 ID 不能为空');
    }
    // 归一化别名并校验目标确实是预置模式，防止把任意 ID 写成"伪覆盖"
    const builtinId = canonicalModeId(input.builtinId);
    if (!builtinModeIds().has(builtinId)) {
      throw new Error(`预置模式不存在: ${input.builtinId}`);
    }
    const name = input.name.trim();
    validateModeName(name);
    validateDescription(input.description);
    validateSystemPrompt(input.systemPrompt);
    validateScoreDimensions(input.scoreDimensions);
    validateTotalMaxScore(input.totalMaxScore);

    const config = await this.loadConfig();
    const index = config.modes.findIndex((mode) => mode.id === builtinId);
    if (index >= 0) {
      // 更新现有覆盖
      const mode = config.modes[index] as GradingMode;
      mode.name = name;
      mode.description = input.description;
      mode.systemPrompt = input.systemPrompt;
      mode.scoreDimensions = input.scoreDimensions.map((dim) => ({ ...dim }));
      mode.totalMaxScore = input.totalMaxScore;
      mode.updatedAt = toRfc3339();
      await this.saveConfig(config);
      return cloneMode(mode);
    }

    // 创建新覆盖
    const now = toRfc3339();
    const mode: GradingMode = {
      id: builtinId,
      name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      scoreDimensions: input.scoreDimensions.map((dim) => ({ ...dim })),
      totalMaxScore: input.totalMaxScore,
      isBuiltin: false, // 标记为自定义，但保留原 ID
      createdAt: now,
      updatedAt: now,
    };
    config.modes.push(mode);
    await this.saveConfig(config);
    return cloneMode(mode);
  }

  /** 重置预置模式为默认配置（删除自定义覆盖） */
  async resetBuiltinMode(builtinId: string): Promise<void> {
    const canonicalId = canonicalModeId(builtinId);
    const config = await this.loadConfig();
    const initialLength = config.modes.length;
    config.modes = config.modes.filter((mode) => mode.id !== canonicalId);
    if (config.modes.length === initialLength) {
      // 没有找到覆盖，可能本来就是预置配置
      return;
    }
    await this.saveConfig(config);
  }

  /** 检查预置模式是否有自定义覆盖 */
  async hasBuiltinOverride(builtinId: string): Promise<boolean> {
    const canonicalId = canonicalModeId(builtinId);
    return (await this.loadConfig()).modes.some((mode) => mode.id === canonicalId);
  }

  /**
   * 删除自定义模式。
   *
   * 预置模式（含其覆盖）受保护：删除覆盖请走 resetBuiltinMode，
   * 避免误把"删除自定义模式"打到预置 ID 上造成覆盖静默丢失。
   */
  async deleteMode(modeId: string): Promise<void> {
    if (builtinModeIds().has(canonicalModeId(modeId))) {
      throw new Error(`预置模式不可删除（如需恢复默认配置请使用重置功能）: ${modeId}`);
    }

    const config = await this.loadConfig();
    const initialLength = config.modes.length;
    config.modes = config.modes.filter((mode) => mode.id !== modeId);
    if (config.modes.length === initialLength) {
      throw new Error(`模式不存在: ${modeId}`);
    }
    await this.saveConfig(config);
  }

  /** 清除缓存（配置文件变更后调用） */
  invalidateCache(): void {
    this.cache = null;
  }

  // --------------------------------------------------------------------------
  // 加载 / 保存
  // --------------------------------------------------------------------------

  private async loadConfig(): Promise<CustomModesConfig> {
    if (this.cache !== null) return cloneConfig(this.cache);

    let config: CustomModesConfig;
    if (await this.files.exists(this.configPath)) {
      let content: string;
      try {
        content = await this.files.readText(this.configPath);
      } catch (error) {
        logWarn(`[CustomModes] 读取配置失败: ${String(error)}`);
        config = emptyConfig();
        this.cache = cloneConfig(config);
        return config;
      }
      try {
        const parsed: unknown = JSON.parse(content);
        config = sanitizeLoadedConfig(configFromWire(parsed));
      } catch (error) {
        // JSON 损坏：备份坏文件后从空配置开始，避免后续保存直接覆盖用户数据
        logWarn(`[CustomModes] 配置文件 JSON 损坏（${String(error)}），备份原文件后从空配置开始`);
        await this.backupCorruptedFile();
        config = emptyConfig();
      }
    } else {
      config = emptyConfig();
    }

    this.cache = cloneConfig(config);
    return config;
  }

  /** 将损坏的配置文件重命名为 .json.bak 备份（保留现场供用户手动恢复） */
  private async backupCorruptedFile(): Promise<void> {
    const backupPath = `${this.configPath}.bak`;
    // Windows 上 rename 无法覆盖已存在的目标文件，先移除旧备份
    await this.removeIfPresent(backupPath);
    try {
      await this.files.rename(this.configPath, backupPath);
      logWarn(`[CustomModes] 损坏的配置已备份至: ${backupPath}`);
    } catch (error) {
      logWarn(`[CustomModes] 备份损坏配置失败: ${String(error)}`);
    }
  }

  private async saveConfig(config: CustomModesConfig): Promise<void> {
    const content = customModesConfigJson({ modes: config.modes.map(modeToWire) } as unknown as JsonValue);
    const tmpPath = `${this.configPath}.tmp`;
    const parent = dirname(this.configPath);
    try {
      await this.files.mkdir(parent, { recursive: true });
    } catch (error) {
      throw new Error(`创建配置目录失败: ${String(error)}`);
    }
    try {
      await this.files.writeText(tmpPath, content);
    } catch (error) {
      throw new Error(`写入临时文件失败: ${String(error)}`);
    }

    try {
      await this.files.rename(tmpPath, this.configPath);
    } catch (firstError) {
      // Windows 上 rename 无法覆盖已存在的目标文件，移除后重试一次
      await this.removeIfPresent(this.configPath);
      try {
        await this.files.rename(tmpPath, this.configPath);
      } catch (error) {
        await this.removeIfPresent(tmpPath);
        throw new Error(`写入配置文件失败: ${String(error)}（首次替换失败: ${String(firstError)}）`);
      }
    }

    this.cache = cloneConfig(config);
  }

  private async removeIfPresent(path: string): Promise<void> {
    if (await this.files.exists(path)) await this.files.rm(path);
  }
}

function configFromWire(value: unknown): CustomModesConfig {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('配置根节点必须是对象');
  }
  const modes = (value as Record<string, unknown>)['modes'];
  if (!Array.isArray(modes)) throw new TypeError('配置缺少 modes 数组');
  return { modes: modes.map(modeFromWire) };
}

/** 预置模式 ID 集合（用于覆盖校验与删除保护） */
function builtinModeIds(): Set<string> {
  return new Set(getBuiltinGradingModes().map((mode) => mode.id));
}

// ============================================================================
// 加载时数据修复
// ============================================================================

/** 判断单个模式记录是否结构有效（用于加载时剔除损坏条目） */
function isStructurallyValidMode(mode: GradingMode): boolean {
  return mode.id.trim().length > 0
    && mode.name.trim().length > 0
    && Number.isFinite(mode.totalMaxScore)
    && mode.totalMaxScore > 0
    && mode.scoreDimensions.every((dim) => dim.name.trim().length > 0
      && Number.isFinite(dim.maxScore) && dim.maxScore > 0);
}

/**
 * 加载后净化：剔除结构损坏的条目、按 ID 去重（保留最后写入者）。
 *
 * 只影响内存视图，不主动回写文件——原始数据保留至下一次显式保存，
 * 避免一次读到部分损坏就永久丢弃用户内容。
 */
export function sanitizeLoadedConfig(config: CustomModesConfig): CustomModesConfig {
  const total = config.modes.length;
  const seenIds = new Set<string>();
  const kept: GradingMode[] = [];
  // 逆序遍历实现"同 ID 保留最后一个"，随后恢复原有相对顺序
  for (let index = config.modes.length - 1; index >= 0; index -= 1) {
    const mode = config.modes[index] as GradingMode;
    if (!isStructurallyValidMode(mode)) {
      logWarn(`[CustomModes] 跳过结构损坏的模式记录 (id=${mode.id}, name=${mode.name})`);
      continue;
    }
    if (seenIds.has(mode.id)) {
      logWarn(`[CustomModes] 跳过重复 ID 的模式记录 (id=${mode.id})`);
      continue;
    }
    seenIds.add(mode.id);
    kept.push(mode);
  }
  kept.reverse();
  if (kept.length !== total) {
    logWarn(`[CustomModes] 加载净化：${total} 条记录中保留 ${kept.length} 条`);
  }
  return { modes: kept };
}

// ============================================================================
// 输入校验
// ============================================================================

/** 校验模式名称：非空且不超长 */
function validateModeName(name: string): void {
  if (name.length === 0) {
    throw new Error('模式名称不能为空');
  }
  if (charCount(name) > MAX_MODE_NAME_CHARS) {
    throw new Error(`模式名称过长（最多 ${MAX_MODE_NAME_CHARS} 字符）`);
  }
}

/** 校验模式描述长度 */
function validateDescription(description: string): void {
  if (charCount(description) > MAX_MODE_DESCRIPTION_CHARS) {
    throw new Error(`模式描述过长（最多 ${MAX_MODE_DESCRIPTION_CHARS} 字符）`);
  }
}

/** 校验系统提示词长度（允许为空：共享的标记/评分指令仍会生效） */
function validateSystemPrompt(systemPrompt: string): void {
  if (charCount(systemPrompt) > MAX_SYSTEM_PROMPT_CHARS) {
    throw new Error(`系统提示词过长（最多 ${MAX_SYSTEM_PROMPT_CHARS} 字符）`);
  }
}

/** 校验评分维度：数量受限、维度名非空且不重复、维度满分为合理正数 */
function validateScoreDimensions(dimensions: readonly ScoreDimension[]): void {
  if (dimensions.length === 0) {
    throw new Error('至少需要一个评分维度');
  }
  if (dimensions.length > MAX_SCORE_DIMENSIONS) {
    throw new Error(`评分维度过多（最多 ${MAX_SCORE_DIMENSIONS} 个）`);
  }
  const seen = new Set<string>();
  for (const dim of dimensions) {
    const dimName = dim.name.trim();
    if (dimName.length === 0) {
      throw new Error('评分维度名称不能为空');
    }
    if (charCount(dimName) > MAX_MODE_NAME_CHARS) {
      throw new Error(`评分维度名称过长（最多 ${MAX_MODE_NAME_CHARS} 字符）: ${dimName}`);
    }
    if (seen.has(dimName)) {
      throw new Error(`评分维度名称重复: ${dimName}`);
    }
    seen.add(dimName);
    if (!Number.isFinite(dim.maxScore) || dim.maxScore <= 0 || dim.maxScore > MAX_SCORE_VALUE) {
      throw new Error(`评分维度「${dimName}」的满分必须为 0 到 ${MAX_SCORE_VALUE} 之间的正数`);
    }
    if (dim.description !== null && charCount(dim.description) > MAX_DIMENSION_DESCRIPTION_CHARS) {
      throw new Error(`评分维度「${dimName}」的描述过长（最多 ${MAX_DIMENSION_DESCRIPTION_CHARS} 字符）`);
    }
  }
}

/** 校验总分满分：有限正数且不超过上界 */
function validateTotalMaxScore(totalMaxScore: number): void {
  if (!Number.isFinite(totalMaxScore) || totalMaxScore <= 0 || totalMaxScore > MAX_SCORE_VALUE) {
    throw new Error(`总分满分必须为 0 到 ${MAX_SCORE_VALUE} 之间的正数`);
  }
}

/** 名称是否等价（trim + 大小写不敏感），用于重名判定 */
function modeNamesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function charCount(value: string): number {
  return Array.from(value).length;
}
