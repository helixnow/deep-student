import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { isValidPluginId, pluginServiceName } from '../../../kernel/plugin-id.ts';
import { managedRelative, sourceFiles } from './compiler.ts';

export interface SourceFile { path: string; content: string }

function toPascalSuffix(raw: string): string {
  return raw
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function normalizeSourceContent(filePath: string, content: string, pluginId: string | null): string {
  if (!pluginId || !/\.(?:[cm]?[jt]sx?|json)$/i.test(filePath)) return content;
  const serviceName = pluginServiceName(pluginId);
  let normalized = content.replaceAll('__PLUGIN_ID__', pluginId).replaceAll('__SERVICE__', serviceName);
  const escapedId = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dottedServiceRe = new RegExp(`(['"\`])${escapedId}\\.([A-Za-z][A-Za-z0-9_-]*)\\1`, 'g');
  normalized = normalized.replace(dottedServiceRe, (_match, quote: string, suffix: string) => {
    const pascal = toPascalSuffix(suffix);
    return `${quote}${serviceName}${pascal}${quote}`;
  });
  return normalized;
}

/** Shared by model output and the scoped edit tool. Never accepts an Agent-supplied root. */
export async function writeSourceFiles(source: string, files: SourceFile[], signal?: AbortSignal): Promise<void> {
  if (!Array.isArray(files) || !files.length || files.length > 64) throw new Error('WORKSHOP_INVALID: expected 1–64 generated files');
  if ((await lstat(source)).isSymbolicLink()) throw new Error('WORKSHOP_INVALID: source root must not be a symbolic link');
  await sourceFiles(source); // Refuse existing links before overwriting any source file.
  const parentName = basename(source) === 'source' ? basename(dirname(source)) : '';
  const pluginId = isValidPluginId(parentName) ? parentName : null;
  let bytes = 0;
  const names = new Set<string>();
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file.content !== 'string') throw new Error('WORKSHOP_INVALID: file path/content required');
    const name = relative(source, managedRelative(source, file.path));
    if (names.has(name) || file.path.includes('\\') || file.path.split('/').some(part => part.startsWith('.') || part === 'node_modules')) {
      throw new Error('WORKSHOP_INVALID: unsupported generated file path');
    }
    names.add(name); bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 2 * 1024 * 1024) throw new Error('WORKSHOP_INVALID: generated files exceed 2 MiB');
  for (const file of files) {
    if (signal?.aborted) return;
    const path = managedRelative(source, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, normalizeSourceContent(file.path, file.content, pluginId));
  }
}
