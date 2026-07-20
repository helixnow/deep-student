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
  SkillRequires,
  JsonSchemaProperty,
} from './types';
import { validateSkillMetadata, SKILL_DEFAULT_PRIORITY } from './types';

// ============================================================================
// 常量
// ============================================================================

const LOG_PREFIX = '[SkillParser]';

/** Frontmatter 分隔符 */
const FRONTMATTER_DELIMITER = '---';

/** 最大 frontmatter 长度（容纳合法 embeddedTools，同时限制 YAML 解析成本） */
const MAX_FRONTMATTER_LENGTH = 64 * 1024;

const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'version',
  'author',
  'license',
  'homepage',
  'tags',
  'compatibility',
  'priority',
  'allowed-tools',
  'allowedTools',
  'tools',
  'disableAutoInvoke',
  'disable-model-invocation',
  'disableModelInvocation',
  'user-invocable',
  'userInvocable',
  'argument-hint',
  'argumentHint',
  'embedded-tools',
  'embeddedTools',
  'skill-type',
  'skillType',
  'related-skills',
  'relatedSkills',
  'dependencies',
  'requires',
  'manifest-version',
  'manifestVersion',
]);

// ============================================================================
// Frontmatter 解析
// ============================================================================

/**
 * 分离 frontmatter 和内容
 *
 * @param content 文件完整内容
 * @returns [frontmatter, content] 或 null（无 frontmatter）
 */
interface FrontmatterBounds {
  start: number;
  end: number;
  contentStart: number;
}

function findFrontmatterBounds(content: string): { trimmed: string; bounds: FrontmatterBounds } | null {
  const trimmed = content.trimStart();

  // Delimiters may have surrounding horizontal whitespace, but no other
  // content. In particular, "---suffix" must never terminate frontmatter.
  const opening = /^---[ \t]*(?:\r?\n|$)/.exec(trimmed);
  if (!opening) {
    return null;
  }

  const closingPattern = /^---[ \t]*\r?$/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(trimmed);
  if (!closing) {
    return null;
  }

  return {
    trimmed,
    bounds: {
      start: opening[0].length,
      end: closing.index,
      contentStart: closingPattern.lastIndex,
    },
  };
}

function splitFrontmatter(content: string): [string, string] | null {
  const located = findFrontmatterBounds(content);
  if (!located) return null;
  const { trimmed, bounds } = located;

  // 提取 frontmatter（不含分隔符）
  const frontmatter = trimmed.slice(bounds.start, bounds.end).trim();

  // 检查长度限制 — 超出则拒绝解析
  if (frontmatter.length > MAX_FRONTMATTER_LENGTH) {
    return null;
  }

  // 提取内容（第二个 --- 之后）
  const markdownContent = trimmed.slice(bounds.contentStart).trim();

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

function extractPreservedFrontmatter(rawMetadata: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawMetadata)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      preserved[key] = value;
    }
  }
  return preserved;
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  target[key] = value;
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
 * 将布尔字段安全转换
 *
 * 支持 YAML bool 与字符串 `"true"` / `"false"`。
 */
function coerceBooleanField(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * 解析 disableAutoInvoke，并合并 Anthropic `disable-model-invocation`
 *
 * 两者同时存在时取更保守值（任一为 true → true）。
 */
function parseDisableAutoInvoke(rawMetadata: Record<string, unknown>): boolean {
  const native = coerceBooleanField(rawMetadata.disableAutoInvoke);
  const anthropic = coerceBooleanField(
    rawMetadata['disable-model-invocation'] ?? rawMetadata.disableModelInvocation
  );
  return native === true || anthropic === true;
}

/**
 * 将数组字段安全转换为字符串数组
 *
 * 支持两种输入格式：
 * - YAML 数组：`[a, b, c]` → `['a', 'b', 'c']`
 * - 逗号分隔字符串：`"a, b, c"` → `['a', 'b', 'c']`
 */
function coerceStringArrayField(value: unknown): string[] | undefined {
  // 支持：
  // - YAML 数组：`[a, b]`
  // - 逗号分隔：`"Read, Write"`
  // - Agent Skills 空格分隔：`allowed-tools: Read Bash`
  if (typeof value === 'string') {
    const parts = value
      .split(/[,\s]+/)
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
        additionalProperties: inputSchema.additionalProperties as
          | boolean
          | JsonSchemaProperty
          | undefined,
        anyOf: Array.isArray(inputSchema.anyOf)
          ? inputSchema.anyOf as JsonSchemaProperty[]
          : undefined,
        oneOf: Array.isArray(inputSchema.oneOf)
          ? inputSchema.oneOf as JsonSchemaProperty[]
          : undefined,
      },
    } as ToolSchema);
  }

  return tools.length > 0 ? tools : undefined;
}

function parseRequiresMap(value: unknown): SkillRequires | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const bins = coerceStringArrayField(record.bins);
  const env = coerceStringArrayField(record.env);
  if (!bins && !env) {
    return undefined;
  }
  return { bins, env };
}

function parseRequiresField(
  requiresRaw: unknown,
  metadataRaw?: unknown,
): SkillRequires | undefined {
  const topLevel = parseRequiresMap(requiresRaw);
  if (topLevel) return topLevel;
  if (!metadataRaw || typeof metadataRaw !== 'object') return undefined;
  const openclaw = (metadataRaw as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== 'object') return undefined;
  return parseRequiresMap((openclaw as Record<string, unknown>).requires);
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
    const located = findFrontmatterBounds(content);
    if (located) {
      const fm = located.trimmed.slice(located.bounds.start, located.bounds.end).trim();
      if (fm.length > MAX_FRONTMATTER_LENGTH) {
        return {
          success: false,
          error: i18n.t('skills:parser.frontmatterTooLong'),
          warnings,
        };
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
  const requiresRaw = rawMetadata.requires;
  const metadataRaw = rawMetadata.metadata;
  const manifestVersionRaw = rawMetadata['manifest-version'] ?? rawMetadata.manifestVersion;

  const userInvocableRaw = coerceBooleanField(
    rawMetadata['user-invocable'] ?? rawMetadata.userInvocable
  );
  const argumentHintRaw =
    rawMetadata['argument-hint'] ?? rawMetadata.argumentHint;

  const metadata: Partial<SkillMetadata> = {
    id: skillId,
    name: coerceStringField(rawMetadata.name),
    description: coerceStringField(rawMetadata.description),
    version: coerceStringField(rawMetadata.version),
    author: coerceStringField(rawMetadata.author),
    license: coerceStringField(rawMetadata.license),
    homepage: coerceStringField(rawMetadata.homepage),
    tags: coerceStringArrayField(rawMetadata.tags),
    compatibility: coerceStringField(rawMetadata.compatibility),
    priority: typeof rawMetadata.priority === 'number' ? rawMetadata.priority : undefined,
    allowedTools: coerceStringArrayField(allowedToolsRaw),
    tools: coerceStringArrayField(toolsRaw), // 向后兼容
    disableAutoInvoke: parseDisableAutoInvoke(rawMetadata),
    userInvocable: userInvocableRaw,
    argumentHint: coerceStringField(argumentHintRaw),
    embeddedTools: parseEmbeddedTools(embeddedToolsRaw, warnings),
    skillType: parseSkillType(skillTypeRaw),
    relatedSkills: coerceStringArrayField(relatedSkillsRaw),
    dependencies: coerceStringArrayField(dependenciesRaw),
    requires: parseRequiresField(requiresRaw, metadataRaw),
    manifestVersion: coerceStringField(manifestVersionRaw),
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
    license: metadata.license,
    homepage: metadata.homepage,
    tags: metadata.tags,
    compatibility: metadata.compatibility,
    priority: metadata.priority ?? SKILL_DEFAULT_PRIORITY,
    allowedTools: metadata.allowedTools,
    tools: metadata.tools, // 向后兼容
    disableAutoInvoke: metadata.disableAutoInvoke ?? false,
    userInvocable: metadata.userInvocable,
    argumentHint: metadata.argumentHint,
    embeddedTools: metadata.embeddedTools, // 渐进披露架构核心字段
    skillType: metadata.skillType ?? 'standalone', // 默认独立型
    relatedSkills: metadata.relatedSkills,
    dependencies: metadata.dependencies,
    requires: metadata.requires,
    manifestVersion: metadata.manifestVersion,
    content: markdownContent,
    sourcePath,
    location,
    preservedFrontmatter: extractPreservedFrontmatter(rawMetadata),
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
    const requiresRaw = raw.requires;
    const metadataRaw = raw.metadata;
    const manifestVersionRaw = raw['manifest-version'] ?? raw.manifestVersion;

    return {
      id: skillId,
      name: raw.name,
      description: raw.description,
      version: coerceStringField(raw.version),
      author: coerceStringField(raw.author),
      license: coerceStringField(raw.license),
      homepage: coerceStringField(raw.homepage),
      tags: coerceStringArrayField(raw.tags),
      compatibility: coerceStringField(raw.compatibility),
      priority: (typeof raw.priority === 'number' ? raw.priority : undefined) ?? SKILL_DEFAULT_PRIORITY,
      allowedTools,
      tools: coerceStringArrayField(raw.tools), // 向后兼容
      disableAutoInvoke: parseDisableAutoInvoke(raw),
      userInvocable: coerceBooleanField(raw['user-invocable'] ?? raw.userInvocable),
      argumentHint: coerceStringField(raw['argument-hint'] ?? raw.argumentHint),
      embeddedTools,
      skillType: parseSkillType(skillTypeRaw),
      relatedSkills: coerceStringArrayField(relatedSkillsRaw),
      dependencies: coerceStringArrayField(dependenciesRaw),
      requires: parseRequiresField(requiresRaw, metadataRaw),
      manifestVersion: coerceStringField(manifestVersionRaw),
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
  metadata: Omit<SkillMetadata, 'id'> & { preservedFrontmatter?: Record<string, unknown> },
  content: string
): string {
  const frontmatter: Record<string, unknown> = {
    ...(metadata.preservedFrontmatter ?? {}),
  };

  frontmatter.name = metadata.name;
  frontmatter.description = metadata.description;
  setIfDefined(frontmatter, 'version', metadata.version);
  setIfDefined(frontmatter, 'author', metadata.author);
  setIfDefined(frontmatter, 'license', metadata.license);
  setIfDefined(frontmatter, 'homepage', metadata.homepage);
  setIfDefined(frontmatter, 'compatibility', metadata.compatibility);

  if (metadata.tags && metadata.tags.length > 0) {
    frontmatter.tags = metadata.tags;
  } else {
    delete frontmatter.tags;
  }

  if (metadata.priority !== undefined && metadata.priority !== SKILL_DEFAULT_PRIORITY) {
    frontmatter.priority = metadata.priority;
  } else {
    delete frontmatter.priority;
  }

  const toolsList = metadata.allowedTools ?? metadata.tools;
  if (toolsList && toolsList.length > 0) {
    frontmatter['allowed-tools'] = toolsList;
  } else {
    delete frontmatter['allowed-tools'];
    delete frontmatter.allowedTools;
    delete frontmatter.tools;
  }

  // disableAutoInvoke 为 Deep Student 一等字段；Anthropic 的 disable-model-invocation
  // 在解析期已合并进来，序列化时写回原生字段并清理 kebab/camel 别名，避免重复。
  if (metadata.disableAutoInvoke) {
    frontmatter.disableAutoInvoke = true;
  } else {
    delete frontmatter.disableAutoInvoke;
  }
  delete frontmatter['disable-model-invocation'];
  delete frontmatter.disableModelInvocation;

  if (metadata.userInvocable === false) {
    frontmatter['user-invocable'] = false;
  } else if (metadata.userInvocable === true) {
    frontmatter['user-invocable'] = true;
  } else {
    delete frontmatter['user-invocable'];
  }
  delete frontmatter.userInvocable;

  if (metadata.argumentHint) {
    frontmatter['argument-hint'] = metadata.argumentHint;
  } else {
    delete frontmatter['argument-hint'];
  }
  delete frontmatter.argumentHint;

  if (metadata.skillType && metadata.skillType !== 'standalone') {
    frontmatter['skill-type'] = metadata.skillType;
  } else {
    delete frontmatter['skill-type'];
    delete frontmatter.skillType;
  }

  if (metadata.relatedSkills && metadata.relatedSkills.length > 0) {
    frontmatter['related-skills'] = metadata.relatedSkills;
  } else {
    delete frontmatter['related-skills'];
    delete frontmatter.relatedSkills;
  }

  if (metadata.dependencies && metadata.dependencies.length > 0) {
    frontmatter.dependencies = metadata.dependencies;
  } else {
    delete frontmatter.dependencies;
  }

  if (metadata.requires && (metadata.requires.bins?.length || metadata.requires.env?.length)) {
    frontmatter.requires = {
      ...(metadata.requires.bins?.length ? { bins: metadata.requires.bins } : {}),
      ...(metadata.requires.env?.length ? { env: metadata.requires.env } : {}),
    };
  } else {
    delete frontmatter.requires;
  }

  if (metadata.manifestVersion) {
    frontmatter['manifest-version'] = metadata.manifestVersion;
  } else {
    delete frontmatter['manifest-version'];
    delete frontmatter.manifestVersion;
  }

  if (metadata.embeddedTools && metadata.embeddedTools.length > 0) {
    frontmatter.embeddedTools = metadata.embeddedTools;
  } else {
    delete frontmatter.embeddedTools;
    delete frontmatter['embedded-tools'];
  }

  const lines: string[] = ['---', YAML.stringify(frontmatter).trimEnd(), '---', ''];

  // 添加内容
  const trimmedContent = content.trim();
  if (trimmedContent) {
    lines.push(trimmedContent);
  }

  return lines.join('\n');
}
