#!/usr/bin/env node
// 运行时可导入检查：以 Host 的实际运行方式（Node 原生类型擦除）导入给定入口，任何一个失败即退出 1。
// tsc 与 vitest 会自行编译 TS，发现不了"Node 运行不了"的问题（参数属性、enum、缺 peer 依赖等）。
//   node scripts/electron-migration/importable.mjs host/plugins/anki/index.ts ...
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = 0;
for (const f of process.argv.slice(2)) {
  try {
    await import(pathToFileURL(path.resolve(f)).href);
  } catch (e) {
    failed++;
    console.log(`error ${f}: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`);
  }
}
if (failed) process.exit(1);
console.log('importable: ok');
