// workspace/custom_agents.rs —— 自定义子代理定义（契约 C6）。
//
// `{workspaces_dir}/agents/*.md` 每个 Markdown 文件定义一个自定义 profile：
// 文件开头 `---` frontmatter 提供元数据，正文（trim 后非空）替换 base 的 instructions。
//
// 原则：手写 frontmatter 解析（未知 key 忽略）；name 非法 / 与内建 id 冲突 /
// base 非内建 → 整个文件跳过；tools 越界仅剔除越界项；tools 覆盖时自动并入协作工具。
import * as fs from 'node:fs';
import path from 'node:path';
import {
  AgentProfileResolver, WORKER_PROFILE_ID, type AgentProfile, type CustomProfileSource, type ReasoningEffort,
} from './agent-profile.ts';
import {
  CHATANKI_READONLY_TOOLS, COLLABORATION_TOOLS, HEADLESS_ALLOWED_TOOLS,
} from './tool-registry.ts';
import { chronoRfc3339 } from '../../../../platform/time/index.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './logger.ts';

/** 单个定义文件大小上限（64 KiB），超出忽略。 */
const MAX_FILE_BYTES = 64 * 1024;
/** 目录最多加载的定义文件数（按文件名排序后）。 */
const MAX_FILES = 64;

interface AgentFileFrontmatter {
  name: string | null;
  description: string | null;
  base: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  tools: string[] | null;
  skills: string[] | null;
  invalidFields: string[];
}

function emptyFrontmatter(): AgentFileFrontmatter {
  return {
    name: null,
    description: null,
    base: null,
    model: null,
    reasoningEffort: null,
    tools: null,
    skills: null,
    invalidFields: [],
  };
}

function nonEmpty(value: string): string | null {
  const trimmed = rustTrim(value);
  return trimmed.length === 0 ? null : trimmed;
}

/** 列表值：支持 `[a, b]` 内联数组或裸逗号分隔，可选引号包裹。 */
function parseListValue(value: string): string[] {
  let inner = rustTrim(value);
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  return inner
    .split(',')
    .map(item => rustTrim(trimQuotes(rustTrim(item))))
    .filter(item => item.length > 0);
}

function trimQuotes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '"' || value[start] === '\'')) start++;
  while (end > start && (value[end - 1] === '"' || value[end - 1] === '\'')) end--;
  return value.slice(start, end);
}

function parseReasoningEffort(value: string): ReasoningEffort | null {
  switch (trimQuotes(rustTrim(value))) {
    case 'minimal': return 'minimal';
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh':
    case 'x_high': return 'xhigh';
    default: return null;
  }
}

/** Rust `str::lines()`：按 `\n` 切分并去掉行尾 `\r`。 */
function rustLines(content: string): string[] {
  return content.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function splitOnce(value: string, separator: string): [string, string] | null {
  const index = value.indexOf(separator);
  if (index < 0) return null;
  return [value.slice(0, index), value.slice(index + separator.length)];
}

/** 拆分 frontmatter 与正文；缺失或未闭合返回 null。 */
function parseAgentFile(content: string): { front: AgentFileFrontmatter; body: string } | null {
  const lines = rustLines(content);
  let index = 0;
  if (rustTrim(lines[index] ?? '') !== '---') return null;
  index++;
  const front = emptyFrontmatter();
  let closed = false;
  for (; index < lines.length; index++) {
    const line = lines[index] as string;
    if (rustTrim(line) === '---') {
      closed = true;
      index++;
      break;
    }
    const pair = splitOnce(line, ':');
    if (!pair) continue;
    const [rawKey, value] = pair;
    switch (rustTrim(rawKey)) {
      case 'name': front.name = nonEmpty(value); break;
      case 'description': front.description = nonEmpty(value); break;
      case 'base': front.base = nonEmpty(value); break;
      case 'model': front.model = nonEmpty(value); break;
      case 'reasoning_effort':
      case 'reasoningEffort': {
        const effort = parseReasoningEffort(value);
        if (effort !== null) front.reasoningEffort = effort;
        else front.invalidFields.push('reasoning_effort (allowed: minimal/low/medium/high/xhigh)');
        break;
      }
      case 'tools': front.tools = parseListValue(value); break;
      case 'skills': front.skills = parseListValue(value); break;
      case 'permissions':
      case 'context_inheritance':
      case 'contextInheritance':
        front.invalidFields.push(`${rustTrim(rawKey)} (unsupported)`);
        break;
      default:
        // 未知 key 忽略，保持前向兼容。
        break;
    }
  }
  if (!closed) return null;
  return { front, body: lines.slice(index).join('\n') };
}

/** name 校验：非空，且只允许小写字母 / 数字 / 连字符。 */
function isValidName(name: string): boolean {
  return name.length > 0 && /^[a-z0-9-]+$/.test(name);
}

/** 自定义 profile 可声明的工具安全全集：协作工具 ∪ headless 只读 ∪ chatanki 只读四工具。 */
export function safeToolSet(): Set<string> {
  const set = new Set<string>(HEADLESS_ALLOWED_TOOLS);
  for (const tool of COLLABORATION_TOOLS) set.add(tool);
  for (const tool of CHATANKI_READONLY_TOOLS) set.add(tool);
  return set;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** tools 覆盖清洗：越界工具剔除并保留协作工具在列。 */
function sanitizeTools(
  tools: readonly string[],
  file: string,
  logger: WorkspaceLogger,
): string[] {
  const safe = safeToolSet();
  const result: string[] = [...COLLABORATION_TOOLS];
  for (const tool of tools) {
    if (!safe.has(tool)) {
      logger.warn(`[CustomAgents] ${file}: tool '${tool}' is outside the safe whitelist, dropped`);
      continue;
    }
    if (!result.includes(tool)) result.push(tool);
  }
  return result;
}

/** 解析单个定义文件为 profile；任何 fail-closed 校验失败返回 null（调用方跳过）。 */
function profileFromFile(
  file: string,
  logger: WorkspaceLogger = silentWorkspaceLogger,
): AgentProfile | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    logger.warn(`[CustomAgents] ${file}: failed to stat file, skipped: ${messageOf(error)}`);
    return null;
  }
  if (size > MAX_FILE_BYTES) {
    logger.warn(`[CustomAgents] ${file}: file exceeds ${MAX_FILE_BYTES / 1024} KiB limit, skipped`);
    return null;
  }

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    logger.warn(`[CustomAgents] ${file}: failed to read file, skipped: ${messageOf(error)}`);
    return null;
  }

  const parsed = parseAgentFile(content);
  if (!parsed) {
    logger.warn(`[CustomAgents] ${file}: missing or unterminated frontmatter, skipped`);
    return null;
  }
  const { front } = parsed;
  if (front.invalidFields.length > 0) {
    logger.warn(`[CustomAgents] ${file}: invalid/unsupported frontmatter fields: ${front.invalidFields.join(', ')}; skipped`);
    return null;
  }
  if (front.name === null) {
    logger.warn(`[CustomAgents] ${file}: frontmatter is missing required 'name', skipped`);
    return null;
  }
  if (!isValidName(front.name)) {
    logger.warn(`[CustomAgents] ${file}: name '${front.name}' is invalid (only lowercase letters, digits and hyphens are allowed), skipped`);
    return null;
  }
  if (AgentProfileResolver.builtIn(front.name) !== null) {
    logger.warn(`[CustomAgents] ${file}: name '${front.name}' conflicts with a built-in profile id, skipped`);
    return null;
  }

  const baseId = front.base ?? WORKER_PROFILE_ID;
  const base = AgentProfileResolver.builtIn(baseId);
  if (!base) {
    logger.warn(`[CustomAgents] ${file}: base '${baseId}' is not a built-in profile id, skipped`);
    return null;
  }

  base.id = front.name;
  // description 不继承 base（内建简介对自定义档案会产生误导）。
  base.description = front.description;
  const body = rustTrim(parsed.body);
  if (body.length > 0) base.instructions = body;
  if (front.model !== null) base.model = front.model;
  if (front.reasoningEffort !== null) base.reasoningEffort = front.reasoningEffort;
  if (front.tools !== null) base.allowedTools = sanitizeTools(front.tools, file, logger);
  if (front.skills !== null) base.skills = [...front.skills];
  return base;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const MD_EXTENSION_RE = /\.md$/i;

/** 目录下的 `.md` 定义文件（按文件名排序）。 */
function definitionFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths = entries
    .map(entry => path.join(dir, entry.name))
    .filter(file => isFile(file) && MD_EXTENSION_RE.test(path.extname(file)));
  paths.sort();
  return paths;
}

/** 扫描目录加载全部自定义 profile（目录不存在返回空；重名先加载者生效）。 */
export function loadCustomProfiles(
  dir: string,
  logger: WorkspaceLogger = silentWorkspaceLogger,
): AgentProfile[] {
  const paths = definitionFiles(dir);
  if (paths.length > MAX_FILES) {
    logger.warn(
      `[CustomAgents] ${dir}: ${paths.length} definition files found, only the first ${MAX_FILES} (by filename) are loaded`,
    );
  }
  const limited = paths.slice(0, MAX_FILES);
  const seenIds = new Set<string>();
  const profiles: AgentProfile[] = [];
  for (const file of limited) {
    const profile = profileFromFile(file, logger);
    if (!profile) continue;
    if (seenIds.has(profile.id)) {
      logger.warn(`[CustomAgents] ${file}: duplicate profile name '${profile.id}', skipped (first definition wins)`);
      continue;
    }
    seenIds.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

/** 按 id 查找单个自定义 profile（现扫目录）。 */
export function findCustomProfile(
  dir: string,
  id: string,
  logger: WorkspaceLogger = silentWorkspaceLogger,
): AgentProfile | null {
  return loadCustomProfiles(dir, logger).find(profile => profile.id === id) ?? null;
}

export function customProfileSource(dir: string): CustomProfileSource {
  return {
    find: (id, logger) => findCustomProfile(dir, id, logger),
    ids: logger => loadCustomProfiles(dir, logger).map(profile => profile.id),
  };
}

/** 设置页文件列表用的 frontmatter 摘要（宽容解析）。 */
export interface FrontmatterSummary {
  name: string | null;
  description: string | null;
  base: string | null;
  model: string | null;
}

/** 宽容提取 frontmatter 中的 name/description/base/model。 */
export function frontmatterSummary(content: string): FrontmatterSummary {
  const summary: FrontmatterSummary = { name: null, description: null, base: null, model: null };
  const lines = rustLines(content);
  if (rustTrim(lines[0] ?? '') !== '---') return summary;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string;
    if (rustTrim(line) === '---') break;
    const pair = splitOnce(line, ':');
    if (!pair) continue;
    const [rawKey, value] = pair;
    const parsed = nonEmpty(value);
    switch (rustTrim(rawKey)) {
      case 'name': summary.name = parsed; break;
      case 'description': summary.description = parsed; break;
      case 'base': summary.base = parsed; break;
      case 'model': summary.model = parsed; break;
      default: break;
    }
  }
  return summary;
}

/** 设置页文件列表条目：宽容摘要 + fail-closed 解析结果。 */
export interface CustomAgentFileInfo {
  fileName: string;
  bytes: number;
  /** RFC3339 修改时间（stat 失败为 null）。 */
  modifiedAt: string | null;
  summary: FrontmatterSummary;
  profile: AgentProfile | null;
}

/** 列出目录下全部 persona 文件（含加载器会跳过的非法文件）。 */
export function listCustomAgentFiles(
  dir: string,
  logger: WorkspaceLogger = silentWorkspaceLogger,
): CustomAgentFileInfo[] {
  return definitionFiles(dir).flatMap(file => {
    const fileName = path.basename(file);
    let bytes = 0;
    let modifiedAt: string | null = null;
    try {
      const stats = fs.statSync(file);
      bytes = stats.size;
      modifiedAt = chronoRfc3339(BigInt(Math.trunc(stats.mtimeMs)) * 1_000_000n);
    } catch {
      modifiedAt = null;
    }
    let summary: FrontmatterSummary;
    try {
      summary = frontmatterSummary(fs.readFileSync(file, 'utf8'));
    } catch {
      summary = { name: null, description: null, base: null, model: null };
    }
    return [{ fileName, bytes, modifiedAt, summary, profile: profileFromFile(file, logger) }];
  });
}
