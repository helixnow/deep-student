/**
 * 设置窗口「模型服务 / 模型分配」的内存后端：13 家预置供应商 + 一家本机 Ollama，
 * 其中硅基流动、DeepSeek、月之暗面已存密钥（演示里只有掩码 ***，没有任何真实密钥），
 * 各功能槽位已分配，嵌入维度 1024（bge-m3）设为默认。
 *
 * 只依赖演示数据模块，不碰 app 模块（见 ../../types.ts）。
 */
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';

type Rec = Record<string, unknown>;

interface VendorSeed {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  websiteUrl: string;
  configured?: boolean;
  authMode?: string;
  apiProtocol?: string;
  notes?: string;
  maxTokensLimit?: number;
  isBuiltin?: boolean;
}

const VENDOR_SEEDS: VendorSeed[] = [
  { id: 'builtin-siliconflow', name: 'SiliconFlow', providerType: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', websiteUrl: 'https://cloud.siliconflow.cn', configured: true },
  { id: 'builtin-deepseek', name: 'DeepSeek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', websiteUrl: 'https://deepseek.com', configured: true, maxTokensLimit: 393_216 },
  { id: 'builtin-qwen', name: '通义千问', providerType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', websiteUrl: 'https://bailian.console.aliyun.com' },
  { id: 'builtin-zhipu', name: '智谱AI', providerType: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', websiteUrl: 'https://open.bigmodel.cn' },
  { id: 'builtin-doubao', name: '字节豆包', providerType: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', websiteUrl: 'https://www.volcengine.com/product/doubao' },
  { id: 'builtin-minimax', name: 'MiniMax', providerType: 'minimax', baseUrl: 'https://api.minimax.io/v1', websiteUrl: 'https://platform.minimaxi.com' },
  { id: 'builtin-moonshot', name: '月之暗面', providerType: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', websiteUrl: 'https://platform.moonshot.cn', configured: true },
  { id: 'builtin-openai', name: 'OpenAI', providerType: 'openai', baseUrl: 'https://api.openai.com/v1', websiteUrl: 'https://platform.openai.com', apiProtocol: 'openai_responses' },
  { id: 'builtin-openai-codex', name: 'Codex', providerType: 'openai_codex', baseUrl: 'https://chatgpt.com/backend-api/codex', websiteUrl: 'https://chatgpt.com/codex', authMode: 'openai_codex_oauth', apiProtocol: 'openai_responses' },
  { id: 'builtin-anthropic', name: 'Anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', websiteUrl: 'https://platform.claude.com', apiProtocol: 'anthropic_messages' },
  { id: 'builtin-nvidia', name: 'NVIDIA', providerType: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', websiteUrl: 'https://build.nvidia.com/nim' },
  { id: 'builtin-mimo', name: 'Xiaomi MiMo', providerType: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1', websiteUrl: 'https://platform.xiaomimimo.com' },
  { id: 'builtin-gemini', name: 'Google Gemini', providerType: 'google', baseUrl: 'https://generativelanguage.googleapis.com', websiteUrl: 'https://aistudio.google.com', apiProtocol: 'google_generate_content' },
  { id: 'demo-ollama', name: '本机 Ollama', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', websiteUrl: '', authMode: 'none', isBuiltin: false, notes: '本机自建服务，无需 API Key' },
];

/** [id, vendorId, label, model, flags, adapter, contextWindow] */
type ProfileSeed = [string, string, string, string, string, string, number?];

// flags：m 多模态 · r 推理 · t 工具调用 · e 嵌入 · k 重排序 · i 生图
const PROFILE_SEEDS: ProfileSeed[] = [
  ['sf-deepseek-v3.2', 'builtin-siliconflow', 'DeepSeek-V3.2', 'deepseek-ai/DeepSeek-V3.2', 'rt', 'deepseek', 163_840],
  ['sf-qwen3-30b', 'builtin-siliconflow', 'Qwen3-30B-A3B-Instruct', 'Qwen/Qwen3-30B-A3B-Instruct-2507', 't', 'qwen', 262_144],
  ['sf-ling-mini', 'builtin-siliconflow', 'Ling-mini-2.0', 'inclusionAI/Ling-mini-2.0', 't', 'general', 131_072],
  ['sf-hunyuan-mt', 'builtin-siliconflow', 'Hunyuan-MT-7B', 'tencent/Hunyuan-MT-7B', '', 'general', 32_768],
  ['sf-qwen3-vl-8b', 'builtin-siliconflow', 'Qwen3-VL-8B-Instruct', 'Qwen/Qwen3-VL-8B-Instruct', 'mt', 'qwen', 262_144],
  ['sf-paddleocr-vl', 'builtin-siliconflow', 'PaddleOCR-VL-1.5', 'PaddlePaddle/PaddleOCR-VL-1.5', 'm', 'general', 16_384],
  ['sf-qwen3-asr', 'builtin-siliconflow', 'Qwen3-ASR-1.7B', 'Qwen/Qwen3-ASR-1.7B', '', 'general'],
  ['sf-bge-m3', 'builtin-siliconflow', 'BAAI/bge-m3', 'BAAI/bge-m3', 'e', 'general', 8_192],
  ['sf-bge-reranker', 'builtin-siliconflow', 'BAAI/bge-reranker-v2-m3', 'BAAI/bge-reranker-v2-m3', 'k', 'general', 8_192],
  ['sf-kolors', 'builtin-siliconflow', 'Kolors', 'Kwai-Kolors/Kolors', 'i', 'general'],
  ['builtin-deepseek-v4-pro', 'builtin-deepseek', 'DeepSeek V4 Pro', 'deepseek-v4-pro', 'rt', 'deepseek', 1_048_576],
  ['builtin-deepseek-v4-flash', 'builtin-deepseek', 'DeepSeek V4 Flash', 'deepseek-v4-flash', 'mrt', 'deepseek', 1_048_576],
  ['builtin-deepseek-flash', 'builtin-deepseek', 'DeepSeek V4.1 Flash', 'deepseek-flash', 'mrt', 'deepseek', 1_048_576],
  ['builtin-kimi-k3', 'builtin-moonshot', 'Kimi K3', 'kimi-k3', 'mrt', 'moonshot', 1_048_576],
  ['builtin-kimi-k2.6', 'builtin-moonshot', 'Kimi K2.6', 'kimi-k2.6', 'mrt', 'moonshot', 262_144],
  ['builtin-qwen3.7-max', 'builtin-qwen', 'Qwen3.7 Max (旗舰/混合思考)', 'qwen3.7-max', 'rt', 'qwen'],
  ['builtin-qwen3.7-plus', 'builtin-qwen', 'Qwen3.7 Plus (官方默认推荐/多模态)', 'qwen3.7-plus', 'mrt', 'qwen'],
  ['builtin-qwen3.6-flash', 'builtin-qwen', 'Qwen3.6 Flash (轻量高并发/多模态)', 'qwen3.6-flash', 'mrt', 'qwen'],
  ['builtin-glm-5.2', 'builtin-zhipu', 'GLM-5.2 (当前旗舰)', 'glm-5.2', 'rt', 'zhipu'],
  ['builtin-glm-4.7-flash', 'builtin-zhipu', 'GLM-4.7 Flash (免费)', 'glm-4.7-flash', 'rt', 'zhipu'],
  ['builtin-doubao-seed-2.1-pro', 'builtin-doubao', 'Doubao Seed 2.1 Pro', 'doubao-seed-2-1-pro-260628', 'mrt', 'doubao'],
  ['builtin-minimax-m3', 'builtin-minimax', 'MiniMax-M3', 'MiniMax-M3', 'mrt', 'minimax'],
  ['builtin-gpt-5.6', 'builtin-openai', 'GPT-5.6', 'gpt-5.6', 'mrt', 'general'],
  ['builtin-codex-gpt-5.6', 'builtin-openai-codex', 'GPT-5.6 Codex', 'gpt-5.6-codex', 'mrt', 'general'],
  ['builtin-claude-sonnet-5', 'builtin-anthropic', 'Claude Sonnet 5', 'claude-sonnet-5', 'mrt', 'anthropic'],
  ['builtin-nvidia-nemotron', 'builtin-nvidia', 'Nemotron Super', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'rt', 'general'],
  ['builtin-mimo-v2.5-pro', 'builtin-mimo', 'MiMo V2.5 Pro', 'mimo-v2.5-pro', 'rt', 'general'],
  ['builtin-gemini-3.5-flash', 'builtin-gemini', 'Gemini 3.5 Flash', 'gemini-3.5-flash', 'mrt', 'google'],
  ['builtin-gemini-3.1-pro', 'builtin-gemini', 'Gemini 3.1 Pro Preview', 'gemini-3.1-pro-preview', 'mrt', 'google'],
  ['ollama-qwen3-8b', 'demo-ollama', 'qwen3:8b', 'qwen3:8b', 'rt', 'general', 40_960],
];

const ASSIGNMENTS_SEED: Rec = {
  model2_config_id: 'builtin-deepseek-v4-pro',
  anki_card_model_config_id: 'sf-qwen3-30b',
  qbank_ai_grading_model_config_id: 'builtin-deepseek-v4-flash',
  qbank_ai_generation_model_config_id: 'sf-deepseek-v3.2',
  embedding_model_config_id: 'sf-bge-m3',
  reranker_model_config_id: 'sf-bge-reranker',
  chat_title_model_config_id: 'sf-ling-mini',
  exam_sheet_ocr_model_config_id: 'sf-paddleocr-vl',
  translation_model_config_id: 'sf-hunyuan-mt',
  vl_embedding_model_config_id: null,
  vl_reranker_model_config_id: null,
  memory_decision_model_config_id: 'sf-ling-mini',
  review_analysis_model_config_id: 'builtin-deepseek-v4-flash',
  voice_input_asr_model_config_id: 'sf-qwen3-asr',
  image_generation_model_config_id: null,
  compaction_model_config_id: 'builtin-deepseek-v4-flash',
  translation_display_mode: 'aligned',
};

const MASK = '***';

function buildVendor(seed: VendorSeed, index: number): Rec {
  return {
    id: seed.id,
    name: seed.name,
    providerType: seed.providerType,
    authMode: seed.authMode ?? 'api_key',
    apiProtocol: seed.apiProtocol ?? 'openai_chat_completions',
    baseUrl: seed.baseUrl,
    apiKey: seed.configured ? MASK : '',
    apiKeys: seed.configured ? [MASK] : [],
    headers: {},
    notes: seed.notes ?? '',
    isBuiltin: seed.isBuiltin ?? true,
    isReadOnly: false,
    sortOrder: index,
    maxTokensLimit: seed.maxTokensLimit,
    websiteUrl: seed.websiteUrl,
  };
}

function buildProfile([id, vendorId, label, model, flags, adapter, contextWindow]: ProfileSeed): Rec {
  const vendor = VENDOR_SEEDS.find((v) => v.id === vendorId);
  return {
    id,
    vendorId,
    label,
    model,
    modelAdapter: adapter,
    apiProtocol: vendor?.apiProtocol ?? 'openai_chat_completions',
    status: 'enabled',
    enabled: true,
    isMultimodal: flags.includes('m'),
    isReasoning: flags.includes('r'),
    supportsReasoning: flags.includes('r'),
    supportsTools: flags.includes('t'),
    isEmbedding: flags.includes('e'),
    isReranker: flags.includes('k'),
    isImageGeneration: flags.includes('i'),
    maxOutputTokens: flags.includes('e') || flags.includes('k') ? 0 : 32_768,
    temperature: 0.7,
    contextWindow,
    isBuiltin: id.startsWith('builtin-'),
    isFavorite: id === 'builtin-deepseek-v4-pro' || id === 'builtin-kimi-k3',
  };
}

interface DimensionRow {
  dimension: number;
  modality: 'text' | 'multimodal';
  modelConfigId: string | null;
  modelName: string | null;
  recordCount: number;
  lanceTableName: string;
  createdAt: number;
  lastUsedAt: number;
}

const DAY = 86_400_000;

function ocrEngine(configId: string, model: string, engineType: string, name: string, isFree: boolean, priority: number): Rec {
  return { configId, model, engineType, name, isFree, supportsGrounding: engineType !== 'generic_vlm', enabled: true, priority };
}

/** get_ocr_engines：后端 OcrAdapterFactory::engine_info_list 的同款清单 */
const OCR_ENGINE_INFOS = [
  ['deepseek_ocr', 'DeepSeek-OCR', '专业 OCR 模型，支持 Grounding 坐标输出，适合题目集识别', 'deepseek-ai/DeepSeek-OCR', true, false],
  ['paddle_ocr_vl', 'PaddleOCR-VL-1.5', '百度开源 OCR 视觉语言模型，完全免费，精度 94.5%', 'PaddlePaddle/PaddleOCR-VL-1.5', true, true],
  ['paddle_ocr_vl_v1', 'PaddleOCR-VL', '百度开源 OCR 视觉语言模型旧版，完全免费，作为 1.5 版的备用', 'PaddlePaddle/PaddleOCR-VL', true, true],
  ['glm4v_ocr', 'GLM-4.6V', '智谱 106B MoE 多模态模型，支持 bbox_2d 坐标输出，题目集导入优先引擎', 'zai-org/GLM-4.6V', true, false],
  ['generic_vlm', '通用多模态模型', '使用通用 VLM 进行 OCR，适合简单文档识别', 'Qwen/Qwen2.5-VL-7B-Instruct', false, false],
  ['system_ocr', '系统 OCR', '调用操作系统内置 OCR 引擎，免费离线，无需 API Key', 'system', false, true],
].map(([engineType, name, description, recommendedModel, supportsGrounding, isFree]) => ({
  engineType, name, description, recommendedModel, supportsGrounding, isFree,
}));

function createState() {
  const now = Date.now();
  return {
    vendors: VENDOR_SEEDS.map(buildVendor),
    profiles: PROFILE_SEEDS.map(buildProfile),
    assignments: { ...ASSIGNMENTS_SEED } as Rec,
    dimensions: [
      { dimension: 1024, modality: 'text', modelConfigId: 'sf-bge-m3', modelName: 'BAAI/bge-m3', recordCount: 18_436, lanceTableName: 'vfs_emb_text_1024', createdAt: now - 62 * DAY, lastUsedAt: now - 2 * 3_600_000 },
      { dimension: 768, modality: 'text', modelConfigId: null, modelName: null, recordCount: 0, lanceTableName: 'vfs_emb_text_768', createdAt: now - 40 * DAY, lastUsedAt: now - 40 * DAY },
    ] as DimensionRow[],
    defaultDimension: { text: 1024 as number | null, multimodal: null as number | null },
    ocrEngines: [
      ocrEngine('sf-paddleocr-vl', 'PaddlePaddle/PaddleOCR-VL-1.5', 'paddle_ocr_vl', 'PaddleOCR-VL-1.5', true, 0),
      ocrEngine('sf-qwen3-vl-8b', 'Qwen/Qwen3-VL-8B-Instruct', 'generic_vlm', 'Qwen3-VL-8B-Instruct', false, 1),
      ocrEngine('__system_ocr__', 'system', 'system_ocr', '系统 OCR', true, 2),
    ],
    ocrThinking: false,
  };
}

const state = createState();

function resolvedConfigs(): Rec[] {
  const vendors = new Map(state.vendors.map((v) => [v.id as string, v]));
  return state.profiles.flatMap((p) => {
    const v = vendors.get(p.vendorId as string);
    if (!v) return [];
    const hasKey = v.authMode === 'none' || v.apiKey === MASK;
    return [{
      ...p,
      name: p.label,
      vendorId: v.id,
      vendorName: v.name,
      providerType: v.providerType,
      authMode: v.authMode,
      apiKey: hasKey && v.authMode !== 'none' ? MASK : '',
      baseUrl: v.baseUrl,
      enabled: Boolean(p.enabled) && hasKey,
      isReadOnly: false,
      headers: v.headers,
    }];
  });
}

function maskVendor(v: Rec): Rec {
  const keys = [v.apiKey, ...((v.apiKeys as string[] | undefined) ?? [])]
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);
  const hasKey = keys.length > 0;
  return { ...v, apiKey: hasKey ? MASK : '', apiKeys: hasKey ? [MASK] : [] };
}

const desktopOnly = (zh: string, en: string) => new Error(tr(`${zh}请在桌面版中使用。`, `${en} is available in the desktop app.`));

function dimensionPayload(d: DimensionRow): Rec {
  return { ...d, modelConfigId: d.modelConfigId ?? undefined, modelName: d.modelName ?? undefined };
}

function findDimension(args: DemoArgs): DimensionRow | undefined {
  return state.dimensions.find((d) => d.dimension === Number(args.dimension) && d.modality === String(args.modality ?? 'text'));
}

export function handleDemoModelSettings(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'get_vendor_configs':
      return state.vendors.map(maskVendor);
    case 'save_vendor_configs': {
      const incoming = (args.configs as Rec[] | undefined) ?? [];
      state.vendors = incoming.map((v) => maskVendor(v));
      return null;
    }
    case 'get_model_profiles':
      return state.profiles;
    case 'save_model_profiles':
      state.profiles = ((args.profiles as Rec[] | undefined) ?? []).map((p) => ({ ...p }));
      return null;
    case 'get_model_assignments':
      return { ...state.assignments };
    case 'save_model_assignments':
      state.assignments = { ...state.assignments, ...((args.assignments as Rec | undefined) ?? {}) };
      return null;
    case 'get_api_configurations':
      return resolvedConfigs();
    case 'openai_codex_auth_status':
      return { state: 'signed_out', hasUsableSession: false };
    case 'openai_codex_login_start':
      throw desktopOnly('ChatGPT 账号登录', 'Signing in with ChatGPT');
    case 'test_api_connection':
      throw desktopOnly('测试连接需要联网调用模型，', 'Testing a connection');
    case 'fetch_vendor_models':
    case 'list_vendor_models':
      throw desktopOnly('从接口获取模型列表需要联网，', 'Fetching the model list');
    // OCR 引擎（模型分配页）
    case 'get_ocr_engines':
      return OCR_ENGINE_INFOS;
    case 'get_available_ocr_models':
      return state.ocrEngines.map((e) => ({ ...e }));
    case 'get_ocr_engine_type':
      return String(state.ocrEngines.find((e) => e.enabled)?.engineType ?? 'paddle_ocr_vl');
    case 'get_ocr_thinking_enabled':
      return state.ocrThinking;
    case 'set_ocr_thinking_enabled':
      state.ocrThinking = Boolean(args.enabled);
      return null;
    case 'save_available_ocr_models':
      state.ocrEngines = ((args.models as Rec[] | undefined) ?? []).map((e, i) => ({ supportsGrounding: false, ...e, priority: i }));
      return true;
    case 'update_ocr_engine_priority': {
      const list = (args.engineList as Array<{ configId: string; enabled: boolean }> | undefined) ?? [];
      const byId = new Map(state.ocrEngines.map((e) => [e.configId as string, e]));
      state.ocrEngines = list.flatMap((item, i) => {
        const e = byId.get(item.configId);
        return e ? [{ ...e, enabled: item.enabled, priority: i }] : [];
      });
      return true;
    }
    case 'add_ocr_engine':
      state.ocrEngines.push(ocrEngine(String(args.configId), String(args.model), String(args.engineType ?? 'generic_vlm'), String(args.name), false, state.ocrEngines.length));
      return true;
    case 'remove_ocr_engine':
      state.ocrEngines = state.ocrEngines.filter((e) => e.configId !== args.configId);
      return true;
    case 'test_ocr_engine':
      throw desktopOnly('测试 OCR 引擎需要联网调用模型，', 'Testing an OCR engine');
    case 'vfs_get_embedding_readiness': {
      const id = state.assignments.embedding_model_config_id as string | null;
      const profile = state.profiles.find((p) => p.id === id);
      return { ready: Boolean(profile), modelConfigId: id, modelName: (profile?.model as string) ?? null, reason: null, vectorIndexAvailable: true };
    }
    // 嵌入维度管理
    case 'vfs_list_dimensions':
      return state.dimensions.map(dimensionPayload);
    case 'vfs_get_preset_dimensions':
      return [256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072, 4096];
    case 'vfs_get_dimension_range':
      return [64, 8192];
    case 'vfs_get_default_embedding_dimension': {
      const modality = String(args.modality ?? 'text') as 'text' | 'multimodal';
      const value = state.defaultDimension[modality];
      const row = state.dimensions.find((d) => d.dimension === value && d.modality === modality);
      return row ? dimensionPayload(row) : null;
    }
    case 'vfs_set_default_embedding_dimension': {
      const modality = String(args.modality ?? 'text') as 'text' | 'multimodal';
      state.defaultDimension[modality] = Number(args.dimension);
      return true;
    }
    case 'vfs_clear_default_embedding_dimension': {
      const modality = String(args.modality ?? 'text') as 'text' | 'multimodal';
      state.defaultDimension[modality] = null;
      return true;
    }
    case 'vfs_assign_dimension_model': {
      const row = findDimension(args);
      if (!row) return false;
      row.modelConfigId = (args.modelConfigId as string | null) ?? null;
      row.modelName = (args.modelName as string | null) ?? null;
      return true;
    }
    case 'vfs_create_dimension': {
      const existing = findDimension(args);
      if (existing) return dimensionPayload(existing);
      const now = Date.now();
      const modality = String(args.modality ?? 'text') as 'text' | 'multimodal';
      const row: DimensionRow = {
        dimension: Number(args.dimension),
        modality,
        modelConfigId: (args.modelConfigId as string | null) ?? null,
        modelName: (args.modelName as string | null) ?? null,
        recordCount: 0,
        lanceTableName: `vfs_emb_${modality}_${Number(args.dimension)}`,
        createdAt: now,
        lastUsedAt: now,
      };
      state.dimensions.push(row);
      return { ...row };
    }
    case 'vfs_delete_dimension': {
      const row = findDimension(args);
      state.dimensions = state.dimensions.filter((d) => d !== row);
      if (row && state.defaultDimension[row.modality] === row.dimension) state.defaultDimension[row.modality] = null;
      return { deletedSegments: row?.recordCount ?? 0, dimension: Number(args.dimension), modality: String(args.modality ?? 'text') };
    }
    default:
      return undefined;
  }
}

const SF_CACHED_MODELS = [
  'deepseek-ai/DeepSeek-V3.2',
  'deepseek-ai/DeepSeek-R1',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-8B',
  'moonshotai/Kimi-K2-Instruct-0905',
  'zai-org/GLM-4.6',
  'inclusionAI/Ling-mini-2.0',
  'tencent/Hunyuan-MT-7B',
  'PaddlePaddle/PaddleOCR-VL-1.5',
  'deepseek-ai/DeepSeek-OCR',
  'BAAI/bge-m3',
  'BAAI/bge-reranker-v2-m3',
  'Qwen/Qwen3-Embedding-8B',
].map((id) => ({
  id,
  object: 'model',
  created: 1_760_000_000,
  owned_by: id.split('/')[0],
  permission: [],
  status: 'available',
  name: id,
  supported_features: [],
}));

/** 模型设置相关的设置表预置（硅基流动的模型列表缓存、演示密钥） */
export const DEMO_MODEL_SETTINGS: Record<string, unknown> = {
  // 显然不是真密钥的占位串：让「一键分配」「保存」等按钮处于可用状态
  'builtin-siliconflow.api_key': 'sk-demo-website-preview-not-a-real-key',
  'siliconflow.cached_models': JSON.stringify(SF_CACHED_MODELS),
  'siliconflow.cached_models_time': String(Date.now() - 3 * 3_600_000),
};
