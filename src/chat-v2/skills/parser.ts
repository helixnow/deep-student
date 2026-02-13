/**
 * Chat V2 - SKILL.md 文件解析器
 *
 * 解析 SKILL.md 文件的 YAML frontmatter 和 Markdown 内容
 *
 * 2026-01-20: 引入 yaml 库支持 embeddedTools 嵌套结构解析
 */

import YAML from 'yaml';
import i18n from '@/i18n';
import type {
  SkillDefinition,
  SkillMetadata,
  SkillParseResult,
  SkillLocation,
  ToolSchema,
  SkillType,
} from './types';
import { validateSkillMetadata, SKILL_DEFAULT_PRIORITY } from './types';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillParser]';

/** Frontmatter 分隔符 */
const FRONTMATTER_DELIMITER = '---';

/** 最大 frontmatter 长度（防止解析过大的文件头） */
const MAX_FRONTMATTER_LENGTH = 4096;

// ============================================================================
// Frontmatter 解析
// ============================================================================

/**
 * 分离 frontmatter 和内容
 *
 * @param content 文件完整内容
 * @returns [frontmatter, content] 或 null（无 frontmatter）
 */
function splitFrontmatter(content: string): [string, string] | null {
  const trimmed = content.trimStart();

  // 检查是否以 --- 开头
  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    return null;
  }

  // 找到第二个 ---
  const firstDelimiterEnd = FRONTMATTER_DELIMITER.length;
  const secondDelimiterStart = trimmed.indexOf(
    `\n${FRONTMATTER_DELIMITER}`,
    firstDelimiterEnd
  );

  if (secondDelimiterStart === -1) {
    return null;
  }

  // 提取 frontmatter（不含分隔符）
  const frontmatter = trimmed.slice(firstDelimiterEnd, secondDelimiterStart).trim();

  // 检查长度限制 — 超出则拒绝解析
  if (frontmatter.length > MAX_FRONTMATTER_LENGTH) {
    return null;
  }

  // 提取内容（第二个 --- 之后）
  const contentStart = secondDelimiterStart + FRONTMATTER_DELIMITER.length + 1;
  const markdownContent = trimmed.slice(contentStart).trim();

  return [frontmatter, markdownContent];
}

/**
 * 使用 yaml 库解析 YAML frontmatter
 *
 * 支持完整的 YAML 特性，包括：
 * - 简单键值对
 * - 嵌套对象（用于 embeddedTools）
 * - 数组
 * - 多行字符串
 */
function parseYamlFrontmatter(yamlStr: string): Record<string, unknown> {
  try {
    const result = YAML.parse(yamlStr);
    return result ?? {};
  } catch (error: unknown) {
    console.error(LOG_PREFIX, i18n.t('skills:parser.yamlParseError'), error);
    throw error;
  }
}

/**
 * 将元数据字段安全转换为字符串
 *
 * - 允许 number/bool，避免 YAML 自动类型导致校验失败
 * - 其他类型返回 undefined
 */
function coerceStringField(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * 将数组字段安全转换为字符串数组
 *
 * 支持两种输入格式：
 * - YAML 数组：`[a, b, c]` → `['a', 'b', 'c']`
 * - 逗号分隔字符串：`"a, b, c"` → `['a', 'b', 'c']`
 */
function coerceStringArrayField(value: unknown): string[] | undefined {
  // 支持逗号分隔的字符串（如 YAML 中写 `allowedTools: "Read, Write"`）
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => coerceStringField(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 解析 skillType 字段
 *
 * @param value 原始值
 * @returns 'composite' | 'standalone' | undefined
 */
function parseSkillType(value: unknown): SkillType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const strValue = coerceStringField(value)?.toLowerCase();
  if (strValue === 'composite' || strValue === 'standalone') {
    return strValue;
  }
  // 无效值时返回 undefined，由验证层报错
  return undefined;
}

/**
 * 解析并验证 embeddedTools 字段
 *
 * 支持从 YAML 解析的嵌套结构转换为 ToolSchema[]
 */
function parseEmbeddedTools(value: unknown, warnings: string[]): ToolSchema[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    warnings.push(i18n.t('skills:parser.embeddedToolsArray'));
    return undefined;
  }

  const tools: ToolSchema[] = [];

  for (let i = 0; i < value.length; i++) {
    const item = value[i];

    if (!item || typeof item !== 'object') {
      warnings.push(i18n.t('skills:parser.embeddedToolsMustBeObject', { index: i }));
      continue;
    }

    const toolItem = item as Record<string, unknown>;

    // 验证必填字段
    if (typeof toolItem.name !== 'string' || !toolItem.name) {
      warnings.push(i18n.t('skills:parser.embeddedToolsMissingName', { index: i }));
      continue;
    }

    if (typeof toolItem.description !== 'string' || !toolItem.description) {
      warnings.push(i18n.t('skills:parser.embeddedToolsMissingDescription', { index: i }));
      continue;
    }

    // inputSchema 验证
    const inputSchema = toolItem.inputSchema as Record<string, unknown> | undefined;
    if (!inputSchema || typeof inputSchema !== 'object') {
      warnings.push(i18n.t('skills:parser.embeddedToolsMissingInputSchema', { index: i }));
      continue;
    }

    if (inputSchema.type !== 'object') {
      warnings.push(i18n.t('skills:parser.inputSchemaTypeMustBeObject', { index: i }));
      continue;
    }

    if (!inputSchema.properties || typeof inputSchema.properties !== 'object') {
      warnings.push(i18n.t('skills:parser.inputSchemaMissingProperties', { index: i }));
      continue;
    }

    // 构建 ToolSchema
    tools.push({
      name: toolItem.name,
      description: toolItem.description,
      inputSchema: {
        type: 'object',
        properties: inputSchema.properties as Record<string, unknown>,
        required: Array.isArray(inputSchema.required) ? inputSchema.required as string[] : undefined,
        additionalProperties: inputSchema.additionalProperties as boolean | undefined,
      },
    } as ToolSchema);
  }

  return tools.length > 0 ? tools : undefined;
}

// ============================================================================
// Skill 解析
// ============================================================================

/**
 * 解析 SKILL.md 文件内容
 *
 * @param content 文件完整内容
 * @param sourcePath 来源文件路径
 * @param skillId Skill ID（通常为目录名）
 * @param location 来源位置
 * @returns 解析结果
 */
export function parseSkillFile(
  content: string,
  sourcePath: string,
  skillId: string,
  location: SkillLocation
): SkillParseResult {
  const warnings: string[] = [];

  // 1. 分离 frontmatter 和内容
  const split = splitFrontmatter(content);

  if (!split) {
    // 区分"无 frontmatter"和"frontmatter 过长"两种情况
    const trimmed = content.trimStart();
    if (trimmed.startsWith(FRONTMATTER_DELIMITER)) {
      const firstEnd = FRONTMATTER_DELIMITER.length;
      const secondStart = trimmed.indexOf(`\n${FRONTMATTER_DELIMITER}`, firstEnd);
      if (secondStart !== -1) {
        const fm = trimmed.slice(firstEnd, secondStart).trim();
        if (fm.length > MAX_FRONTMATTER_LENGTH) {
          return {
            success: false,
            error: i18n.t('skills:parser.frontmatterTooLong'),
            warnings,
          };
        }
      }
    }
    return {
      success: false,
      error: i18n.t('skills:parser.yamlRequired'),
      warnings,
    };
  }

  const [frontmatterStr, markdownContent] = split;

  // 2. 解析 YAML frontmatter
  let rawMetadata: Record<string, unknown>;
  try {
    rawMetadata = parseYamlFrontmatter(frontmatterStr);
  } catch (error: unknown) {
    return {
      success: false,
      error: i18n.t('skills:parser.yamlParseFailed', { error: error instanceof Error ? error.message : String(error) }),
      warnings,
    };
  }

  // 3. 构建元数据对象
  // 支持 allowed-tools（短横线规范）和 allowedTools（驼峰）两种写法
  const allowedToolsRaw = rawMetadata['allowed-tools'] ?? rawMetadata.allowedTools;
  const toolsRaw = rawMetadata.tools;
  // 支持 embedded-tools（短横线）和 embeddedTools（驼峰）两种写法
  const embeddedToolsRaw = rawMetadata['embedded-tools'] ?? rawMetadata.embeddedTools;

  // 支持 skill-type（短横线）和 skillType（驼峰）两种写法
  const skillTypeRaw = rawMetadata['skill-type'] ?? rawMetadata.skillType;
  // 支持 related-skills（短横线）和 relatedSkills（驼峰）两种写法
  const relatedSkillsRaw = rawMetadata['related-skills'] ?? rawMetadata.relatedSkills;
  // 支持 dependencies 字段
  const dependenciesRaw = rawMetadata.dependencies;

  const metadata: Partial<SkillMetadata> = {
    id: skillId,
    name: coerceStringField(rawMetadata.name),
    description: coerceStringField(rawMetadata.description),
    version: coerceStringField(rawMetadata.version),
    author: coerceStringField(rawMetadata.author),
    priority: typeof rawMetadata.priority === 'number' ? rawMetadata.priority : undefined,
    allowedTools: coerceStringArrayField(allowedToolsRaw),
    tools: coerceStringArrayField(toolsRaw), // 向后兼容
    disableAutoInvoke: rawMetadata.disableAutoInvoke === true || rawMetadata.disableAutoInvoke === 'true',
    embeddedTools: parseEmbeddedTools(embeddedToolsRaw, warnings),
    skillType: parseSkillType(skillTypeRaw),
    relatedSkills: coerceStringArrayField(relatedSkillsRaw),
    dependencies: coerceStringArrayField(dependenciesRaw),
  };

  // 4. 验证元数据
  const validation = validateSkillMetadata(metadata);

  if (!validation.valid) {
    return {
      success: false,
      error: i18n.t('skills:parser.metadataValidationFailed', { errors: validation.errors.join('\n') }),
      warnings: validation.warnings,
    };
  }

  // 收集警告
  warnings.push(...validation.warnings);

  // 5. 检查内容
  if (!markdownContent || markdownContent.trim() === '') {
    warnings.push(i18n.t('skills:parser.emptyContent'));
  }

  // 6. 构建完整定义
  const skill: SkillDefinition = {
    id: skillId,
    name: metadata.name!,
    description: metadata.description!,
    version: metadata.version,
    author: metadata.author,
    priority: metadata.priority ?? SKILL_DEFAULT_PRIORITY,
    allowedTools: metadata.allowedTools,
    tools: metadata.tools, // 向后兼容
    disableAutoInvoke: metadata.disableAutoInvoke ?? false,
    embeddedTools: metadata.embeddedTools, // 渐进披露架构核心字段
    skillType: metadata.skillType ?? 'standalone', // 默认独立型
    relatedSkills: metadata.relatedSkills,
    dependencies: metadata.dependencies,
    content: markdownContent,
    sourcePath,
    location,
  };

  return {
    success: true,
    skill,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * 快速验证是否为有效的 SKILL.md 文件
 *
 * 仅检查格式，不完全解析
 *
 * @param content 文件内容
 * @returns 是否为有效格式
 */
export function isValidSkillFile(content: string): boolean {
  const split = splitFrontmatter(content);
  if (!split) return false;

  const [frontmatter] = split;
  try {
    const parsed = parseYamlFrontmatter(frontmatter);
    return typeof parsed.name === 'string' && typeof parsed.description === 'string';
  } catch {
    return false;
  }
}

/**
 * 提取 Skill 元数据（不解析完整内容）
 *
 * 用于快速预览 skill 列表
 *
 * @param content 文件内容
 * @param skillId Skill ID
 * @returns 元数据或 null
 */
export function extractSkillMetadata(
  content: string,
  skillId: string
): SkillMetadata | null {
  const split = splitFrontmatter(content);
  if (!split) return null;

  const [frontmatter] = split;
  try {
    const raw = parseYamlFrontmatter(frontmatter);

    if (typeof raw.name !== 'string' || typeof raw.description !== 'string') {
      return null;
    }

    // 支持 allowed-tools（短横线规范）和 allowedTools 两种写法
    const allowedToolsRaw = raw['allowed-tools'] ?? raw.allowedTools;
    const allowedTools = coerceStringArrayField(allowedToolsRaw);
    // 支持 embedded-tools 和 embeddedTools 两种写法
    const embeddedToolsRaw = raw['embedded-tools'] ?? raw.embeddedTools;
    const tempWarnings: string[] = [];
    const embeddedTools = parseEmbeddedTools(embeddedToolsRaw, tempWarnings);

    // 支持 skill-type 和 skillType 两种写法
    const skillTypeRaw = raw['skill-type'] ?? raw.skillType;
    // 支持 related-skills 和 relatedSkills 两种写法
    const relatedSkillsRaw = raw['related-skills'] ?? raw.relatedSkills;
    // 支持 dependencies
    const dependenciesRaw = raw.dependencies;

    return {
      id: skillId,
      name: raw.name,
      description: raw.description,
      version: coerceStringField(raw.version),
      author: coerceStringField(raw.author),
      priority: (typeof raw.priority === 'number' ? raw.priority : undefined) ?? SKILL_DEFAULT_PRIORITY,
      allowedTools,
      tools: coerceStringArrayField(raw.tools), // 向后兼容
      disableAutoInvoke: raw.disableAutoInvoke === true,
      embeddedTools,
      skillType: parseSkillType(skillTypeRaw),
      relatedSkills: coerceStringArrayField(relatedSkillsRaw),
      dependencies: coerceStringArrayField(dependenciesRaw),
    };
  } catch (e: unknown) {
    console.warn(`[SkillParser]`, i18n.t('skills:parser.extractMetadataFailed', { skillId }), e);
    return null;
  }
}

// ============================================================================
// Skill 序列化
// ============================================================================

/**
 * 将 YAML 值格式化为字符串
 *
 * @param value 值
 * @returns YAML 格式字符串
 */
function formatYamlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    // 始终使用引号包裹字符串，避免纯数字被 YAML 解析为 number
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }

  return String(value);
}

/**
 * 将 Skill 元数据和内容序列化为 SKILL.md 格式
 *
 * @param metadata Skill 元数据（不含 id）
 * @param content Markdown 内容
 * @returns SKILL.md 格式字符串
 */
export function serializeSkillToMarkdown(
  metadata: Omit<SkillMetadata, 'id'>,
  content: string
): string {
  const lines: string[] = ['---'];

  // 必填字段
  lines.push(`name: ${formatYamlValue(metadata.name)}`);
  lines.push(`description: ${formatYamlValue(metadata.description)}`);

  // 可选字段（仅在有值时添加）
  if (metadata.version) {
    lines.push(`version: ${formatYamlValue(metadata.version)}`);
  }

  if (metadata.author) {
    lines.push(`author: ${formatYamlValue(metadata.author)}`);
  }

  if (metadata.priority !== undefined && metadata.priority !== SKILL_DEFAULT_PRIORITY) {
    lines.push(`priority: ${metadata.priority}`);
  }

  // 优先使用 allowedTools（SKILL.md 规范），否则回退到 tools
  const toolsList = metadata.allowedTools ?? metadata.tools;
  if (toolsList && toolsList.length > 0) {
    lines.push('allowed-tools:');  // 使用 SKILL.md 规范的字段名
    for (const tool of toolsList) {
      lines.push(`  - ${formatYamlValue(tool)}`);
    }
  }

  if (metadata.disableAutoInvoke) {
    lines.push(`disableAutoInvoke: true`);
  }

  // skillType（默认 standalone 时不写入）
  if (metadata.skillType && metadata.skillType !== 'standalone') {
    lines.push(`skill-type: ${metadata.skillType}`);
  }

  // relatedSkills（仅 composite 类型有意义）
  if (metadata.relatedSkills && metadata.relatedSkills.length > 0) {
    lines.push('related-skills:');
    for (const skillId of metadata.relatedSkills) {
      lines.push(`  - ${formatYamlValue(skillId)}`);
    }
  }

  // dependencies（硬依赖技能列表）
  if (metadata.dependencies && metadata.dependencies.length > 0) {
    lines.push('dependencies:');
    for (const depId of metadata.dependencies) {
      lines.push(`  - ${formatYamlValue(depId)}`);
    }
  }

  // embeddedTools（渐进披露架构）
  if (metadata.embeddedTools && metadata.embeddedTools.length > 0) {
    lines.push('embeddedTools:');
    for (const tool of metadata.embeddedTools) {
      lines.push(`  - name: ${formatYamlValue(tool.name)}`);
      lines.push(`    description: ${formatYamlValue(tool.description)}`);
      lines.push('    inputSchema:');
      lines.push('      type: object');
      if (Object.keys(tool.inputSchema.properties).length > 0) {
        lines.push('      properties:');
        for (const [propName, prop] of Object.entries(tool.inputSchema.properties)) {
          lines.push(`        ${propName}:`);
          if (prop.type) {
            lines.push(`          type: ${prop.type}`);
          }
          if (prop.description) {
            lines.push(`          description: ${formatYamlValue(prop.description)}`);
          }
          // 🔧 补充序列化：enum / default / items，避免 round-trip 数据丢失
          if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
            lines.push('          enum:');
            for (const val of prop.enum) {
              lines.push(`            - ${formatYamlValue(val)}`);
            }
          }
          if (prop.default !== undefined) {
            lines.push(`          default: ${formatYamlValue(prop.default)}`);
          }
          if (prop.items && typeof prop.items === 'object') {
            lines.push('          items:');
            if ((prop.items as Record<string, unknown>).type) {
              lines.push(`            type: ${(prop.items as Record<string, unknown>).type}`);
            }
          }
        }
      }
      if (tool.inputSchema.required && tool.inputSchema.required.length > 0) {
        lines.push(`      required: [${tool.inputSchema.required.join(', ')}]`);
      }
      if (tool.inputSchema.additionalProperties !== undefined) {
        lines.push(`      additionalProperties: ${tool.inputSchema.additionalProperties}`);
      }
    }
  }

  lines.push('---');
  lines.push('');

  // 添加内容
  const trimmedContent = content.trim();
  if (trimmedContent) {
    lines.push(trimmedContent);
  }

  return lines.join('\n');
}
