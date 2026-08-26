/**
 * CardForge 2.0 - 核心类型定义
 *
 * 遵循 LLM-First 设计原则，所有类型都支持 JSON 序列化
 */

// ============================================================================
// 基础类型
// ============================================================================

/** 任务状态枚举 */
export type TaskStatus =
  | 'pending'      // 待处理
  | 'processing'   // 处理中
  | 'streaming'    // 流式输出中
  | 'paused'       // 已暂停
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'truncated'    // 已截断
  | 'cancelled';   // 已取消

/** 导出格式 */
export type ExportFormat = 'apkg' | 'anki_connect' | 'json';

/** 任务控制动作 */
export type TaskAction = 'pause' | 'resume' | 'retry' | 'cancel';

// ============================================================================
// CardAgent 工具接口类型
// ============================================================================

/** generate_cards 输入 */
export interface GenerateCardsInput {
  /** 学习材料内容 */
  content: string;
  /** 可选，指定使用的模板 ID 列表 */
  templates?: string[];
  /**
   * 可选，本次生成的卡片**总数**上限（跨全部分段的全局额度，
   * 写入后端 max_cards_total，由后端按分段分配）。
   * 必须是 ≥1 的有限数；0/负数/NaN 非法，非法或缺省时回退默认 50。
   */
  maxCards?: number;
  /** 高级选项 */
  options?: {
    deckName?: string;
    noteType?: string;
    maxConcurrency?: number;
    customRequirements?: string;
    /**
     * 是否将本地 FSRS 复习画像注入制卡 prompt（0824 隐私收口）。
     * 注入文本会随生成请求发送到所配置的模型端点（远端模型下即离开本机），
     * 因此默认 **false**；只有调用方显式传 true 才向后端发出授权
     * （后端同样只认显式 Some(true)，注入内容默认仅匿名聚合统计，
     * 不含历史卡片原文摘要）。
     */
    fsrsFeedback?: boolean;
  };
}

/** generate_cards 输出 */
export interface GenerateCardsOutput {
  ok: boolean;
  /** 文档会话 ID */
  documentId?: string;
  /** 是否因暂停提前结束 */
  paused?: boolean;
  /** 是否因空闲超时结束（ok 应为 false） */
  timedOut?: boolean;
  /** 生成的卡片列表 */
  cards?: AnkiCardResult[];
  /** 统计信息 */
  stats?: GenerationStats;
  /** 错误信息 */
  error?: string;
}

/** 生成统计 */
export interface GenerationStats {
  totalCards: number;
  segments: number;
  templatesUsed: string[];
  durationMs: number;
  successCount: number;
  failedCount: number;
}

/** control_task 输入 */
export interface ControlTaskInput {
  action: TaskAction;
  documentId: string;
  taskId?: string;
}

/** control_task 输出 */
export interface ControlTaskOutput {
  ok: boolean;
  message: string;
  /** 当前任务状态列表 */
  tasks?: TaskInfo[];
}

/** export_cards 输入 */
export interface ExportCardsInput {
  cards: AnkiCardResult[];
  format: ExportFormat;
  deckName: string;
  noteType?: string;
}

/** export_cards 输出 */
export interface ExportCardsOutput {
  ok: boolean;
  /** APKG 格式时返回文件路径 */
  filePath?: string;
  /** AnkiConnect 格式时返回导入数量 */
  importedCount?: number;
  /** AnkiConnect 格式时：已存在（重复跳过）的数量 */
  duplicateCount?: number;
  /** AnkiConnect 格式时：导入失败的数量 */
  failedCount?: number;
  /** 实际参与导出的卡片数（排除错误卡/空卡后的数量） */
  exportedCount?: number;
  /** 导出前校验结果（含空卡/缺字段等警告，供 UI 内联展示） */
  validation?: ExportCardsValidationResult;
  error?: string;
}

// ============================================================================
// 导出前校验类型
// ============================================================================

/** 导出前校验问题代码 */
export type ExportCardIssueCode =
  | 'empty_card'        // 正反面与全部字段均为空
  | 'missing_front'     // 缺少正面内容（且无字段可回退）
  | 'missing_back'      // 缺少背面内容（且无字段可回退）
  | 'error_card'        // 错误卡（生成失败/截断产物）
  | 'missing_field';    // 模板必填字段为空

/** 校验问题严重级别：error 会被排除出导出集合，warning 仅提示 */
export type ExportCardIssueLevel = 'error' | 'warning';

/** 单条导出校验问题（供 UI 内联展示） */
export interface ExportCardValidationIssue {
  /** 卡片在输入数组中的下标 */
  index: number;
  /** 卡片 ID（若有） */
  cardId?: string;
  code: ExportCardIssueCode;
  level: ExportCardIssueLevel;
  /** 出问题的字段名（missing_field 时有值） */
  field?: string;
  /** 人类可读描述（已本地化） */
  message: string;
}

/** 导出前校验结果 */
export interface ExportCardsValidationResult {
  /** 是否存在阻断导出的 error 级问题（全部卡片均无法导出时为 false） */
  ok: boolean;
  /** 输入卡片总数 */
  totalCount: number;
  /** 通过校验、可导出的卡片数 */
  exportableCount: number;
  /** 全部问题明细（error + warning） */
  issues: ExportCardValidationIssue[];
}

/** list_templates 输入 */
export interface ListTemplatesInput {
  category?: string;
  activeOnly?: boolean;
}

/** list_templates 输出 */
export interface ListTemplatesOutput {
  templates: TemplateInfo[];
}

/** analyze_content 输入 */
export interface AnalyzeContentInput {
  content: string;
}

/** analyze_content 输出 */
export interface AnalyzeContentOutput {
  estimatedSegments: number;
  estimatedCards: number;
  suggestedTemplates: Array<{
    templateId: string;
    reason: string;
    estimatedUsage: number;
  }>;
  contentTypes: string[];
}

// ============================================================================
// 分段引擎类型
// ============================================================================

/**
 * 分段配置
 *
 * 注意：前端 SegmentEngine 只做纯数学的 token 估算分段；LLM 语义定界
 * 由后端生成管线执行，历史上的 boundaryContext/boundaryModel 配置项
 * 已随前端 LLM 定界死代码一起删除。
 */
export interface SegmentConfig {
  /** 每个子任务的目标大小（tokens） */
  chunkSize: number;
  /** 最小分段大小（tokens） */
  minSegmentSize: number;
}

/** 默认分段配置 */
export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  chunkSize: 50000,
  minSegmentSize: 5000,
};

/** 硬分割点 */
export interface HardSplitPoint {
  /** 字符位置 */
  position: number;
  /** 原始索引 */
  index: number;
}

/** 文档分段 */
export interface DocumentSegment {
  /** 分段索引 */
  index: number;
  /** 起始位置 */
  startPosition: number;
  /** 结束位置 */
  endPosition: number;
  /** 分段内容 */
  content: string;
  /** 估算 token 数 */
  estimatedTokens: number;
}

// ============================================================================
// 制卡引擎类型
// ============================================================================

/** 制卡任务 */
export interface CardGenerationTask {
  /** 任务 ID */
  taskId: string;
  /** 文档 ID */
  documentId: string;
  /** 分段索引 */
  segmentIndex: number;
  /** 分段内容 */
  content: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 可用模板列表 */
  availableTemplates: TemplateInfo[];
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 错误信息 */
  errorMessage?: string;
  /** 重试次数 */
  retryCount: number;
}

/** 任务信息（简化版，用于查询） */
export interface TaskInfo {
  taskId: string;
  segmentIndex: number;
  status: TaskStatus;
  cardsGenerated: number;
  errorMessage?: string;
}

/** 并发控制配置 */
export interface ConcurrencyConfig {
  /** 最大并发数 */
  maxConcurrency: number;
  /** 任务间延迟（ms） */
  taskDelay: number;
  /** 单任务超时（ms） */
  taskTimeout: number;
}

/** 默认并发配置 */
export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
  maxConcurrency: 5,
  taskDelay: 100,
  taskTimeout: 300000, // 5 分钟
};

// ============================================================================
// 卡片类型
// ============================================================================

/** 生成的 Anki 卡片 */
export interface AnkiCardResult {
  /** 卡片 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 使用的模板 ID */
  templateId: string;
  /** 正面内容 */
  front: string;
  /** 背面内容 */
  back: string;
  /** Cloze 填空文本 */
  text?: string;
  /** 标签 */
  tags: string[];
  /** 扩展字段 */
  fields: Record<string, string>;
  /** 图片列表 */
  images: string[];
  /** 是否为错误卡片 */
  isErrorCard: boolean;
  /** 错误内容（用于修复） */
  errorContent?: string;
  /** 创建时间 */
  createdAt: string;
  /** LLM 置信度 */
  confidence?: number;
  /** 元数据 */
  metadata?: {
    sourceSegment: number;
    generationModel?: string;
  };
}

// ============================================================================
// 模板类型
// ============================================================================

/** 字段提取规则 */
export interface FieldExtractionRule {
  field_type: string;
  is_required: boolean;
  description?: string;
}

/** 模板信息 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  fields: string[];
  noteType: string;
  isActive: boolean;
  /** 复杂度等级 */
  complexityLevel?: 'simple' | 'moderate' | 'complex' | 'very_complex';
  /** 适用场景描述（供 LLM 选择） */
  useCaseDescription?: string;
  /** 字段提取规则 - 必须传递给后端用于解析AI生成的JSON */
  field_extraction_rules?: Record<string, FieldExtractionRule>;
  /** 🔧 修复：生成提示词 - 指导 LLM 如何构造模板特定字段 */
  generation_prompt?: string;
}

/** 模板选择上下文（传递给 LLM） */
export interface TemplateSelectionContext {
  /** 可用模板列表 */
  templates: TemplateInfo[];
  /** 当前分段信息 */
  segmentInfo: {
    index: number;
    total: number;
    estimatedTokens: number;
  };
  /** 用户偏好 */
  userPreferences?: {
    preferredTemplates?: string[];
    maxCardsPerSegment?: number;
  };
}

// ============================================================================
// 事件类型
// ============================================================================

/** CardForge 事件类型 */
export type CardForgeEventType =
  | 'segment:start'
  | 'segment:complete'
  | 'segment:error'
  | 'task:start'
  | 'task:progress'
  | 'task:complete'
  | 'task:error'
  | 'task:paused'
  | 'task:resumed'
  | 'card:generated'
  | 'card:error'
  | 'document:start'
  | 'document:complete'
  | 'document:paused'
  | 'document:cancelled'
  | 'rate:limit';

/** API 频率限制警告事件 payload（对齐后端 RateLimitWarning） */
export interface RateLimitWarningPayload {
  message: string;
  retryAfterSeconds?: number;
}

/** 事件基础结构 */
export interface CardForgeEvent<T = unknown> {
  type: CardForgeEventType;
  documentId: string;
  timestamp: string;
  payload: T;
}

/** 卡片生成事件 payload */
export interface CardGeneratedPayload {
  card: AnkiCardResult;
  taskId: string;
  segmentIndex: number;
}

/** 任务进度事件 payload */
export interface TaskProgressPayload {
  taskId: string;
  segmentIndex: number;
  status: TaskStatus;
  progress: number;
  cardsGenerated: number;
}

/** 文档完成事件 payload */
export interface DocumentCompletePayload {
  totalCards: number;
  totalSegments: number;
  successfulTasks: number;
  failedTasks: number;
  durationMs: number;
}

// ============================================================================
// 错误类型
// ============================================================================

/** CardForge 错误代码 */
export type CardForgeErrorCode =
  | 'INVALID_INPUT'
  | 'SEGMENT_FAILED'
  | 'GENERATION_FAILED'
  | 'TEMPLATE_NOT_FOUND'
  | 'LLM_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BACKEND_ERROR'
  | 'UNKNOWN';

/** CardForge 错误 */
export interface CardForgeError {
  code: CardForgeErrorCode;
  message: string;
  details?: unknown;
  taskId?: string;
  segmentIndex?: number;
}

// ============================================================================
// 回调类型
// ============================================================================

/** 事件监听器 */
export type CardForgeEventListener<T = unknown> = (event: CardForgeEvent<T>) => void;

/** 进度回调 */
export type ProgressCallback = (progress: {
  phase: 'segmenting' | 'generating';
  current: number;
  total: number;
  message: string;
}) => void;
