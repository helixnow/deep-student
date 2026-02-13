/**
 * Chat V2 - @模型解析工具
 *
 * 解析输入框中的 `@模型名称` 语法，支持多模型并行变体。
 *
 * 解析规则：
 * 1. 格式：`@model-id` 或 `@"Model Name"`（支持空格）
 * 2. 只匹配可用模型列表中的模型
 * 3. 去重并保持顺序
 * 4. 2+ 个模型才触发多变体模式
 *
 * 约束条件：
 * 1. 大小写不敏感
 * 2. 无效模型保留原文
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 模型信息接口
 *
 * 兼容 ChatParamsPanel.tsx 中的 ModelConfig 接口。
 * 所有字段都与 ModelConfig 兼容，额外添加了 aliases 字段用于别名匹配。
 *
 * 使用说明：
 * - 如果直接传入 ModelConfig[]，功能正常但不支持别名匹配
 * - 如果需要别名匹配，请使用 ModelInfo[] 并填充 aliases 字段
 *
 * @example
 * ```typescript
 * // 基础用法（兼容 ModelConfig）
 * const models: ModelInfo[] = [
 *   { id: 'gpt-4', name: 'GPT-4' },
 * ];
 *
 * // 带别名用法
 * const modelsWithAliases: ModelInfo[] = [
 *   { id: 'gpt-4', name: 'GPT-4', aliases: ['gpt4', 'gpt'] },
 * ];
 * ```
 */
export interface ModelInfo {
  /** 模型数据库 ID（必需，用于后端调用） */
  id: string;
  /** 模型显示名称（必需，用于 UI 显示和 @mention 插入） */
  name: string;
  /** 模型标识符（可选，如 "gpt-4", "deepseek-chat"，用于 Popover 副标题） */
  model?: string;
  /** 模型别名列表（可选，用于 @alias 匹配） */
  aliases?: string[];
  /** 模型提供商（可选，用于 UI 显示） */
  provider?: string;
  /** 允许其他字段以兼容 ModelConfig */
  [key: string]: unknown;
}

/**
 * 解析后的输入结果
 */
export interface ParsedInput {
  /** 纯文本内容（移除 @mentions） */
  cleanContent: string;
  /** 提取的模型 ID（去重保序） */
  modelIds: string[];
  /** 原始输入 */
  rawInput: string;
  /** 是否多变体模式（modelIds.length > 1） */
  isMultiVariant: boolean;
}

/**
 * 匹配到的 @mention
 */
export interface ModelMention {
  /** 匹配的模型 ID */
  modelId: string;
  /** 原始匹配文本（包含 @） */
  matchedText: string;
  /** 在输入中的起始位置 */
  startIndex: number;
  /** 在输入中的结束位置 */
  endIndex: number;
  /** 是否有效（匹配到可用模型） */
  isValid: boolean;
}

// ============================================================================
// 正则表达式
// ============================================================================

/**
 * 匹配 @模型 的正则表达式
 * 支持两种格式：
 * 1. @model-id - 简单格式，匹配字母、数字、连字符、下划线、点
 * 2. @"Model Name" - 带引号格式，支持空格
 */
const MODEL_MENTION_REGEX = /@(?:"([^"]+)"|'([^']+)'|([\w\-.]+))/g;

// ============================================================================
// 核心解析函数
// ============================================================================

/**
 * 解析输入中的 @模型 mentions
 *
 * @param input - 用户输入文本
 * @param availableModels - 可用模型列表
 * @returns 解析结果
 *
 * @example
 * ```typescript
 * const models = [
 *   { id: 'gpt-4', name: 'GPT-4', aliases: ['gpt4'] },
 *   { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', aliases: ['claude'] },
 * ];
 *
 * parseModelMentions('@gpt-4 @claude 你好', models);
 * // => {
 * //   cleanContent: '你好',
 * //   modelIds: ['gpt-4', 'claude-3-5-sonnet'],
 * //   rawInput: '@gpt-4 @claude 你好',
 * //   isMultiVariant: true,
 * // }
 * ```
 */
export function parseModelMentions(
  input: string,
  availableModels: ModelInfo[]
): ParsedInput {
  if (!input || availableModels.length === 0) {
    return {
      cleanContent: input || '',
      modelIds: [],
      rawInput: input || '',
      isMultiVariant: false,
    };
  }

  // 构建模型查找映射（大小写不敏感）
  const modelLookup = buildModelLookup(availableModels);

  // 查找所有 @mentions
  const mentions = findAllMentions(input, modelLookup);

  // 提取有效的模型 ID（去重保序）
  const modelIds = extractUniqueModelIds(mentions);

  // 生成清理后的内容（移除有效的 @mentions）
  const cleanContent = removeValidMentions(input, mentions);

  return {
    cleanContent,
    modelIds,
    rawInput: input,
    isMultiVariant: modelIds.length > 1,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 构建模型查找映射
 * 支持通过 ID、名称、别名查找（全部小写）
 */
function buildModelLookup(models: ModelInfo[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const model of models) {
    // 通过 ID 查找
    lookup.set(model.id.toLowerCase(), model.id);

    // 通过名称查找
    lookup.set(model.name.toLowerCase(), model.id);

    // 通过别名查找
    if (model.aliases) {
      for (const alias of model.aliases) {
        lookup.set(alias.toLowerCase(), model.id);
      }
    }
  }

  return lookup;
}

/**
 * 查找所有 @mentions
 */
function findAllMentions(
  input: string,
  modelLookup: Map<string, string>
): ModelMention[] {
  const mentions: ModelMention[] = [];

  // 重置正则表达式状态
  MODEL_MENTION_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MODEL_MENTION_REGEX.exec(input)) !== null) {
    // 提取匹配的模型名（三种捕获组：双引号、单引号、无引号）
    const modelName = match[1] || match[2] || match[3];
    const matchedText = match[0];
    const startIndex = match.index;
    const endIndex = match.index + matchedText.length;

    // 查找对应的模型 ID
    const modelId = modelLookup.get(modelName.toLowerCase());

    mentions.push({
      modelId: modelId || '',
      matchedText,
      startIndex,
      endIndex,
      isValid: !!modelId,
    });
  }

  return mentions;
}

/**
 * 提取唯一的模型 ID（保持顺序）
 */
function extractUniqueModelIds(mentions: ModelMention[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const mention of mentions) {
    if (mention.isValid && !seen.has(mention.modelId)) {
      seen.add(mention.modelId);
      result.push(mention.modelId);
    }
  }

  return result;
}

/**
 * 移除有效的 @mentions，保留无效的
 */
function removeValidMentions(input: string, mentions: ModelMention[]): string {
  // 按位置倒序排列，从后往前删除
  const validMentions = mentions
    .filter((m) => m.isValid)
    .sort((a, b) => b.startIndex - a.startIndex);

  let result = input;
  for (const mention of validMentions) {
    result =
      result.slice(0, mention.startIndex) + result.slice(mention.endIndex);
  }

  // 清理多余空格
  return result.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// 自动完成相关函数
// ============================================================================

/**
 * 获取当前光标位置的 @mention 上下文
 *
 * @param input - 输入文本
 * @param cursorPosition - 光标位置
 * @returns 当前正在输入的 @mention 信息，如果不在 @mention 中返回 null
 */
export function getCurrentMentionContext(
  input: string,
  cursorPosition: number
): { query: string; startIndex: number } | null {
  // 从光标位置向前查找 @
  const beforeCursor = input.slice(0, cursorPosition);

  // 查找最后一个 @ 的位置
  const lastAtIndex = beforeCursor.lastIndexOf('@');
  if (lastAtIndex === -1) {
    return null;
  }

  // 检查 @ 之后到光标位置是否是连续的模型名字符（或引号内容）
  const afterAt = beforeCursor.slice(lastAtIndex + 1);

  // 如果以引号开头，检查是否在引号内
  if (afterAt.startsWith('"') || afterAt.startsWith("'")) {
    const quote = afterAt[0];
    const closingQuoteIndex = afterAt.indexOf(quote, 1);
    if (closingQuoteIndex === -1) {
      // 还在引号内，返回引号内的内容
      return {
        query: afterAt.slice(1), // 去掉开头的引号
        startIndex: lastAtIndex,
      };
    }
    // 引号已闭合，不在 mention 中
    return null;
  }

  // 无引号格式：检查是否是有效的模型名字符
  if (/^[\w\-.]*$/.test(afterAt)) {
    return {
      query: afterAt,
      startIndex: lastAtIndex,
    };
  }

  return null;
}

/**
 * 过滤并排序模型建议列表
 *
 * @param query - 搜索查询（@后的文本）
 * @param availableModels - 可用模型列表
 * @param maxResults - 最大结果数，默认 5
 * @returns 匹配的模型列表
 */
export function filterModelSuggestions(
  query: string,
  availableModels: ModelInfo[],
  maxResults: number = 5
): ModelInfo[] {
  if (!query) {
    // 无查询时返回前 N 个模型
    return availableModels.slice(0, maxResults);
  }

  const queryLower = query.toLowerCase();

  // 计算匹配分数
  const scored = availableModels.map((model) => {
    let score = 0;

    // ID 完全匹配
    if (model.id.toLowerCase() === queryLower) {
      score = 100;
    }
    // ID 前缀匹配
    else if (model.id.toLowerCase().startsWith(queryLower)) {
      score = 80;
    }
    // 名称前缀匹配
    else if (model.name.toLowerCase().startsWith(queryLower)) {
      score = 70;
    }
    // ID 包含匹配
    else if (model.id.toLowerCase().includes(queryLower)) {
      score = 50;
    }
    // 名称包含匹配
    else if (model.name.toLowerCase().includes(queryLower)) {
      score = 40;
    }
    // 别名匹配
    else if (model.aliases?.some((a) => a.toLowerCase().includes(queryLower))) {
      score = 30;
    }

    return { model, score };
  });

  // 过滤有分数的结果，按分数排序
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.model);
}

/**
 * 生成替换文本
 *
 * @param modelId - 模型 ID（用于内部解析）
 * @param modelName - 模型名称（用于显示）
 * @returns 格式化的 @mention 文本，显示名称但解析时用 ID
 * 
 * @example
 * ```typescript
 * formatMention('gpt-4', 'GPT-4');
 * // => '@"GPT-4"'  （显示名称，但解析时会匹配到 ID）
 * ```
 */
export function formatMention(modelId: string, modelName: string): string {
  // 始终使用引号格式包裹显示名称，确保包含空格的名称也能正确解析
  // 使用 modelName 显示，解析时通过 modelLookup 将名称映射回 ID
  return `@"${modelName}"`;
}

/**
 * 检查输入是否应该触发自动完成
 *
 * @param input - 输入文本
 * @param cursorPosition - 光标位置
 * @returns 是否应该显示自动完成
 */
export function shouldShowAutoComplete(
  input: string,
  cursorPosition: number
): boolean {
  const context = getCurrentMentionContext(input, cursorPosition);
  return context !== null;
}

/**
 * 查找光标位置左侧的完整 @mention
 *
 * 用于原子删除：当用户按 Backspace 时，如果光标紧邻一个 @mention 的末尾，
 * 则删除整个 @mention 而不是只删除一个字符。
 *
 * @param input - 输入文本
 * @param cursorPosition - 光标位置
 * @returns 如果找到，返回 mention 信息；否则返回 null
 */
export function findMentionBeforeCursor(
  input: string,
  cursorPosition: number
): { startIndex: number; endIndex: number; matchedText: string } | null {
  // 如果光标在最开始，没有内容可删除
  if (cursorPosition <= 0) return null;

  // 从开头查找所有 @mentions
  MODEL_MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  
  while ((match = MODEL_MENTION_REGEX.exec(input)) !== null) {
    const startIndex = match.index;
    const endIndex = match.index + match[0].length;
    
    // 检查光标是否紧邻这个 mention 的末尾（或在其内部）
    // 情况1：光标正好在 mention 结束位置
    // 情况2：光标在 mention 结束位置之后紧跟一个空格处
    if (endIndex === cursorPosition || 
        (endIndex === cursorPosition - 1 && input[cursorPosition - 1] === ' ')) {
      return {
        startIndex,
        endIndex: cursorPosition, // 包含可能的尾随空格
        matchedText: input.slice(startIndex, cursorPosition),
      };
    }
  }
  
  return null;
}

/**
 * 删除指定范围的文本并返回新值
 *
 * @param input - 输入文本
 * @param startIndex - 开始位置
 * @param endIndex - 结束位置
 * @returns 新的输入值和新光标位置
 */
export function deleteMentionRange(
  input: string,
  startIndex: number,
  endIndex: number
): { newValue: string; newCursorPosition: number } {
  const newValue = input.slice(0, startIndex) + input.slice(endIndex);
  return {
    newValue: newValue.replace(/\s+/g, ' ').trim(),
    newCursorPosition: startIndex,
  };
}
