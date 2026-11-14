// src/cmd/mcp.rs:209-550. Validation compares canonical executable AND every launch field.
import { realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import type { JsonValue } from '../api.ts';

export interface ValidatedStdioStart { command: string; args: string[]; env: Record<string, string>; cwd: string; framing: string }
export function normalizeStdioFraming(value: string | null): 'jsonl' | 'content_length' {
  return ['content_length', 'content-length', 'contentlength'].includes(value?.trim().toLowerCase() ?? '') ? 'content_length' : 'jsonl';
}
export function normalizeCommandPath(command: string): string {
  if (command.startsWith('\\\\?\\UNC\\')) return `\\\\${command.slice(8)}`;
  return command.startsWith('\\\\?\\') ? command.slice(4) : command;
}
export function rustIoError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  const text: Record<string, string> = { ENOENT: 'No such file or directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted', ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EPIPE: 'Broken pipe', ENOEXEC: 'Exec format error', EINVAL: 'Invalid argument' };
  return e.code && text[e.code] ? `${text[e.code]} (os error ${Math.abs(e.errno ?? 0)})` : e.message ?? String(error);
}
function obj(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function pick(entry: Record<string, JsonValue>, keys: string[], nestedKeys: string[] = keys): JsonValue | undefined {
  for (const key of keys) if (Object.hasOwn(entry, key)) return entry[key];
  const fetch = obj(entry.fetch);
  for (const key of nestedKeys) if (Object.hasOwn(fetch, key)) return fetch[key];
  return undefined;
}
function str(value: JsonValue | undefined): string | null { return typeof value === 'string' ? value : null; }
function normalizeArgs(args: readonly string[]): string[] { return args.map(s => s.trim()).filter(Boolean); }
function entryArgs(entry: Record<string, JsonValue>): string[] | null {
  const value = pick(entry, ['args']);
  if (value === undefined) return [];
  if (typeof value === 'string') return normalizeArgs(value.split(','));
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return normalizeArgs(value as string[]);
  return null;
}
function entryEnv(entry: Record<string, JsonValue>): Record<string, string> | null {
  const value = pick(entry, ['env']);
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') return null;
    Object.defineProperty(result, key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function canonicalCwd(cwd: string | null): string {
  let current: string;
  try { current = process.cwd(); } catch (e) { throw new Error(`cannot resolve current working directory: ${rustIoError(e)}`); }
  const path = cwd?.trim() ? resolve(current, cwd.trim()) : current;
  let canonical: string;
  try { canonical = realpathSync(path); } catch (e) { throw new Error(`cannot canonicalize cwd '${path}': ${rustIoError(e)}`); }
  if (!statSync(canonical).isDirectory()) throw new Error(`cwd is not a directory: ${canonical}`);
  return canonical;
}
function canonicalExecutable(path: string, platform: string): string | null {
  try {
    const canonical = realpathSync(path), metadata = statSync(canonical);
    return metadata.isFile() && (platform === 'win32' || (metadata.mode & 0o111) !== 0) ? canonical : null;
  } catch { return null; }
}
function envValue(env: Record<string, string>, key: string, platform: string): string | undefined {
  return platform === 'win32' ? Object.entries(env).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] : env[key];
}
function candidates(base: string, command: string, env: Record<string, string>, platform: string): string[] {
  if (platform !== 'win32' || extname(command) !== '') return [base];
  // RUST-FIX(RF-W21-windows-pathext-before-shim): Rust tries the bare name first and lands on npm's extensionless sh shim, which Windows cannot execute.
  return (envValue(env, 'PATHEXT', platform) ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(x => x.trim()).filter(Boolean)
    .map(ext => base + (ext.startsWith('.') ? ext : `.${ext}`));
}
function resolveExecutable(command: string, env: Record<string, string>, cwd: string, platform: string): string {
  command = command.trim();
  if (command === '') throw new Error('command is empty');
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    for (const candidate of candidates(isAbsolute(command) ? command : join(cwd, command), command, env, platform)) {
      const canonical = canonicalExecutable(candidate, platform);
      if (canonical !== null) return canonical;
    }
    throw new Error(`executable not found: ${command}`);
  }
  for (let directory of (envValue(env, 'PATH', platform) ?? process.env.PATH ?? '').split(delimiter)) {
    // Rust std::env::split_paths removes Windows quote delimiters.
    if (platform === 'win32') directory = directory.replaceAll('"', '');
    for (const candidate of candidates(join(resolve(cwd, directory), command), command, env, platform)) {
      const canonical = canonicalExecutable(candidate, platform);
      if (canonical !== null) return canonical;
    }
  }
  throw new Error(`executable '${command}' is not reachable via PATH`);
}
function pathsEqual(a: string, b: string, platform: string): boolean { return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
export function validateStdioStart(entries: JsonValue[], command: string, args: string[], env: Record<string, string>, cwd: string | null, framing: string | null,
  platform: string = process.platform): ValidatedStdioStart {
  const requestedArgs = normalizeArgs(args), requestedFraming = normalizeStdioFraming(framing);
  let requestedCwd: string, requestedExe: string;
  try { requestedCwd = canonicalCwd(cwd); requestedExe = resolveExecutable(command, env, requestedCwd, platform); }
  catch (e) { throw new Error(`mcp_stdio_start rejected: ${e instanceof Error ? e.message : String(e)}`); }
  for (const value of entries) {
    const entry = obj(value);
    if (entry.enabled !== true || (str(pick(entry, ['transportType', 'transport'], [])) ?? 'stdio').toLowerCase() !== 'stdio') continue;
    const entryCommand = (str(pick(entry, ['command'])) ?? '').trim(), approvedArgs = entryArgs(entry), approvedEnv = entryEnv(entry);
    if (!entryCommand || approvedArgs === null || approvedArgs.length !== requestedArgs.length || approvedArgs.some((v, i) => v !== requestedArgs[i]) || approvedEnv === null) continue;
    const approvedFraming = normalizeStdioFraming(str(pick(entry, ['framing', 'framingMode'], ['framing'])));
    if (approvedFraming !== requestedFraming || Object.keys(approvedEnv).length !== Object.keys(env).length || Object.keys(approvedEnv).some(k => !Object.hasOwn(env, k) || env[k] !== approvedEnv[k])) continue;
    let approvedCwd: string, approvedExe: string;
    try { approvedCwd = canonicalCwd(str(pick(entry, ['cwd', 'working_dir', 'workingDir']))); }
    catch { continue; }
    if (!pathsEqual(approvedCwd, requestedCwd, platform)) continue;
    try { approvedExe = resolveExecutable(entryCommand, approvedEnv, approvedCwd, platform); }
    catch { continue; }
    if (!pathsEqual(approvedExe, requestedExe, platform)) continue;
    return { command: approvedExe, args: approvedArgs, env: approvedEnv, framing: approvedFraming, cwd: approvedCwd };
  }
  throw new Error('mcp_stdio_start rejected: executable, args, env, cwd, and framing must exactly match an enabled MCP stdio server in the approved configuration (mcp.tools.list)');
}
