/**
 * vfs/handlers.rs embedding dimension, indexing config and index-state commands.
 *
 * Rust: handlers.rs:3260-4270（状态/维度/配置/批量索引/就绪性）与 5860-6030（重置）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { ApiConfig, LlmEmbeddingModels } from '../../llm/api.ts';
import type {
  EmbeddingIndexState,
  EmbeddingModelConfig,
  VfsEmbeddingDim,
  VfsEmbeddingDimension,
  VfsReposService,
} from '../../vfs-repos/api.ts';
import type {
  DeleteDimensionResult,
  EmbeddingReadiness,
  VfsEmbeddingStats,
  dstu_vfs__vfs__handlers__BatchIndexResult as BatchIndexResult,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { VfsIndexService, VfsIndexingApi, VfsSearchApi, VfsLanceStore } from '../../vfs-index/api.ts';
import { VECTOR_UNAVAILABLE } from './index-admin.ts';
import { requireMaintenance, type VfsMaintenanceService } from './maintenance-needs.ts';

/** LLM surface used by the commands; optional members are detected at runtime. */
export interface EmbeddingLlm {
  getApiConfigs(): Promise<ApiConfig[]>;
}

export interface EmbeddingDeps {
  readonly maintenance?: VfsMaintenanceService;
  readonly vectorAvailable: boolean;
  readonly conn: () => DatabaseHandle;
  readonly repos: VfsReposService;
  readonly indexing: VfsIndexingApi;
  readonly search: VfsSearchApi;
  readonly lance: VfsLanceStore;
  readonly settings: SettingsStore;
  readonly llm?: EmbeddingLlm;
  readonly embeddingModels?: LlmEmbeddingModels;
  readonly emit: (event: string, payload: Record<string, unknown>) => void;
  readonly log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

function messageOf(error: unknown): string {
  const value = error instanceof CommandError ? error.value : error;
  if (value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return error instanceof Error ? error.message : String(error);
}

// Rust embedding_dim_repo constants (api.ts does not re-export them yet).
const PRESET_DIMENSIONS = [256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096] as const;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 8192;

const DEFAULT_TEXT_DIMENSION = 'embedding.default_text_dimension';
const DEFAULT_TEXT_MODEL = 'embedding.default_text_model_config_id';
const DEFAULT_MM_DIMENSION = 'embedding.default_multimodal_dimension';
const DEFAULT_MM_MODEL = 'embedding.default_multimodal_model_config_id';

const INDEX_STATE_PENDING = 'pending';
const INDEX_STATE_DISABLED = 'disabled';

function requireLlm(deps: EmbeddingDeps): EmbeddingLlm {
  if (deps.llm === undefined) throw new Error('LLM 服务不可用');
  return deps.llm;
}

/**
 * handlers.rs:3415-3418,3512-3515 `get_api_configs().await.map_err(|error| error.to_string())`.
 * The LLM owner rejects with an AppError value; Rust `AppError` Display is its
 * `message` (dstu-core models.rs:1038-1041), so the command error is that string.
 */
async function apiConfigs(deps: EmbeddingDeps): Promise<ApiConfig[]> {
  try {
    return await requireLlm(deps).getApiConfigs();
  } catch (error) {
    const value = error instanceof CommandError ? error.value : undefined;
    if (value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
      throw new CommandError(value.message);
    }
    throw error;
  }
}

/** handlers.rs:3354-3393 `validate_embedding_model_config`. */
export function validateEmbeddingModelConfig(
  configs: readonly ApiConfig[],
  modelConfigId: string,
  modality: string,
): ApiConfig {
  const config = configs.find(candidate => candidate.id === modelConfigId);
  if (config === undefined) throw new Error(`模型配置 ${modelConfigId} 不存在`);
  const protocolMatches = modality === 'text'
    ? !config.isMultimodal
    : modality === 'multimodal'
      ? config.isMultimodal
      : undefined;
  if (protocolMatches === undefined) throw new Error(`无效的嵌入模态: ${modality}`);
  if (!config.enabled || !config.isEmbedding || config.isReranker || !protocolMatches
    || rustTrim(config.model) === '') {
    throw new Error(`模型配置 ${modelConfigId} 已禁用或不支持 ${modality} 嵌入协议`);
  }
  return config;
}

function fingerprintFor(
  repos: VfsReposService,
  config: ApiConfig,
  modality: string,
): string {
  const model: EmbeddingModelConfig = {
    id: config.id,
    model: config.model,
    baseUrl: config.baseUrl,
    providerType: config.providerType ?? null,
    providerScope: config.providerScope ?? null,
    apiProtocol: config.apiProtocol ?? null,
    modelAdapter: config.modelAdapter,
  };
  return repos.embeddingDims.modelFingerprintForConfig(model, modality);
}

function dimensionKeys(modality: string): [string, string] | null {
  if (modality === 'text') return [DEFAULT_TEXT_DIMENSION, DEFAULT_TEXT_MODEL];
  if (modality === 'multimodal') return [DEFAULT_MM_DIMENSION, DEFAULT_MM_MODEL];
  return null;
}

/** Rust `adopt_default_multimodal_embedding`（rag_extension.rs:381-422）。 */
async function adoptDefaultMultimodal(
  deps: EmbeddingDeps,
  dimension: number,
  modelConfigId: string,
): Promise<boolean> {
  if (deps.embeddingModels === undefined) throw new Error('LLM 服务不可用');
  return deps.embeddingModels.adoptDefaultMultimodalEmbedding(dimension, modelConfigId);
}

/** handlers.rs:4199-4220 `vfs_get_embedding_readiness`. */
async function resolveEmbeddingModelConfig(deps: EmbeddingDeps): Promise<ApiConfig> {
  if (deps.embeddingModels === undefined) throw new Error('LLM 服务不可用');
  return deps.embeddingModels.getEmbeddingModelConfig();
}

export async function getEmbeddingReadiness(deps: EmbeddingDeps): Promise<EmbeddingReadiness> {
  try {
    const config = await resolveEmbeddingModelConfig(deps);
    return {
      ready: true,
      modelConfigId: config.id,
      modelName: rustTrim(config.name) === '' ? config.model : config.name,
      reason: null,
      vectorIndexAvailable: deps.vectorAvailable,
    };
  } catch (error) {
    return {
      ready: false,
      modelConfigId: null,
      modelName: null,
      reason: messageOf(error),
      vectorIndexAvailable: deps.vectorAvailable,
    };
  }
}

export function getIndexStatus(deps: EmbeddingDeps, resourceId: string): EmbeddingIndexState | null {
  try {
    return deps.repos.indexStates.getIndexState(deps.conn(), resourceId);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:3283-3317 */
export function toggleIndexDisabled(deps: EmbeddingDeps, resourceId: string): string {
  deps.log.info('[VFS::handlers] vfs_toggle_index_disabled: id=%s', resourceId);
  try {
    const current = deps.repos.indexStates.getIndexState(deps.conn(), resourceId)?.state ?? INDEX_STATE_PENDING;
    if (current === INDEX_STATE_DISABLED) {
      deps.repos.indexStates.markPending(deps.conn(), resourceId);
      deps.log.info('[VFS::handlers] vfs_toggle_index_disabled: %s -> %s', current, INDEX_STATE_PENDING);
      return INDEX_STATE_PENDING;
    }
    deps.repos.indexStates.markDisabled(deps.conn(), resourceId);
    deps.log.info('[VFS::handlers] vfs_toggle_index_disabled: %s -> %s', current, INDEX_STATE_DISABLED);
    return INDEX_STATE_DISABLED;
  } catch (error) {
    return fail(error);
  }
}

export function getEmbeddingStats(deps: EmbeddingDeps): VfsEmbeddingStats {
  try {
    return deps.search.getEmbeddingStats();
  } catch (error) {
    return fail(error);
  }
}

export function listDimensions(deps: EmbeddingDeps): VfsEmbeddingDimension[] {
  try {
    return deps.repos.embeddingDims.listAll(deps.conn()).map(dimension => ({
      dimension: dimension.dimension,
      modality: dimension.modality,
      recordCount: dimension.recordCount,
      lanceTableName: dimension.lanceTableName,
      createdAt: dimension.createdAt,
      lastUsedAt: dimension.lastUsedAt,
      modelConfigId: dimension.modelConfigId,
      modelName: dimension.modelName,
    }));
  } catch (error) {
    return fail(error);
  }
}

export function getPendingResources(deps: EmbeddingDeps): string[] {
  try {
    return deps.indexing.getPendingResources();
  } catch (error) {
    return fail(error);
  }
}

export async function assignDimensionModel(
  deps: EmbeddingDeps,
  dimension: number,
  modality: string,
  modelConfigId: string,
  modelName: string,
): Promise<boolean> {
  deps.log.info('[VFS::handlers] vfs_assign_dimension_model: dim=%d, modality=%s, model=%s', dimension, modality, modelConfigId);
  try {
    const configs = await apiConfigs(deps);
    const config = validateEmbeddingModelConfig(configs, modelConfigId, modality);
    if (modelName !== config.model) {
      deps.log.warn('[VFS::handlers] Ignoring client model name %s; authoritative model is %s', modelName, config.model);
    }
    const fingerprint = fingerprintFor(deps.repos, config, modality);
    const conn = deps.conn();
    if (deps.repos.embeddingDims.getByKey(conn, dimension, modality) === null) {
      throw new Error(`维度 ${dimension}:${modality} 不存在`);
    }
    deps.repos.embeddingDims.registerWithModelFingerprint(
      conn, dimension, modality, modelConfigId, config.model, fingerprint,
    );

    const keys = dimensionKeys(modality);
    if (keys === null) return true;
    const [dimensionKey, modelKey] = keys;
    const currentDefault = deps.settings.get(dimensionKey);
    if (currentDefault !== null && Number(currentDefault) === dimension) {
      deps.settings.save(modelKey, modelConfigId);
      deps.log.info('[VFS::handlers] 已同步更新默认 %s 嵌入模型: %s', modality, modelConfigId);
    }
    if (modality === 'multimodal') {
      try {
        await adoptDefaultMultimodal(deps, dimension, modelConfigId);
      } catch (error) {
        deps.log.warn('[VFS::handlers] adopt multimodal default failed: %s', messageOf(error));
      }
    }
    return true;
  } catch (error) {
    return fail(error);
  }
}

export async function createDimension(
  deps: EmbeddingDeps,
  dimension: number,
  modality: string,
  modelConfigId: string | null,
  modelName: string | null,
): Promise<VfsEmbeddingDim> {
  deps.log.info('[VFS::handlers] vfs_create_dimension: dim=%d, modality=%s, model=%s', dimension, modality, modelConfigId);
  try {
    let resolved: { config: ApiConfig; fingerprint: string } | null = null;
    if (modelConfigId !== null) {
      const configs = await apiConfigs(deps);
      const config = validateEmbeddingModelConfig(configs, modelConfigId, modality);
      if (modelName !== null && modelName !== config.model) {
        deps.log.warn('[VFS::handlers] Ignoring client model name for %s; authoritative model is %s',
          modelConfigId, config.model);
      }
      resolved = { config, fingerprint: fingerprintFor(deps.repos, config, modality) };
    } else if (modelName !== null) {
      throw new Error('modelName 不能在 modelConfigId 缺失时单独使用');
    }

    const conn = deps.conn();
    const created = resolved === null
      ? deps.repos.embeddingDims.createDimension(conn, dimension, modality, null, null)
      : deps.repos.embeddingDims.registerWithModelFingerprint(
        conn, dimension, modality, resolved.config.id, resolved.config.model, resolved.fingerprint,
      );
    if (modality === 'multimodal' && resolved !== null) {
      try {
        await adoptDefaultMultimodal(deps, dimension, resolved.config.id);
      } catch (error) {
        deps.log.warn('[VFS::handlers] adopt multimodal default failed: %s', messageOf(error));
      }
    }
    return created;
  } catch (error) {
    return fail(error);
  }
}

export async function deleteDimension(
  deps: EmbeddingDeps,
  dimension: number,
  modality: string,
): Promise<DeleteDimensionResult> {
  deps.log.info('[VFS::handlers] vfs_delete_dimension: dim=%d, modality=%s', dimension, modality);
  try {
    const conn = deps.conn();
    if (deps.repos.embeddingDims.hasIndexingUnitsForDimension(conn, dimension, modality)) {
      throw new Error(`维度 ${dimension}:${modality} 有正在进行的索引任务，请等待索引完成后再删除`);
    }

    const keys = dimensionKeys(modality);
    if (keys !== null) {
      const [dimensionKey, modelKey] = keys;
      const currentDefault = deps.settings.get(dimensionKey);
      if (currentDefault !== null && Number(currentDefault) === dimension) {
        deps.settings.delete(dimensionKey);
        deps.settings.delete(modelKey);
        deps.log.info('[VFS::handlers] 已清除默认 %s 嵌入维度设置（因维度被删除）', modality);
      }
    }

    const lanceTableName = deps.repos.embeddingDims.getByKey(conn, dimension, modality)
      ?.lanceTableName
      ?? deps.repos.embeddingDims.generateLanceTableName(modality, dimension);
    const deletedSegments = deps.repos.embeddingDims.deleteDimensionCascade(conn, dimension, modality);

    try {
      await deps.lance.dropTable(lanceTableName);
    } catch (error) {
      deps.log.warn('[VFS::handlers] LanceDB table %s cleanup failed (non-fatal): %s',
        lanceTableName, messageOf(error));
    }
    return { deletedSegments, dimension, modality };
  } catch (error) {
    return fail(error);
  }
}

export function getPresetDimensions(): number[] {
  return [...PRESET_DIMENSIONS];
}

export function getDimensionRange(): [number, number] {
  return [MIN_DIMENSION, MAX_DIMENSION];
}

export function setDefaultEmbeddingDimension(
  deps: EmbeddingDeps,
  dimension: number,
  modality: string,
): boolean {
  deps.log.info('[VFS::handlers] vfs_set_default_embedding_dimension: dim=%d, modality=%s', dimension, modality);
  try {
    const info = deps.repos.embeddingDims.getByKey(deps.conn(), dimension, modality);
    if (info === null) throw new Error(`维度 ${dimension}:${modality} 不存在`);
    if (info.modelConfigId === null) deps.log.warn('[VFS::handlers] Dimension %d:%s has no model binding, allowing set_default but clearing model config', dimension, modality);
    const keys = dimensionKeys(modality);
    if (keys === null) throw new Error(`无效的模态类型: ${modality}`);
    const [dimensionKey, modelKey] = keys;
    deps.settings.save(dimensionKey, String(dimension));
    if (info.modelConfigId !== null) {
      deps.settings.save(modelKey, info.modelConfigId);
      deps.log.info('[VFS::handlers] 已设置默认 %s 嵌入模型: %s', modality, info.modelConfigId);
    } else {
      deps.settings.delete(modelKey);
      deps.log.warn('[VFS::handlers] 维度 %d:%s 未绑定模型，已清除默认模型配置', dimension, modality);
    }
    return true;
  } catch (error) {
    return fail(error);
  }
}

export function getDefaultEmbeddingDimension(
  deps: EmbeddingDeps,
  modality: string,
): VfsEmbeddingDim | null {
  try {
    const keys = dimensionKeys(modality);
    if (keys === null) throw new Error(`无效的模态类型: ${modality}`);
    const [dimensionKey, modelKey] = keys;
    const stored = deps.settings.get(dimensionKey);
    if (stored === null) return null;
    if (!/^-?\d+$/.test(stored)) throw new Error(`无效的维度值: ${stored}`);
    const dimension = Number(stored);
    const info = deps.repos.embeddingDims.getByKey(deps.conn(), dimension, modality);
    if (info === null) {
      deps.log.warn('[VFS::handlers] Default dimension %d:%s no longer exists in VFS DB, auto-clearing setting', dimension, modality);
      deps.settings.delete(dimensionKey);
      deps.settings.delete(modelKey);
    }
    return info;
  } catch (error) {
    return fail(error);
  }
}

export function clearDefaultEmbeddingDimension(deps: EmbeddingDeps, modality: string): boolean {
  deps.log.info('[VFS::handlers] vfs_clear_default_embedding_dimension: modality=%s', modality);
  try {
    const keys = dimensionKeys(modality);
    if (keys === null) throw new Error(`无效的模态类型: ${modality}`);
    deps.settings.delete(keys[0]);
    deps.settings.delete(keys[1]);
    return true;
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:3860-4042 */
export async function batchIndexPending(
  deps: EmbeddingDeps,
  batchSize: number | null,
): Promise<BatchIndexResult> {
  try {
    if (!deps.vectorAvailable) throw new Error(VECTOR_UNAVAILABLE);
    const size = batchSize ?? 10;
    deps.log.info('[VFS::handlers] vfs_batch_index_pending: batch_size=%d', size);
    deps.log.info('[VFS::handlers] vfs_batch_index_pending: 获取索引配置...');
    const config = deps.indexing.getIndexingConfig();
    deps.log.info('[VFS::handlers] vfs_batch_index_pending: 原子抢占待处理资源...');
    const pending = deps.repos.indexStates.claimPendingResources(deps.conn(), size, config.maxRetries);
    deps.log.info('[VFS::handlers] vfs_batch_index_pending: 原子抢占 %d 个待处理资源', pending.length);
    if (pending.length === 0) return { successCount: 0, failCount: 0, total: 0 };

    const total = pending.length;
    deps.emit('vfs-index-progress', {
      type: 'batch_started', total, message: `开始批量索引 ${total} 个资源...`,
    });
    let successCount = 0;
    let failCount = 0;
    for (const [index, resourceId] of pending.entries()) {
      deps.emit('vfs-index-progress', {
        type: 'resource_started',
        resourceId,
        current: index + 1,
        total,
        progress: Math.trunc((index / total) * 100),
        message: `正在索引资源 ${index + 1}/${total}`,
      });
      try {
        const [chunkCount] = await deps.indexing.indexResource(resourceId, null, (chunksDone, chunksTotal) => {
          const base = index / total;
          const sub = chunksTotal > 0 ? chunksDone / chunksTotal / total : 0;
          deps.emit('vfs-index-progress', {
            type: 'embedding_progress',
            resourceId,
            current: index + 1,
            total,
            chunksProcessed: chunksDone,
            chunksTotal,
            progress: Math.min(Math.trunc((base + sub) * 100), 99),
            message: `正在索引资源 ${index + 1}/${total} (嵌入 ${chunksDone}/${chunksTotal})`,
          });
        });
        successCount += 1;
        deps.emit('vfs-index-progress', {
          type: 'resource_completed',
          resourceId,
          chunkCount,
          current: index + 1,
          total,
          progress: Math.trunc(((index + 1) / total) * 100),
          message: `资源索引完成: ${chunkCount} 个块`,
        });
      } catch (error) {
        failCount += 1;
        deps.log.warn('[VFS::handlers] Failed to index %s: %s', resourceId, messageOf(error));
        deps.emit('vfs-index-progress', {
          type: 'resource_failed',
          resourceId,
          error: messageOf(error),
          current: index + 1,
          total,
          progress: Math.trunc(((index + 1) / total) * 100),
          message: `索引失败 (${index + 1}/${total}): ${messageOf(error)}`,
        });
      }
    }
    deps.emit('vfs-index-progress', {
      type: 'batch_completed',
      successCount,
      failCount,
      total,
      progress: 100,
      message: `批量索引完成: ${successCount} 成功, ${failCount} 失败`,
    });
    return { successCount, failCount, total };
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:3154-3260 */
export async function reindexResource(deps: EmbeddingDeps, resourceId: string, embeddingDim: number | null = null): Promise<number> {
  deps.log.info('[VFS::handlers] vfs_reindex_resource: id=%s', resourceId);
  try {
    if (!deps.vectorAvailable) throw new Error(VECTOR_UNAVAILABLE);
    if (!resourceId.startsWith('res_')) throw new Error(`Invalid resource ID format: ${resourceId}`);
    const current = deps.repos.indexStates.getIndexState(deps.conn(), resourceId);
    if (current?.state === 'indexing') {
      deps.log.warn('[VFS::handlers] vfs_reindex_resource: resource %s is already indexing, skipping', resourceId);
      throw new Error('资源正在索引中，请等待完成后再试');
    }
    if (embeddingDim !== null) deps.log.warn('[VFS::handlers] vfs_reindex_resource: embedding_dim ignored (full indexing uses model config)');

    deps.emit('vfs-index-progress', {
      type: 'started', resourceId, message: '开始索引资源...',
    });
    try {
      const [chunkCount] = await deps.indexing.reindexResource(resourceId, null, (chunksDone, chunksTotal) => {
        const progress = chunksTotal > 0 ? Math.min(Math.trunc((chunksDone / chunksTotal) * 100), 99) : 0;
        deps.emit('vfs-index-progress', {
          type: 'embedding_progress',
          resourceId,
          chunksProcessed: chunksDone,
          chunksTotal,
          progress,
          message: `正在生成嵌入 ${chunksDone}/${chunksTotal}`,
        });
      });
      deps.emit('vfs-index-progress', {
        type: 'completed', resourceId, chunkCount, message: `索引完成，共 ${chunkCount} 个块`,
      });
      return chunkCount;
    } catch (error) {
      deps.emit('vfs-index-progress', {
        type: 'failed', resourceId, error: messageOf(error),
        message: `索引失败: ${messageOf(error)}`,
      });
      throw error;
    }
  } catch (error) {
    return fail(error);
  }
}

export function getIndexingConfig(deps: EmbeddingDeps, key: string): string | null {
  try {
    return deps.repos.indexingConfig.getConfig(deps.conn(), key);
  } catch (error) {
    return fail(error);
  }
}

export function setIndexingConfig(deps: EmbeddingDeps, key: string, value: string): null {
  deps.log.info('[VFS::handlers] vfs_set_indexing_config: %s=%s', key, value);
  try {
    deps.repos.indexingConfig.setConfig(deps.conn(), key, value);
    return null;
  } catch (error) {
    return fail(error);
  }
}

export function resetDisabledToPending(deps: EmbeddingDeps): number {
  deps.log.info('[VFS::handlers] vfs_reset_disabled_to_pending');
  try {
    const updated = requireMaintenance(deps.maintenance).resetDisabledToPending();
    deps.log.info('[VFS::handlers] Reset %d disabled resources to pending', updated);
    return updated;
  } catch (error) {
    return fail(error);
  }
}

export function resetIndexedWithoutEmbeddings(deps: EmbeddingDeps): number {
  deps.log.info('[VFS::handlers] vfs_reset_indexed_without_segments');
  try {
    const updated = requireMaintenance(deps.maintenance).resetIndexedWithoutEmbeddings();
    deps.log.info('[VFS::handlers] Reset %d indexed-without-segments resources to pending', updated);
    return updated;
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:5923-6020 */
export async function resetAllIndexState(deps: EmbeddingDeps): Promise<number> {
  deps.log.info('[VFS::handlers] vfs_reset_all_index_state - 重置所有索引状态');
  try {
    const maintenance = requireMaintenance(deps.maintenance);
    const textCleared = await deps.lance.clearAll('text');
    deps.log.info('[VFS::handlers] 清除 %d 个文本向量表', textCleared);
    const mmCleared = await deps.lance.clearAll('multimodal');
    deps.log.info('[VFS::handlers] 清除 %d 个多模态向量表', mmCleared);
    const counts = maintenance.resetAllIndexStateRows();
    deps.log.info('[VFS::handlers] 重置 %d 个资源为 pending 状态（files=%d, exam_sheets=%d）',
      counts.updatedResources, counts.updatedFiles, counts.updatedExams);
    return counts.updatedResources;
  } catch (error) {
    return fail(error);
  }
}
