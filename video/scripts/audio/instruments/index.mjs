// 开源采样音色的采样器。
// 用法：
//   import { loadInstruments, INSTRUMENTS, INSTRUMENT_INFO } from './instruments/index.mjs';
//   await loadInstruments({ variant: { piano: 'felt' } });
//   const { L, R } = INSTRUMENTS.piano({ t: 12, dur: 0.8, midi: 62, vel: 0.6, pan: -0.2, seed: 7 });
// 返回从音符起点开始的立体声缓冲（含释放尾音），vel=1 时峰值约 0.5；不做摆放与混响。
// 样本先运行 node scripts/audio/fetch-samples.mjs 下载；首次加载某个音色会预处理并缓存到 .cache/samples/prep/。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCES, SETS } from './catalog.mjs';
import { readWav, resampleSinc, resampleHermite, yin, ftom, biquad } from './dsp.mjs';

export const SR = 48000;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const cacheDir = path.join(root, '.cache', 'samples');
const prepDir = path.join(cacheDir, 'prep');
const manifestFile = path.join(here, '..', 'samples.manifest.json');
const PREP_VERSION = 5;

export const ROLES = [
  'piano', 'mallet', 'bells', 'pluck', 'strings_long', 'strings_short', 'pad', 'bass',
  'kick', 'snare', 'clap', 'hat', 'shaker', 'perc_wood', 'perc_metal', 'impact', 'swell',
  'foley_paper', 'foley_pencil', 'foley_book',
];

/** @type {Record<string, (ev: any) => { L: Float32Array; R: Float32Array }>} */
export const INSTRUMENTS = {};
/** @type {Record<string, { range?: [number, number]; tail: number; source: string; license: string; desc: string; variant?: string }>} */
export const INSTRUMENT_INFO = {};
/** 每个角色可选的音色：{ piano: ['osiris', 'felt', 'upright'], ... }，第一个为默认。 */
export const VARIANTS = {};
for (const r of ROLES) {
  const sets = SETS.filter((s) => s.role === r).sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0));
  VARIANTS[r] = sets.map((s) => s.variant);
}

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[instruments] ${msg}`);
};
const silent = (role, why) => (ev) => {
  warnOnce(`silent:${role}`, `${role} 不可用（${why}），返回静音`);
  const n = Math.ceil(Math.max(0.05, ev?.dur ?? 0.1) * SR);
  return { L: new Float32Array(n), R: new Float32Array(n) };
};
for (const r of ROLES) {
  INSTRUMENTS[r] = silent(r, '尚未调用 loadInstruments');
  INSTRUMENT_INFO[r] = { tail: 1, source: 'pending', license: 'pending', desc: '尚未加载' };
}

// ── 小工具 ───────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hash32 = (...xs) => {
  let h = 0x811c9dc5;
  for (const x of xs) {
    let v = Math.floor(Number(x) * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
};
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const noteMidi = (s) => {
  const m = /^([A-Ga-g])([#sb]?)(-?\d)$/.exec(s);
  if (!m) return null;
  let pc = PC[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === 's') pc++;
  if (m[2] === 'b') pc--;
  return 12 * (Number(m[3]) + 1) + pc;
};
const setById = (id) => SETS.find((s) => s.id === id);
const fileOf = (source, p) =>
  /\.wav$/i.test(p) ? path.join(cacheDir, 'src', source, ...p.split('/')) : path.join(cacheDir, 'dec', source, ...p.split('/')) + '.wav';

function readManifest() {
  if (!fs.existsSync(manifestFile)) throw new Error('缺少 scripts/audio/samples.manifest.json');
  return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
}

// ── 预处理 ───────────────────────────────────────────
/** 读一个文件为 48 kHz、≤2 声道 Float32Array[]。 */
function loadAudio(file) {
  const { sr, channels } = readWav(fs.readFileSync(file));
  let ch = channels.length > 2 ? channels.slice(0, 2) : channels;
  if (sr !== SR) {
    const step = sr / SR;
    const n = Math.floor(ch[0].length / step);
    ch = ch.map((c) => resampleSinc(c, step, n, { half: 24 }));
  }
  return ch;
}

const monoOf = (ch) => {
  if (ch.length === 1) return ch[0];
  const m = new Float32Array(ch[0].length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (ch[0][i] + ch[1][i]);
  return m;
};

/** 去直流（20 Hz 一阶高通）、去开头静音、截断过长尾巴。 */
function cleanSample(ch, { trimDb = -40, maxLen = 8, keepHead = false } = {}) {
  for (const c of ch) {
    let x1 = 0;
    let y1 = 0;
    const a = Math.exp((-2 * Math.PI * 20) / SR);
    for (let i = 0; i < c.length; i++) {
      const y = c[i] - x1 + a * y1;
      x1 = c[i];
      y1 = y;
      c[i] = y;
    }
  }
  const n = ch[0].length;
  let peak = 0;
  for (const c of ch) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (peak <= 0) return null;
  let start = 0;
  if (!keepHead) {
    const thr = peak * 10 ** (trimDb / 20);
    outer: for (let i = 0; i < n; i++) for (const c of ch) if (Math.abs(c[i]) > thr) { start = i; break outer; }
    start = Math.max(0, start - Math.round(0.0015 * SR));
  }
  // 尾部：低于峰值 -75 dB 之后的全部去掉
  const thrEnd = peak * 10 ** (-75 / 20);
  let end = n;
  for (let i = n - 1; i > start; i--) {
    let hit = false;
    for (const c of ch) if (Math.abs(c[i]) > thrEnd) hit = true;
    if (hit) { end = i + 1; break; }
  }
  end = Math.min(end, start + Math.round(maxLen * SR));
  const len = end - start;
  if (len < 64) return null;
  const out = ch.map((c) => c.slice(start, end));
  const fi = Math.min(24, len >> 2);
  const fo = Math.min(Math.round(0.05 * SR), len >> 2);
  for (const c of out) {
    if (start > 0) for (let i = 0; i < fi; i++) c[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    for (let i = 0; i < fo; i++) c[len - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  }
  return out;
}

const rmsWindow = (ch, sec) => {
  const m = monoOf(ch);
  const n = Math.min(m.length, Math.max(256, Math.round(sec * SR)));
  // 取窗内 50 ms 滑窗的最大 RMS（对起音位置不敏感）
  const w = Math.round(0.05 * SR);
  let best = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += m[i] * m[i];
    if (i >= w) acc -= m[i - w] * m[i - w];
    if (i >= Math.min(w, n) - 1) best = Math.max(best, acc / Math.min(w, i + 1));
  }
  return Math.sqrt(best) + 1e-9;
};

/** 长录音切片（铅笔笔划等）。 */
function sliceRecording(ch, { minLen, maxLen, gapMs, thrDb }) {
  const m = monoOf(ch);
  const hop = Math.round(0.005 * SR);
  const env = [];
  for (let i = 0; i + hop <= m.length; i += hop) {
    let s = 0;
    for (let k = 0; k < hop; k++) s += m[i + k] * m[i + k];
    env.push(Math.sqrt(s / hop));
  }
  const sorted = [...env].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.98)] || 1e-9;
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(ref * 10 ** (thrDb / 20), floor * 2.5);
  const runs = [];
  let cur = null;
  const gap = Math.round(gapMs / 5);
  for (let i = 0; i < env.length; i++) {
    if (env[i] > thr) {
      if (cur && i - cur.e <= gap) cur.e = i;
      else {
        if (cur) runs.push(cur);
        cur = { s: i, e: i };
      }
    }
  }
  if (cur) runs.push(cur);
  const out = [];
  for (const r of runs) {
    const s = Math.max(0, r.s * hop - Math.round(0.012 * SR));
    const e = Math.min(m.length, (r.e + 1) * hop + Math.round(0.04 * SR));
    const len = (e - s) / SR;
    if (len < minLen || len > maxLen) continue;
    const seg = ch.map((c) => c.slice(s, e));
    const fi = Math.round(0.008 * SR);
    const fo = Math.round(0.03 * SR);
    for (const c of seg) {
      for (let i = 0; i < fi; i++) c[i] *= i / fi;
      for (let i = 0; i < fo; i++) c[c.length - 1 - i] *= i / fo;
    }
    out.push(seg);
  }
  return out;
}

const setFingerprint = (set, files) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify({ v: PREP_VERSION, set: { ...set, parse: set.parse?.toString(), select: set.select?.map((s) => [s.dir, String(s.re)]) }, files: files.map((f) => [f.path, f.sha256]) }))
    .digest('hex')
    .slice(0, 16);

/** 预处理一个音色集合（或读缓存），返回 { samples: [...], meta }。 */
function prepSet(set, manifest) {
  const ms = manifest.sets.find((s) => s.id === set.id);
  if (!ms) throw new Error(`清单中没有 ${set.id}，请运行 fetch-samples.mjs --resolve`);
  const fp = setFingerprint(set, ms.files);
  const metaFile = path.join(prepDir, `${set.id}.json`);
  const binFile = path.join(prepDir, `${set.id}.bin`);
  if (fs.existsSync(metaFile) && fs.existsSync(binFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta.fp === fp) return materialize(meta, fs.readFileSync(binFile));
  }
  const t0 = Date.now();
  const present = ms.files.filter((f) => fs.existsSync(fileOf(set.source, f.path)));
  if (!present.length) throw new Error(`${set.id} 的样本还没下载（运行 node scripts/audio/fetch-samples.mjs --only ${set.role}）`);
  if (present.length < ms.files.length) warnOnce(`missing:${set.id}`, `${set.id} 缺少 ${ms.files.length - present.length} 个样本文件，先用已有的 ${present.length} 个`);

  const raw = []; // { ch, info }
  if (set.kind === 'slices') {
    for (const f of present) {
      const ch = loadAudio(fileOf(set.source, f.path));
      const segs = sliceRecording(ch, set.slice);
      segs.forEach((seg, k) => raw.push({ ch: seg, info: { artic: 'stroke', layer: 1, rr: raw.length + k, src: f.path } }));
    }
  } else if (set.mics) {
    const groups = new Map();
    for (const f of present) {
      const info = set.parse(f.path);
      if (!info) continue;
      const g = groups.get(info.key) ?? { info, parts: [] };
      g.parts.push({ f, mic: info.mic });
      groups.set(info.key, g);
    }
    for (const { info, parts } of groups.values()) {
      let mix = null;
      for (const { f, mic } of parts) {
        const ch = loadAudio(fileOf(set.source, f.path));
        const st = ch.length === 1 ? [ch[0], ch[0]] : ch;
        const g = set.mics[mic] ?? 1;
        if (!mix) mix = [new Float32Array(st[0].length), new Float32Array(st[0].length)];
        if (st[0].length > mix[0].length) mix = mix.map((c) => { const d = new Float32Array(st[0].length); d.set(c); return d; });
        for (let c = 0; c < 2; c++) for (let i = 0; i < st[c].length; i++) mix[c][i] += g * st[c][i];
      }
      raw.push({ ch: mix, info: { ...info, src: parts.map((p) => p.f.path).join(' + ') } });
    }
  } else {
    for (const f of present) {
      const info = set.parse(f.path);
      if (!info) continue;
      raw.push({ ch: loadAudio(fileOf(set.source, f.path)), info: { ...info, src: f.path } });
    }
  }

  const samples = [];
  for (const { ch, info } of raw) {
    const c = cleanSample(ch, { trimDb: set.trimDb ?? (set.kind === 'pitched' ? -36 : -42), maxLen: set.maxLen ?? 8, keepHead: set.kind === 'slices' });
    if (!c) continue;
    const s = { ...info, ch: c, len: c[0].length };
    if (info.note) s.nameMidi = noteMidi(info.note);
    samples.push(s);
  }

  // 音高检测 + 八度偏差修正
  const warnings = [];
  if (set.kind === 'pitched') {
    const diffs = [];
    for (const s of samples) {
      if (s.nameMidi == null) continue;
      const m = monoOf(s.ch);
      const fmin = Math.max(22, 440 * 2 ** ((s.nameMidi - 26 - 69) / 12));
      const fmax = Math.min(6000, 440 * 2 ** ((s.nameMidi + 26 - 69) / 12));
      const off = Math.min(Math.round((set.pitchAt ?? 0.08) * SR), Math.floor(s.len / 4));
      const r = yin(m, SR, { fmin, fmax, start: off, len: Math.min(8192, Math.max(1024, Math.ceil((3 * SR) / fmin))) });
      s.f0 = r.f0;
      s.f0conf = r.conf;
      if (r.f0 > 0 && r.conf > 0.6) diffs.push(Math.round((ftom(r.f0) - s.nameMidi) / 12));
    }
    const votes = new Map();
    for (const d of diffs) votes.set(d, (votes.get(d) ?? 0) + 1);
    let oct = 0;
    let best = -1;
    for (const [d, n] of votes) if (n > best || (n === best && Math.abs(d) < Math.abs(oct))) [oct, best] = [d, n];
    for (const s of samples) {
      s.root = s.nameMidi + 12 * oct;
      if (s.f0 > 0 && s.f0conf > 0.6) {
        const det = ftom(s.f0);
        let dev = det - s.root;
        dev -= 12 * Math.round(dev / 12);
        s.detuneCents = Math.round(dev * 100);
        if (set.tuneFromPitch && Math.abs(dev) < 0.8) s.root += dev;
        else if (Math.abs(dev) > 0.35) warnings.push(`${s.src}: 检测音高与标注相差 ${Math.round(dev * 100)} 音分（可能是音高检测误差）`);
      }
    }
    // 人手音准（无品乐器）：同一音的轮换采样检测结果一致时，按其中位数校正根音
    if (set.tuneCorrect) {
      const byNote = new Map();
      for (const s of samples) if (s.detuneCents != null && Math.abs(s.detuneCents) < 90) (byNote.get(s.nameMidi) ?? byNote.set(s.nameMidi, []).get(s.nameMidi)).push(s);
      for (const [, list] of byNote) {
        const d = list.map((s) => s.detuneCents).sort((a, b) => a - b);
        const med = d[Math.floor(d.length / 2)];
        if (d.length >= 2 && d[d.length - 1] - d[0] <= 35 && Math.abs(med) >= 8) {
          for (const s of samples) if (s.nameMidi === list[0].nameMidi) s.root += med / 100;
          warnings.push(`${list[0].src.split('/').pop()} 等：按实测校正 ${med} 音分`);
        }
      }
    }
    if (oct !== 0) warnings.unshift(`文件名八度记法与实际差 ${oct > 0 ? '+' : ''}${oct} 个八度（按音高检测修正，${best}/${diffs.length} 票）`);
  }

  // 响度归一：同一 artic / group 内按起音 RMS 拉齐，再整体缩放使峰值 ≈ 0.5
  // 增益 = RMS 归一与峰值归一的几何平均（兼顾响度一致与峰值一致），再缩放使中位峰值 = 0.5，个别超出者压到 0.5
  const win = set.play === 'sustain' ? 1.5 : set.kind === 'pitched' ? 0.35 : 0.08;
  const groups = new Map();
  for (const s of samples) {
    const k = set.kind === 'pitched' ? 'all' : s.artic;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const list of groups.values()) {
    for (const s of list) {
      s.rms = rmsWindow(s.ch, win);
      s.peak = Math.max(...s.ch.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
      s.g = Math.sqrt(1 / (s.rms * s.peak));
    }
    const pk = list.map((s) => s.peak * s.g).sort((a, b) => a - b);
    const scale = 0.5 / pk[Math.floor((pk.length - 1) * 0.5)];
    for (const s of list) s.gain = Math.min(s.g * scale, 0.5 / s.peak);
  }
  // 渐强素材记录高潮位置
  for (const s of samples) {
    if (!set.swell) continue;
    const m = monoOf(s.ch);
    const w = Math.round(0.05 * SR);
    let acc = 0;
    let best = 0;
    let at = 0;
    for (let i = 0; i < m.length; i++) {
      acc += m[i] * m[i];
      if (i >= w) acc -= m[i - w] * m[i - w];
      if (acc > best) [best, at] = [acc, i];
    }
    s.peakPos = at;
  }

  // 打包为 int16（每个样本按自身峰值放大到满刻度，scale 记在元数据里）
  let total = 0;
  for (const s of samples) total += s.len * s.ch.length;
  const bin = Buffer.alloc(total * 2);
  let off = 0;
  const metaSamples = [];
  for (const s of samples) {
    const q = 32767 / s.peak;
    const chOff = [];
    for (const c of s.ch) {
      chOff.push(off);
      for (let i = 0; i < s.len; i++, off += 2) bin.writeInt16LE(clamp(Math.round(c[i] * q), -32767, 32767), off);
    }
    metaSamples.push({
      src: s.src, artic: s.artic, group: s.group, layer: s.layer, rr: s.rr, root: s.root, nameMidi: s.nameMidi,
      f0: s.f0 ? Math.round(s.f0 * 100) / 100 : undefined, detuneCents: s.detuneCents, peakPos: s.peakPos,
      len: s.len, nch: s.ch.length, chOff, scale: (s.peak / 32767) * s.gain,
    });
  }
  const meta = { fp, id: set.id, warnings, samples: metaSamples, prepSeconds: (Date.now() - t0) / 1000 };
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(binFile, bin);
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  if (warnings.length) {
    console.warn(`[instruments] ${set.id} 预处理提示：`);
    for (const w of warnings.slice(0, 8)) console.warn(`    ${w}`);
    if (warnings.length > 8) console.warn(`    …另有 ${warnings.length - 8} 条，见 ${path.relative(root, metaFile)}`);
  }
  console.log(`[instruments] 预处理 ${set.id}：${metaSamples.length} 个样本，${(meta.prepSeconds).toFixed(1)}s`);
  return materialize(meta, bin);
}

function materialize(meta, bin) {
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length);
  const samples = meta.samples.map((s, idx) => ({
    ...s,
    idx,
    data: s.chOff.map((o) => new Int16Array(ab, o, s.len)),
  }));
  return { meta, samples };
}

// ── 渲染 ─────────────────────────────────────────────
const resCache = new Map();
let resBytes = 0;
const RES_CAP = 900e6;
/** 取样本 s 以 step 变速后的前 n 个输出样本（每声道 Float32Array，已乘 scale），带 LRU 缓存。 */
function resampled(setId, s, step, n) {
  const key = `${setId}|${s.idx}|${step.toFixed(7)}`;
  const hit = resCache.get(key);
  const avail = Math.floor((s.len - 1) / step);
  const want = Math.min(n, avail);
  if (hit && hit[0].length >= want) {
    resCache.delete(key);
    resCache.set(key, hit);
    return hit;
  }
  const semis = Math.abs(12 * Math.log2(step));
  let out;
  if (Math.abs(step - 1) < 1e-9) {
    out = s.data.map((d) => {
      const f = new Float32Array(want);
      for (let i = 0; i < want; i++) f[i] = d[i] * s.scale;
      return f;
    });
  } else if (semis <= 1.5) {
    out = s.data.map((d) => resampleHermite(d, step, want, { scale: s.scale }));
  } else {
    out = s.data.map((d) => resampleSinc(d, step, want, { scale: s.scale, half: 12 }));
  }
  if (hit) resBytes -= hit[0].length * 4 * hit.length;
  resCache.set(key, out);
  resBytes += want * 4 * out.length;
  while (resBytes > RES_CAP && resCache.size > 1) {
    const [k, v] = resCache.entries().next().value;
    resCache.delete(k);
    resBytes -= v[0].length * 4 * v.length;
  }
  return out;
}

/** 循环延长持续音：在样本中后段做等功率交叉淡化循环。 */
function loopExtend(src, n) {
  const S = src[0].length;
  if (S >= n) return src;
  const X = Math.round(Math.min(0.3 * SR, S * 0.12));
  const a = Math.round(Math.max(0.6 * SR, S * 0.35));
  const b = S - Math.round(0.15 * SR);
  if (b - a < 3 * X) return src;
  return src.map((c) => {
    const out = new Float32Array(n);
    let p = Math.min(n, b - X);
    out.set(c.subarray(0, p));
    while (p < n) {
      for (let i = 0; i < X && p < n; i++, p++) {
        const k = (i + 0.5) / X;
        out[p] = c[b - X + i] * Math.cos((k * Math.PI) / 2) + c[a + i] * Math.sin((k * Math.PI) / 2);
      }
      for (let i = a + X; i < b - X && p < n; i++, p++) out[p] = c[i];
    }
    return out;
  });
}

const velGain = (vel) => clamp(vel, 0, 1) ** 1.5;
const panGains = (pan = 0) => {
  const p = clamp(pan, -1, 1);
  return [Math.min(1, Math.SQRT2 * Math.sqrt((1 - p) / 2)), Math.min(1, Math.SQRT2 * Math.sqrt((1 + p) / 2))];
};

function finish(chs, n, ev, { attack = 0, releaseAt = Infinity, release = 0.2, lpf = 0, choke = Infinity } = {}) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const [gl, gr] = panGains(ev.pan);
  const g = velGain(ev.vel ?? 0.8);
  const a = Math.round(attack * SR);
  const ra = Math.round(releaseAt * SR);
  const rk = Math.exp(-6.91 / Math.max(1, release * SR));
  const cs = Math.round(choke * SR);
  const ck = Math.exp(-6.91 / (0.06 * SR));
  const c0 = chs[0];
  const c1 = chs[1] ?? chs[0];
  let env = 1;
  const m = Math.min(n, c0.length);
  for (let i = 0; i < m; i++) {
    let e = g;
    if (i < a) e *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
    if (i >= ra) env *= rk;
    if (i >= cs) env *= ck;
    e *= env;
    L[i] = c0[i] * e * gl;
    R[i] = c1[i] * e * gr;
  }
  const fo = Math.min(Math.round(0.004 * SR), m);
  for (let i = 0; i < fo; i++) {
    const k = i / fo;
    L[m - 1 - i] *= k;
    R[m - 1 - i] *= k;
  }
  if (lpf > 0) {
    biquad(L, SR, 'lp', lpf, 0.6);
    biquad(R, SR, 'lp', lpf, 0.6);
  }
  return { L, R };
}

const pickRR = (list, ev, salt) => {
  if (list.length === 1) return list[0];
  const sorted = [...list].sort((a, b) => a.rr - b.rr || a.idx - b.idx);
  const seed = ev.seed ?? hash32(ev.t ?? 0, ev.midi ?? 0, salt);
  return sorted[hash32(seed, salt, ev.midi ?? 0) % sorted.length];
};

const pickLayer = (list, vel) => {
  const layers = [...new Set(list.map((s) => s.layer))].sort((a, b) => a - b);
  const i = Math.min(layers.length - 1, Math.floor(clamp(vel, 0, 1) * layers.length * 0.9999));
  return list.filter((s) => s.layer === layers[i]);
};

function makePitched(set, base, samples) {
  const play = set.play;
  const lpfDefault = set.lpf ?? base?.lpf ?? 0;
  return (ev) => {
    const vel = clamp(ev.vel ?? 0.8, 0, 1);
    const dur = Math.max(0.01, ev.dur ?? 0.5);
    const midi = ev.midi ?? 60;
    let pool = samples;
    if (set.split) {
      const g = Object.entries(set.split).find(([, [lo, hi]]) => midi >= lo && midi <= hi)?.[0];
      const inG = samples.filter((s) => s.group === g);
      if (inG.length && Math.min(...inG.map((s) => Math.abs(s.root - midi))) <= 4) pool = inG;
    }
    let bestD = Infinity;
    let root = null;
    for (const s of pool) {
      const d = Math.abs(s.root - midi) + (s.root < midi ? 0.01 : 0);
      if (d < bestD) [bestD, root] = [d, s.root];
    }
    const atRoot = pool.filter((s) => Math.abs(s.root - root) < 0.5);
    const s = pickRR(pickLayer(atRoot, vel), ev, 1);
    const semis = midi - s.root + Number(ev.params?.tune ?? 0) / 100;
    if (Math.abs(semis) > 5) warnOnce(`shift:${set.id}:${midi}`, `${set.id} midi ${midi} 距最近采样根音 ${semis.toFixed(1)} 半音，变调过大（音域约 ${set.range?.join('–')}）`);
    const step = 2 ** (semis / 12);
    const natural = Math.floor((s.len - 1) / step);
    const damp = ev.params?.damp != null ? Number(ev.params.damp) : null;
    let rel = Number(ev.params?.release ?? set.release ?? 0.3);
    if (set.role === 'piano' || base?.role === 'piano') rel *= clamp(1 + (60 - midi) / 40, 0.5, 1.8);
    let n;
    let releaseAt = Infinity;
    if (play === 'ring' && damp == null) {
      n = natural;
    } else {
      releaseAt = damp ?? dur;
      n = Math.round((releaseAt + rel) * SR);
      if (play !== 'sustain') n = Math.min(n, natural);
    }
    let src = resampled(set.id, s, step, play === 'sustain' ? Math.min(n, natural) : n);
    if (play === 'sustain' && n > src[0].length) src = loopExtend(src, n);
    const attack = Number(ev.params?.attack ?? set.attack ?? base?.attack ?? 0);
    const lpf = Number(ev.params?.lpf ?? lpfDefault);
    return finish(src, Math.min(n, src[0].length), ev, { attack, releaseAt, release: rel, lpf });
  };
}

function makePerc(set, base, samples) {
  const artics = [...new Set(samples.map((s) => s.artic))];
  const defArtic = set.defaultArtic ?? base?.defaultArtic ?? artics[0];
  const lpfDefault = set.lpf ?? base?.lpf ?? 0;
  return (ev) => {
    let artic = ev.params?.variant ?? defArtic;
    if (!artics.includes(artic)) {
      warnOnce(`artic:${set.id}:${artic}`, `${set.id} 没有 variant "${artic}"（可选：${artics.join(' / ')}），改用 ${defArtic}`);
      artic = defArtic;
    }
    const list = samples.filter((s) => s.artic === artic);
    const vel = clamp(ev.vel ?? 0.8, 0, 1);
    const s = pickRR(pickLayer(list, vel), ev, 2);
    const step = 2 ** (Number(ev.params?.tune ?? 0) / 1200);
    const n = Math.floor((s.len - 1) / step);
    const src = resampled(set.id, s, step, n);
    const choke = (set.chokeOnDur ?? base?.chokeOnDur) && ev.dur != null ? ev.dur : Infinity;
    return finish(src, src[0].length, ev, { lpf: Number(ev.params?.lpf ?? lpfDefault), choke });
  };
}

function makeSwell(set, samples) {
  return (ev) => {
    const dur = Math.max(0.3, ev.dur ?? 2);
    let s = samples[0];
    for (const x of samples) if (Math.abs(x.peakPos / SR - dur) < Math.abs(s.peakPos / SR - dur)) s = x;
    const step = clamp(s.peakPos / SR / dur, 0.8, 1.25);
    const src = resampled(set.id, s, step, Math.floor((s.len - 1) / step));
    const pk = Math.round(s.peakPos / step);
    const target = Math.round(dur * SR);
    const shift = target - pk;
    const total = src[0].length + shift;
    const chs = src.map((c) => {
      const o = new Float32Array(Math.max(1, total));
      if (shift >= 0) o.set(c, shift);
      else o.set(c.subarray(-shift));
      if (shift < 0) {
        const fi = Math.round(0.15 * SR);
        for (let i = 0; i < fi && i < o.length; i++) o[i] *= i / fi;
      }
      return o;
    });
    return finish(chs, chs[0].length, ev, { lpf: Number(ev.params?.lpf ?? 0) });
  };
}

function makeReverse(set, pianoSamples) {
  return (ev) => {
    const dur = Math.max(0.2, ev.dur ?? 2);
    const notes = ev.midi != null ? [ev.midi] : [50, 57, 62, 66];
    const n = Math.round(dur * SR);
    const accL = new Float32Array(n);
    const accR = new Float32Array(n);
    const vel = clamp(ev.vel ?? 0.8, 0, 1);
    for (const midi of notes) {
      let root = null;
      let bd = Infinity;
      for (const s of pianoSamples) if (Math.abs(s.root - midi) < bd) [bd, root] = [Math.abs(s.root - midi), s.root];
      const s = pickRR(pickLayer(pianoSamples.filter((x) => x.root === root), Math.max(0.6, vel)), { ...ev, midi }, 3);
      const step = 2 ** ((midi - s.root) / 12);
      const src = resampled('piano.osiris', s, step, n);
      const m = src[0].length;
      for (let i = 0; i < Math.min(n, m); i++) {
        const j = n - 1 - i;
        accL[j] += src[0][i] / notes.length ** 0.5;
        accR[j] += (src[1] ?? src[0])[i] / notes.length ** 0.5;
      }
    }
    // 反向后开头是原尾音，做指数淡入；结尾（原起音）只留 3 ms 防爆音
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const e = k ** 1.6;
      accL[i] *= e;
      accR[i] *= e;
    }
    return finish([accL, accR], n, ev, { lpf: Number(ev.params?.lpf ?? 0) });
  };
}

function makeSlices(set, samples) {
  return (ev) => {
    const dur = ev.dur ?? 0.3;
    const ranked = [...samples].sort((a, b) => Math.abs(a.len / SR - dur) - Math.abs(b.len / SR - dur));
    const pool = ranked.slice(0, Math.min(4, ranked.length));
    const s = pickRR(pool, ev, 4);
    const src = resampled(set.id, s, 1, s.len - 1);
    return finish(src, src[0].length, ev, { lpf: Number(ev.params?.lpf ?? 0) });
  };
}

const loadedSets = new Map();
function getSet(id, manifest) {
  if (loadedSets.has(id)) return loadedSets.get(id);
  const set = setById(id);
  if (!set) throw new Error(`未知音色集合 ${id}`);
  const base = set.kind === 'derived' ? getSet(set.from, manifest) : null;
  const data = base ? base.data : prepSet(set, manifest);
  let fn;
  if (set.reverse) fn = makeReverse(set, data.samples);
  else if (set.swell) fn = makeSwell(set, data.samples);
  else if (set.kind === 'slices') fn = makeSlices(set, data.samples);
  else if ((base?.set.kind ?? set.kind) === 'pitched') fn = makePitched({ ...base?.set, ...set, id: base ? base.set.id : set.id, role: set.role }, base?.set, data.samples);
  else fn = makePerc({ ...base?.set, ...set, id: base ? base.set.id : set.id }, base?.set, data.samples);
  const roots = data.samples.map((s) => s.root).filter((r) => r != null);
  const src = SOURCES[set.source];
  const info = {
    variant: set.variant,
    range: set.range ?? (roots.length ? [Math.floor(Math.min(...roots)) - 3, Math.ceil(Math.max(...roots)) + 3] : undefined),
    tail: set.tail ?? 1,
    source: `${src.name} — ${set.desc.split('，')[0]}`,
    license: src.license,
    desc: set.desc,
  };
  if (set.kind === 'perc' || base?.set.kind === 'perc') info.variants = [...new Set(data.samples.map((s) => s.artic))];
  const entry = { set, data, fn, info };
  loadedSets.set(id, entry);
  return entry;
}

/**
 * 加载音色。opts.variant 指定角色的音色（缺省用默认）；opts.roles 可只加载部分角色（缺省全部）。
 * 某角色样本缺失时打印警告并保留静音占位，不抛错。
 */
export async function loadInstruments(opts = {}) {
  const manifest = readManifest();
  const roles = opts.roles ?? ROLES;
  for (const role of roles) {
    const variant = opts.variant?.[role] ?? VARIANTS[role][0];
    const set = SETS.find((s) => s.role === role && s.variant === variant);
    if (!set) {
      console.warn(`[instruments] ${role} 没有音色 "${variant}"（可选：${VARIANTS[role].join(' / ')}）`);
      continue;
    }
    try {
      const e = getSet(set.id, manifest);
      INSTRUMENTS[role] = e.fn;
      INSTRUMENT_INFO[role] = e.info;
    } catch (err) {
      INSTRUMENTS[role] = silent(role, err.message);
      INSTRUMENT_INFO[role] = { tail: 1, source: 'missing', license: '-', desc: err.message };
      console.warn(`[instruments] ${role}: ${err.message}`);
    }
  }
}

/** 直接取某个音色集合的渲染函数（试听用）：renderer('piano.felt')(ev)。 */
export function renderer(setId) {
  const e = getSet(setId, readManifest());
  return Object.assign(e.fn, { info: e.info, meta: e.data.meta });
}
