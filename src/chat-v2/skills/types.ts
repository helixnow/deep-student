/**
 * Chat V2 - Skills 系统类型定义
 *
 * Skills 系统类型定义
 * 复用现有 contextRef 注入系统
 *
 * 2026-01-20: 新增渐进披露架构支持
 * - ToolSchema: 工具 Schema 类型定义
 * - embeddedTools: Skill 内嵌工具定义
 *
 * 2026-01-22: 新增技能类型分类
 * - SkillType: 区分整合型和独立型技能
 */

// ============================================================================
// 工具 Schema 类型定义（用于渐进披露架构）
// ============================================================================

/**
 * JSON Schema 属性定义
 */
export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  /** JSON Schema 数值约束 */
  minimum?: number;
  maximum?: number;
  /** JSON Schema 数组约束 */
  minItems?: number;
  maxItems?: number;
  /** JSON Schema anyOf/oneOf 支持 */
  anyOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
}

/**
 * 工具输入 Schema（JSON Schema 格式）
 */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * 工具 Schema 定义
 *
 * 用于在 SKILL.md 的 frontmatter 中嵌入工具定义，
 * 实现渐进披露：只有激活 Skill 时才加载对应工具。
 */
export interface ToolSchema {
  /** 工具名称（需与后端 Executor 匹配，如 builtin-unified_search） */
  name: string;

  /** 工具描述，告诉 LLM 何时使用此工具 */
  description: string;

  /** 输入参数 Schema（JSON Schema 格式） */
  inputSchema: ToolInputSchema;
}

// ============================================================================
// Skill 类型定义
// ============================================================================

/**
 * 技能类型
 *
 * - composite (整合型): 内部引用其他 skills，是多个工具组的组合入口
 *   典型例子：研究模式、学习模式等，会提示用户加载子技能组
 *
 * - standalone (独立型): 不依赖其他 skills，自身是最小的工具集合
 *   典型例子：知识检索、笔记工具等，提供独立的工具能力
 *
 * 默认为 standalone（向后兼容）
 */
export type SkillType = 'composite' | 'standalone';

// ============================================================================
// Skill 元数据（从 SKILL.md frontmatter 解析）
// ============================================================================

/**
 * Skill 元数据
 * 对应 SKILL.md 文件的 YAML frontmatter
 *
 * SKILL.md 规范：
 * - name: 小写字母+数字+连字符，≤64字符，不含保留字
 * - description: ≤1024字符，用于 LLM 自动发现和激活
 */
export interface SkillMetadata {
  /** 唯一 ID（通常为目录名，小写字母+数字+连字符） */
  id: string;

  /**
   * 技能名称
   * - 只允许小写字母、数字、连字符
   * - 最大 64 字符
   * - 不能包含保留字（deep-student）
   */
  name: string;

  /**
   * 功能描述（≤1024 字符）
   *
   * 这是 LLM 发现何时使用此技能的关键字段，应包含：
   * - 核心功能说明
   * - 适用场景和触发条件
   * - 支持的文件类型（如适用）
   * - 任务类型关键词
   */
  description: string;

  /** 版本号（可选，如 "1.0.0"） */
  version?: string;

  /** 作者（可选） */
  author?: string;

  /**
   * 优先级（默认 3）
   *
   * 优先级值越小越靠前：
   * - system_prompt: 1
   * - user_preference: 2
   * - skill_instruction: 3 (默认)
   * - note: 10
   */
  priority?: number;

  /**
   * 限制可访问的工具列表
   *
   * SKILL.md 规范的 allowed-tools 字段
   * 例如：['Read', 'Grep', 'Bash'] 允许读取但限制写入
   */
  allowedTools?: string[];

  /**
   * @deprecated 使用 allowedTools 代替
   * 保留用于向后兼容
   */
  tools?: string[];

  /**
   * 是否禁止 LLM 自动调用
   *
   * 设为 true 时，skill 只能通过 /skill 命令或 UI 手动激活，
   * 不会出现在 <available_skills> 元数据中供 LLM 自动推荐。
   *
   * 注：Anthropic 官方 Skills 默认自动激活，此为 Deep Student 扩展功能
   */
  disableAutoInvoke?: boolean;

  /**
   * 内嵌工具定义（渐进披露架构核心字段）
   *
   * 用于在 SKILL.md 中直接定义该 Skill 提供的工具 Schema。
   * 当 Skill 被激活时，这些工具会被注入到 LLM 请求中。
   *
   * 与 allowedTools 的区别：
   * - allowedTools: 引用已存在的工具名称，用于权限过滤
   * - embeddedTools: 直接嵌入完整的工具 Schema 定义
   *
   * 示例：
   * ```yaml
   * embeddedTools:
   *   - name: builtin-unified_search
   *     description: 统一搜索本地知识
   *     inputSchema:
   *       type: object
   *       properties:
   *         query: { type: string, description: 搜索查询 }
   *       required: [query]
   * ```
   */
  embeddedTools?: ToolSchema[];

  /**
   * 技能类型
   *
   * - composite (整合型): 内部会引用/建议加载其他 skills
   *   例如：研究模式会建议加载知识检索、网页抓取等子技能
   *
   * - standalone (独立型): 自身是最小工具集合，不依赖其他 skills
   *   例如：知识检索、笔记工具等独立功能模块
   *
   * 默认值: 'standalone'（向后兼容）
   */
  skillType?: SkillType;

  /**
   * 关联技能列表（仅对 composite 类型有效）
   *
   * 存储该整合型技能建议加载的子技能 ID 列表。
   * 这不是硬依赖，只是提示用户可能需要的相关技能。
   *
   * 示例：
   * ```yaml
   * skillType: composite
   * relatedSkills:
   *   - knowledge-retrieval
   *   - web-fetch
   *   - canvas-note
   * ```
   */
  relatedSkills?: string[];

  /**
   * 前置依赖技能列表（硬依赖）
   *
   * 当加载此技能时，会自动加载列表中的前置技能。
   * 与 relatedSkills 的区别：dependencies 是强制性的，系统会自动加载。
   *
   * 示例：
   * ```yaml
   * dependencies:
   *   - learning-resource  # mindmap-tools 需要 learning-resource 的基础能力
   * ```
   */
  dependencies?: string[];
}

// ============================================================================
// Skill 完整定义
// ============================================================================

/**
 * Skill 存储位置
 */
export type SkillLocation = 'global' | 'project' | 'builtin';

/**
 * 完整的 Skill 定义
 * 包含元数据和指令内容
 */
export interface SkillDefinition extends SkillMetadata {
  /** 指令内容（Markdown 格式） */
  content: string;

  /** 来源文件路径 */
  sourcePath: string;

  /** 来源位置 */
  location: SkillLocation;

  /**
   * 是否为内置 skill
   *
   * 内置 skills 有以下特性：
   * - 可编辑但不可删除
   * - 编辑后可恢复默认
   * - 自定义版本存储在数据库而非文件系统
   */
  isBuiltin?: boolean;

  /**
   * 是否被用户自定义过
   *
   * 仅对内置 skills 有效。当用户编辑内置 skill 后，
   * 此字段为 true，表示当前内容与原始版本不同。
   */
  isCustomized?: boolean;

  /**
   * 原始内容（用于恢复默认）
   *
   * 仅对内置 skills 有效。存储内置 skill 的原始指令内容，
   * 用户可通过"恢复默认"功能恢复到此内容。
   */
  originalContent?: string;

  /**
   * 原始元数据（用于恢复默认）
   *
   * 仅对内置 skills 有效。存储内置 skill 的原始元数据，
   * 包括 name、description、version 等字段。
   */
  originalMetadata?: Partial<SkillMetadata>;
}

// ============================================================================
// Skill 加载配置
// ============================================================================

/**
 * Skill 加载配置
 */
export interface SkillLoadConfig {
  /**
   * 全局 skills 目录路径
   * 默认: ~/.deep-student/skills
   * 设为 null 禁用全局加载
   */
  globalPath?: string | null;

  /**
   * 项目 skills 目录路径
   * 默认: .skills
   * 设为 null 禁用项目加载
   */
  projectPath?: string | null;

  /**
   * ★ P0-08：项目根目录（用于解析相对路径）
   *
   * 如果指定，会将 projectPath 相对于此目录解析为绝对路径。
   * 例如：projectRootDir="/path/to/my-project", projectPath=".skills"
   * → 实际加载 "/path/to/my-project/.skills"
   *
   * 如果不指定，相对路径可能相对于应用工作目录（Tauri 环境下行为不确定）
   */
  projectRootDir?: string | null;

  /**
   * 是否加载内置 skills
   * 默认: true
   */
  loadBuiltin?: boolean;
}

/**
 * 默认加载配置
 */
export const DEFAULT_SKILL_LOAD_CONFIG: Required<SkillLoadConfig> = {
  globalPath: '~/.deep-student/skills',
  projectPath: '.skills',
  projectRootDir: null,
  loadBuiltin: true,
};

// ============================================================================
// Skill 资源元数据（用于 contextRef）
// ============================================================================

/**
 * Skill 资源元数据
 * 存储在 Resource.metadata 中
 */
export interface SkillResourceMetadata {
  /** Skill ID */
  skillId: string;

  /** Skill 名称 */
  skillName: string;

  /** Skill 版本 */
  skillVersion?: string;

  /** 来源位置 */
  location: SkillLocation;
}

// ============================================================================
// Skill 解析结果
// ============================================================================

/**
 * SKILL.md 解析结果
 */
export interface SkillParseResult {
  /** 是否解析成功 */
  success: boolean;

  /** 解析出的 Skill 定义（成功时存在） */
  skill?: SkillDefinition;

  /** 错误信息（失败时存在） */
  error?: string;

  /** 警告信息列表 */
  warnings?: string[];
}

// ============================================================================
// Skill 验证
// ============================================================================

/**
 * Skill 验证结果
 */
export interface SkillValidationResult {
  /** 是否有效 */
  valid: boolean;

  /** 错误列表 */
  errors: string[];

  /** 警告列表 */
  warnings: string[];
}

/** 保留字列表（不能在 name 中使用） */
const RESERVED_WORDS = ['deep-student', 'deepstudent'];

/** name 格式正则：只允许小写字母、数字、连字符 */
const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * 验证 Skill 元数据
 *
 * SKILL.md 规范：
 * - name: 小写字母+数字+连字符，≤64字符，不含保留字
 * - description: ≤1024字符
 */
export function validateSkillMetadata(metadata: Partial<SkillMetadata>): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ========== name 验证（严格遵循 SKILL.md 规范） ==========
  if (!metadata.name || typeof metadata.name !== 'string') {
    errors.push('缺少必填字段 "name"');
  } else {
    // 长度检查
    if (metadata.name.length > 64) {
      errors.push(`name 长度超过限制（${metadata.name.length}/64）`);
    }

    // 格式检查：只允许小写字母、数字、连字符
    if (!NAME_PATTERN.test(metadata.name)) {
      errors.push('name 只能包含小写字母、数字和连字符（a-z, 0-9, -）');
    }

    // 保留字检查
    const lowerName = metadata.name.toLowerCase();
    for (const reserved of RESERVED_WORDS) {
      if (lowerName.includes(reserved)) {
        errors.push(`name 不能包含保留字 "${reserved}"`);
        break;
      }
    }
  }

  // ========== description 验证 ==========
  if (!metadata.description || typeof metadata.description !== 'string') {
    errors.push('缺少必填字段 "description"');
  } else {
    // SKILL.md 规范：最大 1024 字符
    if (metadata.description.length > 1024) {
      errors.push(`description 长度超过限制（${metadata.description.length}/1024）`);
    }

    // 建议：描述过短可能影响 LLM 发现
    if (metadata.description.length < 50) {
      warnings.push('description 建议至少 50 字符，以便 LLM 更好地理解何时使用此技能');
    }
  }

  // ========== 可选字段类型检查 ==========
  if (metadata.version !== undefined && typeof metadata.version !== 'string') {
    errors.push('version 必须是字符串');
  }

  if (metadata.author !== undefined && typeof metadata.author !== 'string') {
    errors.push('author 必须是字符串');
  }

  if (metadata.priority !== undefined) {
    if (typeof metadata.priority !== 'number' || !Number.isInteger(metadata.priority)) {
      errors.push('priority 必须是整数');
    } else if (metadata.priority < 1 || metadata.priority > 100) {
      warnings.push('priority 建议范围为 1-100');
    }
  }

  // allowedTools 验证（优先）
  if (metadata.allowedTools !== undefined) {
    if (!Array.isArray(metadata.allowedTools)) {
      errors.push('allowedTools 必须是字符串数组');
    } else if (!metadata.allowedTools.every((t) => typeof t === 'string')) {
      errors.push('allowedTools 数组中的每个元素必须是字符串');
    }
  }

  // tools 验证（向后兼容）
  if (metadata.tools !== undefined) {
    if (!Array.isArray(metadata.tools)) {
      errors.push('tools 必须是字符串数组');
    } else if (!metadata.tools.every((t) => typeof t === 'string')) {
      errors.push('tools 数组中的每个元素必须是字符串');
    }
    // 建议使用新字段名
    if (!metadata.allowedTools) {
      warnings.push('建议使用 allowedTools 代替 tools（遵循 SKILL.md 规范）');
    }
  }

  if (metadata.disableAutoInvoke !== undefined && typeof metadata.disableAutoInvoke !== 'boolean') {
    errors.push('disableAutoInvoke 必须是布尔值');
  }

  // ========== skillType 验证 ==========
  if (metadata.skillType !== undefined) {
    if (metadata.skillType !== 'composite' && metadata.skillType !== 'standalone') {
      errors.push('skillType 必须是 "composite" 或 "standalone"');
    }
  }

  // ========== relatedSkills 验证 ==========
  if (metadata.relatedSkills !== undefined) {
    if (!Array.isArray(metadata.relatedSkills)) {
      errors.push('relatedSkills 必须是字符串数组');
    } else if (!metadata.relatedSkills.every((s) => typeof s === 'string')) {
      errors.push('relatedSkills 数组中的每个元素必须是字符串');
    } else if (metadata.skillType !== 'composite' && metadata.relatedSkills.length > 0) {
      warnings.push('relatedSkills 仅对 composite 类型技能有意义，当前 skillType 不是 composite');
    }
  }

  // ========== dependencies 验证 ==========
  if (metadata.dependencies !== undefined) {
    if (!Array.isArray(metadata.dependencies)) {
      errors.push('dependencies 必须是字符串数组');
    } else if (!metadata.dependencies.every((s) => typeof s === 'string')) {
      errors.push('dependencies 数组中的每个元素必须是字符串');
    } else if (metadata.dependencies.length > 0 && metadata.skillType !== 'composite') {
      warnings.push('dependencies 通常用于 composite 技能，当前 skillType 不是 composite');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// 常量
// ============================================================================

/**
 * Skill 上下文类型 ID
 */
export const SKILL_INSTRUCTION_TYPE_ID = 'skill_instruction' as const;

/**
 * Skill 默认优先级
 */
export const SKILL_DEFAULT_PRIORITY = 3;

/**
 * Skill XML 标签名
 */
export const SKILL_XML_TAG = 'skill_instruction';
