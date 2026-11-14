import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, opendir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { CommandError } from '../../../kernel/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { SkillDirectoryEntry, SkillFileContent, SkillPackageFileEntry } from '../api.ts';

export function buildAllowedSkillsBases(home: string | null, data: string | null, appData: string | null, current: string | null, mobile: boolean): string[] {
  const bases: string[] = [];
  const push = (value: string) => { if (!bases.includes(value)) bases.push(value); };
  if (home !== null) {
    push(path.join(home, '.cursor', 'skills-cursor'));
    push(path.join(home, '.deep-student', 'skills'));
    if (mobile) push(path.join(home, '.skills'));
  }
  if (appData !== null) push(path.join(appData, '.skills'));
  if (!mobile && data !== null) {
    push(path.join(data, 'ds91', 'skills'));
    push(path.join(data, 'deep-student', 'skills'));
  }
  if (current !== null) for (const relative of ['.skills', '.agents/skills', '.claude/skills', '.github/skills']) push(path.join(current, relative));
  return bases;
}

export function commandMentionsSkillsDirectory(command: string, bases: string[]): boolean {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  if (!normalized) return false;
  if (['.deep-student/skills', '.claude/skills', '.agents/skills', '.github/skills', 'skills-cursor'].some(pattern => normalized.includes(pattern))) return true;
  return bases.some(base => {
    const value = base.replaceAll('\\', '/').toLowerCase();
    return Buffer.byteLength(value) >= 4 && normalized.includes(value);
  });
}

export function stripVerbatimPrefix(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

export function normalizePath(value: string): string {
  const root = path.parse(value).root;
  const parts: string[] = [];
  for (const component of value.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//)) {
    if (component === '..') parts.pop();
    else if (component && component !== '.') parts.push(component);
  }
  return root + parts.join(path.sep);
}

function join(base: string, child: string): string {
  if (path.isAbsolute(child)) return child;
  return base ? `${base}${base.endsWith(path.sep) ? '' : path.sep}${child}` : child;
}

// Portable envelopes (`errors-core.ts`) are re-exported so existing desktop imports keep working.
export { debugPath, fail } from './errors-core.ts';
import { debugPath, fail } from './errors-core.ts';

export function ioMessage(error: unknown): string {
  const value = error as NodeJS.ErrnoException;
  if (typeof value.errno === 'number' && value.errno < 0) {
    const message = getSystemErrorMap().get(value.errno)?.[1] ?? value.message;
    return `${message[0]!.toUpperCase()}${message.slice(1)} (os error ${-value.errno})`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function io<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); }
  catch (error) { return fail('IO_ERROR', `${message}: ${ioMessage(error)}`); }
}

function metadata(value: string) {
  try { return statSync(value); }
  catch { return null; }
}

function within(value: string, base: string): boolean {
  // Path::starts_with is component-based and case-sensitive, including on Windows.
  const normalized = normalizePath(value);
  const parent = normalizePath(base);
  return normalized === parent || normalized.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// RUST-FIX(RF-W02-skills-path-realpath-ancestor): skills.rs:285 normalizes a missing path purely lexically
// while existing bases are canonicalized; resolve the deepest existing ancestor so both sides see the same
// symlink resolution (macOS /var → /private/var) and a symlink inside a base cannot carry a new target outside it.
function canonicalizeViaExistingAncestor(absolute: string): string {
  const normalized = normalizePath(absolute);
  const tail: string[] = [];
  let current = normalized;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return normalized;
    tail.unshift(path.basename(current));
    current = parent;
  }
  try { return path.join(stripVerbatimPrefix(realpathSync(current)), ...tail); }
  catch { return normalized; }
}

export interface SkillFilesLogger {
  warn?(message: string): void;
}

const defaultFilesLogger: SkillFilesLogger = {
  warn: message => process.emitWarning(message),
};

export class SkillFiles {
  _paths: PathsService;
  _logger: SkillFilesLogger;

  constructor(paths: PathsService, logger: SkillFilesLogger = defaultFilesLogger) {
    this._paths = paths;
    this._logger = logger;
  }

  private warn(message: string): void {
    this._logger.warn?.(`[Skills] ${message}`);
  }

  getAllowedSkillsBases(): string[] {
    let current: string | null;
    try { current = process.cwd(); } catch { current = null; }
    return buildAllowedSkillsBases(this._paths.os.home, this._paths.os.data, this._paths.appDataDir, current, false);
  }

  commandMentionsSkillsDirectory(command: string): boolean {
    return commandMentionsSkillsDirectory(command, this.getAllowedSkillsBases());
  }

  expandPath(value: string): string {
    if (value === '~') return this._paths.os.home;
    if (value.startsWith('~/')) return join(this._paths.os.home, value.slice(2));
    return value;
  }

  /** `PathBuf::join` (no `..` normalization; an absolute child replaces the base). */
  joinPath(base: string, child: string): string {
    return join(base, child);
  }

  /** `Path::exists`. */
  exists(value: string): boolean {
    return existsSync(value);
  }

  validatePath(value: string): void {
    const bases = this.getAllowedSkillsBases();
    if (!bases.length) fail('IO_ERROR', 'Cannot determine allowed skills directories');
    let canonical: string;
    if (existsSync(value)) {
      try { canonical = stripVerbatimPrefix(realpathSync(value)); }
      catch (error) { return fail('IO_ERROR', `Failed to canonicalize path ${debugPath(value)}: ${ioMessage(error)}`); }
    } else {
      let absolute = value;
      if (!path.isAbsolute(value)) {
        try { absolute = join(process.cwd(), value); }
        catch (error) { return fail('IO_ERROR', `Failed to get current dir: ${ioMessage(error)}`); }
      }
      canonical = canonicalizeViaExistingAncestor(absolute);
    }
    for (const base of bases) {
      let canonicalBase: string;
      if (existsSync(base)) {
        try { canonicalBase = stripVerbatimPrefix(realpathSync(base)); }
        catch { continue; }
      } else canonicalBase = canonicalizeViaExistingAncestor(base);
      if (within(canonical, canonicalBase)) return;
    }
    this.warn(`路径遍历检测: ${debugPath(value)} 不在允许的目录范围内`);
    fail('INVALID_INPUT', `Path traversal detected: ${debugPath(value)} is not within allowed skills directories. Allowed bases: [${bases.map(debugPath).join(', ')}]`);
  }

  canonicalizeSkillPackageRoot(raw: string): string {
    const value = this.expandPath(raw);
    this.validatePath(value);
    if (!existsSync(value)) fail('RESOURCE_NOT_FOUND', `Skill package root not found: ${debugPath(value)}`);
    if (!metadata(value)?.isDirectory()) fail('INVALID_INPUT', `Skill package root is not a directory: ${debugPath(value)}`);
    if (!existsSync(join(value, 'SKILL.md'))) fail('INVALID_INPUT', `Not a valid skill package directory (missing SKILL.md): ${debugPath(value)}`);
    try { return realpathSync(value); }
    catch (error) { return fail('IO_ERROR', `Failed to canonicalize skill package root ${debugPath(value)}: ${ioMessage(error)}`); }
  }

  async listDirectories(raw: string): Promise<SkillDirectoryEntry[]> {
    const value = this.expandPath(raw);
    this.validatePath(value);
    if (!existsSync(value)) return [];
    if (!metadata(value)?.isDirectory()) {
      this.warn(`路径不是目录: ${debugPath(value)}`);
      fail('INVALID_INPUT', `Path is not a directory: ${debugPath(value)}`);
    }
    const dir = await io(() => opendir(value), `Failed to read directory ${debugPath(value)}`);
    const entries: SkillDirectoryEntry[] = [];
    try {
      for await (const entry of dir) {
        const file = join(value, entry.name);
        if (metadata(file)?.isDirectory() && !entry.name.startsWith('.')) entries.push({ name: entry.name, path: file });
      }
    } catch (error) { fail('IO_ERROR', `Failed to read directory entry: ${ioMessage(error)}`); }
    return entries;
  }

  async listPackageFiles(raw: string): Promise<SkillPackageFileEntry[]> {
    let root: string;
    try { root = this.canonicalizeSkillPackageRoot(raw); }
    catch (error) {
      if (error instanceof CommandError && typeof error.value === 'string' && JSON.parse(error.value).code === 'RESOURCE_NOT_FOUND') return [];
      throw error;
    }
    if (!existsSync(root)) return [];
    const entries: SkillPackageFileEntry[] = [];
    const collect = async (current: string, depth: number): Promise<void> => {
      if (entries.length >= 200 || depth > 4) return;
      const dir = await io(() => opendir(current), `Failed to read package directory ${debugPath(current)}`);
      try {
        for await (const entry of dir) {
          if (entries.length >= 200) break;
          const file = join(current, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && !['node_modules', 'target', 'dist', 'build'].includes(entry.name)) await collect(file, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          const relative = path.relative(root, file).replaceAll('\\', '/');
          if (relative) entries.push({ path: relative, size: metadata(file)?.size ?? 0 });
        }
      } catch (error) {
        if (error instanceof CommandError) throw error;
        fail('IO_ERROR', `Failed to read package directory entry: ${ioMessage(error)}`);
      }
    };
    await collect(root, 0);
    return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }

  async readFile(raw: string): Promise<SkillFileContent> {
    const value = this.expandPath(raw);
    this.validateExistingFile(value);
    const bytes = await io(() => readFile(value), `Failed to read file ${debugPath(value)}`);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return fail('IO_ERROR', `Failed to read file ${debugPath(value)}: stream did not contain valid UTF-8`); }
    return { content, path: value };
  }

  validateExistingFile(value: string): void {
    this.validatePath(value);
    if (!existsSync(value)) fail('RESOURCE_NOT_FOUND', `File not found: ${debugPath(value)}`);
    if (!metadata(value)?.isFile()) fail('INVALID_INPUT', `Path is not a file: ${debugPath(value)}`);
  }

  validateFileSize(content: string): void {
    const size = Buffer.byteLength(content);
    if (size > 2 * 1024 * 1024) fail('INVALID_INPUT', `Skill file too large (${size} bytes > ${2 * 1024 * 1024} bytes)`);
  }

  async create(basePath: string, skillId: string, content: string): Promise<SkillFileContent> {
    this.validateFileSize(content);
    if (!/^[\p{Alphabetic}\p{N}_-]*$/u.test(skillId) || skillId.includes('\n')) fail('INVALID_INPUT', 'Skill ID can only contain letters, numbers, hyphens, and underscores');
    if (!skillId) fail('INVALID_INPUT', 'Skill ID cannot be empty');
    const base = this.expandPath(basePath);
    const dir = join(base, skillId);
    const file = join(dir, 'SKILL.md');
    this.validatePath(file);
    if (existsSync(dir)) fail('INVALID_INPUT', `Skill directory already exists: ${debugPath(dir)}`);
    if (!existsSync(base)) await io(() => mkdir(base, { recursive: true }), `Failed to create base directory ${debugPath(base)}`);
    await io(() => mkdir(dir), `Failed to create skill directory ${debugPath(dir)}`);
    await io(() => writeFile(file, content), `Failed to write skill file ${debugPath(file)}`);
    return { content, path: file };
  }

  async update(raw: string, content: string): Promise<SkillFileContent> {
    this.validateFileSize(content);
    const value = this.expandPath(raw);
    this.validateExistingFile(value);
    await io(() => writeFile(value, content), `Failed to write file ${debugPath(value)}`);
    return { content, path: value };
  }

  async delete(raw: string): Promise<null> {
    const value = this.expandPath(raw);
    this.validatePath(value);
    if (!existsSync(value)) fail('RESOURCE_NOT_FOUND', `Directory not found: ${debugPath(value)}`);
    if (!metadata(value)?.isDirectory()) fail('INVALID_INPUT', `Path is not a directory: ${debugPath(value)}`);
    if (!existsSync(join(value, 'SKILL.md'))) fail('INVALID_INPUT', `Not a valid skill directory (missing SKILL.md): ${debugPath(value)}`);
    await io(() => rm(value, { recursive: true }), `Failed to delete directory ${debugPath(value)}`);
    return null;
  }
}
