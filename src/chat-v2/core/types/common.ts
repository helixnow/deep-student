/**
 * Chat V2 - 公共类型定义
 * 
 * 这些类型被多个模块共享，定义在此处避免循环依赖。
 */

// ========== 会话状态 ==========

/**
 * 会话状态机
 * - idle: 空闲，可执行所有操作
 * - streaming: 流式生成中，只允许 abort
 * - aborting: 中断中，等待完成
 */
// 🔒 审计修复: 添加 'sending' 状态，用于 canSend() 通过后到 streaming 之间的异步窗口
export type SessionStatus = 'idle' | 'sending' | 'streaming' | 'aborting';

// ========== 块状态 ==========

/**
 * 块状态机
 * - pending: 等待开始
 * - running: 进行中（流式/执行中）
 * - success: 成功完成
 * - error: 失败
 */
export type BlockStatus = 'pending' | 'running' | 'success' | 'error';

/**
 * 块类型（可扩展，通过注册表管理）
 */
export type BlockType =
  // 流式内容块
  | 'thinking'      // 思维链
  | 'content'       // 正文
  // 知识检索块
  | 'rag'           // 文档知识库 RAG
  | 'memory'        // 用户记忆
  | 'web_search'    // 网络搜索
  | 'multimodal_rag' // 多模态知识库
  // 工具调用块
  | 'mcp_tool'      // MCP 工具调用
  | 'image_gen'     // 图片生成
  // 特殊功能块
  | 'anki_cards'    // Anki 卡片生成
  // 多 Agent 协作块
  | 'workspace_status' // 工作区状态面板
  | 'subagent_retry'   // 🆕 P38: 子代理重试提醒块
  // 系统提示块
  | 'tool_limit'    // 工具递归限制提示
  // 插件扩展
  | string;

// ========== 面板状态 ==========

/**
 * 输入框面板状态
 */
export interface PanelStates {
  /** RAG 知识库面板 */
  rag: boolean;
  /** MCP 工具面板 */
  mcp: boolean;
  /** 搜索引擎面板 */
  search: boolean;
  /** 学习模式面板 */
  learn: boolean;
  /** 模型选择面板 */
  model: boolean;
  /** 高级设置面板 */
  advanced: boolean;
  /** 附件面板 */
  attachment: boolean;
  /** 技能选择面板 */
  skill: boolean;
}

/**
 * 创建默认面板状态
 */
export function createDefaultPanelStates(): PanelStates {
  return {
    rag: false,
    mcp: false,
    search: false,
    learn: false,
    model: false,
    advanced: false,
    attachment: false,
    skill: false,
  };
}

// ========== 对话参数 ==========

/**
 * 对话参数配置
 */
export interface ChatParams {
  /** 当前选择的模型 ID（API 配置 ID，用于后端调用） */
  modelId: string;
  /** 模型显示名称（如 "Qwen/Qwen3-8B"，用于前端显示） */
  modelDisplayName?: string;
  /** 温度（0-2，默认 0.7） */
  temperature: number;
  /** Top-P 核采样（0-1，默认 0.9） */
  topP: number;
  /** 频率惩罚（-2 到 2，默认 0） */
  frequencyPenalty: number;
  /** 存在惩罚（-2 到 2，默认 0） */
  presencePenalty: number;
  /** 最大输出 tokens */
  maxTokens: number;
  /** 上下文窗口上限（tokens） */
  contextLimit?: number;
  /** 启用推理/思维链 */
  enableThinking: boolean;
  /** 禁用工具调用 */
  disableTools: boolean;
  /** 模型 2 覆盖（用于特定场景） */
  model2OverrideId: string | null;
  /** RAG 检索数量（Top-K） */
  ragTopK?: number;
  /** RAG 启用重排序（Rerank）*/
  ragEnableReranking?: boolean;
  /** RAG 选中的知识库 ID 列表 */
  ragLibraryIds?: string[];
  /** 学习模式提示词（启用学习模式时使用） */
  learnModePrompt?: string;
  /** 选中的 MCP 服务器 ID 列表 */
  selectedMcpServers?: string[];
  /** 选中的搜索引擎 ID 列表 */
  selectedSearchEngines?: string[];
  /** 工具递归最大深度（1-100，默认 30） */
  maxToolRecursion?: number;
  /** 启用多模态知识库检索 */
  multimodalRagEnabled?: boolean;
  /** 多模态检索数量（Top-K），默认 10 */
  multimodalTopK?: number;
  /** 多模态检索启用精排 */
  multimodalEnableReranking?: boolean;
  /** 多模态检索知识库 ID 过滤 */
  multimodalLibraryIds?: string[];
  
  // ★ 2026-01 简化：VFS RAG 作为唯一知识检索方案，移除 vfsRagEnabled 开关
  // ragTopK 和 ragEnableReranking 直接用于 VFS RAG 检索

  /**
   * 🆕 图片压缩策略（用于多模态消息）
   * - 'low': 最大 768px，JPEG 60%，适用于大量图片/PDF 概览
   * - 'medium': 最大 1024px，JPEG 75%，适用于一般理解
   * - 'high': 不压缩，适用于 OCR/细节识别
   * - 'auto': 智能策略（默认，不设置时生效）：
   *   - 单图 + 非 PDF：high
   *   - 2-5 张图：medium
   *   - 6+ 张图或 PDF/教材：low
   */
  visionQuality?: 'low' | 'medium' | 'high' | 'auto';
}

/**
 * 创建默认对话参数
 */
export function createDefaultChatParams(): ChatParams {
  return {
    modelId: '',
    modelDisplayName: '',
    temperature: 0.7,
    topP: 0.9,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 32768,
    enableThinking: true,
    disableTools: false,
    model2OverrideId: null,
    maxToolRecursion: 30,
  };
}

// ========== 附件 ==========

/**
 * 图片注入模式
 * - image: 注入原始图片（多模态模型可用）
 * - ocr: 注入 OCR 识别的文本
 */
export type ImageInjectMode = 'image' | 'ocr';

/**
 * PDF 注入模式
 * - text: 注入解析提取的文本
 * - ocr: 注入 OCR 识别的文本（按页）
 * - image: 注入页面图片（多模态模型可用）
 */
export type PdfInjectMode = 'text' | 'ocr' | 'image';

/**
 * 附件注入模式配置
 */
export interface AttachmentInjectModes {
  /** 图片注入模式（支持多选） */
  image?: ImageInjectMode[];
  /** PDF 注入模式（支持多选） */
  pdf?: PdfInjectMode[];
}

/**
 * 默认图片注入模式
 */
export const DEFAULT_IMAGE_INJECT_MODES: ImageInjectMode[] = ['image'];

/**
 * 默认 PDF 注入模式
 */
export const DEFAULT_PDF_INJECT_MODES: PdfInjectMode[] = ['text'];

/** 媒体类型 */
export type MediaType = 'pdf' | 'image';

/** 处理阶段（包括 PDF 和图片） */
export type ProcessingStageType = 
  | 'pending'
  | 'text_extraction'     // PDF 专用
  | 'page_rendering'      // PDF 专用
  | 'page_compression'    // PDF 专用
  | 'image_compression'   // 图片专用
  | 'ocr_processing'      // 共享
  | 'vector_indexing'     // 共享
  | 'completed'
  | 'error';

/**
 * 媒体处理状态（PDF + 图片）
 * 用于跟踪媒体预处理流水线的进度
 */
export interface PdfProcessingStatus {
  /** 当前处理阶段 */
  stage?: ProcessingStageType;
  /** 当前处理的页码（PDF 渲染/OCR 时使用，图片始终为 1） */
  currentPage?: number;
  /** 总页数（PDF 专用，图片始终为 1） */
  totalPages?: number;
  /** 总进度百分比 (0-100) */
  percent?: number;
  /** 已就绪的注入模式 */
  readyModes?: Array<'text' | 'ocr' | 'image'>;
  /** 错误信息（error 状态时填充） */
  error?: string;
  /** 媒体类型（v2.0 新增） */
  mediaType?: MediaType;
}

/**
 * 附件元数据
 */
export interface AttachmentMeta {
  id: string;
  name: string;
  type: 'image' | 'document' | 'audio' | 'video' | 'other';
  mimeType: string;
  size: number;
  /** 图片/文档的预览 URL 或 base64 */
  previewUrl?: string;
  /** 上传状态（改造：增加 processing 状态） */
  status: 'pending' | 'uploading' | 'processing' | 'ready' | 'error';
  /** 错误信息 */
  error?: string;
  /** 🆕 关联的资源 ID（用于统一上下文注入系统） */
  resourceId?: string;
  /** ★ P0 修复：文件 ID（att_xxx），用于重试等操作 */
  sourceId?: string;
  /** 🆕 注入模式配置（用户显式选择） */
  injectModes?: AttachmentInjectModes;
  /** 🆕 PDF 处理状态（仅 PDF 文件使用） */
  processingStatus?: PdfProcessingStatus;
  /** 上传进度 (0-100)，仅在 uploading 状态有效 */
  uploadProgress?: number;
  /** 上传阶段，仅在 uploading 状态有效 */
  uploadStage?: 'reading' | 'uploading' | 'creating';
}

// ========== Token 使用统计 ==========

/**
 * Token 来源类型
 * - api: LLM API 返回的精确值（最高优先级）
 * - tiktoken: 使用 tiktoken 库估算（中等优先级）
 * - heuristic: 启发式规则估算（最低优先级）
 * - mixed: 多轮累加时来源混合
 */
export type TokenSource = 'api' | 'tiktoken' | 'heuristic' | 'mixed';

/**
 * Token 使用统计
 * 用于记录 LLM 调用的 token 消耗情况
 */
export interface TokenUsage {
  /** 输入 token 数量（prompt） */
  promptTokens: number;

  /** 输出 token 数量（completion） */
  completionTokens: number;

  /** 总计 token 数量 */
  totalTokens: number;

  /** 
   * 数据来源
   * - api: LLM API 返回的精确值
   * - tiktoken: 使用 tiktoken 库估算
   * - heuristic: 启发式规则估算
   * - mixed: 多轮累加时来源混合
   */
  source: TokenSource;

  /** 思维链 token 数量（可选，部分 API 独立返回，如 DeepSeek） */
  reasoningTokens?: number;

  /** 缓存命中的 token（可选，某些 API 支持，如 Anthropic） */
  cachedTokens?: number;

  /** 最后一轮请求的 prompt token（上下文窗口使用量） */
  lastRoundPromptTokens?: number;
}
