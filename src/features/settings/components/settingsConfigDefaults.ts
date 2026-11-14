import type { SystemConfig } from './types';
import { DEFAULT_STDIO_ARGS_STORAGE } from './constants';

/**
 * 设置页第一帧的 SystemConfig 默认值。
 *
 * 真实值由 useSettingsConfig / useSettingsConfigSources 从后端读取覆盖；
 * 这里只保留与历史 Settings.tsx 内联默认值完全一致的安全兜底，
 * 供设置分区各自初始渲染使用（identity 稳定，不需要 memo）。
 */
export function createDefaultSystemConfig(): SystemConfig {
  return {
    apiConfigs: [],
    model2ConfigId: '',
    ankiCardModelConfigId: '',
    qbank_ai_grading_model_config_id: '',
    qbank_ai_generation_model_config_id: '',
    // 嵌入模型通过维度管理设置
    rerankerModelConfigId: '',
    autoSave: true,
    theme: 'light',
    themePalette: 'default',
    debugMode: false,
    ragEnabled: false,
    ragTopK: 5,
    ankiConnectEnabled: false,
    exam_sheet_ocr_model_config_id: '', // 新增：题目集识别OCR专用模型配置ID
    translation_model_config_id: '', // 新增：翻译专用模型配置ID
    chat_title_model_config_id: '', // 新增：聊天标题生成模型配置ID
    // 多模态知识库模型配置（嵌入模型通过维度管理设置）
    vl_reranker_model_config_id: '', // 多模态重排序模型
    memory_decision_model_config_id: '', // 记忆决策模型
    voice_input_asr_model_config_id: '', // 语音输入 ASR 模型
    image_generation_model_config_id: '', // 生图模型
    compaction_model_config_id: '', // 上下文压缩专用模型（未设置回退对话模型）
    translation_display_mode: 'aligned', // 聊天翻译显示模式：'aligned' 短语对照（默认）/ 'streaming' 流式纯译文

    // MCP 工具协议设置（默认保持可配置；启用与否由消息级选择决定）
    mcpCommand: 'npx',
    mcpArgs: DEFAULT_STDIO_ARGS_STORAGE,
    mcpTransportType: 'stdio',
    mcpUrl: 'ws://localhost:8000',
    mcpAdvertiseAll: false,
    mcpWhitelist: 'read_file, write_file, list_directory',
    mcpBlacklist: 'delete_file, execute_command, rm, sudo',
    mcpTimeoutMs: 15000,
    mcpRateLimit: 10,
    mcpCacheMax: 500,
    mcpCacheTtlMs: 300000,
    mcpTools: [],

    // 外部搜索设置（启用与否由消息级选择决定）
    webSearchEngine: 'bing_rss',
    webSearchTimeoutMs: 15000,
    webSearchGoogleKey: '',
    webSearchGoogleCx: '',
    webSearchSerpApiKey: '',
    webSearchTavilyKey: '',
    webSearchBraveKey: '',
    webSearchSearxngEndpoint: '',
    webSearchSearxngKey: '',
    webSearchZhipuKey: '',
    webSearchBochaKey: '',
    webSearchDeepseekKey: '',
    webSearchDeepseekNeedContent: false,
    webSearchDeepseekFetchEnabled: false,
    webSearchWhitelist: '',
    webSearchBlacklist: '',
    webSearchInjectSnippetMax: 180,
    webSearchInjectTotalMax: 1900,
  };
}
