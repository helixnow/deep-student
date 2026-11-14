/**
 * Skill 包路径校验与包哈希：移植 `chat_v2/skills.rs` 的
 * `get_allowed_skills_bases` / `expand_path` / `validate_skill_path` /
 * `canonicalize_skill_package_root`，以及
 * `chat_v2/tools/skill_workshop_executor.rs` 的 `read_package_directory` /
 * `package_sha256` / `validate_package_files`。
 *
 * 这些函数供 `runtime_roots` 的技能信任记录使用；错误文案保持 Rust 的
 * `ChatV2Error` Display 形式。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { RuntimeRoot } from '../api.ts';
import { isWithin, stripWindowsVerbatimPrefix } from './runtime-paths.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export const SKILL_FILE_NAME = 'SKILL.md';
export const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';
export const MAX_PACKAGE_FILES = 256;
export const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PACKAGE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_CONTENT_BYTES = 40_000;

/** Rust `{:?}` 的 PathBuf 展示（普通路径即加引号）。 */
export function debugPath(value: string): string {
  return JSON.stringify(value);
}

function debugPaths(values: readonly string[]): string {
  return `[${values.map(debugPath).join(', ')}]`;
}

/** Rust `dirs::data_dir()` 的桌面平台口径。 */
export function platformDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA && rustTrim(env.APPDATA) ? env.APPDATA : null;
  const xdg = env.XDG_DATA_HOME == null ? undefined : rustTrim(env.XDG_DATA_HOME);
  return xdg ? xdg : path.join(os.homedir(), '.local', 'share');
}

export interface SkillPathOptions {
  /** `ctx.app.dataDir`，对应 Tauri `app_data_dir()`。 */
  appDataDir: string;
  home?: string;
  dataDir?: string | null;
  currentDir?: string | null;
  mobile?: boolean;
}

/** `build_allowed_skills_bases`：顺序与去重语义与 Rust 一致。 */
export function allowedSkillsBases(options: SkillPathOptions): string[] {
  const bases: string[] = [];
  const push = (value: string) => { if (!bases.includes(value)) bases.push(value); };
  const home = options.home ?? os.homedir();
  if (home) {
    push(path.join(home, '.cursor', 'skills-cursor'));
    push(path.join(home, '.deep-student', 'skills'));
    if (options.mobile) push(path.join(home, '.skills'));
  }
  push(path.join(options.appDataDir, '.skills'));
  if (!options.mobile) {
    const dataDir = options.dataDir === undefined ? platformDataDir() : options.dataDir;
    if (dataDir) {
      push(path.join(dataDir, 'ds91', 'skills'));
      push(path.join(dataDir, 'deep-student', 'skills'));
    }
  }
  const currentDir = options.currentDir === undefined ? safeCwd() : options.currentDir;
  if (currentDir) {
    push(path.join(currentDir, '.skills'));
    push(path.join(currentDir, '.agents', 'skills'));
    push(path.join(currentDir, '.claude', 'skills'));
    push(path.join(currentDir, '.github', 'skills'));
  }
  return bases;
}

function safeCwd(): string | null {
  try { return process.cwd(); } catch { return null; }
}

/** Rust `expand_path`：只展开 `~` 与 `~/` 前缀。 */
export function expandSkillPath(raw: string, home: string = os.homedir()): string {
  if (raw === '~') return home || raw;
  if (raw.startsWith('~/') && home) return path.join(home, raw.slice(2));
  return raw;
}

/** Rust `normalize_path`：纯逻辑消除 `.` / `..`（不访问文件系统）。 */
export function normalizeLexicalPath(value: string): string {
  return path.normalize(value);
}

/** Rust `validate_skill_path`（返回 void，失败抛带 ChatV2Error 前缀的字符串）。 */
export function validateSkillPath(target: string, options: SkillPathOptions): void {
  const bases = allowedSkillsBases(options);
  if (bases.length === 0) throw new Error('IO error: Cannot determine allowed skills directories');

  let canonicalPath: string;
  if (fs.existsSync(target)) {
    let resolved: string;
    try { resolved = fs.realpathSync.native(target); } catch (error) {
      throw new Error(`IO error: Failed to canonicalize path ${debugPath(target)}: ${(error as Error).message}`);
    }
    canonicalPath = stripWindowsVerbatimPrefix(resolved);
  } else {
    const absolute = path.isAbsolute(target) ? target : path.join(safeCwd() ?? process.cwd(), target);
    canonicalPath = normalizeLexicalPath(absolute);
  }

  for (const base of bases) {
    let canonicalBase: string;
    if (fs.existsSync(base)) {
      try { canonicalBase = stripWindowsVerbatimPrefix(fs.realpathSync.native(base)); } catch { continue; }
    } else {
      canonicalBase = normalizeLexicalPath(base);
    }
    if (isWithin(canonicalBase, canonicalPath)) return;
  }

  throw new Error(`Invalid input: Path traversal detected: ${debugPath(target)} is not within allowed skills directories. Allowed bases: ${debugPaths(bases)}`);
}

/** `canonicalize_skill_package_root`：必须存在、是目录且包含 SKILL.md。 */
export function canonicalizeSkillPackageRoot(rawPath: string, options: SkillPathOptions): string {
  const expanded = expandSkillPath(rawPath, options.home ?? os.homedir());
  validateSkillPath(expanded, options);
  if (!fs.existsSync(expanded)) {
    throw new Error(`Resource not found: Skill package root not found: ${debugPath(expanded)}`);
  }
  if (!fs.statSync(expanded).isDirectory()) {
    throw new Error(`Invalid input: Skill package root is not a directory: ${debugPath(expanded)}`);
  }
  if (!fs.existsSync(path.join(expanded, SKILL_FILE_NAME))) {
    throw new Error(`Invalid input: Not a valid skill package directory (missing SKILL.md): ${debugPath(expanded)}`);
  }
  try {
    return fs.realpathSync.native(expanded);
  } catch (error) {
    throw new Error(`IO error: Failed to canonicalize skill package root ${debugPath(expanded)}: ${(error as Error).message}`);
  }
}

/** `SkillWorkshopExecutor::normalize_package_path`。 */
export function normalizePackagePath(raw: string): string {
  if (raw === '' || raw.includes('\\') || path.isAbsolute(raw)) {
    throw new Error(`Invalid skill package path: ${debugPath(raw)}`);
  }
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new Error(`Invalid skill package path: ${debugPath(raw)}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Invalid skill package path: ${debugPath(raw)}`);
  const normalized = parts.join('/');
  const normalizedLower = normalized.toLowerCase();
  const allowed = normalizedLower === SKILL_FILE_NAME.toLowerCase()
    || ['scripts/', 'references/', 'assets/', 'agents/', 'templates/', 'examples/']
      .some(prefix => normalizedLower.startsWith(prefix))
    || normalizedLower === '_meta.json'
    || normalizedLower === 'skill-card.md'
    || (!normalizedLower.includes('/') && (
      normalizedLower === 'readme'
      || normalizedLower.startsWith('readme.')
      || normalizedLower === 'license'
      || normalizedLower.startsWith('license.')
    ));
  if (!allowed) {
    throw new Error(`Skill package path '${raw}' is outside the supported Agent Skills package layout (SKILL.md, scripts/, references/, assets/, agents/, templates/, examples/, README*, LICENSE*, _meta.json, skill-card.md)`);
  }
  return normalizedLower === SKILL_FILE_NAME.toLowerCase() ? SKILL_FILE_NAME : normalized;
}

/** `SkillWorkshopExecutor::validate_content`。 */
export function validateSkillContent(content: string): void {
  const bytes = Buffer.byteLength(content);
  if (bytes === 0) throw new Error('content must not be empty');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(`content exceeds ${MAX_CONTENT_BYTES} byte limit (got ${bytes} bytes)`);
  }
  const lines = content.replace(/^\p{White_Space}+/u, '').split(/\r?\n/);
  if (lines[0] !== '---' || !lines.slice(1).some(line => line === '---')) {
    throw new Error('content must contain a complete YAML frontmatter block delimited by exact --- lines');
  }
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** `SkillWorkshopExecutor::validate_package_files`。 */
export function validatePackageFiles(files: readonly [string, Buffer][]): [string, Buffer][] {
  if (files.length === 0) throw new Error('files must contain SKILL.md');
  if (files.length > MAX_PACKAGE_FILES) throw new Error(`Skill package exceeds ${MAX_PACKAGE_FILES} file limit`);
  const seen = new Set<string>();
  let total = 0;
  const normalized: [string, Buffer][] = [];
  for (const [rawPath, bytes] of files) {
    const filePath = normalizePackagePath(rawPath);
    const folded = filePath.toLowerCase();
    if (seen.has(folded)) throw new Error(`Skill package contains duplicate path: ${filePath}`);
    seen.add(folded);
    if (bytes.length > MAX_PACKAGE_FILE_BYTES) {
      throw new Error(`Skill package file '${filePath}' exceeds ${MAX_PACKAGE_FILE_BYTES} byte limit`);
    }
    total += bytes.length;
    if (total > MAX_PACKAGE_TOTAL_BYTES) {
      throw new Error(`Skill package exceeds ${MAX_PACKAGE_TOTAL_BYTES} byte total limit`);
    }
    normalized.push([filePath, bytes]);
  }
  const skill = normalized.find(([filePath]) => filePath === SKILL_FILE_NAME);
  if (!skill) throw new Error('Skill package must contain SKILL.md');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(skill[1]);
  } catch (error) {
    throw new Error(`SKILL.md is not valid UTF-8: ${(error as Error).message}`);
  }
  validateSkillContent(content);
  normalized.sort((left, right) => byteCompare(left[0], right[0]));
  return normalized;
}

/** `SkillWorkshopExecutor::read_package_directory`。 */
export function readPackageDirectory(root: string): [string, Buffer][] {
  if (!fs.existsSync(root)) throw new Error(`Skill directory does not exist: ${debugPath(root)}`);
  const files: [string, Buffer][] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      throw new Error(`Failed to inspect skill package: ${(error as Error).message}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill packages may not contain symlinks: ${debugPath(full)}`);
      }
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      let relative: string;
      try { relative = path.relative(root, full).split(path.sep).join('/'); } catch (error) {
        throw new Error(`Failed to resolve package path: ${(error as Error).message}`);
      }
      if (relative === AGENT_INSTALLED_MARKER) continue;
      let bytes: Buffer;
      try { bytes = fs.readFileSync(full); } catch (error) {
        throw new Error(`Failed to read package file: ${(error as Error).message}`);
      }
      files.push([relative, bytes]);
    }
  };
  walk(root);
  return validatePackageFiles(files);
}

/** `SkillWorkshopExecutor::package_sha256`。 */
export function packageSha256(files: readonly [string, Buffer][]): string {
  const ordered = [...files].sort((left, right) => byteCompare(left[0], right[0]));
  const hash = createHash('sha256');
  const length = Buffer.alloc(8);
  for (const [filePath, bytes] of ordered) {
    const pathBytes = Buffer.from(filePath, 'utf8');
    length.writeBigUInt64LE(BigInt(pathBytes.length));
    hash.update(length);
    hash.update(pathBytes);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** `runtime_roots::skill_package_runtime_root`。 */
export function skillPackageRuntimeRoot(skillId: string, rawPath: string, options: SkillPathOptions): RuntimeRoot {
  const canonical = canonicalizeSkillPackageRoot(rawPath, options);
  return {
    id: `skill:${skillId}`,
    kind: 'skill_package',
    path: canonical,
    access: 'read_only',
    label: `Skill: ${skillId}`,
    description: 'Read-only skill package root for references, scripts, and assets.',
    session_scoped: false,
    configured: false,
  };
}
