/**
 * 移动端技能文件命令（`skill_list_directories` / `skill_list_package_files` / `skill_read_file` /
 * `skill_create` / `skill_update` / `skill_delete`）的 `ctx.files` 实现。
 *
 * 与桌面 `files.ts` 的分支顺序和错误文案保持一致：先校验路径范围，再判存在/类型，最后做 IO。
 * 差别只有两处，都是平台事实：
 * - `ctx.files` 只有异步 API（OPFS / Capacitor Filesystem），因此这些命令在移动端是 async；
 * - 没有符号链接与 Unix 权限位，`listPackageFiles` 不需要 symlink 分支，也不返回 `unixMode`。
 */
import type { FilesService } from '../../../../platform/files/api.ts';
import type { SkillDirectoryEntry, SkillFileContent, SkillPackageFileEntry } from '../../api.ts';
import { posix } from '../../../../platform/util/path.ts';
import { debugPath, fail, MobileSkillPaths } from './paths.ts';

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_FILES = 200;
const MAX_PACKAGE_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'target', 'dist', 'build']);

export interface MobileSkillFilesLogger {
  warn?(message: string): void;
}

export function ioMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 错误信封里的 code（解析 CommandError 的 JSON 值）。 */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { value?: unknown }).value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch { return null; }
}

async function io<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (errorCode(error) !== null) throw error;
    return fail('IO_ERROR', `${message}: ${ioMessage(error)}`);
  }
}

export class MobileSkillFiles {
  readonly files: FilesService;
  readonly paths: MobileSkillPaths;
  private readonly logger: MobileSkillFilesLogger;

  constructor(files: FilesService, paths: MobileSkillPaths, logger: MobileSkillFilesLogger = {}) {
    this.files = files;
    this.paths = paths;
    this.logger = logger;
  }

  private warn(message: string): void {
    this.logger.warn?.(`[Skills] ${message}`);
  }

  expandPath(raw: string): string {
    return this.paths.expandSkillPath(raw);
  }

  validatePath(raw: string): string {
    return this.paths.validateSkillPath(raw);
  }

  getAllowedSkillsBases(): string[] {
    return this.paths.getAllowedSkillsBases();
  }

  async exists(path: string): Promise<boolean> {
    try { return await this.files.exists(path); }
    catch { return false; }
  }

  async canonicalizeSkillPackageRoot(raw: string): Promise<string> {
    const value = this.validatePath(raw);
    if (!await this.exists(value)) fail('RESOURCE_NOT_FOUND', `Skill package root not found: ${debugPath(value)}`);
    let stat;
    try { stat = await this.files.stat(value); }
    catch (error) { return fail('IO_ERROR', `Failed to read skill package root ${debugPath(value)}: ${ioMessage(error)}`); }
    if (stat.kind !== 'directory') fail('INVALID_INPUT', `Skill package root is not a directory: ${debugPath(value)}`);
    if (!await this.exists(posix.join(value, 'SKILL.md'))) {
      fail('INVALID_INPUT', `Not a valid skill package directory (missing SKILL.md): ${debugPath(value)}`);
    }
    return value;
  }

  async listDirectories(raw: string): Promise<SkillDirectoryEntry[]> {
    const value = this.validatePath(raw);
    if (!await this.exists(value)) return [];
    let stat;
    try { stat = await this.files.stat(value); }
    catch (error) { return fail('IO_ERROR', `Failed to read directory ${debugPath(value)}: ${ioMessage(error)}`); }
    if (stat.kind !== 'directory') {
      this.warn(`路径不是目录: ${debugPath(value)}`);
      fail('INVALID_INPUT', `Path is not a directory: ${debugPath(value)}`);
    }
    const entries = await io(() => this.files.readDir(value), `Failed to read directory ${debugPath(value)}`);
    const out: SkillDirectoryEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
      out.push({ name: entry.name, path: entry.path });
    }
    return out;
  }

  async listPackageFiles(raw: string): Promise<SkillPackageFileEntry[]> {
    let root: string;
    try { root = await this.canonicalizeSkillPackageRoot(raw); }
    catch (error) {
      if (errorCode(error) === 'RESOURCE_NOT_FOUND') return [];
      throw error;
    }
    if (!await this.exists(root)) return [];
    const entries: SkillPackageFileEntry[] = [];
    const collect = async (current: string, depth: number): Promise<void> => {
      if (entries.length >= MAX_PACKAGE_FILES || depth > MAX_PACKAGE_DEPTH) return;
      const children = await io(() => this.files.readDir(current),
        `Failed to read package directory ${debugPath(current)}`);
      for (const child of children) {
        if (entries.length >= MAX_PACKAGE_FILES) break;
        if (child.kind === 'symlink') continue;
        if (child.kind === 'directory') {
          if (!child.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(child.name)) {
            await collect(child.path, depth + 1);
          }
          continue;
        }
        if (child.kind !== 'file') continue;
        const relative = posix.relative(root, child.path).replaceAll('\\', '/');
        if (!relative) continue;
        let size = 0;
        try { size = (await this.files.stat(child.path)).size; } catch { size = 0; }
        entries.push({ path: relative, size });
      }
    };
    await collect(root, 0);
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  async readFile(raw: string): Promise<SkillFileContent> {
    const value = this.validatePath(raw);
    await this.validateExistingFile(value);
    const bytes = await io(() => this.files.readBytes(value), `Failed to read file ${debugPath(value)}`);
    try {
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), path: value };
    } catch {
      return fail('IO_ERROR', `Failed to read file ${debugPath(value)}: stream did not contain valid UTF-8`);
    }
  }

  async validateExistingFile(value: string): Promise<void> {
    if (!await this.exists(value)) fail('RESOURCE_NOT_FOUND', `File not found: ${debugPath(value)}`);
    let stat;
    try { stat = await this.files.stat(value); }
    catch (error) { return fail('IO_ERROR', `Failed to read file ${debugPath(value)}: ${ioMessage(error)}`); }
    if (stat.kind !== 'file') fail('INVALID_INPUT', `Path is not a file: ${debugPath(value)}`);
  }

  validateFileSize(content: string): void {
    const size = new TextEncoder().encode(content).length;
    if (size > MAX_SKILL_FILE_BYTES) {
      fail('INVALID_INPUT', `Skill file too large (${size} bytes > ${MAX_SKILL_FILE_BYTES} bytes)`);
    }
  }

  async create(basePath: string, skillId: string, content: string): Promise<SkillFileContent> {
    this.validateFileSize(content);
    if (!/^[\p{Alphabetic}\p{N}_-]*$/u.test(skillId) || skillId.includes('\n')) {
      fail('INVALID_INPUT', 'Skill ID can only contain letters, numbers, hyphens, and underscores');
    }
    if (!skillId) fail('INVALID_INPUT', 'Skill ID cannot be empty');
    const base = this.expandPath(basePath);
    const dir = posix.join(base, skillId);
    const file = posix.join(dir, 'SKILL.md');
    this.validatePath(file);
    if (await this.exists(dir)) fail('INVALID_INPUT', `Skill directory already exists: ${debugPath(dir)}`);
    await io(() => this.files.mkdir(base, { recursive: true }), `Failed to create base directory ${debugPath(base)}`);
    await io(() => this.files.mkdir(dir), `Failed to create skill directory ${debugPath(dir)}`);
    await io(() => this.files.writeText(file, content), `Failed to write skill file ${debugPath(file)}`);
    return { content, path: file };
  }

  async update(raw: string, content: string): Promise<SkillFileContent> {
    this.validateFileSize(content);
    const value = this.validatePath(raw);
    await this.validateExistingFile(value);
    await io(() => this.files.writeText(value, content), `Failed to write file ${debugPath(value)}`);
    return { content, path: value };
  }

  async delete(raw: string): Promise<null> {
    const value = this.validatePath(raw);
    if (!await this.exists(value)) fail('RESOURCE_NOT_FOUND', `Directory not found: ${debugPath(value)}`);
    let stat;
    try { stat = await this.files.stat(value); }
    catch (error) { return fail('IO_ERROR', `Failed to read directory ${debugPath(value)}: ${ioMessage(error)}`); }
    if (stat.kind !== 'directory') fail('INVALID_INPUT', `Path is not a directory: ${debugPath(value)}`);
    if (!await this.exists(posix.join(value, 'SKILL.md'))) {
      fail('INVALID_INPUT', `Not a valid skill directory (missing SKILL.md): ${debugPath(value)}`);
    }
    await io(() => this.files.rm(value, { recursive: true }), `Failed to delete directory ${debugPath(value)}`);
    return null;
  }
}
