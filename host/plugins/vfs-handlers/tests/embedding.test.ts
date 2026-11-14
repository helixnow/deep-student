import { afterEach, describe, expect, it, vi } from 'vitest';
import llmPlugin from '../../llm/index.ts';
import llmProvidersPlugin from '../../llm-providers/index.ts';
import { defaultBudgetConfig, InjectionBudgetManager, newInjectionItem } from '../../../platform/storage/injection-budget.ts';
import { createVfsHost, type VfsHost } from './harness.ts';
import { validateEmbeddingModelConfig, batchIndexPending, reindexResource, type EmbeddingDeps } from '../src/embedding.ts';
import { VECTOR_UNAVAILABLE } from '../src/index-admin.ts';

let hosts: VfsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map(host => host.dispose()));
  hosts = [];
});

// Real LLM plugin dependencies: L01 publishes llmAdapters/llmCodexAuth; F3 storage
// publishes this exact injectionBudget object (platform/storage/index.ts:94-99).
const llmHost = (other: Record<string, unknown> = {}) => ({
  provide: { ...other, secrets: { isEncryptedFormat: () => false }, nativeImage: {}, nativeTokenizer: {},
    injectionBudget: { defaultConfig: defaultBudgetConfig, newItem: newInjectionItem,
      createManager: (config: ConstructorParameters<typeof InjectionBudgetManager>[0]) => new InjectionBudgetManager(config) } },
  plugins: [llmProvidersPlugin, llmPlugin],
});

async function open(provide?: Record<string, unknown>): Promise<VfsHost> {
  const { llm, ...other } = provide ?? {};
  const vfs = await createVfsHost(llm === undefined ? { provide: other } : llmHost(other));
  if (llm !== undefined) vi.spyOn(vfs.host.ctx.llm, 'getApiConfigs').mockImplementation((llm as ReturnType<typeof llmWith>).getApiConfigs);
  hosts.push(vfs);
  return vfs;
}

const invoke = <T = unknown>(vfs: VfsHost, name: string, args: Record<string, unknown> = {}) =>
  vfs.host.invoke(name, args) as Promise<T>;
const repos = (vfs: VfsHost) => vfs.host.ctx.vfsRepo;
const db = (vfs: VfsHost) => vfs.storage.database('vfs');
function vectorDeps(vfs: VfsHost): EmbeddingDeps {
  const index = vfs.host.ctx.vfsIndex;
  return { vectorAvailable: true, conn: () => db(vfs), repos: repos(vfs), indexing: index.indexing,
    search: index.search, lance: index.lance, settings: vfs.host.ctx.settings, log: vfs.host.ctx.logger,
    emit: (name, payload) => vfs.host.ctx.backendEvents.emit(name, payload) };
}

interface ConfigOverrides {
  id?: string; name?: string; model?: string; isMultimodal?: boolean; isEmbedding?: boolean;
  isReranker?: boolean; enabled?: boolean; isBuiltin?: boolean; apiKey?: string;
}

function apiConfig(overrides: ConfigOverrides = {}) {
  return {
    id: 'cfg_text', name: 'Embedding Model', model: 'embed-v1', baseUrl: 'https://example.invalid',
    vendorId: null, vendorName: null, providerType: 'openai', providerScope: null,
    authMode: null, apiProtocol: 'openai', supportsOpenaiResponses: null,
    apiKey: 'sk-test', isMultimodal: false, isReasoning: false, isEmbedding: true,
    isReranker: false, isImageGeneration: false, enabled: true, modelAdapter: 'openai',
    maxOutputTokens: 1024, temperature: 0, supportsTools: false, geminiApiVersion: '',
    isBuiltin: false, isReadOnly: false, reasoningEffort: null, reasoningMode: null,
    thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null, isFavorite: false,
    maxTokensLimit: null, contextWindow: null, extraBody: null, resolvedAdapterId: null,
    ...overrides,
  };
}

function llmWith(configs: ReturnType<typeof apiConfig>[], embeddingModelConfigId: string | null = null) {
  return {
    async getApiConfigs() { return configs; },
    async getModelAssignments() { return { embedding_model_config_id: embeddingModelConfigId }; },
  };
}

async function newResource(vfs: VfsHost, body: string): Promise<string> {
  const created = repos(vfs).resources.createOrReuse(
    db(vfs), 'note', body, `note_${body}`, 'notes', null,
  );
  return created.resourceId;
}

describe('vfs/handlers.rs embedding dimension commands', { timeout: 120_000 }, () => {
  it('embedding_model_validation_enforces_backend_protocol_contract', () => {
    const configs = [apiConfig({ id: 'text-embedding' }), apiConfig({ id: 'mm-embedding', model: 'vl-embed-v1', isMultimodal: true }),
      apiConfig({ id: 'reranker', model: 'rerank-v1', isReranker: true })];
    expect(() => validateEmbeddingModelConfig(configs, 'text-embedding', 'text')).not.toThrow();
    expect(() => validateEmbeddingModelConfig(configs, 'mm-embedding', 'multimodal')).not.toThrow();
    expect(() => validateEmbeddingModelConfig(configs, 'mm-embedding', 'text')).toThrow();
    expect(() => validateEmbeddingModelConfig(configs, 'text-embedding', 'multimodal')).toThrow();
    expect(() => validateEmbeddingModelConfig(configs, 'reranker', 'text')).toThrow();
    expect(() => validateEmbeddingModelConfig(configs, 'missing', 'text')).toThrow();
  });
  it('creates, lists and removes dimensions without a model binding', async () => {
    const vfs = await open();
    const created = await invoke<Record<string, unknown>>(vfs, 'vfs_create_dimension', {
      dimension: 1024, modality: 'text',
    });
    expect(created).toMatchObject({
      dimension: 1024, modality: 'text', recordCount: 0, modelConfigId: null, modelName: null,
    });
    expect(typeof created.lanceTableName).toBe('string');
    expect(typeof created.embeddingProtocol).toBe('string');
    expect(String(created.embeddingProtocol)).not.toBe('');

    const listed = await invoke<Array<Record<string, unknown>>>(vfs, 'vfs_list_dimensions');
    expect(listed).toEqual([
      expect.objectContaining({ dimension: 1024, modality: 'text', recordCount: 0 }),
    ]);
    expect(listed[0]).not.toHaveProperty('activeProfileId');

    expect(await invoke(vfs, 'vfs_get_preset_dimensions'))
      .toEqual([256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]);
    expect(await invoke(vfs, 'vfs_get_dimension_range')).toEqual([64, 8192]);

    const removed = await invoke<{ deletedSegments: number; dimension: number; modality: string }>(
      vfs, 'vfs_delete_dimension', { dimension: 1024, modality: 'text' },
    );
    expect(removed).toEqual({ deletedSegments: 0, dimension: 1024, modality: 'text' });
    expect(await invoke(vfs, 'vfs_list_dimensions')).toEqual([]);
  });

  it('validates model bindings and refuses a lone modelName', async () => {
    const vfs = await open({ llm: llmWith([apiConfig()]) });
    const created = await invoke<Record<string, unknown>>(vfs, 'vfs_create_dimension', {
      dimension: 768, modality: 'text', modelConfigId: 'cfg_text', modelName: 'ignored-name',
    });
    // Rust 忽略客户端 modelName，使用配置中的权威模型名。
    expect(created).toMatchObject({
      dimension: 768, modality: 'text', modelConfigId: 'cfg_text', modelName: 'embed-v1',
    });
    expect(created.modelFingerprint).toEqual(expect.any(String));

    await expect(invoke(vfs, 'vfs_create_dimension', {
      dimension: 512, modality: 'text', modelName: 'embed-v1',
    })).rejects.toBe('modelName 不能在 modelConfigId 缺失时单独使用');
    await expect(invoke(vfs, 'vfs_create_dimension', {
      dimension: 512, modality: 'text', modelConfigId: 'cfg_missing',
    })).rejects.toBe('模型配置 cfg_missing 不存在');
    await expect(invoke(vfs, 'vfs_create_dimension', {
      dimension: 512, modality: 'multimodal', modelConfigId: 'cfg_text',
    })).rejects.toBe('模型配置 cfg_text 已禁用或不支持 multimodal 嵌入协议');
    await expect(invoke(vfs, 'vfs_create_dimension', {
      dimension: 512, modality: 'video', modelConfigId: 'cfg_text',
    })).rejects.toBe('无效的嵌入模态: video');
  });

  it('assigns dimension models and keeps the default model setting in sync', async () => {
    const configs = [
      apiConfig({ id: 'cfg_a', name: 'A', model: 'embed-a' }),
      apiConfig({ id: 'cfg_b', name: 'B', model: 'embed-b' }),
    ];
    const vfs = await open({ llm: llmWith(configs) });
    const settings = vfs.host.ctx.settings;
    await invoke(vfs, 'vfs_create_dimension', {
      dimension: 768, modality: 'text', modelConfigId: 'cfg_a',
    });
    await invoke(vfs, 'vfs_set_default_embedding_dimension', { dimension: 768, modality: 'text' });
    expect(settings.get('embedding.default_text_model_config_id')).toBe('cfg_a');

    expect(await invoke(vfs, 'vfs_assign_dimension_model', {
      dimension: 768, modality: 'text', modelConfigId: 'cfg_b', modelName: 'client-name',
    })).toBe(true);
    expect(settings.get('embedding.default_text_model_config_id')).toBe('cfg_b');
    const defaultDimension = await invoke<Record<string, unknown>>(
      vfs, 'vfs_get_default_embedding_dimension', { modality: 'text' },
    );
    expect(defaultDimension).toMatchObject({ dimension: 768, modelConfigId: 'cfg_b', modelName: 'embed-b' });

    await expect(invoke(vfs, 'vfs_assign_dimension_model', {
      dimension: 999, modality: 'text', modelConfigId: 'cfg_b', modelName: 'embed-b',
    })).rejects.toBe('维度 999:text 不存在');
    await expect(invoke(vfs, 'vfs_assign_dimension_model', {
      dimension: 768, modality: 'text', modelConfigId: 'cfg_missing', modelName: 'x',
    })).rejects.toBe('模型配置 cfg_missing 不存在');
  });

  it('X1: maps the real LLM AppError from get_api_configs to its Display string before any dimension work', async () => {
    const vfs = await createVfsHost(llmHost());
    hosts.push(vfs);
    vfs.storage.database('mistakes').exec('DROP TABLE settings');
    const expected = '检测供应商配置失败: no such table: settings';
    // Owner shape stays AppError; handlers.rs map_err(|error| error.to_string()) yields AppError.message.
    await expect(vfs.host.ctx.llm.getApiConfigs()).rejects.toMatchObject({
      value: { error_type: 'Database', message: expected, details: null },
    });
    await expect(invoke(vfs, 'vfs_assign_dimension_model', {
      dimension: 0, modality: '', modelConfigId: '', modelName: '',
    })).rejects.toBe(expected);
    await expect(invoke(vfs, 'vfs_create_dimension', {
      dimension: 768, modality: 'text', modelConfigId: 'cfg', modelName: null,
    })).rejects.toBe(expected);
    expect(repos(vfs).embeddingDims.listAll(db(vfs))).toEqual([]);
  });

  it('set/get/clear default dimension and auto-clears dangling settings', async () => {
    const vfs = await open({ llm: llmWith([apiConfig()]) });
    const settings = vfs.host.ctx.settings;
    await invoke(vfs, 'vfs_create_dimension', { dimension: 512, modality: 'text' });

    await expect(invoke(vfs, 'vfs_set_default_embedding_dimension', { dimension: 1, modality: 'text' }))
      .rejects.toBe('维度 1:text 不存在');
    // Rust 先按 (dimension, modality) 查记录，再校验模态类型。
    await expect(invoke(vfs, 'vfs_set_default_embedding_dimension', { dimension: 512, modality: 'image' }))
      .rejects.toBe('维度 512:image 不存在');

    expect(await invoke(vfs, 'vfs_set_default_embedding_dimension', { dimension: 512, modality: 'text' }))
      .toBe(true);
    expect(settings.get('embedding.default_text_dimension')).toBe('512');
    expect(await invoke(vfs, 'vfs_get_default_embedding_dimension', { modality: 'text' }))
      .toMatchObject({ dimension: 512, modality: 'text' });

    expect(await invoke(vfs, 'vfs_clear_default_embedding_dimension', { modality: 'text' })).toBe(true);
    expect(settings.get('embedding.default_text_dimension')).toBeNull();
    expect(await invoke(vfs, 'vfs_get_default_embedding_dimension', { modality: 'text' })).toBeNull();

    settings.save('embedding.default_text_dimension', '2048');
    settings.save('embedding.default_text_model_config_id', 'cfg_a');
    expect(await invoke(vfs, 'vfs_get_default_embedding_dimension', { modality: 'text' })).toBeNull();
    expect(settings.get('embedding.default_text_dimension')).toBeNull();
    expect(settings.get('embedding.default_text_model_config_id')).toBeNull();
  });

  it('clears the default when the default dimension is deleted', async () => {
    const vfs = await open({ llm: llmWith([apiConfig()]) });
    const settings = vfs.host.ctx.settings;
    await invoke(vfs, 'vfs_create_dimension', {
      dimension: 1024, modality: 'text', modelConfigId: 'cfg_text',
    });
    await invoke(vfs, 'vfs_set_default_embedding_dimension', { dimension: 1024, modality: 'text' });
    await invoke(vfs, 'vfs_delete_dimension', { dimension: 1024, modality: 'text' });
    expect(settings.get('embedding.default_text_dimension')).toBeNull();
    expect(settings.get('embedding.default_text_model_config_id')).toBeNull();
  });

  it('infers embedding readiness from settings and fallbacks', async () => {
    const withoutLlm = await open();
    expect(await invoke(withoutLlm, 'vfs_get_embedding_readiness')).toEqual({
      ready: false, modelConfigId: null, modelName: null, reason: 'LLM 服务不可用',
      vectorIndexAvailable: false,
    });
    // One notes installation per process: notes registers the process-global F3 deletion-journal Slot.
    hosts.splice(hosts.indexOf(withoutLlm), 1);
    await withoutLlm.dispose();

    const vfs = await open({ llm: llmWith([apiConfig({ name: '  ' })]) });
    const settings = vfs.host.ctx.settings;
    expect(await invoke(vfs, 'vfs_get_embedding_readiness')).toEqual({
      ready: true, modelConfigId: 'cfg_text', modelName: 'embed-v1', reason: null,
      vectorIndexAvailable: false,
    });
    // 无显式默认时自动探测唯一可用配置并写回 settings。
    expect(settings.get('embedding.default_text_model_config_id')).toBe('cfg_text');

    settings.save('embedding.default_text_model_config_id', 'cfg_missing');
    expect(await invoke(vfs, 'vfs_get_embedding_readiness'))
      .toMatchObject({ ready: true, modelConfigId: 'cfg_text' });
  });

  it('reports unready when no usable embedding configuration exists', async () => {
    const vfs = await open({ llm: llmWith([apiConfig({ enabled: false })]) });
    expect(await invoke(vfs, 'vfs_get_embedding_readiness')).toEqual({
      ready: false, modelConfigId: null, modelName: null,
      reason: '未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。',
      vectorIndexAvailable: false,
    });
  });
  it('keeps owner fallback working when assignment reads and default writeback fail', async () => {
    const vfs = await open({ llm: llmWith([apiConfig({ id: 'z', name: 'z' }), apiConfig({ id: 'a', name: 'Z' })]) });
    const settings = vfs.host.ctx.settings;
    const get = settings.get.bind(settings);
    const read = vi.spyOn(settings, 'get').mockImplementation(key => {
      if (key === 'model_assignments') throw new Error('assignment read failed');
      return get(key);
    });
    const write = vi.spyOn(settings, 'save').mockImplementation(() => { throw new Error('writeback failed'); });
    try {
      expect(await invoke(vfs, 'vfs_get_embedding_readiness')).toMatchObject({ ready: true, modelConfigId: 'a', reason: null });
    } finally { read.mockRestore(); write.mockRestore(); }
  });
});

describe('vfs/handlers.rs index state and config commands', { timeout: 120_000 }, () => {
  it('reads and toggles resource index state', async () => {
    const vfs = await open();
    const resourceId = await newResource(vfs, 'toggle');
    expect(await invoke(vfs, 'vfs_get_index_status', { resourceId }))
      .toMatchObject({ state: 'pending', hash: null, error: null });
    expect(await invoke(vfs, 'vfs_toggle_index_disabled', { resourceId })).toBe('disabled');
    expect(await invoke(vfs, 'vfs_get_index_status', { resourceId }))
      .toEqual({ state: 'disabled', hash: null, error: null, indexedAt: null, retryCount: 0 });
    expect(await invoke(vfs, 'vfs_toggle_index_disabled', { resourceId })).toBe('pending');
    expect(await invoke(vfs, 'vfs_get_index_status', { resourceId }))
      .toMatchObject({ state: 'pending' });
  });

  it('stores indexing configuration keys verbatim', async () => {
    const vfs = await open();
    // 迁移预置 indexing.batch_size=10（Rust 默认值）
    expect(await invoke(vfs, 'vfs_get_indexing_config', { key: 'indexing.batch_size' })).toBe('10');
    expect(await invoke(vfs, 'vfs_set_indexing_config', {
      key: 'indexing.batch_size', value: '20',
    })).toBeNull();
    expect(await invoke(vfs, 'vfs_get_indexing_config', { key: 'indexing.batch_size' })).toBe('20');
    expect(await invoke(vfs, 'vfs_get_indexing_config', { key: 'unknown.key' })).toBeNull();
    // Rust validate_config 拒绝未知键
    await expect(invoke(vfs, 'vfs_set_indexing_config', { key: 'unknown.key', value: '1' }))
      .rejects.toBe("Invalid argument 'unknown.key': Unknown indexing configuration key");
  });

  it('returns embedding stats from the index service', async () => {
    const vfs = await open();
    expect(await invoke(vfs, 'vfs_get_embedding_stats'))
      .toEqual({ totalEmbeddings: 0, totalResourcesIndexed: 0, dimensions: [] });
  });

  it('resets disabled and indexed-without-segments resources to pending', async () => {
    const vfs = await open();
    const disabled = await newResource(vfs, 'disabled');
    const indexed = await newResource(vfs, 'indexed');
    const healthy = await newResource(vfs, 'healthy');
    db(vfs).run("UPDATE resources SET index_state = 'disabled' WHERE id = ?1", [disabled]);
    db(vfs).run("UPDATE resources SET index_state = 'indexed' WHERE id = ?1", [indexed]);
    db(vfs).run("UPDATE resources SET index_state = 'indexed' WHERE id = ?1", [healthy]);
    db(vfs).run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_source,
      text_required, text_state, mm_required, mm_state, created_at, updated_at)
      VALUES ('unit_1', ?1, 0, 'text', 'native', 1, 'indexed', 0, 'disabled', 1, 1)`, [healthy]);
    db(vfs).run(`INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim,
      lance_row_id, content_text, created_at, updated_at)
      VALUES ('seg_1', 'unit_1', 0, 'text', 1024, 'emb_1', 'text', 1, 1)`);

    expect(await invoke(vfs, 'vfs_reset_disabled_to_pending')).toBe(1);
    expect(await invoke(vfs, 'vfs_reset_indexed_without_embeddings')).toBe(1);
    expect(db(vfs).pluck("SELECT index_state FROM resources WHERE id = ?1", [disabled])).toBe('pending');
    expect(db(vfs).pluck("SELECT index_state FROM resources WHERE id = ?1", [indexed])).toBe('pending');
    expect(db(vfs).pluck("SELECT index_state FROM resources WHERE id = ?1", [healthy])).toBe('indexed');
  });

  it('reset_all_index_state clears units, segments, dimension counts and states', async () => {
    const vfs = await open();
    const resourceId = await newResource(vfs, 'full-reset');
    await invoke(vfs, 'vfs_create_dimension', { dimension: 1024, modality: 'text' });
    repos(vfs).embeddingDims.updateCount(db(vfs), 1024, 'text', 7);
    db(vfs).run("UPDATE resources SET index_state = 'indexed', index_hash = 'h' WHERE id = ?1", [resourceId]);
    db(vfs).run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_source,
      text_required, text_state, mm_required, mm_state, created_at, updated_at)
      VALUES ('unit_reset', ?1, 0, 'text', 'native', 1, 'indexed', 0, 'disabled', 1, 1)`, [resourceId]);
    db(vfs).run(`INSERT INTO vfs_index_segments (id, unit_id, segment_index, modality, embedding_dim,
      lance_row_id, content_text, created_at, updated_at)
      VALUES ('seg_reset', 'unit_reset', 0, 'text', 1024, 'emb_reset', 'text', 1, 1)`);

    expect(await invoke(vfs, 'vfs_reset_all_index_state')).toBe(1);
    expect(db(vfs).pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
    expect(db(vfs).pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db(vfs).pluck('SELECT record_count FROM vfs_embedding_dims WHERE dimension = 1024')).toBe(0);
    expect(db(vfs).pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId])).toBe('pending');
    expect(db(vfs).pluck('SELECT index_hash FROM resources WHERE id = ?1', [resourceId])).toBeNull();
  });

  it('batch indexing returns an empty result when nothing is pending', async () => {
    const vfs = await open();
    expect(await batchIndexPending(vectorDeps(vfs), 5))
      .toEqual({ successCount: 0, failCount: 0, total: 0 });
    await expect(invoke(vfs, 'vfs_batch_index_pending', { batchSize: 5 })).rejects.toBe(VECTOR_UNAVAILABLE);
  });

  it('reindex_resource validates ids and rejects in-flight resources', async () => {
    const vfs = await open();
    await expect(reindexResource(vectorDeps(vfs), 'note_bad'))
      .rejects.toThrow('Invalid resource ID format: note_bad');
    const resourceId = await newResource(vfs, 'reindex');
    db(vfs).run("UPDATE resources SET index_state = 'indexing' WHERE id = ?1", [resourceId]);
    await expect(reindexResource(vectorDeps(vfs), resourceId))
      .rejects.toThrow('资源正在索引中，请等待完成后再试');
    await expect(invoke(vfs, 'vfs_reindex_resource', { resourceId })).rejects.toBe(VECTOR_UNAVAILABLE);
  });

  it('lists pending resources through the indexing service', async () => {
    const vfs = await open();
    const resourceId = await newResource(vfs, 'pending');
    expect(await invoke(vfs, 'vfs_get_pending_resources')).toContain(resourceId);
  });
});
