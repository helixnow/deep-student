// 下载并校验开源采样与脉冲响应：node scripts/audio/fetch-samples.mjs
//   默认：按 samples.manifest.json 下载所有文件到 .cache/samples/src/、IR 到 .cache/ir/，
//         已存在且 sha256 一致则跳过；flac / ogg 用 ffmpeg 解码为 48 kHz wav 存 .cache/samples/dec/。
//   --resolve        依据 instruments/catalog.mjs 查询 GitHub 文件树，重新生成清单（保留已记录的 sha256）
//   --only a,b       只处理这些角色或集合 id（如 piano,kick 或 piano.osiris）
//   --defaults       只处理每个角色的默认音色
//   --jobs N         并发下载数（默认 8）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCES, SETS, FREESOUND, IRS, IR_LICENSE } from './instruments/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const manifestFile = path.join(here, 'samples.manifest.json');
const cacheDir = path.join(root, '.cache', 'samples');
const irDir = path.join(root, '.cache', 'ir');
export const FFMPEG = process.env.FFMPEG ?? path.join(root, 'node_modules', '@remotion', `compositor-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const rawUrl = (src, p) =>
  src.lfs
    ? `https://media.githubusercontent.com/media/${src.repo}/${src.commit}/${encPath(p)}`
    : `https://raw.githubusercontent.com/${src.repo}/${src.commit}/${encPath(p)}`;

export const srcPath = (source, p) => path.join(cacheDir, 'src', source, ...p.split('/'));
export const decPath = (source, p) => path.join(cacheDir, 'dec', source, ...p.split('/')) + '.wav';

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function resolve() {
  const old = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const known = new Map();
  for (const s of old?.sets ?? []) for (const f of s.files) if (f.sha256) known.set(`${s.source}:${f.path}`, f);
  const token = githubToken();
  const trees = new Map();
  const tree = async (key) => {
    if (trees.has(key)) return trees.get(key);
    const src = SOURCES[key];
    const res = await fetch(`https://api.github.com/repos/${src.repo}/git/trees/${src.commit}?recursive=1`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub tree ${src.repo}: ${res.status}`);
    const j = await res.json();
    let blobs = j.tree.filter((e) => e.type === 'blob');
    if (j.truncated) {
      // 仓库太大，递归树被截断：改为逐目录列出需要的文件
      blobs = [];
      const dirs = new Set(SETS.filter((s) => s.source === key).flatMap((s) => (s.select ?? []).map((x) => x.dir)));
      for (const d of dirs) {
        const r = await fetch(`https://api.github.com/repos/${src.repo}/contents/${encPath(d.replace(/\/$/, ''))}?ref=${src.commit}`, {
          headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (!r.ok) throw new Error(`GitHub contents ${src.repo}/${d}: ${r.status}`);
        for (const e of await r.json()) if (e.type === 'file') blobs.push({ path: e.path, size: e.size, type: 'blob' });
      }
    }
    trees.set(key, blobs);
    return blobs;
  };
  const sets = [];
  for (const set of SETS) {
    const src = SOURCES[set.source];
    const entry = {
      id: set.id, role: set.role, variant: set.variant, default: !!set.default,
      library: src.name, source: set.source, homepage: src.homepage, license: src.license, credit: src.credit,
      desc: set.desc, files: [],
    };
    if (set.kind === 'derived') {
      entry.derivedFrom = set.from;
      sets.push(entry);
      continue;
    }
    if (set.source === 'freesound') {
      for (const fsd of FREESOUND) {
        if (!set.select.some((s) => s.re.test(fsd.file))) continue;
        const k = known.get(`freesound:${fsd.file}`);
        entry.files.push({ path: fsd.file, url: fsd.url, page: fsd.page, credit: fsd.credit, bytes: k?.bytes ?? null, sha256: k?.sha256 ?? null });
      }
      sets.push(entry);
      continue;
    }
    const blobs = await tree(set.source);
    for (const b of blobs) {
      const sel = set.select.find((s) => b.path.startsWith(s.dir) && s.re.test(b.path.slice(s.dir.length)));
      if (!sel) continue;
      if (set.parse && !set.parse(b.path)) continue;
      const k = known.get(`${set.source}:${b.path}`);
      entry.files.push({ path: b.path, url: rawUrl(src, b.path), bytes: src.lfs ? (k?.bytes ?? null) : b.size, sha256: k?.sha256 ?? null });
    }
    if (!entry.files.length) console.warn(`! ${set.id}: 没有匹配到任何文件`);
    sets.push(entry);
  }
  const oldIr = new Map((old?.irs ?? []).map((i) => [i.name, i]));
  const irs = IRS.map((i) => ({ ...i, license: IR_LICENSE, sha256: oldIr.get(i.name)?.sha256 ?? null, bytes: oldIr.get(i.name)?.bytes ?? null }));
  const manifest = {
    note: '由 scripts/audio/fetch-samples.mjs --resolve 生成；样本本身不入库，运行 node scripts/audio/fetch-samples.mjs 下载到 .cache/samples',
    cacheDir: '.cache/samples',
    irCacheDir: '.cache/ir',
    sources: SOURCES,
    sets,
    irs,
  };
  writeManifest(manifest);
  const total = sets.reduce((a, s) => a + s.files.reduce((b, f) => b + (f.bytes ?? 0), 0), 0);
  const nFiles = new Set(sets.flatMap((s) => s.files.map((f) => `${s.source}:${f.path}`))).size;
  console.log(`清单已更新：${sets.length} 个音色集合，${nFiles} 个文件，约 ${(total / 1e6).toFixed(0)} MB`);
  for (const s of sets) console.log(`  ${s.id.padEnd(26)} ${String(s.files.length).padStart(4)} 文件  ${(s.files.reduce((a, f) => a + (f.bytes ?? 0), 0) / 1e6).toFixed(1)} MB`);
}

function writeManifest(m) {
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 1) + '\n');
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(url, dest, tries = 4) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200 && buf.toString('utf8').startsWith('version https://git-lfs')) throw new Error('得到 LFS 指针而非文件');
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      return buf.length;
    } catch (e) {
      if (a === tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * a));
    }
  }
}

function decode(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ar', '48000', '-c:a', 'pcm_s24le', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 解码失败 ${src}: ${r.stderr}`);
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

async function fetchAll() {
  if (!fs.existsSync(manifestFile)) throw new Error('缺少 samples.manifest.json，先运行 --resolve');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const only = opt('--only', '')?.split(',').filter(Boolean) ?? [];
  const want = (s) => (only.length ? only.includes(s.role) || only.includes(s.id) : true) && (!flag('--defaults') || s.default);
  const chosen = m.sets.filter(want);
  for (const s of chosen) if (s.derivedFrom) { const b = m.sets.find((x) => x.id === s.derivedFrom); if (b && !chosen.includes(b)) chosen.push(b); }
  const jobs = [];
  const seen = new Set();
  for (const s of chosen) {
    for (const f of s.files) {
      const k = `${s.source}:${f.path}`;
      if (seen.has(k)) continue;
      seen.add(k);
      jobs.push({ set: s, f });
    }
  }
  let got = 0;
  let skipped = 0;
  let bytes = 0;
  let failed = 0;
  let dirty = false;
  const t0 = Date.now();
  await pool(jobs, Number(opt('--jobs', 8)), async ({ set, f }, k) => {
    const dest = srcPath(set.source, f.path);
    try {
      if (fs.existsSync(dest) && f.sha256 && sha256(dest) === f.sha256) {
        skipped++;
      } else {
        if (fs.existsSync(dest) && f.sha256) console.warn(`  校验不符，重新下载 ${f.path}`);
        const b = await download(f.url, dest);
        bytes += b;
        const h = sha256(dest);
        if (f.sha256 && h !== f.sha256) throw new Error(`sha256 不符：${f.path}`);
        if (!f.sha256) {
          for (const s of m.sets) for (const g of s.files) if (s.source === set.source && g.path === f.path) { g.sha256 = h; g.bytes = fs.statSync(dest).size; }
          dirty = true;
        }
        got++;
      }
      if (!/\.wav$/i.test(f.path)) {
        const dp = decPath(set.source, f.path);
        if (!fs.existsSync(dp) || fs.statSync(dp).mtimeMs < fs.statSync(dest).mtimeMs) decode(dest, dp);
      }
    } catch (e) {
      failed++;
      console.error(`✗ ${e.message}`);
    }
    if ((k + 1) % 50 === 0) console.log(`  … ${k + 1}/${jobs.length}  新下载 ${(bytes / 1e6).toFixed(0)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
  // 脉冲响应
  for (const ir of m.irs) {
    const dest = path.join(irDir, ir.file);
    try {
      if (fs.existsSync(dest) && ir.sha256 && sha256(dest) === ir.sha256) { skipped++; continue; }
      const b = await download(ir.url, dest);
      bytes += b;
      const h = sha256(dest);
      if (ir.sha256 && ir.sha256 !== h) throw new Error(`sha256 不符：${ir.file}`);
      if (!ir.sha256) { ir.sha256 = h; ir.bytes = fs.statSync(dest).size; dirty = true; }
      got++;
    } catch (e) {
      failed++;
      console.error(`✗ IR ${ir.name}: ${e.message}`);
    }
  }
  if (dirty) writeManifest(m);
  console.log(`完成：新下载 ${got} 个（${(bytes / 1e6).toFixed(0)} MB），校验通过跳过 ${skipped} 个，失败 ${failed} 个，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failed) process.exitCode = 1;
}

/** Windows 系统代理（Node 的 fetch 不读系统代理）：读注册表后带 NODE_USE_ENV_PROXY 重启自身。 */
function relaunchWithSystemProxy() {
  if (process.platform !== 'win32' || process.env.NODE_USE_ENV_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy) return false;
  let out = '';
  try {
    out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8' });
  } catch {
    return false;
  }
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return false;
  const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1];
  if (!server) return false;
  const hostPort = server.includes('=') ? (/https=([^;]+)/.exec(server)?.[1] ?? /http=([^;]+)/.exec(server)?.[1]) : server;
  if (!hostPort) return false;
  const proxy = /^\w+:\/\//.test(hostPort) ? hostPort : `http://${hostPort}`;
  console.log(`使用系统代理 ${proxy}`);
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy },
  });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  relaunchWithSystemProxy();
  (flag('--resolve') ? resolve() : fetchAll()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
