// 按清单下载开源音效素材到 .cache/sfx/（不入库）：node scripts/audio/sfx/fetch-sfx.mjs [--update-hashes]
// 清单 sfx.manifest.json 记录每个文件的来源 URL、授权、署名与 sha256；已存在且校验通过的文件会跳过。
// Kenney 素材包需先取资产页的会话 cookie，再换一次性签名下载链接，下载 zip 后只解出用到的成员。
// --update-hashes：把实际下载内容的 sha256 写回清单（只在有意更换素材时使用）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ROOT } from './dsp.mjs';

const MANIFEST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sfx.manifest.json');
export const CACHE = path.join(ROOT, '.cache', 'sfx');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchBuf = async (url, init = {}, tries = 4) => {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (k >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1500 * k);
    }
  }
};

/** Kenney：资产页 → cookie → /download-link/<hex(assets/slug)> → 签名 zip。 */
const fetchKenneyZip = async (slug) => {
  const page = `https://kenney.nl/assets/${slug}`;
  const res = await fetch(page, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${page}: HTTP ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const id = Buffer.from(`assets/${slug}`).toString('hex');
  const link = JSON.parse((await fetchBuf(`https://kenney.nl/download-link/${id}`, { headers: { cookie, referer: page } })).toString('utf8'));
  if (!link.url) throw new Error(`kenney ${slug}: no signed url`);
  return fetchBuf(link.url, { headers: { cookie, referer: page } });
};

/** 极简 zip 读取：按中央目录找成员，支持 stored / deflate。 */
const unzipMember = (zip, member) => {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const want = member.replace(/\\/g, '/');
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nlen);
    if (name === want || name.endsWith(`/${want}`)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip method ${method}`);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`zip member not found: ${member}`);
};

export const loadManifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
export const assetPath = (a) => path.join(CACHE, a.file);

export const fetchAll = async ({ updateHashes = false, quiet = false } = {}) => {
  const manifest = loadManifest();
  const zips = new Map();
  let changed = false;
  for (const a of manifest.assets) {
    const out = assetPath(a);
    if (fs.existsSync(out) && a.sha256 && sha256(fs.readFileSync(out)) === a.sha256) {
      if (!quiet) console.log(`ok     ${a.file}`);
      continue;
    }
    let buf;
    const pack = a.pack ? manifest.packs[a.pack] : null;
    if (pack?.type === 'kenney') {
      if (!zips.has(a.pack)) {
        const zfile = path.join(CACHE, 'kenney', `${pack.slug}.zip`);
        let zip = fs.existsSync(zfile) ? fs.readFileSync(zfile) : null;
        if (!zip) {
          zip = await fetchKenneyZip(pack.slug);
          fs.mkdirSync(path.dirname(zfile), { recursive: true });
          fs.writeFileSync(zfile, zip);
        }
        zips.set(a.pack, zip);
      }
      buf = unzipMember(zips.get(a.pack), a.member);
    } else {
      buf = await fetchBuf(a.url);
    }
    const h = sha256(buf);
    if (a.sha256 && h !== a.sha256 && !updateHashes) throw new Error(`sha256 mismatch for ${a.file}: got ${h}, manifest ${a.sha256}`);
    if (a.sha256 !== h) {
      a.sha256 = h;
      changed = true;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    if (!quiet) console.log(`fetch  ${a.file}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
  if (changed && updateHashes) {
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('sfx.manifest.json: sha256 updated');
  }
  return manifest;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchAll({ updateHashes: process.argv.includes('--update-hashes') }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
