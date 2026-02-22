/**
 * Settings 页面类型定义
 * 从 Settings.tsx 提取
 */

import type { ApiConfig } from '../../types';
import type { ThemeMode, ThemePalette } from '../../hooks/useTheme';


// 系统配置接口
export interface SystemConfig {
  apiConfigs: ApiConfig[];
  model2ConfigId: string;  // 对话模型（可以是任意类型）
  ankiCardModelConfigId: string;  // Anki制卡模型（可以是任意类型）
  qbank_ai_grading_model_config_id: string; // 题库AI批改/解析模型配置ID
  // 嵌入模型通过维度管理设置，不再作为全局配置
  rerankerModelConfigId: string;   // 重排序模型（RAG用）
  autoSave: boolean;
  theme: ThemeMode;
  themePalette: ThemePalette;
  debugMode: boolean;  // 调试模式开关
  // RAG设置
  ragEnabled: boolean;
  ragTopK: number;
  // 开发功能设置
  ankiConnectEnabled: boolean;
  exam_sheet_ocr_model_config_id: string; // 新增：题目集识别OCR专用模型配置ID
  translation_model_config_id: string; // 新增：翻译专用模型配置ID
  chat_title_model_config_id: string; // 新增：聊天标题生成模型配置ID
  // 多模态知识库模型配置（嵌入模型通过维度管理设置，此处仅保留重排序）
  vl_reranker_model_config_id: string;  // 多模态重排序模型（Qwen3-VL-Reranker）
  memory_decision_model_config_id: string; // 记忆决策模型（smart write 去重判断）

  // MCP 工具协议设置（不再提供全局启用开关，仅保留连接与工具配置）
  mcpCommand: string;
  mcpArgs: string;
  mcpTransportType?: 'stdio' | 'websocket';
  mcpUrl?: string;
  mcpAdvertiseAll: boolean;
  mcpWhitelist: string;
  mcpBlacklist: string;
  mcpTimeoutMs: number;
  mcpRateLimit: number;
  mcpCacheMax: number;
  mcpCacheTtlMs: number;
  // 多个 MCP 工具配置（以工具为单位）
  mcpTools?: Array<{ id: string; name: string; transportType?: 'stdio'|'websocket'|'sse'|'streamable_http'; url?: string; command?: string; args?: string | string[]; env?: Record<string, string>; endpoint?: string; apiKey?: string; fetch?: { type: 'sse'|'streamable_http'; url: string }; mcpServers?: Record<string, any> }>;

  // 外部搜索设置（不再提供全局启用开关，仅保留引擎与密钥配置）
  webSearchEngine: string;
  webSearchTimeoutMs: number;
  webSearchGoogleKey: string;
  webSearchGoogleCx: string;
  webSearchSerpApiKey: string;
  webSearchTavilyKey: string;
  webSearchBraveKey: string;
  webSearchSearxngEndpoint: string;
  webSearchSearxngKey: string;
  webSearchZhipuKey: string;
  webSearchBochaKey: string;
  webSearchWhitelist: string;
  webSearchBlacklist: string;
  webSearchInjectSnippetMax?: number;
  webSearchInjectTotalMax?: number;
}

export interface SettingsProps {
  onBack: () => void;
}
