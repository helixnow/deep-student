/**
 * 打包产物的生产依赖闭包。
 *
 * electron-builder 的 npm 收集器依赖 `npm ls`：工作树的 node_modules 是指向共享安装的软链时，arborist 把每个包
 * 都当成指向项目外的链接，包之间的依赖全部报 missing（如 `@deepseek-ai/cordis` → `@deepseek-ai/cosmokit`），
 * 平台可选包（`@koromix/koffi-darwin-arm64`、`@img/sharp-darwin-arm64`、`@lancedb/lancedb-darwin-arm64`…）
 * 也不会进包，打包后的应用启动即因 ERR_MODULE_NOT_FOUND 失败。
 *
 * 这里按 Node 的解析规则从项目 package.json 走出运行时闭包：`dependencies`、已安装的 `peerDependencies`、
 * 已安装且 os/cpu 匹配目标平台的 `optionalDependencies`；包在产物中的位置与源 node_modules 中的相对位置一致，
 * 因此嵌套版本（如 `tar/node_modules/yallist`）的解析结果不变。打包配置用它生成 `files`，取代 electron-builder 的收集。
 */
'use strict';
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** npm 的 os/cpu 字段：列表为空表示不限；`!x` 表示排除。 */
function fieldMatches(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const excluded = list.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  if (excluded.includes(value)) return false;
  const included = list.filter((entry) => !entry.startsWith('!'));
  return included.length === 0 || included.includes(value);
}

/** `target.libc`（`glibc` / `musl`）省略时不按 libc 过滤。 */
function platformMatches(manifest, target) {
  return fieldMatches(manifest.os, target.platform) && fieldMatches(manifest.cpu, target.arch)
    && (target.libc === undefined || fieldMatches(manifest.libc, target.libc));
}

/** Node 的 node_modules 查找：从 `fromDir` 逐级向上，跳过本身名为 node_modules 的目录。 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 每个依赖包都不进包的内容（electron-builder 自带收集器的默认排除，加上 source map 与 TS 源码）。
 * node_modules 里的 `.ts` 不会被执行（Node 拒绝对 node_modules 做类型剥离），`.d.ts` 只给编译器用。
 * 自定义 FileSet 的 filter 不继承顶层 `files` 的排除，所以要在这里写全。
 */
const COMMON_EXCLUDES = Object.freeze([
  '!**/*.map',
  '!**/*.{ts,mts,cts}',
  '!**/{README,Readme,readme,CHANGELOG,Changelog,changelog,ChangeLog,HISTORY,History,history}{,.md,.markdown,.txt}',
  '!{test,tests,__tests__,powered-test,example,examples,.bin,.github}{,/**}',
  '!**/{binding.gyp,*.gypi,*.mk,Makefile,gyp-mac-tool,.npmignore,.eslintrc,.DS_Store}',
  '!**/*.{cc,cpp,h,hpp,o,a,obj,iml,orig,swp}',
]);

/**
 * 包内只在构建期或其他平台用到的大块内容（相对包目录）。每条都核对过运行时入口：
 * - better-sqlite3：`lib/binding.js` 只加载 `prebuilds/<platform>-<arch>.node`，没有时退回 `build/Release`；
 *   `deps/`（SQLite 源码）与 `src/` 只用于源码编译。Electron 不支持 musl，linuxmusl 预编译不进包。
 * - tiktoken：Node 入口 `tiktoken.cjs` 只用 `tiktoken_bg.cjs` 与完整 wasm；`encoders/`、`lite/` 是 lite 版的词表。
 * - exceljs：`excel.js` → `lib/`；`dist/` 是浏览器构建。
 * - docx：有 `exports` 时 Node 只走 `index.cjs` / `index.mjs`（及同名子入口），umd / iife 是浏览器构建。
 */
const PACKAGE_EXCLUDES = Object.freeze({
  'better-sqlite3': (target) => ['!deps{,/**}', '!src{,/**}', '!prebuilds/**', `prebuilds/${target.platform}-${target.arch}.node`, '!build/**', 'build/Release/*.node'],
  tiktoken: () => ['!encoders{,/**}', '!lite{,/**}'],
  exceljs: () => ['!dist{,/**}'],
  docx: () => ['!dist/*.{iife.js,umd.cjs}'],
});

/** 某个顶层包的 FileSet filter：先全选，再按顺序排除（electron-builder 的过滤是后出现的规则优先）。 */
function packageFilter(name, target) {
  return ['**/*', ...COMMON_EXCLUDES, ...(PACKAGE_EXCLUDES[name]?.(target) ?? [])];
}

/**
 * @param {string} projectDir 含 package.json 与 node_modules 的项目目录
 * @param {{ platform: string, arch: string }} target Node 的 `process.platform` / `process.arch` 取值
 * @param {readonly string[]} [extraRoots] 视同 package.json 必需依赖的额外包名
 * @returns {Map<string, string>} 产物 node_modules 内的相对路径 → 源目录（realpath）
 */
function collectProductionClosure(projectDir, target, extraRoots = []) {
  const nodeModules = realpathSync(path.join(projectDir, 'node_modules'));
  const closure = new Map();
  const root = readManifest(projectDir);
  const extras = Object.fromEntries(extraRoots.filter((name) => !(name in (root.dependencies ?? {}))).map((name) => [name, '*']));
  const queue = [{ dir: projectDir, manifest: { ...root, dependencies: { ...root.dependencies, ...extras } }, label: 'package.json' }];
  while (queue.length > 0) {
    const { dir, manifest, label } = queue.shift();
    const optionalPeers = new Set(Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta && meta.optional).map(([name]) => name));
    const wanted = [
      ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, required: !(name in (manifest.optionalDependencies ?? {})) })),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, required: false })),
      ...Object.keys(manifest.peerDependencies ?? {}).map((name) => ({ name, required: false, peer: !optionalPeers.has(name) })),
    ];
    for (const { name, required } of wanted) {
      const source = resolvePackageDir(name, dir);
      if (source === null) {
        if (required) throw new Error(`production dependency ${name} of ${label} is not installed`);
        continue;
      }
      const relative = path.relative(nodeModules, source);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`production dependency ${name} of ${label} resolves outside node_modules: ${source}`);
      }
      const key = relative.split(path.sep).join('/');
      if (closure.has(key)) continue;
      const dependency = readManifest(source);
      if (!required && !platformMatches(dependency, target)) continue;
      closure.set(key, source);
      queue.push({ dir: source, manifest: dependency, label: key });
    }
  }
  return closure;
}

/** 闭包键（可能是嵌套路径 `jszip/node_modules/readable-stream`）对应的包名。 */
function packageNameOf(key) {
  const index = key.lastIndexOf('/node_modules/');
  return index === -1 ? key : key.slice(index + '/node_modules/'.length);
}

/**
 * electron-builder `files` 的 FileSet：闭包里每个包一个，嵌套版本（如 `tar/node_modules/yallist`）也单独一个、位置不变。
 * electron-builder 的过滤器总是丢弃相对 `from` 恰为 `node_modules` 的目录（本意是应用根目录的 node_modules），
 * 所以嵌套版本不会随父目录进包。配合 `beforeBuild` 返回 false（node_modules 由外部处理），electron-builder 不再自己收集依赖。
 */
function productionFileSets(projectDir, target, extraRoots = []) {
  const closure = collectProductionClosure(projectDir, target, extraRoots);
  return [...closure.keys()].sort()
    .map((key) => ({ from: closure.get(key), to: `node_modules/${key}`, filter: packageFilter(packageNameOf(key), target) }));
}

module.exports = { collectProductionClosure, productionFileSets, platformMatches, packageFilter };
