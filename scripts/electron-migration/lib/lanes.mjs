// 业务 lane 目录表：从 lanes.md 的业务线表格解析目录、职责与提供/消费，从 inventory 取 lane id。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './tree-sitter-rust.mjs';

export const LANES_MD = path.join(ROOT, 'docs/dev/electron-migration/lanes.md');

/**
 * 一条 lane 有两个目录时的文件划分（lanes.md 只给出目录名，未规定文件归属；这是默认划分，
 * 两个目录同属一个代理，可自行调整）。规则按 Rust 相对路径匹配，未匹配的归第一个目录。
 */
export const DIR_SPLIT = {
  'L02-llm-manager': {
    'translation/': [/^crates\/dstu-translation-core\//, /\/translation(\/|\.rs$|_)/, /^src\/chat_v2\/tools\/translation_executor\.rs$/, /^tests\/(translation_|c1_cross_lang)/],
  },
  'L19-mcp-browser': {
    'browser/': [/^crates\/dstu-browser\//, /^src\/chat_v2\/tools\/(browser|index_webpage)/, /^src\/cmd\/web_search\.rs$/, /^tests\/(browser_|bing_)/],
  },
};

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 解析 lanes.md 业务线表格。返回 [{ short, title, dirs, scope, size, provides, consumes, notes }]。 */
export function parseLanesMd(text = fs.readFileSync(LANES_MD, 'utf8')) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(L\d\d)\s+([^|]+)\|/.exec(line);
    if (!m) continue;
    const c = cells(line);
    if (c.length < 7) continue;
    rows.push({
      short: m[1],
      title: m[2].trim(),
      dirs: [...c[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]),
      scope: c[2],
      size: c[3],
      provides: c[4],
      consumes: c[5],
      notes: c[6],
    });
  }
  return rows;
}

/** 业务 lane（L01–L24）列表，lane id 取 inventory 中以同一短号开头的键。 */
export function businessLanes(inventoryLanes, text) {
  const ids = Object.keys(inventoryLanes);
  return parseLanesMd(text).map((row) => {
    const id = ids.find((k) => k.startsWith(`${row.short}-`));
    if (!id) throw new Error(`lanes.md ${row.short} has no matching lane in inventory/lanes.json`);
    return { ...row, id };
  });
}

/** 某个 Rust 文件在 lane 内归属的目录（相对 host/plugins）。 */
export function dirForFile(lane, rel) {
  const split = DIR_SPLIT[lane.id];
  if (split) {
    for (const [dir, res] of Object.entries(split)) if (res.some((re) => re.test(rel))) return dir;
  }
  return lane.dirs[0];
}

/** 命令所在目录：commands.rs 中按名分派的命令按名称判断。 */
export function dirForCommand(lane, cmd) {
  if (lane.id === 'L19-mcp-browser' && cmd.file === 'src/commands.rs') return 'mcp/';
  if (lane.id === 'L02-llm-manager' && cmd.file === 'src/commands.rs') return 'llm/';
  return dirForFile(lane, cmd.file);
}

export const F_LANES = ['F1-kernel', 'F2-shell', 'F3-storage', 'F4-security'];
