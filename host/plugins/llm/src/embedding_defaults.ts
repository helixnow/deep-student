/**
 * 嵌入维度默认模型的解析与自愈（移植
 * `dstu-llm/src/llm_manager/rag_extension.rs:169–494` 的
 * `get_embedding_model_config` / `fallback_embedding_model_id` /
 * `auto_detect_embedding_model_id` / `get_vl_embedding_model_config` /
 * `adopt_default_multimodal_embedding` / `heal_default_multimodal_embedding`）。
 *
 * 默认键与 `model_assignments` 都存在 settings 中（与 Rust 一致）；模型条目由调用方
 * 以运行期视图提供（`ModelProfile` 合入供应商后按 `id` / `label` / 能力标记投影即可）。
 *
 * 解析顺序保持 Rust 语义：
 * - 文本轨道：有效默认键 → `model_assignments.embedding_model_config_id` → 自动探测；
 *   后两级命中时回写默认键，悬空引用绝不写回。
 * - 多模态轨道：默认键（按引用存在性保留，能力另行校验）→
 *   `model_assignments.vl_embedding_model_config_id`（写回）；键缺失时不做自动探测，
 *   以保留 `is_multimodal_rag_configured` 的显式启用语义。
 */
import type { ModelAssignments, ModelProfile } from '../api.ts';
import { rustTrim, compareUtf8 } from '../../../platform/util/portable.ts';

export const TEXT_EMBEDDING_DEFAULT_KEY = 'embedding.default_text_model_config_id';
export const MULTIMODAL_EMBEDDING_DEFAULT_KEY = 'embedding.default_multimodal_model_config_id';
export const MULTIMODAL_EMBEDDING_DEFAULT_DIMENSION_KEY = 'embedding.default_multimodal_dimension';
export const MODEL_ASSIGNMENTS_KEY = 'model_assignments';

export const NO_DEFAULT_EMBEDDING_DIMENSION_MESSAGE =
  '未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。';
export const MULTIMODAL_EMBEDDING_NOT_ENABLED_MESSAGE =
  '还没有启用多模态索引：请在「设置 → 模型 → 模型分配 → 嵌入维度管理」中新建一个多模态维度并绑定多模态嵌入模型（已有多个多模态维度时，把要用的那个设为默认）。';
export const MULTIMODAL_EMBEDDING_MISSING_MESSAGE =
  '找不到多模态嵌入模型配置，请检查维度绑定的模型是否存在';

export type EmbeddingDefaultsErrorKind = 'configuration' | 'database';

/** `AppError::configuration` 的本地投影；只保留调用方需要的分类与消息。 */
export class EmbeddingDefaultsError extends Error {
  readonly kind: EmbeddingDefaultsErrorKind;

  constructor(kind: EmbeddingDefaultsErrorKind, message: string) {
    super(message);
    this.name = 'EmbeddingDefaultsError';
    this.kind = kind;
  }
}

/**
 * 一条可参与默认解析的模型条目。
 *
 * `ModelProfile` 结构上满足该接口；`apiKey` 对应合并供应商后的运行期 Key，
 * 内置配置缺编译期 Key（`is_builtin && api_key.trim().is_empty()`）时视为不可用。
 */
export interface EmbeddingModelEntry {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly isEmbedding: boolean;
  readonly isMultimodal: boolean;
  readonly isReranker: boolean;
  readonly isBuiltin: boolean;
  readonly apiKey?: string;
}

/** 本模块依赖的窄设置 + 模型条目表面。 */
export interface EmbeddingDefaultsStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  listEnabledProfiles(): readonly EmbeddingModelEntry[];
  /** Text selection re-reads live configs during auto-detection (rag_extension.rs:271). */
  loadTextProfiles?(): Promise<readonly EmbeddingModelEntry[]>;
  loadTextAssignments?(): Promise<ModelAssignments>;
  /** 可选诊断日志（回写失败、跳过悬空分配等）。 */
  warn?(message: string): void;
  info?(message: string): void;
  debug?(message: string): void;
}

type EmbeddingAssignmentField = Extract<
  keyof ModelAssignments,
  'embedding_model_config_id' | 'vl_embedding_model_config_id'
>;

const TEXT_READ_FAILURE = '读取嵌入模型配置失败';
const MULTIMODAL_READ_FAILURE = '读取多模态嵌入模型配置失败';
const MULTIMODAL_ADOPT_READ_FAILURE = '读取多模态嵌入设置失败';

function configurationError(message: string): EmbeddingDefaultsError {
  return new EmbeddingDefaultsError('configuration', message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareModelNames(left: string, right: string): number {
  return compareUtf8(left, right);
}

let lastWarnedTextDefault: string | null = null;

/** `is_usable_text_embedding`（rag_extension.rs:141）。 */
export function isUsableTextEmbedding(entry: EmbeddingModelEntry): boolean {
  return (
    entry.enabled &&
    entry.isEmbedding &&
    !entry.isMultimodal &&
    !entry.isReranker &&
    !(entry.isBuiltin && rustTrim(entry.apiKey ?? '') === '')
  );
}

/** 多模态轨道的可用条件（rag_extension.rs:368/395/434）。 */
export function isUsableMultimodalEmbedding(entry: EmbeddingModelEntry): boolean {
  return entry.enabled && entry.isEmbedding && entry.isMultimodal && !entry.isReranker;
}

export class EmbeddingDefaults {
  private readonly store: EmbeddingDefaultsStore;

  constructor(store: EmbeddingDefaultsStore) {
    this.store = store;
  }

  /**
   * 获取默认文本嵌入配置（rag_extension.rs:169 `get_embedding_model_config`）。
   *
   * 默认键指向的配置不存在、已禁用或能力不匹配时落到 assignments / 自动探测回退链，
   * 而不是让索引整体停摆。
   */
  async getEmbeddingModelConfig(): Promise<EmbeddingModelEntry> {
    const configuredId = this.readSetting(TEXT_EMBEDDING_DEFAULT_KEY, TEXT_READ_FAILURE);
    const entries = await this.textProfiles();

    let resolvedId: string;
    if (configuredId !== null && entries.some(entry => entry.id === configuredId && isUsableTextEmbedding(entry))) {
      resolvedId = configuredId;
    } else {
      if (configuredId !== null) {
        if (lastWarnedTextDefault !== configuredId) {
          lastWarnedTextDefault = configuredId;
          this.warn(`[RAG] Unusable embedding default: setting 'embedding.default_text_model_config_id'='${configuredId}' is missing, disabled or keyless; falling back to model_assignments/auto-detect`);
        } else this.store.debug?.(`[RAG] Unusable embedding default '${configuredId}' (already warned)`);
      }
      resolvedId = await this.fallbackEmbeddingModelId(entries);
    }

    const config = entries.find((entry) => entry.id === resolvedId);
    if (config === undefined) {
      throw configurationError('找不到嵌入模型配置，请检查维度绑定的模型是否存在');
    }
    if (!config.enabled || !config.isEmbedding || config.isMultimodal || config.isReranker) {
      throw configurationError('默认文本嵌入配置已禁用或能力协议不匹配');
    }
    return config;
  }

  /**
   * 获取默认多模态嵌入配置（rag_extension.rs:330 `get_vl_embedding_model_config`）。
   *
   * 设置键缺失时必须保持报错：`is_multimodal_rag_configured` 依赖该 Err 关闭
   * 多模态索引批处理（显式启用语义），不做自动探测。
   */
  getVlEmbeddingModelConfig(): EmbeddingModelEntry {
    const settingId = this.readSetting(MULTIMODAL_EMBEDDING_DEFAULT_KEY, MULTIMODAL_READ_FAILURE);
    const entries = this.store.listEnabledProfiles();

    if (settingId === null) {
      let fallbackId: string;
      try {
        fallbackId = this.fallbackVlEmbeddingModelId(entries);
      } catch (error) {
        this.warn(`[RAG] ${messageOf(error)}`);
        throw configurationError(MULTIMODAL_EMBEDDING_NOT_ENABLED_MESSAGE);
      }
      const config = entries.find((entry) => entry.id === fallbackId);
      if (config === undefined) {
        throw configurationError('找不到多模态嵌入模型配置');
      }
      return this.ensureMultimodalConfig(config);
    }

    let resolvedId: string;
    if (entries.some((entry) => entry.id === settingId)) {
      resolvedId = settingId;
    } else {
      this.warn(
        `[RAG] Dangling multimodal embedding default: setting '${MULTIMODAL_EMBEDDING_DEFAULT_KEY}' points to nonexistent config '${settingId}'; falling back to model_assignments.vl_embedding_model_config_id`,
      );
      resolvedId = this.fallbackVlEmbeddingModelId(entries);
    }

    const config = entries.find((entry) => entry.id === resolvedId);
    if (config === undefined) {
      throw configurationError(MULTIMODAL_EMBEDDING_MISSING_MESSAGE);
    }
    return this.ensureMultimodalConfig(config);
  }

  /**
   * 还没有默认多模态维度时，把刚创建 / 绑定模型的多模态维度设为默认
   * （rag_extension.rs:381 `adopt_default_multimodal_embedding`）。
   *
   * 已有默认时不覆盖；模型配置不是可用的多模态嵌入模型时不写。返回是否写入默认。
   */
  adoptDefaultMultimodalEmbedding(dimension: number, modelConfigId: string): boolean {
    const current = this.readSetting(
      MULTIMODAL_EMBEDDING_DEFAULT_KEY,
      MULTIMODAL_ADOPT_READ_FAILURE,
    );
    if (current !== null && current.trim() !== '') return false;

    const entries = this.store.listEnabledProfiles();
    const usable = entries.some(
      (entry) => entry.id === modelConfigId && isUsableMultimodalEmbedding(entry),
    );
    if (!usable) return false;

    this.saveSetting(
      MULTIMODAL_EMBEDDING_DEFAULT_DIMENSION_KEY,
      String(dimension),
      '保存默认多模态维度失败',
    );
    this.saveSetting(
      MULTIMODAL_EMBEDDING_DEFAULT_KEY,
      modelConfigId,
      '保存默认多模态模型失败',
    );
    return true;
  }

  /**
   * 被动补救（索引前 / 查询状态时）：没有默认多模态维度、但恰好只有一个绑定了可用
   * 多模态嵌入模型的多模态维度时采用它。有多个时不替用户选（返回 false）。
   * `candidates`：所有已绑定模型的多模态维度 `(dimension, model_config_id)`。
   * rag_extension.rs:427 `heal_default_multimodal_embedding`。
   */
  healDefaultMultimodalEmbedding(
    candidates: readonly (readonly [dimension: number, modelConfigId: string])[],
  ): boolean {
    let entries: readonly EmbeddingModelEntry[];
    try {
      entries = this.store.listEnabledProfiles();
    } catch (error) {
      this.warn(`[RAG] 读取模型条目失败，跳过多模态默认维度补救: ${messageOf(error)}`);
      return false;
    }

    const usable = candidates.filter(([, modelConfigId]) =>
      entries.some(
        (entry) => entry.id === modelConfigId && isUsableMultimodalEmbedding(entry),
      ),
    );
    if (usable.length !== 1) return false;

    const [dimension, modelConfigId] = usable[0]!;
    try {
      return this.adoptDefaultMultimodalEmbedding(dimension, modelConfigId);
    } catch (error) {
      this.warn(`[RAG] 采用多模态默认维度失败: ${messageOf(error)}`);
      return false;
    }
  }

  /**
   * 默认嵌入模型回退链（rag_extension.rs:223 `fallback_embedding_model_id`）。
   *
   * assignments 命中时回写设置键；悬空或不可用的 assignments 跳过回写继续探测，
   * 避免把死引用写进默认键。
   */
  private async fallbackEmbeddingModelId(entries: readonly EmbeddingModelEntry[]): Promise<string> {
    let assignedId: string | null = null;
    try {
      assignedId = this.store.loadTextAssignments
        ? (await this.store.loadTextAssignments()).embedding_model_config_id
        : this.assignedModelId('embedding_model_config_id');
    } catch { // boundary-allow empty-catch: rag_extension.rs:225 ignores get_model_assignments failure.
    }
    if (assignedId !== null) {
      if (entries.some((entry) => entry.id === assignedId && isUsableTextEmbedding(entry))) {
        this.store.info?.(`[RAG] Falling back to model_assignments.embedding_model_config_id=${assignedId}`);
        this.writeBackText(assignedId);
        return assignedId;
      }
      this.warn(
        `[RAG] model_assignments.embedding_model_config_id=${assignedId} also missing from configs; skipping write-back`,
      );
    }

    this.store.debug?.('[RAG] No default embedding dimension set, attempting auto-detect...');
    const detectedId = await this.autoDetectEmbeddingModelId();
    if (detectedId !== null) return detectedId;
    throw configurationError(NO_DEFAULT_EMBEDDING_DIMENSION_MESSAGE);
  }

  /**
   * 自动探测文本嵌入模型（rag_extension.rs:260 `auto_detect_embedding_model_id`）。
   *
   * 多个可用配置时按稳定顺序（用户配置优先于内置，再按名称 / id）选一个并回写默认键，
   * 而不是拒绝——拒绝会让整个知识库静默停摆。
   */
  private async autoDetectEmbeddingModelId(): Promise<string | null> {
    try {
      const dimension = this.store.getSetting('embedding.default_text_dimension');
      if (dimension !== null) this.store.info?.(`[RAG] Default dimension ${dimension} set but model_config_id missing`);
    } catch { // boundary-allow empty-catch: rag_extension.rs:262 only handles Ok(Some(dimension)).
    }
    let entries: readonly EmbeddingModelEntry[];
    try { entries = await this.textProfiles(); }
    catch { return null; } // boundary-allow empty-catch: rag_extension.rs:271 auto-detect ignores config read errors.
    const usable = entries
      .filter(isUsableTextEmbedding)
      .sort(
        (left, right) =>
          Number(left.isBuiltin) - Number(right.isBuiltin) ||
          compareModelNames(left.label, right.label) ||
          compareModelNames(left.id, right.id),
      );
    const detected = usable[0];
    if (detected === undefined) return null;
    this.store.info?.(`[RAG] Auto-selected embedding model: id=${detected.id}, name=${detected.label} (${usable.length} usable)`);
    this.writeBackText(detected.id);
    return detected.id;
  }

  private textProfiles(): Promise<readonly EmbeddingModelEntry[]> | readonly EmbeddingModelEntry[] {
    return this.store.loadTextProfiles ? this.store.loadTextProfiles() : this.store.listEnabledProfiles();
  }

  private writeBackText(id: string): void {
    try { this.store.saveSetting(TEXT_EMBEDDING_DEFAULT_KEY, id); }
    catch { // boundary-allow empty-catch: rag_extension.rs:235/291 let _ = save_setting, without a warning.
    }
  }

  /**
   * 多模态嵌入默认回退（rag_extension.rs:457 `fallback_vl_embedding_model_id`）。
   *
   * 仅接受能力标记完整的 assignments 配置，避免把文本嵌入模型或死引用写回设置键。
   */
  private fallbackVlEmbeddingModelId(entries: readonly EmbeddingModelEntry[]): string {
    const assignedId = this.assignedModelId('vl_embedding_model_config_id');
    if (assignedId !== null) {
      const config = entries.find((entry) => entry.id === assignedId);
      if (config !== undefined && isUsableMultimodalEmbedding(config)) {
        this.writeBack(MULTIMODAL_EMBEDDING_DEFAULT_KEY, assignedId);
        return assignedId;
      }
      this.warn(
        `[RAG] model_assignments.vl_embedding_model_config_id=${assignedId} lacks multimodal embedding capability or is missing; skipping write-back`,
      );
    }
    throw configurationError(MULTIMODAL_EMBEDDING_MISSING_MESSAGE);
  }

  private ensureMultimodalConfig(config: EmbeddingModelEntry): EmbeddingModelEntry {
    if (!config.enabled || !config.isEmbedding || !config.isMultimodal || config.isReranker) {
      throw configurationError('默认多模态嵌入配置已禁用或能力协议不匹配');
    }
    return config;
  }

  /** `get_model_assignments` 的错误在回退链中被吞掉（`if let Ok(assignments)`）。 */
  private assignedModelId(field: EmbeddingAssignmentField): string | null {
    let raw: string | null;
    try {
      raw = this.store.getSetting(MODEL_ASSIGNMENTS_KEY);
    } catch (error) {
      this.warn(`[RAG] 读取模型分配失败，跳过 assignments 回退: ${messageOf(error)}`);
      return null;
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.warn(`[RAG] 解析模型分配失败，跳过 assignments 回退: ${messageOf(error)}`);
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn('[RAG] 模型分配格式无效，跳过 assignments 回退');
      return null;
    }
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  }

  private readSetting(key: string, failure: string): string | null {
    try {
      return this.store.getSetting(key);
    } catch (error) {
      throw configurationError(`${failure}: ${messageOf(error)}`);
    }
  }

  private saveSetting(key: string, value: string, failure: string): void {
    try {
      this.store.saveSetting(key, value);
    } catch (error) {
      throw configurationError(`${failure}: ${messageOf(error)}`);
    }
  }

  /** Rust 回退链的写回是 best-effort（`let _ = save_setting`）。 */
  private writeBack(key: string, value: string): void {
    try {
      this.store.saveSetting(key, value);
    } catch (error) {
      this.warn(`[RAG] 回写 ${key}=${value} 失败: ${messageOf(error)}`);
    }
  }

  private warn(message: string): void {
    this.store.warn?.(message);
  }
}

/** 便捷类型守卫：调用方从 `ModelProfile[]` 投影运行期条目时可直接展开。 */
export function embeddingEntryFromProfile(
  profile: ModelProfile,
  apiKey = '',
): EmbeddingModelEntry {
  return {
    id: profile.id,
    label: profile.label,
    enabled: profile.enabled && profile.status.toLowerCase() !== 'disabled',
    isEmbedding: profile.isEmbedding,
    isMultimodal: profile.isMultimodal,
    isReranker: profile.isReranker,
    isBuiltin: profile.isBuiltin,
    apiKey,
  };
}
