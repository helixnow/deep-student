#!/usr/bin/env node
// ============================================================================
// Rust workspace 分层守卫（CI Gate）
//
// 职责：读取 `cargo metadata`，校验 src-tauri workspace 的 crate 依赖方向。
//   1. 除 app 包 `deep-student` 外，每个成员必须命名为 `dstu-*`，
//      `version = "0.0.0"`、`publish = false`，并在
//      `[package.metadata.dstu] layer = "<层名>"` 中声明所在层。
//   2. 成员只能依赖更低层的成员；同层依赖只允许出现在基础层
//      （base/infra/service/capability），且由 Cargo 保证无环。
//   3. 业务域层（domain）之间禁止互相依赖；agent 层不得依赖业务域层。
//   4. dstu-core 的普通依赖闭包里不得出现 tauri。
//
// 用法：
//   node scripts/check-crate-layers.mjs          # 校验，违规时退出码 1
//   node scripts/check-crate-layers.mjs --json   # 机器可读输出
// ============================================================================

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src-tauri', 'Cargo.toml');
const APP_PACKAGE = 'deep-student';

// 层序：数值越小越底层。同层是否允许互相依赖见 SAME_LAYER_ALLOWED。
export const LAYERS = {
  core: 0,
  base: 1,
  infra: 2,
  service: 3,
  capability: 4,
  domain: 5,
  agent: 6,
};
const SAME_LAYER_ALLOWED = new Set(['base', 'infra', 'service', 'capability']);
// 显式禁止的“向下”依赖：agent 层只能依赖 capability 及以下；业务域执行器由 app
// 经 ExecutorRoster 注入，跨域回调走 dstu-kernel Slot/HookSet（extensions.rs 注册）。
export const FORBIDDEN_LAYER_DEPS = {
  agent: new Set(['domain']),
};

export function checkLayers(metadata) {
  const members = new Set(metadata.workspace_members);
  const pkgs = metadata.packages.filter((p) => members.has(p.id));
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const problems = [];

  for (const p of pkgs) {
    if (p.name === APP_PACKAGE) continue;
    if (!p.name.startsWith('dstu-')) problems.push(`${p.name}: 成员 crate 必须以 dstu- 开头`);
    if (p.version !== '0.0.0') problems.push(`${p.name}: version 必须为 0.0.0（应用版本只由 ${APP_PACKAGE} 决定）`);
    if (!(Array.isArray(p.publish) && p.publish.length === 0)) problems.push(`${p.name}: 必须设置 publish = false`);
    const layer = p.metadata?.dstu?.layer;
    if (!(layer in LAYERS)) problems.push(`${p.name}: [package.metadata.dstu] layer 缺失或无效（${layer ?? '未设置'}）`);
  }

  for (const p of pkgs) {
    if (p.name === APP_PACKAGE) continue;
    const layer = p.metadata?.dstu?.layer;
    if (!(layer in LAYERS)) continue;
    for (const d of p.dependencies) {
      if (d.kind === 'dev') continue;
      const dep = byName.get(d.name);
      if (!dep) continue;
      if (dep.name === APP_PACKAGE) {
        problems.push(`${p.name} -> ${APP_PACKAGE}: 成员不得依赖 app 包`);
        continue;
      }
      const dl = dep.metadata?.dstu?.layer;
      if (!(dl in LAYERS)) continue;
      if (LAYERS[dl] > LAYERS[layer]) problems.push(`${p.name}(${layer}) -> ${dep.name}(${dl}): 依赖了更高层`);
      else if (FORBIDDEN_LAYER_DEPS[layer]?.has(dl))
        problems.push(`${p.name}(${layer}) -> ${dep.name}(${dl}): ${layer} 层不得依赖 ${dl} 层`);
      else if (LAYERS[dl] === LAYERS[layer] && !SAME_LAYER_ALLOWED.has(layer))
        problems.push(`${p.name}(${layer}) -> ${dep.name}(${dl}): ${layer} 层成员之间禁止互相依赖`);
    }
  }

  const core = byName.get('dstu-core');
  if (core && metadata.resolve) {
    const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
    const names = new Map(metadata.packages.map((p) => [p.id, p.name]));
    const seen = new Set();
    const stack = [core.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id)?.deps ?? []) {
        if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
        if (names.get(dep.pkg) === 'tauri') problems.push(`dstu-core 的依赖闭包包含 tauri（经由 ${names.get(id)}）`);
        stack.push(dep.pkg);
      }
    }
  }

  return { members: pkgs.map((p) => ({ name: p.name, layer: p.metadata?.dstu?.layer ?? null })), problems };
}

function main() {
  const json = process.argv.includes('--json');
  const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', MANIFEST], {
    cwd: path.dirname(MANIFEST),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  const result = checkLayers(JSON.parse(out));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const m of result.members) console.log(`  ${m.name.padEnd(24)} ${m.layer ?? '(app)'}`);
    if (result.problems.length) {
      console.error(`\n分层校验失败（${result.problems.length} 处）：`);
      for (const p of result.problems) console.error(`  - ${p}`);
    } else {
      console.log(`\n分层校验通过：${result.members.length} 个 workspace 成员`);
    }
  }
  process.exit(result.problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
