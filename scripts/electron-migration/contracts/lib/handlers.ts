// Rust 命令注册表：src-tauri/src/lib.rs 中唯一的 `tauri::generate_handler![...]`。
// 带 `#[tauri::command]` 但不在列表里的函数前端调不到（Tauri 报 "command not found"），契约标 `x-rust-registered: false`。

export const HANDLER_FILE = 'src-tauri/src/lib.rs';

/** 条目的函数名（路径最后一段）→ 条目上的 `#[cfg(...)]` 文本（无则 null）。找不到 `generate_handler!` 时返回 null。 */
export function parseGenerateHandler(source: string): Map<string, string | null> | null {
  const start = source.indexOf('generate_handler![');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start + 'generate_handler!'.length; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error(`${HANDLER_FILE}: generate_handler! is not closed`);
  const body = source.slice(start + 'generate_handler!['.length, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const entries: string[] = [];
  let cur = '';
  let level = 0;
  for (const ch of body) {
    if (ch === '(' || ch === '[') level++;
    else if (ch === ')' || ch === ']') level--;
    if (ch === ',' && level === 0) { entries.push(cur); cur = ''; } else cur += ch;
  }
  entries.push(cur);
  const out = new Map<string, string | null>();
  for (const raw of entries) {
    const cfg = raw.match(/#\[cfg\(([\s\S]*)\)\]/)?.[1]?.replace(/\s+/g, ' ') ?? null;
    const path = raw.replace(/#\[[\s\S]*?\]\s*/g, '').trim();
    if (!path) continue;
    out.set(path.split('::').pop()!, cfg);
  }
  return out;
}
