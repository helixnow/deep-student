/**
 * Unified Type Definitions
 * 
 * Consolidates all TypeScript interfaces and types used throughout the application
 * to improve maintainability and consistency.
 */

import type { ExamSheetSessionDetail } from '../utils/types';

// ============================================================================
// Core Data Models (matching backend Rust structs)
// ============================================================================

// 统一的链接状态枚举
export enum LinkageStatus {
  Unlinked = 0,   // 未关联
  Reserved = 1,   // 已预占（等待激活）
  Completed = 2,  // 已完成（双向激活）
  Failed = 3,     // 失败
}

// 链接状态标签映射
export const LinkageStatusLabels: Record<LinkageStatus, string> = {
  [LinkageStatus.Unlinked]: '未关联',
  [LinkageStatus.Reserved]: '已预占',
  [LinkageStatus.Completed]: '已完成',
  [LinkageStatus.Failed]: '失败',
};

// 链接状态颜色映射（用于UI显示）
export const LinkageStatusColors: Record<LinkageStatus, string> = {
  [LinkageStatus.Unlinked]: 'text-gray-500',
  [LinkageStatus.Reserved]: 'text-yellow-500',
  [LinkageStatus.Completed]: 'text-green-500',
  [LinkageStatus.Failed]: 'text-red-500',
};

export interface RagSourceInfo {
  document_id: string;
  file_name: string;
  chunk_text: string;
  score: number;
  chunk_index: number;
}

export interface DocumentAttachment {
  name: string;           // 文件名
  mime_type: string;      // MIME 类型
  size_bytes: number;     // 文件大小（字节）
  text_content?: string;  // 提取的文本内容（可选）
  base64_content?: string; // Base64 编码的原始内容（可选）
}

export interface ExamCardBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExamSheetLink {
  exam_id: string;
  origin_exam_id?: string | null;
  exam_name?: string | null;
  card_id?: string | null;
  page_index?: number;
  question_label?: string;
  bbox?: ExamCardBBox;
  resolved_bbox?: ExamCardBBox;
  original_image_path?: string | null;
  cropped_image_path?: string | null;
  session_id?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
}
// 多模态内容块类型
export type ChatMessageContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

// 追问时上传的图片文件基本信息
export interface UploadedImageInfo {
  id: string; // 临时客户端ID
  name: string;
  type: string; // MIME type
  base64_data: string; // 图片的Base64编码
  file?: File; // 原始File对象，可选
}

export interface ChatMessage {
  id?: string; // 消息的唯一ID，前端生成或后端返回
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ChatMessageContentPart[]; // 支持旧的字符串格式和新的多模态数组格式
  timestamp: string;
  thinking_content?: string;
  /** Gemini 3 思维签名（工具调用必需，用于验证思维链连续性） */
  thought_signature?: string;

  // 🎯 来源信息（完整版）
  rag_sources?: RagSourceInfo[];
  memory_sources?: RagSourceInfo[];
  graph_sources?: RagSourceInfo[]; // 知识图谱来源
  web_search_sources?: RagSourceInfo[]; // 网络搜索来源
  unified_sources?: any; // 统一来源包（UnifiedSourceBundle）
  
  // 🎯 附件支持
  image_paths?: string[]; // 用户消息中包含的图片路径
  image_base64?: string[]; // base64编码的图片数据
  doc_attachments?: DocumentAttachment[]; // 文档附件信息
  
  // 🎯 教材导学支持
  textbook_pages?: Array<{
    textbook_path: string;
    textbook_name: string;
    pages: any[]; // TextbookPageInfo[]
  }>;
  
  // 🎯 工具调用支持（单轮与多轮）
  tool_call?: {
    id: string;
    tool_name: string;
    args_json: any;
  };
  tool_result?: {
    call_id: string;
    ok: boolean;
    error?: string;
    data_json?: any;
    citations?: RagSourceInfo[];
  };
  tool_calls?: Array<{
    id: string;
    tool_name: string;
    args_json: any;
  }>;
  tool_results?: Array<{
    call_id: string;
    ok: boolean;
    error?: string;
    data_json?: any;
    citations?: RagSourceInfo[];
  }>;
  
  // 🎯 消息级配置与关系
  overrides?: any; // 消息级覆盖配置（模型、工具、RAG等）
  relations?: any; // 消息关系（parent_id, supersedes等）
  persistent_stable_id?: string; // 持久化稳定ID
  _stableId?: string; // 临时稳定ID（前端生成）
  _meta?: Record<string, any>; // 运行时元数据（阶段信息、工具事件等）
  metadata?: Record<string, any>; // 持久化元数据（从数据库读取或准备保存）
  
  // 前端展示用的附件信息，不参与持久化
  ui_attachments?: Array<{
    type: 'image' | 'doc';
    url?: string; // 图片 data URL
    name?: string; // 文档名
    text?: string; // 文档解析文本
  }>;
}

/**
 * @deprecated 2026-01 清理：错题功能已废弃，保留以兼容旧数据。
 * ⚠️ 仍有以下文件引用（2026-02-08 确认）：
 *   - src/utils/tauriApi.ts（废弃函数 getMistakeDetails / updateMistake / runtimeAutosaveCommit 等）
 *   - src/utils/ankiSourceBuilder.ts（buildContentFromMistake）
 *   - src/app/services/saveRequestHandler.ts
 *   - src/stores/anki/types.ts（MistakeSummary 别名）
 * 待上述调用方迁移后再删除此类型。
 */
export interface MistakeItem {
  id: string;
  created_at: string;
  question_images: string[];
  analysis_images: string[];
  user_question: string;
  ocr_text: string;
  ocr_note?: string | null;
  tags: string[];
  mistake_type: string;
  status: string;
  chat_category: string;
  updated_at: string;
  chat_history: ChatMessage[];
  question_image_urls?: string[];
  mistake_summary?: string | null;
  user_error_analysis?: string | null;
  /** @deprecated irec 模块已废弃 */
  irec_card_id?: string;
  /** @deprecated irec 模块已废弃 */
  irec_status?: number;
  chat_metadata?: ChatMetadata | null;
  exam_sheet?: ExamSheetLink | null;
  examSheet?: ExamSheetLink | null;
  last_accessed_at?: string;
  autosave_signature?: string | null;
}

export interface ChatMetadata {
  title: string;
  summary?: string | null;
  tags: string[];
  note?: string | null;
  attributes?: Record<string, unknown> | null;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface GeneralChatSessionRequest {
  userQuestion: string;
  questionImageFiles?: Array<string | { base64: string } | File>;
  docAttachments?: DocumentAttachment[];
  enableChainOfThought?: boolean;
  /** 新架构兼容：前端预生成的会话 ID */
  sessionId?: string;
}

export interface GeneralChatSessionResponse {
  session_id: string;
  business_session_id: string;
  generation_id: number;
  metadata?: ChatMetadata | null;
}

export interface GenerateChatMetadataResponse {
  metadata?: ChatMetadata | null;
}

export interface UpdateChatMetadataNoteResponse {
  metadata?: ChatMetadata | null;
}

export interface UpdateOcrNoteResponse {
  ocr_note?: string | null;
}

export interface ContinueChatResponse {
  new_assistant_message: string;
}

export interface RuntimeAutosaveCommitSnapshot {
  history: ChatMessage[];
  normalizedHistory: ChatMessage[];
  thinkingContent?: Record<string, string>;
  summaryContent?: string | null;
  summaryComplete?: boolean;
  signaturePayload: string;
  stableIds?: string[];
}

export interface RuntimeAutosaveCommitRequest {
  businessSessionId?: string | null;
  snapshot: RuntimeAutosaveCommitSnapshot;
  saveSource?: string;
  saveReason?: string;
  reason?: string;
  chatCategory?: 'analysis' | 'general_chat';
  chatMetadata?: ChatMetadata | null;
  autosaveSignature?: string | null;
  generationId?: number | null;
}

export interface RuntimeAutosaveCommitResponse {
  success: boolean;
  sessionId?: string | null;
  /** @deprecated 使用 sessionId */
  mistakeId?: string | null;
  finalItem?: MistakeItem;
  /** @deprecated 使用 finalItem */
  finalMistakeItem?: MistakeItem;
  reason?: string | null;
}

export type TempStreamState = 'in_progress' | 'completed' | 'failed';

// ============================================================================
// API Configuration Types
// ============================================================================

export interface ApiConfig {
  id: string;
  name: string;
  vendorId?: string;
  vendorName?: string;
  providerType?: string;
  providerScope?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  enabled: boolean;
  modelAdapter: string;
  supportsTools?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  geminiApiVersion?: string;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  enableThinking?: boolean;
  minP?: number;
  topK?: number;
  supportsReasoning?: boolean;
  headers?: Record<string, string>;
  /** 是否收藏（收藏的模型在列表中优先显示） */
  isFavorite?: boolean;
  /** 供应商级别的 max_tokens 限制（API 最大允许值） */
  maxTokensLimit?: number;
  /** 上下文窗口大小（tokens），推断引擎提供默认值，用户可在设置页覆盖 */
  contextWindow?: number;
  repetitionPenalty?: number;
  reasoningSplit?: boolean;
  effort?: string;
  verbosity?: string;
}

export interface VendorConfig {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  rateLimitPerMinute?: number;
  defaultTimeoutMs?: number;
  notes?: string;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  sortOrder?: number;
  /** 供应商级别的 max_tokens 限制（API 最大允许值） */
  maxTokensLimit?: number;
  /** 供应商官网链接 */
  websiteUrl?: string;
}

export interface ModelProfile {
  id: string;
  vendorId: string;
  label: string;
  model: string;
  providerScope?: string;
  modelAdapter: string;
  status?: string;
  enabled: boolean;
  isMultimodal: boolean;
  isReasoning: boolean;
  isEmbedding: boolean;
  isReranker: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  enableThinking?: boolean;
  minP?: number;
  topK?: number;
  geminiApiVersion?: string;
  isBuiltin?: boolean;
  isReadOnly?: boolean;
  /** 是否收藏（收藏的模型在列表中优先显示） */
  isFavorite?: boolean;
  repetitionPenalty?: number;
  reasoningSplit?: boolean;
  effort?: string;
  verbosity?: string;
}

export interface ModelAssignments {
  model2_config_id: string | null;
  anki_card_model_config_id: string | null;
  qbank_ai_grading_model_config_id: string | null;
  embedding_model_config_id: string | null;
  reranker_model_config_id: string | null;
  chat_title_model_config_id: string | null;
  exam_sheet_ocr_model_config_id: string | null;
  translation_model_config_id: string | null;
  // 多模态知识库模型配置
  vl_embedding_model_config_id: string | null;  // 多模态嵌入模型（Qwen3-VL-Embedding）
  vl_reranker_model_config_id: string | null;   // 多模态重排序模型（Qwen3-VL-Reranker）
  memory_decision_model_config_id: string | null; // 记忆决策模型（smart write 去重判断）
}

// 子适配器类型（与后端 ADAPTER_REGISTRY 保持一致）
export type ModelAdapter = 
  | 'general'      // 通用 OpenAI 兼容（替代旧的 'openai'）
  | 'openai'       // 兼容旧版
  | 'google'       // Gemini
  | 'anthropic'    // Claude
  | 'deepseek'     // DeepSeek
  | 'qwen'         // 通义千问
  | 'zhipu'        // 智谱 GLM
  | 'doubao'       // 字节豆包
  | 'moonshot'     // Kimi/Moonshot
  | 'grok'         // xAI Grok
  | 'minimax'      // MiniMax
  | 'ernie'        // 百度文心
  | 'mistral'      // Mistral
  | 'custom';      // 自定义（兼容旧版）

// ============================================================================
// System Settings Types
// ============================================================================

export interface SystemSettings {
  autoSave: boolean;
  theme: 'light' | 'dark' | 'auto';
  language: string;
  enableNotifications: boolean;
  maxChatHistory: number;
  debugMode: boolean;
  enableAnkiConnect: boolean;
  markdownRendererMode: 'legacy' | 'enhanced';
}

// ============================================================================
// UI Component Types
// ============================================================================

export interface NotificationMessage {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  text: string;
  duration?: number;
  persistent?: boolean;
}

export interface StreamChunk {
  content: string;
  is_complete: boolean;
  chunk_id: string;
}

export interface StreamMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking_content?: string;
  /** Gemini 3 思维签名（工具调用必需） */
  thought_signature?: string;
  timestamp: string;
}

export interface StreamOptions {
  enableChainOfThought?: boolean;
  onChunk?: (chunk: string) => void;
  onThinking?: (thinking: string) => void;
  onComplete?: (fullResponse: string, thinkingContent?: string) => void;
  onError?: (error: string) => void;
  onProgress?: (progress: { content: string; thinking?: string }) => void;
}

// ============================================================================
// Batch Operations Types
// ============================================================================

export interface BatchOperationResult {
  success: boolean;
  processed_count: number;
  message: string;
}

// ============================================================================
// Database Query Types
// ============================================================================

export interface FullTextSearchRequest {
  search_term: string;
  limit?: number;
}

export interface DateRangeRequest {
  start_date: string; // RFC3339 format
  end_date: string;   // RFC3339 format
}

// ============================================================================
// Statistics Types
// ============================================================================

export interface Statistics {
  total_sessions: number;
  /** @deprecated 使用 total_sessions */
  total_mistakes?: number;
  total_reviews: number;
  type_stats: Record<string, number>;
  tag_stats: Record<string, number>;
  recent_sessions?: any[];
  /** @deprecated 使用 recent_sessions */
  recent_mistakes?: any[];
}

// ============================================================================
// File Management Types
// ============================================================================

export interface ImageFile {
  file: File;
  preview: string;
  id: string;
}

export interface FileUploadResult {
  success: boolean;
  path?: string;
  error?: string;
}

// ============================================================================
// Component Props Types
// ============================================================================

export interface BaseComponentProps {
  className?: string;
  children?: React.ReactNode;
}

export interface ModalProps extends BaseComponentProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
}

export interface FormProps extends BaseComponentProps {
  onSubmit: (data: any) => void | Promise<void>;
  loading?: boolean;
  disabled?: boolean;
}

export interface ListProps<T> extends BaseComponentProps {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  loading?: boolean;
  empty?: React.ReactNode;
}

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  total?: number;
}

// ============================================================================
// Error Handling Types
// ============================================================================

export interface AppError {
  type: 'validation' | 'network' | 'server' | 'unknown';
  message: string;
  details?: any;
  code?: string;
}

export type AsyncResult<T> = {
  data?: T;
  error?: AppError;
  loading: boolean;
};

// ============================================================================
// Hook Return Types
// ============================================================================

export interface UseApiConfigReturn {
  apiConfigs: ApiConfig[];
  modelAssignments: ModelAssignments;
  loading: boolean;
  saving: boolean;
  testingApi: string | null;
  loadApiConfigs: () => Promise<void>;
  saveApiConfigs: (configs: ApiConfig[]) => Promise<boolean>;
  saveModelAssignments: (assignments: ModelAssignments) => Promise<boolean>;
  testApiConnection: (config: ApiConfig) => Promise<boolean>;
  addApiConfig: (config: Omit<ApiConfig, 'id'>) => ApiConfig;
  updateApiConfig: (id: string, updates: Partial<ApiConfig>) => ApiConfig | undefined;
  deleteApiConfig: (id: string) => ApiConfig[];
  getMultimodalConfigs: () => ApiConfig[];
  getEnabledConfigs: () => ApiConfig[];
  getConfigById: (id: string | null) => ApiConfig | null;
  validateModelAssignments: () => string[];
}

export interface UseSystemSettingsReturn {
  settings: SystemSettings;
  loading: boolean;
  saving: boolean;
  loadSettings: () => Promise<void>;
  saveSetting: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => Promise<boolean>;
  saveAllSettings: (newSettings: SystemSettings) => Promise<boolean>;
  resetSettings: () => Promise<boolean>;
  updateSetting: <K extends keyof SystemSettings>(key: K, value: SystemSettings[K]) => void;
  updateSettings: (updates: Partial<SystemSettings>) => void;
  applyTheme: (theme: string) => Promise<boolean>;
  validateSettings: (settingsToValidate: Partial<SystemSettings>) => string[];
  getSettingsSummary: () => any;
  isAutoSaveEnabled: boolean;
  isDarkTheme: boolean;
  isDebugMode: boolean;
  markdownRendererMode: SystemSettings['markdownRendererMode'];
}

export interface UseNotificationReturn {
  notifications: NotificationMessage[];
  hasNotifications: boolean;
  showNotification: (type: NotificationMessage['type'], text: string, options?: any) => string;
  removeNotification: (id: string) => void;
  clearAllNotifications: () => void;
  updateNotification: (id: string, updates: Partial<Omit<NotificationMessage, 'id'>>) => void;
  showSuccess: (text: string, options?: any) => string;
  showError: (text: string, options?: any) => string;
  showWarning: (text: string, options?: any) => string;
  showInfo: (text: string, options?: any) => string;
  showLoading: (text: string, options?: any) => string;
  hasNotificationType: (type: NotificationMessage['type']) => boolean;
  getNotificationCount: (type?: NotificationMessage['type']) => number;
  showBatchResult: (results: { success: number; failed: number; total: number }, operation: string) => void;
  showOperationProgress: (operation: string, current: number, total: number) => string;
}

// ============================================================================
// Utility Types
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type KeyOf<T> = keyof T;

export type ValueOf<T> = T[keyof T];

// ============================================================================
// Event Types
// ============================================================================

export interface CustomEvent<T = any> {
  type: string;
  payload: T;
  timestamp: number;
}

export type EventHandler<T = any> = (event: CustomEvent<T>) => void;

// ============================================================================
// Theme Types
// ============================================================================

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  border: string;
  error: string;
  warning: string;
  success: string;
  info: string;
}

export interface Theme {
  name: string;
  colors: ThemeColors;
  spacing: {
    xs: string;
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };
  typography: {
    fontFamily: string;
    fontSize: {
      xs: string;
      sm: string;
      md: string;
      lg: string;
      xl: string;
    };
  };
  borderRadius: string;
  shadows: {
    sm: string;
    md: string;
    lg: string;
  };
}



// ============================================================================
// Anki Card Generation Types
// ============================================================================

export interface AnkiCard {
  id?: string; // 供导出/删除等功能使用
  task_id?: string;
  front: string;
  back: string;
  text?: string; // 填空题使用的字段
  tags: string[];
  images: string[];
  // ★ 新增：完整字段映射，支持任意字段模板
  fields?: Record<string, string>;
  extra_fields?: Record<string, string>;
  template_id?: string | null;
  is_error_card?: boolean;
  error_content?: string | null;
  created_at?: string;
  updated_at?: string;
  streamHtml?: string;
}

export interface AnkiLibraryCard extends AnkiCard {
  id: string;
  task_id: string;
  source_type?: string | null;
  source_id?: string | null;
  template_id?: string | null;
  extra_fields?: Record<string, string>;
  tags: string[];
  images: string[];
  created_at: string;
  updated_at: string;
}

export interface AnkiLibraryListResponse {
  items: AnkiLibraryCard[];
  page: number;
  page_size: number;
  total: number;
}

export interface ListAnkiCardsParams {
  template_id?: string;
  search?: string;
  page?: number;
  page_size?: number;
}

export interface ExportAnkiCardsResult {
  file_path: string;
  size_bytes: number;
  format: 'apkg' | 'json';
}

export interface ChatAnkiCardsMeta {
  status?: 'parsing' | 'ready' | 'error' | 'stored' | 'exported' | 'discarded';
  templateId?: string;
  cards?: AnkiCard[];
  error?: {
    message?: string;
    chunk?: string;
  };
  lastUpdatedAt?: number;
  lastAction?: 'save' | 'export' | 'import' | 'discard';
}

export interface ChatAnkiModeMeta {
  enabled?: boolean;
  templateId?: string;
  options?: AnkiGenerationOptions;
  attachmentTrimmed?: boolean;
  reason?: string;
}

export interface ChatAnkiCardsErrorMeta {
  message?: string;
  chunk?: string;
  resolved?: boolean;
  timestamp?: number;
}

// Anki卡片模板定义
export interface AnkiCardTemplate {
  id: string;
  name: string;
  description: string;
  preview_front: string;
  preview_back: string;
  preview_data_json?: string; // 预览数据JSON字符串
  front_template: string;
  back_template: string;
  css_style: string;
  note_type: string; // 对应的Anki笔记类型
  generation_prompt: string; // 每个模板专门的生成prompt
  fields: string[]; // 模板包含的字段列表
}

// 自定义 Anki 模板系统类型定义
export type FieldType = 'Text' | 'Array' | 'Number' | 'Boolean' | 'Date' | 'RichText' | 'Formula';

// 验证规则 - 支持SOTA级别的字段验证
export interface ValidationRule {
  pattern?: string;           // 正则表达式
  min?: number;              // 最小值（数字或长度）
  max?: number;              // 最大值（数字或长度）  
  enum_values?: any[];       // 枚举值
  custom?: string;           // 自定义验证函数名
  error_message?: string;    // 自定义错误消息
}

// 转换规则 - 支持字段值的智能转换
export interface TransformRule {
  transform_type: 'uppercase' | 'lowercase' | 'titlecase' | 'trim' | 'split' | 'join' | 'date_format' | 'custom';
  options?: Record<string, any>;
}

// 对象结构定义 - 支持复杂嵌套结构
export interface ObjectSchema {
  properties: Record<string, FieldExtractionRule>;
  required?: string[];
}

export interface FieldExtractionRule {
  field_type: FieldType;
  is_required: boolean;
  default_value?: any;
  validation_pattern?: string; // 向后兼容：保留旧的验证模式
  description: string;
  
  // 新增SOTA级别功能
  validation?: ValidationRule;      // 增强验证规则
  transform?: TransformRule;        // 转换规则
  schema?: ObjectSchema;            // Object类型的结构定义
  item_schema?: ObjectSchema;       // ArrayObject的项目结构
  display_format?: string;          // 显示格式模板
  ai_hint?: string;                 // AI生成提示
  extract_pattern?: string;         // 提取模式（正则或JSONPath）
}

export interface CustomAnkiTemplate {
  id: string;
  name: string;
  description: string;
  author?: string;
  version: string;
  preview_front: string;
  preview_back: string;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules: Record<string, FieldExtractionRule>;
  created_at: string;
  preview_data_json?: string;
  updated_at: string;
  is_active: boolean;
  is_built_in: boolean;
}

export interface CreateTemplateRequest {
  name: string;
  description: string;
  author?: string;
  version?: string;
  is_active?: boolean;
  preview_front: string;
  preview_back: string;
  preview_data_json?: string;
  note_type: string;
  fields: string[];
  generation_prompt: string;
  front_template: string;
  back_template: string;
  css_style: string;
  field_extraction_rules: Record<string, FieldExtractionRule>;
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  expected_version?: string;
  preview_front?: string;
  preview_back?: string;
  preview_data_json?: string;
  note_type?: string;
  fields?: string[];
  generation_prompt?: string;
  front_template?: string;
  back_template?: string;
  css_style?: string;
  field_extraction_rules?: Record<string, FieldExtractionRule>;
  is_active?: boolean;
}

export interface TemplateImportRequest {
  template_data: string; // JSON格式的模板数据
  overwrite_existing: boolean;
}

export interface TemplateExportResponse {
  template_data: string; // JSON格式的模板数据
}

export interface AnkiGenerationOptions {
  deck_name: string;
  note_type: string;
  enable_images: boolean;
  max_cards_per_source: number;
  /** @deprecated 使用 max_cards_per_source */
  max_cards_per_mistake?: number;
  /** ChatAnki 全流程总上限（可选） */
  max_cards_total?: number;
  max_tokens?: number;
  temperature?: number;
  template_id?: string;
  custom_anki_prompt?: string;
  template_fields?: string[];
  field_extraction_rules?: Record<string, FieldExtractionRule>;
  template_fields_by_id?: Record<string, string[]>;
  field_extraction_rules_by_id?: Record<string, Record<string, FieldExtractionRule>>;
  custom_requirements?: string;
  segment_overlap_size?: number;
  system_prompt?: string;
}

export interface AnkiDocumentGenerationRequest {
  document_content: string;
  original_document_name?: string;
  options?: AnkiGenerationOptions;
}

export interface AnkiDocumentGenerationResponse {
  success: boolean;
  cards: AnkiCard[];
  error_message?: string;
}

export interface AnkiCardGenerationResponse {
  success: boolean;
  cards: AnkiCard[];
  error_message?: string;
}

export interface AnkiExportResponse {
  success: boolean;
  file_path?: string;
  card_count: number;
  error_message?: string;
}

export interface AnkiConnectResult {
  success: boolean;
  result?: any;
  error?: string;
}

// ============================================================================
// RAG Knowledge Base Types
// ============================================================================

// ============================================================================
// Export all types for easy importing
// ============================================================================

// 所有类型都已经在上面定义并导出，无需重复导出

export interface ExamSheetSessionLinkResponse {
  success: boolean;
}

export interface ExamSheetSessionUnlinkRequest {
  session_id: string;
  card_id?: string | null;
  /** @deprecated 2026-01 清理：错题功能已废弃，保留兼容 */
  mistake_id?: string;
}

export interface ExamSheetSessionUnlinkResponse {
  detail: ExamSheetSessionDetail;
}

export interface PdfOcrTextBlock {
  text: string;
  bbox: ExamCardBBox;
}

export interface PdfOcrPageResult {
  page_index: number;
  width: number;
  height: number;
  image_path?: string | null;
  blocks: PdfOcrTextBlock[];
}

export interface PdfOcrResult {
  session_id: string;
  source_pdf_path: string;
  pdfstream_url: string;
  page_results: PdfOcrPageResult[];
}
