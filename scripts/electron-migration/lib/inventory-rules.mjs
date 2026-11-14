// 读取 scripts/electron-migration/inventory.mjs 中的 LANE_RULES / COMMAND_NAME_RULES / NAME_ROUTED_FILES。
//
// inventory.mjs 在模块顶层直接执行盘点并写 inventory/ 输出，import 它会产生副作用（并在 argv 含
// `--check` 时退出进程）。这里只截取规则声明的源码片段，以 data: URL 模块求值，规则仍以
// inventory.mjs 为唯一来源。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './tree-sitter-rust.mjs';
import { readHead, trackedFiles } from './git-source.mjs';

export const INVENTORY_SCRIPT = path.join(ROOT, 'scripts/electron-migration/inventory.mjs');
export const INVENTORY_DIR = path.join(ROOT, 'docs/dev/electron-migration/inventory');
export const RUST_ROOT = path.join(ROOT, 'src-tauri');

let cached;

export async function loadInventoryRules() {
  if (cached) return cached;
  const src = fs.readFileSync(INVENTORY_SCRIPT, 'utf8');
  const start = src.indexOf('export const LANE_RULES');
  const endMarker = src.indexOf('const NAME_ROUTED_FILES');
  if (start < 0 || endMarker < 0) throw new Error('inventory.mjs: LANE_RULES / NAME_ROUTED_FILES declarations not found');
  const lineEnd = src.indexOf('\n', endMarker);
  const snippet = `${src.slice(start, lineEnd)}\nexport { NAME_ROUTED_FILES };\n`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(snippet).toString('base64')}`);
  cached = {
    LANE_RULES: mod.LANE_RULES,
    COMMAND_NAME_RULES: mod.COMMAND_NAME_RULES,
    NAME_ROUTED_FILES: mod.NAME_ROUTED_FILES,
  };
  return cached;
}

export function laneOfFile(rules, rel) {
  for (const [lane, re] of rules.LANE_RULES) if (re.test(rel)) return lane;
  return null;
}

/**
 * 与 inventory.mjs 的 walk 相同的 Rust 文件范围（src-tauri/{src,crates,tests}，跳过 target/vendor/gen 与点目录），
 * 但只取 HEAD 中已提交的文件（见 git-source.mjs）。返回相对 src-tauri 的路径，排序。
 */
export function listRustFiles() {
  return trackedFiles(['src-tauri/src', 'src-tauri/crates', 'src-tauri/tests'])
    .filter((p) => p.endsWith('.rs'))
    .map((p) => p.slice('src-tauri/'.length))
    .filter((rel) => !rel.split('/').some((seg) => seg === 'target' || seg === 'vendor' || seg === 'gen' || seg.startsWith('.')))
    .sort();
}

/** HEAD 中 Rust 文件的内容：Map 相对 src-tauri 路径 → 文本。 */
export function readRustSources(files) {
  const head = readHead(files.map((f) => `src-tauri/${f}`));
  return new Map(files.map((f) => [f, head.get(`src-tauri/${f}`)]));
}

export function loadInventory() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(INVENTORY_DIR, f), 'utf8'));
  return { lanes: read('lanes.json'), commands: read('commands.json') };
}
