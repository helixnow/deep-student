/**
 * `normalize_runtime_relative_path` 的移植（Rust `dstu-agent-api/src/tools.rs`）。
 *
 * 语义与 `agent-workspace/src/runtime-paths.ts` 的同名函数一致，但那一份在 `api.ts` 的运行时闭包里
 * （经 `runtime-paths.ts` 触达 `node:fs`），移动端不能引入。语义归属仍是 L05，等它发布到
 * `agent-workspace/portable.ts` 后本文件可直接替换为 re-export。
 */
import * as path from '../../../../platform/util/path.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';

export function normalizeRuntimeRelativePath(raw?: string | null): string {
  const value = raw == null ? '' : rustTrim(raw);
  if (value === '' || value === '.') return '';
  if (path.isAbsolute(value) || (path.sep === '\\' && /^(?:[a-zA-Z]:|[\\/])/.test(value))) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  const parts = value.split(path.sep === '\\' ? /[\\/]/ : /\//);
  if (parts.includes('..')) throw new Error('Parent directory traversal is not allowed');
  return parts.filter(part => part !== '' && part !== '.').join(path.sep);
}
