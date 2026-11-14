/** `node:path`（POSIX）在 Worker 中的最小实现：Host 的路径都是 OPFS 内的虚拟 POSIX 路径。 */

export const sep = '/';
export const delimiter = ':';

export function normalize(input: string): string {
  if (input === '') return '.';
  const absolute = input.startsWith('/');
  const out: string[] = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  const trailing = input.endsWith('/') && joined ? '/' : '';
  return absolute ? `/${joined}${trailing}` : (joined || '.') + trailing;
}

export function join(...parts: string[]): string {
  const filtered = parts.filter(part => part !== '');
  return filtered.length ? normalize(filtered.join('/')) : '.';
}

export function resolve(...parts: string[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0 && !resolved.startsWith('/'); i--) {
    const part = parts[i]!;
    if (part) resolved = resolved ? `${part}/${resolved}` : part;
  }
  if (!resolved.startsWith('/')) resolved = `/${resolved}`;
  const normalized = normalize(resolved);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function isAbsolute(input: string): boolean {
  return input.startsWith('/');
}

export function dirname(input: string): string {
  if (!input) return '.';
  const trimmed = input.length > 1 ? input.replace(/\/+$/, '') : input;
  const index = trimmed.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return trimmed.slice(0, index);
}

export function basename(input: string, ext?: string): string {
  const trimmed = input.length > 1 ? input.replace(/\/+$/, '') : input;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}

export function extname(input: string): string {
  const base = basename(input);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export function parse(input: string): { root: string; dir: string; base: string; ext: string; name: string } {
  const base = basename(input);
  const ext = extname(input);
  return { root: input.startsWith('/') ? '/' : '', dir: dirname(input), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(parts: { dir?: string; root?: string; base?: string; name?: string; ext?: string }): string {
  const dir = parts.dir ?? parts.root ?? '';
  const base = parts.base ?? `${parts.name ?? ''}${parts.ext ?? ''}`;
  return dir ? (dir.endsWith('/') ? `${dir}${base}` : `${dir}/${base}`) : base;
}

const path = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, parse, format };
export const posix = path;
export const win32 = path;
export default { ...path, posix: path, win32: path };
