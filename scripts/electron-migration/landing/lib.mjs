// 回服务器落地工具包的共用部分。本机（land-pack / land-send / land-simulate）与服务器（land-apply / land-test）都用；
// 服务器上它和 land-apply.mjs、land-test.mjs 一起从上传目录运行（首次落地前服务器仓库里还没有这些脚本），
// 所以只能依赖 Node 内置模块（zstd 用 node:zlib，Node ≥ 22.15）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

export const SCHEMA = 'ds-landing/1';
export const BASE_SNAPSHOT = {
  tag: 'base-ae4efdf9e',
  sha: '21c9d8086fe679261115e08f5800145530ff50be',
  server: 'ae4efdf9e',
};
export const EXCLUDED_PATHS = ['src/version.ts'];
export const TOOL_FILES = ['lib.mjs', 'land-apply.mjs', 'land-test.mjs'];
export const PATCH_FILE = 'land.patch';
export const ARCHIVE_FILE = 'land.patch.zst';
export const FROM_TREE_FILE = 'from.tree.zst';
export const TO_TREE_FILE = 'to.tree.zst';
export const MANIFEST_FILE = 'MANIFEST.json';
export const SUMS_FILE = 'SHA256SUMS';
export const DEFAULT_BRANCH = 'assault/landing';
export const MAP_SCHEMA = 'ds-landing-map/1';

// landing-map.json 可以同时记录多条落地分支（assault/landing、旁路的 assault/visual-base 等）。
// 第一版的记录没有 branch 字段，按顶层 map.branch 归属。
export const entryBranch = (map, e) => e.branch ?? map?.branch ?? DEFAULT_BRANCH;
export const branchEntries = (map, branch) => (map?.entries ?? []).filter((e) => entryBranch(map, e) === branch);
export const lastLanding = (map, branch) => branchEntries(map, branch).at(-1) ?? null;

// 快照传输时没带过来的区域：服务器 main 上有文件，本机基线完全没有。补丁触及这里时服务器上可能已有同名文件。
export const UNTRANSFERRED_ZONES = [
  { name: 'example/', test: (p) => p.startsWith('example/') },
  { name: 'src-tauri/resources/', test: (p) => p.startsWith('src-tauri/resources/') },
  { name: '字体', test: (p) => /\.(ttf|otf|woff2?|eot)$/i.test(p) },
  { name: '历史 bundle', test: (p) => /\.bundle$/i.test(p) || /(^|\/)bundles\//.test(p) },
  { name: 'pdfium 二进制', test: (p) => /(^|\/)(lib)?pdfium[^/]*\.(so|dylib|dll)$/i.test(p) },
];
export const zoneOf = (p) => UNTRANSFERRED_ZONES.find((z) => z.test(p))?.name ?? null;

export const short = (sha) => String(sha).slice(0, 12);
export const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
export const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s));
export const safeName = (s) => /^[\w][\w.-]*$/.test(String(s));

/** 是否作为入口脚本运行。import.meta.url 已解析符号链接（macOS 的 /var → /private/var），argv[1] 没有，必须都取 realpath 再比。 */
export function isEntry(fileUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(fileUrl));
  } catch {
    return false;
  }
}

/** 打印脚本文件头的注释块（用法说明）并退出。 */
export function printUsage(fileUrl) {
  const lines = fs.readFileSync(new URL(fileUrl), 'utf8').split('\n');
  const head = [];
  for (const l of lines.slice(lines[0].startsWith('#!') ? 1 : 0)) {
    if (!l.startsWith('//')) break;
    head.push(l.replace(/^\/\/ ?/, ''));
  }
  console.log(head.join('\n'));
  process.exit(0);
}

export class LandingError extends Error {}
export const fail = (m) => {
  throw new LandingError(m);
};

/** 运行 git；钩子一律关掉（服务器仓库配置了 husky 等，落地不能触发它们）。 */
export function git(cwd, args, { env, input, encoding = 'utf8', stdout } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      input,
      encoding: stdout === undefined ? encoding : undefined,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 1 << 30,
      stdio: [input === undefined ? 'ignore' : 'pipe', stdout ?? 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = new LandingError(`git ${args.join(' ')} 失败（退出码 ${e.status}）：${String(e.stderr ?? e.message).trim().slice(0, 2000)}`);
    err.status = e.status;
    err.stdoutText = e.stdout ? String(e.stdout) : '';
    throw err;
  }
}
export const gitLine = (cwd, args, o) => git(cwd, args, o).trim();
export function gitOk(cwd, args, o) {
  try {
    git(cwd, args, o);
    return true;
  } catch {
    return false;
  }
}
/** 解析成完整提交 SHA；不存在时返回空串。 */
export function revParse(cwd, rev) {
  try {
    return gitLine(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  } catch {
    return '';
  }
}

/** `git ls-tree -r -z` 或 `git ls-files -s -z` 的输出 → Map(path → { mode, oid })。 */
export function parseTreeListing(text, { exclude = EXCLUDED_PATHS, format = 'ls-tree' } = {}) {
  const map = new Map();
  for (const rec of text.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const meta = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (exclude.includes(p)) continue;
    if (format === 'ls-files') {
      if (meta[2] !== '0') fail(`索引里有未解决的冲突条目：${p}`);
      map.set(p, { mode: meta[0], oid: meta[1] });
    } else {
      map.set(p, { mode: meta[0], oid: meta[2] });
    }
  }
  return map;
}
export const lsTree = (cwd, rev, o) => parseTreeListing(git(cwd, ['ls-tree', '-r', '-z', '--full-tree', rev]), o);
export const lsIndex = (cwd, o = {}) => parseTreeListing(git(cwd, ['ls-files', '-s', '-z'], { env: o.env }), { ...o, format: 'ls-files' });

export function serializeTree(map) {
  return [...map.keys()].sort().map((p) => {
    const e = map.get(p);
    return `${e.mode} ${e.mode === '160000' ? 'commit' : 'blob'} ${e.oid}\t${p}\0`;
  }).join('');
}
export const zstdCompress = (buf, level = 19) => zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
export const zstdDecompress = (buf) => zlib.zstdDecompressSync(buf);
export const readTreeFile = (file) => parseTreeListing(zstdDecompress(fs.readFileSync(file)).toString('utf8'), { exclude: [] });

/** expected 里每个路径在 actual 中必须同 mode 同 oid；actual 多出的路径单独列出（服务器独有文件）。 */
export function compareTrees(expected, actual) {
  const missing = [];
  const mismatch = [];
  for (const [p, e] of expected) {
    const a = actual.get(p);
    if (!a) missing.push(p);
    else if (a.mode !== e.mode || a.oid !== e.oid) mismatch.push({ path: p, expected: e, actual: a });
  }
  const extra = [...actual.keys()].filter((p) => !expected.has(p)).sort();
  return { missing, mismatch, extra, equal: missing.length === 0 && mismatch.length === 0 };
}

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function writeJSONAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

/** GNU coreutils 格式（`sha256sum -c` 可直接校验）。 */
export function writeSums(dir, files) {
  const lines = files.map((f) => `${sha256File(path.join(dir, f))}  ${f}\n`);
  fs.writeFileSync(path.join(dir, SUMS_FILE), lines.join(''));
}
export function readSums(dir) {
  const out = [];
  for (const line of fs.readFileSync(path.join(dir, SUMS_FILE), 'utf8').split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m || !safeName(m[2])) fail(`SHA256SUMS 行格式不对：${line}`);
    out.push({ sha256: m[1], file: m[2] });
  }
  return out;
}
export function checkSums(dir) {
  return readSums(dir).map(({ sha256, file }) => {
    const p = path.join(dir, file);
    const ok = fs.existsSync(p) && sha256File(p) === sha256;
    return { file, ok };
  });
}

export function validateManifest(m) {
  if (!m || m.schema !== SCHEMA) fail(`MANIFEST schema 不是 ${SCHEMA}`);
  for (const k of ['from', 'to']) if (!isSha(m[k]?.sha)) fail(`MANIFEST.${k}.sha 不是完整 SHA`);
  if (!Array.isArray(m.parts) || !m.parts.length) fail('MANIFEST.parts 为空');
  const files = [...m.parts.map((p) => p.file), m.trees?.from?.file, m.trees?.to?.file, ...(m.tools ?? []).map((t) => t.file)];
  for (const f of files) if (!safeName(f)) fail(`MANIFEST 里有不安全的文件名：${f}`);
  for (const p of m.parts) if (!/^[0-9a-f]{64}$/.test(p.sha256) || !Number.isInteger(p.bytes)) fail(`分片 ${p.file} 的 sha256/bytes 无效`);
  for (const k of ['patch', 'archive']) if (!/^[0-9a-f]{64}$/.test(m[k]?.sha256 ?? '')) fail(`MANIFEST.${k}.sha256 无效`);
  if (!isSha(m.baseSnapshot?.sha) || !m.baseSnapshot?.server) fail('MANIFEST.baseSnapshot 缺 sha 或 server');
  return m;
}

/** 校验分片 → 拼接 → 校验整包 → 用 node:zlib 解压 → 校验补丁。返回补丁路径。 */
export async function reassemble(packDir, manifest, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const archive = path.join(workDir, ARCHIVE_FILE);
  const patch = path.join(workDir, PATCH_FILE);
  const bad = [];
  for (const p of manifest.parts) {
    const f = path.join(packDir, p.file);
    if (!fs.existsSync(f)) bad.push(`${p.file}（缺失）`);
    else if (fs.statSync(f).size !== p.bytes) bad.push(`${p.file}（大小 ${fs.statSync(f).size} ≠ ${p.bytes}）`);
    else if (sha256File(f) !== p.sha256) bad.push(`${p.file}（sha256 不符）`);
  }
  if (bad.length) fail(`分片校验失败：${bad.join('，')}。重传这些分片（land-send --only ...）`);
  const fd = fs.openSync(archive, 'w');
  try {
    for (const p of manifest.parts) fs.writeSync(fd, fs.readFileSync(path.join(packDir, p.file)));
  } finally {
    fs.closeSync(fd);
  }
  if (sha256File(archive) !== manifest.archive.sha256) fail('分片拼接后整包 sha256 与 MANIFEST 不符（分片顺序或内容错）');
  await pipeline(fs.createReadStream(archive), zlib.createZstdDecompress(), fs.createWriteStream(patch));
  if (sha256File(patch) !== manifest.patch.sha256) fail('解压后的补丁 sha256 与 MANIFEST 不符');
  fs.rmSync(archive);
  return patch;
}

/** mkdir 互斥锁；持有进程已不存在时接管。返回释放函数。 */
export function acquireLock(lockDir) {
  try {
    fs.mkdirSync(lockDir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim() || 0);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid > 0;
    } catch {
      alive = false;
    }
    if (alive) fail(`另一个进程（pid ${pid}）持有锁 ${lockDir}`);
  }
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  return () => fs.rmSync(lockDir, { recursive: true, force: true });
}

/** `git apply --numstat -z` 列出补丁里的每个路径（不依赖解析补丁头的引号规则）。 */
export function patchPaths(cwd, patchFile) {
  const out = git(cwd, ['apply', '--numstat', '-z', '--binary', patchFile]);
  const res = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const [added, deleted, p] = rec.split('\t');
    res.push({ path: p, binary: added === '-' && deleted === '-' });
  }
  return res;
}

export function systemctlState(unit) {
  try {
    return execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return String(e.stdout ?? '').trim() || 'unknown';
  }
}
export const unitRunning = (unit) => ['active', 'activating', 'reloading', 'deactivating'].includes(systemctlState(unit));

export function pgrep(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map(Number).filter((p) => p && p !== process.pid && p !== process.ppid);
  } catch {
    return [];
  }
}
