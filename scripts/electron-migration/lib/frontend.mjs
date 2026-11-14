// 前端 invoke 调用点（静态字面量，与 inventory.mjs 同一正则；读取 HEAD 中已提交的源码）。
// 只读已提交内容，工作区里他人未提交的试验改动（foundation.md 共同规则 3）不会进入结果。
import { readHead, trackedFiles } from './git-source.mjs';

export function frontendInvokeSites() {
  const sites = new Map();
  const files = trackedFiles(['src']).filter((f) => /\.(ts|tsx)$/.test(f) && !f.split('/').includes('node_modules'));
  for (const [rel, text] of readHead(files)) {
    const re = /invoke(?:<[^>]*>)?\(\s*['"`]([a-z0-9_]+)['"`]/g;
    for (let m; (m = re.exec(text)); ) {
      const line = text.slice(0, m.index).split('\n').length;
      (sites.get(m[1]) ?? sites.set(m[1], []).get(m[1])).push({ file: rel, line, demo: rel.startsWith('src/demo/') });
    }
  }
  return sites;
}
