// 采样器用的底层工具：WAV 读写、窗化 sinc / Hermite 重采样、YIN 音高检测、滤波、PNG 频谱图。
// 只依赖 Node 内置模块（node:fs / node:zlib / node:crypto）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ── WAV ──────────────────────────────────────────────
/** 解析 PCM / IEEE float / EXTENSIBLE WAV，返回每声道 Float32Array。 */
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    let size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (body + size > buf.length) size = buf.length - body;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sr = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sr, bits };
    } else if (id === 'data') {
      data = { off: body, size };
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  const { format, channels, sr, bits } = fmt;
  const bps = bits / 8;
  const n = Math.floor(data.size / (bps * channels));
  const ch = Array.from({ length: channels }, () => new Float32Array(n));
  let o = data.off;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (format === 3) v = bits === 64 ? buf.readDoubleLE(o) : buf.readFloatLE(o);
      else if (bits === 16) v = buf.readInt16LE(o) / 32768;
      else if (bits === 24) v = buf.readIntLE(o, 3) / 8388608;
      else if (bits === 32) v = buf.readInt32LE(o) / 2147483648;
      else if (bits === 8) v = (buf[o] - 128) / 128;
      else throw new Error(`unsupported WAV bits ${bits}`);
      ch[c][i] = v;
      o += bps;
    }
  }
  return { sr, channels: ch };
}

/** 写 24-bit PCM 立体声 WAV。 */
export function writeWav(file, L, R = L, sr = 48000) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 6);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 6, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 6, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 6, 40);
  const q = (v) => Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)));
  for (let i = 0, o = 44; i < n; i++, o += 6) {
    buf.writeIntLE(q(L[i]), o, 3);
    buf.writeIntLE(q(R[i]), o + 3, 3);
  }
  fs.writeFileSync(file, buf);
}

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── 重采样 ───────────────────────────────────────────
const besselI0 = (x) => {
  let s = 1;
  let t = 1;
  for (let k = 1; k < 30; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
  }
  return s;
};

const sincTables = new Map();
/** Kaiser 窗化 sinc 多相表：half 个零交叉，phases 个相位，截止 fc（相对输入奈奎斯特）。 */
function sincTable(half, phases, fc) {
  const key = `${half}|${phases}|${fc.toFixed(5)}`;
  let t = sincTables.get(key);
  if (t) return t;
  const taps = half * 2;
  const beta = 9;
  const i0b = besselI0(beta);
  t = new Float32Array((phases + 1) * taps);
  for (let ph = 0; ph <= phases; ph++) {
    const frac = ph / phases;
    for (let k = 0; k < taps; k++) {
      const x = k - half + 1 - frac; // 距离（输入样本）
      const w = Math.abs(x) >= half ? 0 : besselI0(beta * Math.sqrt(1 - (x / half) ** 2)) / i0b;
      const s = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
      t[ph * taps + k] = fc * s * w;
    }
  }
  sincTables.set(key, t);
  return t;
}

/**
 * 窗化 sinc 重采样。step = 每个输出样本前进的输入样本数（>1 为升调/降采样）。
 * src 可为 Float32Array 或 Int16Array（配合 scale）。从 start（输入样本，可为小数）开始取 outLen 个。
 */
export function resampleSinc(src, step, outLen, { scale = 1, start = 0, half = 16 } = {}) {
  const fc = Math.min(1, 1 / step) * 0.94;
  const h = Math.ceil(half / Math.min(1, fc / 0.94));
  const phases = 256;
  const taps = h * 2;
  const tab = sincTable(h, phases, fc);
  const out = new Float32Array(outLen);
  const n = src.length;
  let pos = start;
  for (let i = 0; i < outLen; i++, pos += step) {
    const ip = Math.floor(pos);
    const fr = pos - ip;
    const pf = fr * phases;
    const p0 = Math.floor(pf);
    const a = pf - p0;
    const r0 = p0 * taps;
    const r1 = r0 + taps;
    let acc = 0;
    const base = ip - h + 1;
    if (base >= 0 && base + taps <= n) {
      for (let k = 0; k < taps; k++) acc += src[base + k] * (tab[r0 + k] + a * (tab[r1 + k] - tab[r0 + k]));
    } else {
      for (let k = 0; k < taps; k++) {
        const j = base + k;
        if (j < 0 || j >= n) continue;
        acc += src[j] * (tab[r0 + k] + a * (tab[r1 + k] - tab[r0 + k]));
      }
    }
    out[i] = acc * scale;
    if (ip - h > n) break;
  }
  return out;
}

/** 4 点 3 阶 Hermite 插值重采样（小幅变调用，快）。 */
export function resampleHermite(src, step, outLen, { scale = 1, start = 0 } = {}) {
  const out = new Float32Array(outLen);
  const n = src.length;
  let pos = start;
  for (let i = 0; i < outLen; i++, pos += step) {
    const ip = Math.floor(pos);
    if (ip >= n) break;
    const t = pos - ip;
    const xm1 = ip >= 1 ? src[ip - 1] : 0;
    const x0 = src[ip];
    const x1 = ip + 1 < n ? src[ip + 1] : 0;
    const x2 = ip + 2 < n ? src[ip + 2] : 0;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[i] = (((c3 * t + c2) * t + c1) * t + x0) * scale;
  }
  return out;
}

// ── 分析 ─────────────────────────────────────────────
/** YIN 基频检测，返回 { f0, conf }（conf 越接近 1 越可信）。 */
export function yin(x, sr, { fmin = 25, fmax = 4200, start = 0, len = 0 } = {}) {
  const maxLag = Math.min(Math.floor(sr / fmin), Math.floor((len || x.length - start) / 2));
  const minLag = Math.max(2, Math.floor(sr / fmax));
  const W = Math.min(len || 4096, x.length - start - maxLag);
  if (W < 256 || maxLag <= minLag) return { f0: 0, conf: 0 };
  const d = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const v = x[start + i] - x[start + i + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  let run = 0;
  const cm = new Float64Array(maxLag + 1);
  cm[0] = 1;
  for (let tau = 1; tau <= maxLag; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let best = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cm[tau] < 0.15) {
      while (tau + 1 <= maxLag && cm[tau + 1] < cm[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let m = Infinity;
    for (let tau = minLag; tau <= maxLag; tau++) if (cm[tau] < m) [m, best] = [cm[tau], tau];
  }
  let tb = best;
  if (best > 1 && best < maxLag) {
    const a = cm[best - 1];
    const b = cm[best];
    const c = cm[best + 1];
    const den = a - 2 * b + c;
    if (den !== 0) tb = best + (0.5 * (a - c)) / den;
  }
  return { f0: sr / tb, conf: 1 - cm[best] };
}

export const ftom = (f) => 69 + 12 * Math.log2(f / 440);
export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** RBJ 双二阶低通/高通，原地处理。 */
export function biquad(x, sr, type, fc, q = 0.707) {
  const w = (2 * Math.PI * Math.min(fc, sr * 0.45)) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lp') [b0, b1, b2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2];
  else [b0, b1, b2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2];
  const a0 = 1 + al;
  const a1 = -2 * cs;
  const a2 = 1 - al;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** 实数 FFT（原地，基 2），re/im 长度为 2 的幂。 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ── PNG 频谱图 ───────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 写 RGB PNG。rgb: Uint8Array(w*h*3)。 */
export function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const heat = (v) => {
  // 0..1 → 黑-紫-橙-黄-白
  const stops = [
    [0, 0, 0, 0],
    [0.25, 40, 10, 90],
    [0.5, 170, 30, 90],
    [0.75, 250, 140, 30],
    [1, 255, 250, 210],
  ];
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, r0, g0, b0] = stops[i - 1];
      const [p1, r1, g1, b1] = stops[i];
      const k = (v - p0) / (p1 - p0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  return [255, 250, 210];
};

/** 对数频率轴频谱图（上半 L+R 频谱，下半波形包络），写 PNG。 */
export function spectrogramPng(file, L, R, sr, { width = 1200, height = 420 } = {}) {
  const specH = Math.round(height * 0.78);
  const waveH = height - specH;
  const N = 4096;
  const rgb = new Uint8Array(width * height * 3);
  const n = L.length;
  const hop = Math.max(1, Math.floor(n / width));
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const fLo = 30;
  const fHi = sr / 2;
  for (let x = 0; x < width; x++) {
    const c = x * hop + (hop >> 1) - N / 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const j = c + i;
      if (j >= 0 && j < n) re[i] = 0.5 * (L[j] + R[j]) * win[i];
    }
    fft(re, im);
    for (let y = 0; y < specH; y++) {
      const f = fLo * (fHi / fLo) ** (1 - y / (specH - 1));
      const b = Math.min(N / 2 - 1, Math.round((f / sr) * N));
      const mag = Math.hypot(re[b], im[b]) / (N / 4);
      const db = 20 * Math.log10(mag + 1e-12);
      const [r, g, bl] = heat((db + 110) / 100);
      const o = (y * width + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = bl;
    }
    let pk = 0;
    for (let i = x * hop; i < Math.min(n, (x + 1) * hop); i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const hpx = Math.round(Math.min(1, pk) * (waveH - 2));
    for (let y = 0; y < waveH; y++) {
      const o = ((specH + y) * width + x) * 3;
      const on = waveH - 1 - y <= hpx;
      const clip = pk >= 0.999;
      rgb[o] = on ? (clip ? 255 : 90) : 18;
      rgb[o + 1] = on ? (clip ? 40 : 200) : 18;
      rgb[o + 2] = on ? (clip ? 40 : 255) : 24;
    }
  }
  // 频率刻度线：100 Hz / 1 kHz / 10 kHz
  for (const f of [100, 1000, 10000]) {
    const y = Math.round((1 - Math.log(f / fLo) / Math.log(fHi / fLo)) * (specH - 1));
    for (let x = 0; x < width; x += 4) {
      const o = (y * width + x) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = 200;
    }
  }
  writePng(file, width, height, rgb);
}

/** 质检：峰值、DC、开头静音、爆音（相邻样本突变）、削波样本数。 */
export function qcStats(L, R, sr) {
  let peak = 0;
  let sumL = 0;
  let sumR = 0;
  let clip = 0;
  let first = -1;
  let maxJump = 0;
  let sq = 0;
  for (let i = 0; i < L.length; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    const m = Math.max(a, b);
    if (m > peak) peak = m;
    if (m >= 0.999) clip++;
    sumL += L[i];
    sumR += R[i];
    sq += L[i] * L[i] + R[i] * R[i];
  }
  // 开头静音：第一个超过（开头 0.5 秒内峰值 -30 dB）的样本
  let headPk = 0;
  for (let i = 0; i < Math.min(L.length, sr / 2); i++) headPk = Math.max(headPk, Math.abs(L[i]), Math.abs(R[i]));
  for (let i = 0; i < L.length; i++) if (Math.max(Math.abs(L[i]), Math.abs(R[i])) > headPk * 0.0316) { first = i; break; }
  // 爆音：二阶差分相对局部幅度异常大的点
  for (let i = 2; i < L.length; i++) {
    const d2 = Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]);
    if (d2 > maxJump) maxJump = d2;
  }
  return {
    peak,
    peakDb: 20 * Math.log10(peak + 1e-12),
    rmsDb: 10 * Math.log10(sq / (2 * L.length) + 1e-20),
    dc: Math.max(Math.abs(sumL / L.length), Math.abs(sumR / L.length)),
    leadSilenceMs: first < 0 ? Infinity : (first / sr) * 1000,
    clipSamples: clip,
    maxD2: maxJump,
  };
}
