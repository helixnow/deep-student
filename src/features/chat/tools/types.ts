/**
 * Chat V2 - 工具类型定义
 *
 * 定义统一工具注入系统的核心类型。
 * 遵循文档 26：统一工具注入系统架构设计。
 */

// ============================================================================
// 工具分类
// ============================================================================

/**
 * 工具分类枚举
 */
export type ToolCategory =
  | 'context_bound' // 上下文绑定工具（如 Canvas note_*, Card card_*）
  | 'mcp' // MCP 外部工具
  | 'agent' // Agent 控制工具（如 attempt_completion, todo_*）
  | 'custom'; // 自定义工具（未来扩展）

// ============================================================================
// 工具定义
// ============================================================================

/**
 * Schema 工具定义
 *
 * 用于注册工具的元数据，包含工具 ID、名称、描述、Schema 等。
 */
export interface ToolDefinition {
  /** 工具唯一 ID（全局唯一，前后端一致）*/
  id: string;

  /** 工具名称（OpenAI Function Calling 中的 name）*/
  name: string;

  /** 工具描述 */
  description: string;

  /** OpenAI Function Calling Schema (JSON) */
  schema: ToolSchema;

  /** 工具分类 */
  category: ToolCategory;

  /** 关联的上下文类型（可选）*/
  associatedContextTypes?: string[];
}

/**
 * OpenAI Function Calling Schema
 *
 * @deprecated 使用 skills/types.ts 中的 ToolSchema 替代。
 * 此接口保留以兼容旧代码，新代码应使用 FunctionCallingSchema。
 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterSchema>;
      required?: string[];
    };
  };
}

/**
 * OpenAI Function Calling Schema（显式命名，避免与 skills/types.ts 的 ToolSchema 混淆）
 */
export type FunctionCallingSchema = ToolSchema;

/**
 * 工具参数 Schema
 */
export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
}

// ============================================================================
// 工具执行
// ============================================================================

/**
 * 工具执行上下文
 */
export interface ToolExecutionContext {
  /** 会话 ID */
  sessionId: string;
  /** 消息 ID */
  messageId: string;
  /** Canvas 笔记 ID（Canvas 工具需要）*/
  canvasNoteId?: string;
}

/**
 * 工具执行结果
 */
export interface ToolExecutionResult {
  /** 是否执行成功 */
  success: boolean;
  /** 执行结果数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 使用统计（可选）*/
  usage?: unknown;
}
