#!/usr/bin/env node
/**
 * 打包产物体积构成：读取 `app.asar` 头部（含 `unpacked` 标记的条目），按顶层目录、node_modules 包、host 子目录
 * 汇总，并列出可疑内容（非目标平台的原生二进制、src-tauri、测试夹具、source map、类型声明）。
 *
 * 用法：`node electron/scripts/package-size-report.mjs [<.app | resources 目录>] [--json <输出文件>] [--top <N>]`
 * 默认取 `release/` 下本机平台的产物。
 */
import { existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const jsonOut = option('--json');
const top = Number(option('--top') ?? 40);

function defaultTarget() {
  const release = join(root, 'release');
  for (const name of existsSync(release) ? readdirSync(release) : []) {
    const dir = join(release, name);
    if (name.startsWith('mac')) {
      const app = readdirSync(dir).find((entry) => entry.endsWith('.app'));
      if (app) return join(dir, app);
    }
    if (name === 'linux-unpacked' || name === 'win-unpacked') return dir;
  }
  throw new Error(`no packaged app under ${release}`);
}

function resourcesOf(target) {
  if (target.endsWith('.app')) return join(target, 'Contents', 'Resources');
  if (existsSync(join(target, 'app.asar'))) return target;
  return join(target, 'resources');
}

/** 不跟随符号链接（macOS framework 的 `Versions/Current` 等），与 `du` 的计数方式一致。 */
function diskSize(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let total = 0;
  for (const entry of readdirSync(path)) total += diskSize(join(path, entry));
  return total;
}

/** 目录名里的平台 / 架构片段（如 `linux-x64`、`win32-arm64-msvc`）与目标不符时视为多余平台。 */
const FOREIGN_PLATFORM = (platform, arch) => {
  const platforms = ['darwin', 'macos', 'linux', 'linuxmusl', 'musl', 'win32', 'windows', 'android', 'freebsd', 'openbsd', 'sunos', 'aix', 'ios'];
  const arches = ['x64', 'arm64', 'ia32', 'arm', 'armv7', 'armv6', 'ppc64', 's390x', 'riscv64', 'loong64', 'x86_64', 'aarch64', 'universal'];
  const selfPlatforms = new Set({ darwin: ['darwin', 'macos'], win32: ['win32', 'windows'], linux: ['linux', 'linuxmusl', 'musl'] }[platform] ?? [platform]);
  const selfArches = new Set([arch, { x64: 'x86_64', arm64: 'aarch64' }[arch], platform === 'darwin' ? 'universal' : undefined].filter(Boolean));
  return (segment) => {
    const parts = segment.toLowerCase().split(/[-_.]/);
    const named = parts.filter((part) => platforms.includes(part));
    if (named.length === 0) return false;
    if (!named.every((part) => selfPlatforms.has(part))) return true;
    const archs = parts.filter((part) => arches.includes(part));
    return archs.length > 0 && !archs.some((part) => selfArches.has(part));
  };
};

const target = resolve(args[0] ?? defaultTarget());
const resources = resourcesOf(target);
const archive = join(resources, 'app.asar');
const header = asar.getRawHeader(archive).header;
const platform = target.endsWith('.app') ? 'darwin' : basename(target).startsWith('win') ? 'win32' : 'linux';
const isForeign = FOREIGN_PLATFORM(platform, process.arch);

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, path);
    else if (typeof entry.size === 'number') files.push({ path, size: entry.size, unpacked: entry.unpacked === true });
  }
})(header, '');

const add = (map, key, size) => map.set(key, (map.get(key) ?? 0) + size);
const byTop = new Map();
const byPackage = new Map();
const byPackageUnpacked = new Map();
const byHost = new Map();
const suspicious = new Map();
let asarBytes = 0;
let unpackedBytes = 0;
for (const { path, size, unpacked } of files) {
  if (unpacked) unpackedBytes += size; else asarBytes += size;
  const segments = path.split('/');
  add(byTop, segments[0], size);
  if (segments[0] === 'node_modules') {
    const pkg = segments[1].startsWith('@') ? `${segments[1]}/${segments[2]}` : segments[1];
    add(byPackage, pkg, size);
    if (unpacked) add(byPackageUnpacked, pkg, size);
    const foreign = segments.slice(1, -1).find((segment) => isForeign(segment));
    if (foreign) add(suspicious, `多余平台二进制（${pkg}）`, size);
  }
  if (segments[0] === 'host') add(byHost, segments.slice(0, 3).join('/'), size);
  if (segments[0] === 'src-tauri' && segments[1] !== 'tauri.conf.json' && !/^tauri\..*\.conf\.json$/.test(segments[1] ?? '') && segments[1] !== 'capabilities' && segments[1] !== 'permissions') add(suspicious, 'src-tauri（配置以外）', size);
  if (segments.some((segment) => ['test', 'tests', '__tests__', '__fixtures__', 'fixtures', 'e2e', 'equivalence'].includes(segment))) add(suspicious, `测试 / 夹具目录（${segments[0] === 'node_modules' ? 'node_modules' : segments[0]}）`, size);
  if (path.endsWith('.map')) add(suspicious, 'source map', size);
  if (/\.d\.[cm]?ts$/.test(path)) add(suspicious, '类型声明 .d.ts', size);
  if (/(^|\/)(README|CHANGELOG|HISTORY)(\.[a-z]+)?$/i.test(path)) add(suspicious, 'README / CHANGELOG', size);
}

const contents = dirname(resources);
const report = {
  target,
  platform,
  arch: process.arch,
  totals: {
    bundle: diskSize(target),
    frameworks: target.endsWith('.app') ? diskSize(join(contents, 'Frameworks')) : 0,
    asarFile: diskSize(archive),
    asarPacked: asarBytes,
    asarUnpacked: unpackedBytes,
    asarUnpackedOnDisk: diskSize(`${archive}.unpacked`),
    migrations: diskSize(join(resources, 'migrations')),
    licenses: diskSize(join(resources, 'licenses')),
    files: files.length,
    packages: byPackage.size,
  },
  byTop: Object.fromEntries([...byTop].sort((a, b) => b[1] - a[1])),
  byPackage: Object.fromEntries([...byPackage].sort((a, b) => b[1] - a[1])),
  byPackageUnpacked: Object.fromEntries([...byPackageUnpacked].sort((a, b) => b[1] - a[1])),
  byHost: Object.fromEntries([...byHost].sort((a, b) => b[1] - a[1])),
  suspicious: Object.fromEntries([...suspicious].sort((a, b) => b[1] - a[1])),
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const table = (title, entries, limit = top) => {
  process.stdout.write(`\n## ${title}\n`);
  for (const [key, size] of Object.entries(entries).slice(0, limit)) process.stdout.write(`${mb(size).padStart(10)}  ${key}\n`);
};
process.stdout.write(`# ${target}\n`);
for (const [key, value] of Object.entries(report.totals)) process.stdout.write(`${key.padEnd(20)} ${key === 'files' || key === 'packages' ? value : mb(value)}\n`);
table('app.asar 顶层（含 unpacked）', report.byTop);
table('node_modules 按包（含 unpacked）', report.byPackage);
table('app.asar.unpacked 按包', report.byPackageUnpacked, 20);
table('host 子目录', report.byHost, 20);
table('可疑内容', report.suspicious);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
