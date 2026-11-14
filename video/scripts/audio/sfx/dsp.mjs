// 音效处理与测量的公共工具：解码（借 Remotion 自带 ffmpeg）、WAV 读写、滤波、变调、淡入淡出、
// BS.1770 响度 / 真峰值、频谱测量、PNG 频谱图。只做「处理」，不产生任何振荡器音色。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const SR = 48000;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const FFMPEG = process.env.FFMPEG ?? path.join(ROOT, 'node_modules', '@remotion', `compositor-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : process.platform === 'linux' ? '-gnu' : ''}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const db = (g) => 20 * Math.log10(Math.max(1e-12, g));
export const undb = (d) => 10 ** (d / 20);

// ── 解码 / 写出 ──────────────────────────────────────
/** 解析 PCM WAV（16 / 24 / 32 bit 整数或 32 bit float），返回各声道 float。管道输出的 data 长度可能未知，读到结尾为止。 */
export const parseWav = (buf) => {
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      const start = p + 8;
      const end = size === 0xffffffff || size === 0 || start + size > buf.length ? buf.length : start + size;
      const bps = fmt.bits / 8;
      const n = Math.floor((end - start) / (bps * fmt.ch));
      const out = Array.from({ length: fmt.ch }, () => new Float32Array(n));
      const isFloat = fmt.tag === 3 || (fmt.tag === 0xfffe && fmt.bits === 32 && false);
      for (let i = 0; i < n; i++)
        for (let c = 0; c < fmt.ch; c++) {
          const o = start + (i * fmt.ch + c) * bps;
          out[c][i] = isFloat ? buf.readFloatLE(o) : bps === 2 ? buf.readInt16LE(o) / 32768 : bps === 3 ? buf.readIntLE(o, 3) / 8388608 : buf.readInt32LE(o) / 2147483648;
        }
      return { sr: fmt.sr, ch: out };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
};

/** 任意格式 → 48k 立体声 float（[L, R]）。单声道源会被复制到两个声道。 */
export const decode = (file) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'wav', '-acodec', 'pcm_s24le', '-ac', '2', '-ar', String(SR), 'pipe:1'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${file}\n${r.stderr}`);
  const { ch } = parseWav(r.stdout);
  return [ch[0], ch[1] ?? Float32Array.from(ch[0])];
};

/** 24-bit PCM 立体声 WAV（尾部轻微 TPDF 抖动不必要：24 bit 足够）。 */
export const writeWav = (file, [L, R = L]) => {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 6);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 6, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 6, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 6, 40);
  for (let i = 0; i < n; i++) {
    buf.writeIntLE(Math.round(clamp(L[i], -1, 1) * 8388607), 44 + i * 6, 3);
    buf.writeIntLE(Math.round(clamp(R[i], -1, 1) * 8388607), 47 + i * 6, 3);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
};

// ── 基础运算 ──────────────────────────────────────────
export const len = (ch) => ch[0].length;
export const map = (ch, fn) => ch.map((c, k) => fn(c, k));
export const copy = (ch) => ch.map((c) => Float32Array.from(c));
export const gain = (ch, g) => map(ch, (c) => c.map((v) => v * g));
export const peak = (ch) => {
  let m = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  return m;
};
export const toMono = ([L, R]) => L.map((v, i) => (v + R[i]) / 2);
export const stereo = (m) => [Float32Array.from(m), Float32Array.from(m)];
/** 立体声宽度：0 = 单声道，1 = 原样。 */
export const width = ([L, R], w) => {
  const outL = new Float32Array(L.length);
  const outR = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) / 2;
    const s = ((L[i] - R[i]) / 2) * w;
    outL[i] = m + s;
    outR[i] = m - s;
  }
  return [outL, outR];
};
/** 等功率声像：-1 左 … 1 右。 */
export const pan = ([L, R], p) => {
  const a = ((p + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * Math.SQRT2;
  const gr = Math.sin(a) * Math.SQRT2;
  return [L.map((v) => v * gl), R.map((v) => v * gr)];
};

export const trim = (ch, t0, t1 = Infinity) => {
  const a = Math.max(0, Math.round(t0 * SR));
  const b = Math.min(len(ch), Math.round(t1 * SR));
  return ch.map((c) => c.slice(a, b));
};
export const padTo = (ch, sec) => {
  const n = Math.round(sec * SR);
  return ch.map((c) => {
    const o = new Float32Array(Math.max(n, c.length));
    o.set(c);
    return o;
  });
};

/** 首个超过（峰值 − rel dB）的样本位置（秒）。 */
export const onset = (ch, rel = 36) => {
  const th = peak(ch) * undb(-rel);
  const n = len(ch);
  for (let i = 0; i < n; i++) if (Math.abs(ch[0][i]) > th || Math.abs(ch[1][i]) > th) return i / SR;
  return 0;
};
/** 从起振前 pre 秒开始裁（去掉素材开头的空白）。 */
export const trimStart = (ch, pre = 0.002, rel = 36) => trim(ch, Math.max(0, onset(ch, rel) - pre));
/** 尾部降到（峰值 − rel dB）之后的位置（秒）。 */
export const tailEnd = (ch, rel = 60) => {
  const th = peak(ch) * undb(-rel);
  for (let i = len(ch) - 1; i >= 0; i--) if (Math.abs(ch[0][i]) > th || Math.abs(ch[1][i]) > th) return (i + 1) / SR;
  return 0;
};

/** 1 ms 包络最大处（秒），可限定在 [t0, t1] 内找。 */
export const peakTime = (ch, t0 = 0, t1 = Infinity) => {
  const a = Math.max(0, Math.round(t0 * SR));
  const b = Math.min(len(ch), Math.round(t1 * SR));
  let bi = a;
  let bv = -1;
  for (let i = a; i < b; i++) {
    const v = Math.abs(ch[0][i]) + Math.abs(ch[1][i]);
    if (v > bv) {
      bv = v;
      bi = i;
    }
  }
  return bi / SR;
};
/**
 * 从多击录音里取一击：在 near ± search 秒内找最响处，往前找到起振（低于该峰 rel dB 的最后一点），
 * 从起振前 pre 秒裁到起振后 dur 秒。
 */
export const hitAt = (ch, near, dur, { search = 0.03, pre = 0.002, rel = 30 } = {}) => {
  const pt = peakTime(ch, near - search, near + search);
  const pi = Math.round(pt * SR);
  const th = (Math.abs(ch[0][pi]) + Math.abs(ch[1][pi])) * undb(-rel);
  let i = pi;
  while (i > 0 && pi - i < 0.03 * SR && Math.abs(ch[0][i]) + Math.abs(ch[1][i]) > th) i--;
  const on = i / SR;
  return trim(ch, Math.max(0, on - pre), on + dur);
};
/** 让最响处落在 pre 秒（打击声与画面对齐用）。 */
export const alignPeak = (ch, pre = 0.006, t0 = 0, t1 = Infinity) => trim(ch, Math.max(0, peakTime(ch, t0, t1) - pre));

/** 实测主峰音高（在 approxMidi ± 1.5 半音内找），返回 MIDI 小数。 */
export const measureMidi = (ch, approxMidi, t0 = 0.04, t1 = 0.6) => {
  const f = 440 * 2 ** ((approxMidi - 69) / 12);
  const s = onset(ch, 30);
  return hzToMidi(dominantHz(toMono(ch), s + t0, s + t1, f * 2 ** (-1.5 / 12), f * 2 ** (1.5 / 12)));
};
/** 精确调到目标音（12 平均律，A4 = 440 Hz）；移调超过 ±3.5 半音视为选错样本。 */
export const tuneTo = (ch, approxMidi, targetMidi) => {
  const m = measureMidi(ch, approxMidi);
  const shift = targetMidi - m;
  if (Math.abs(shift) > 3.5) throw new Error(`tuneTo: shift ${shift.toFixed(2)} too large (measured ${midiName(m)})`);
  return { ch: pitch(ch, shift), measured: m, shift };
};

/** 淡入（线性）+ 淡出（余弦平方）。fadeOut 从 end − out 处开始。 */
export const fade = (ch, inSec = 0.001, outSec = 0.02) => {
  const n = len(ch);
  const a = Math.max(1, Math.round(inSec * SR));
  const b = Math.max(1, Math.round(outSec * SR));
  return ch.map((c) =>
    c.map((v, i) => {
      let g = 1;
      if (i < a) g *= i / a;
      const j = n - 1 - i;
      if (j < b) g *= Math.sin(((j / b) * Math.PI) / 2) ** 2;
      return v * g;
    }),
  );
};
/** 指数尾：从 t0 秒起以 tau 秒时间常数额外衰减（收紧过长的余音）。 */
export const tighten = (ch, t0, tau) =>
  ch.map((c) => c.map((v, i) => (i / SR < t0 ? v : v * Math.exp(-(i / SR - t0) / tau))));

/** 叠层：layers = [{ ch, at: 秒, g: 线性增益 }]。 */
export const mix = (layers) => {
  const n = Math.max(...layers.map((l) => Math.round((l.at ?? 0) * SR) + len(l.ch)));
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const { ch, at = 0, g = 1 } of layers) {
    const o = Math.round(at * SR);
    for (let k = 0; k < 2; k++) for (let i = 0; i < ch[k].length; i++) out[k][o + i] += ch[k][i] * g;
  }
  return out;
};

export const reverse = (ch) => ch.map((c) => Float32Array.from(c).reverse());

// ── 滤波（RBJ biquad，因果） ─────────────────────────
const biquadCoef = (type, f, q = 0.707, gainDb = 0) => {
  const w = (2 * Math.PI * f) / SR;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const A = 10 ** (gainDb / 40);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lp':
      [b0, b1, b2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'hp':
      [b0, b1, b2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'peak':
      [b0, b1, b2] = [1 + alpha * A, -2 * cw, 1 - alpha * A];
      [a0, a1, a2] = [1 + alpha / A, -2 * cw, 1 - alpha / A];
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2] = [A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s)];
      [a0, a1, a2] = [A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s];
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2] = [A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s)];
      [a0, a1, a2] = [A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s];
      break;
    }
    default:
      throw new Error(type);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
};
const runBiquad = (c, [b0, b1, b2, a1, a2]) => {
  const o = new Float32Array(c.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    o[i] = y;
  }
  return o;
};
/** EQ 链：[['hp', 120], ['peak', 3000, 1.2, -3], ['highshelf', 8000, 0.7, -4], ['lp', 12000]]。 */
export const eq = (ch, chain) => {
  let out = ch;
  for (const [type, f, q, g] of chain) {
    const coef = biquadCoef(type, f, q ?? 0.707, g ?? 0);
    out = out.map((c) => runBiquad(c, coef));
  }
  return out;
};

// ── 变调（窗化 sinc 重采样：音高与时长一起变，适合打击类一次性样本） ─────
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/** 升 / 降 semis 个半音（可带小数）。 */
export const pitch = (ch, semis) => {
  if (Math.abs(semis) < 1e-6) return copy(ch);
  const ratio = 2 ** (semis / 12);
  const cut = Math.min(1, 1 / ratio) * 0.97;
  const half = 24;
  return ch.map((c) => {
    const n = Math.floor(c.length / ratio);
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const k0 = Math.floor(pos);
      let acc = 0;
      for (let k = k0 - half + 1; k <= k0 + half; k++) {
        if (k < 0 || k >= c.length) continue;
        const d = pos - k;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half);
        acc += c[k] * cut * sinc(cut * d) * w;
      }
      o[i] = acc;
    }
    return o;
  });
};

// ── 响度（ITU-R BS.1770-4，48 kHz K 加权） ─────────────
const K1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
const K2 = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621];
const kWeight = (ch) => ch.map((c) => runBiquad(runBiquad(c, K1), K2));
const blockLoudness = (kw, win, hop) => {
  const n = len(kw);
  const w = Math.round(win * SR);
  const h = Math.round(hop * SR);
  const sq = kw.map((c) => {
    const s = new Float64Array(c.length + 1);
    for (let i = 0; i < c.length; i++) s[i + 1] = s[i] + c[i] * c[i];
    return s;
  });
  const out = [];
  for (let a = 0; a + w <= Math.max(n, w); a += h) {
    const b = Math.min(n, a + w);
    let z = 0;
    for (const s of sq) z += (s[b] - s[Math.min(a, n)]) / w;
    out.push(z);
  }
  return out;
};
const lufs = (z) => -0.691 + 10 * Math.log10(Math.max(1e-20, z));
/** 整段积分响度（LUFS），带 −70 绝对门限与 −10 LU 相对门限。 */
export const integrated = (ch) => {
  const z = blockLoudness(kWeight(ch), 0.4, 0.1).filter((v) => lufs(v) > -70);
  if (!z.length) return -Infinity;
  const rel = lufs(z.reduce((a, b) => a + b, 0) / z.length) - 10;
  const g = z.filter((v) => lufs(v) > rel);
  return lufs(g.reduce((a, b) => a + b, 0) / g.length);
};
/** 最大瞬时响度（400 ms 窗，10 ms 步进）：短音效的「听感音量」。 */
export const momentaryMax = (ch) => Math.max(...blockLoudness(kWeight(ch), 0.4, 0.01).map(lufs));
/** 「事件响度」：100 ms 窗的最大 K 加权响度。短促音效按它对齐，比 400 ms 瞬时响度更接近听感。 */
export const eventLoudness = (ch, win = 0.1) => Math.max(...blockLoudness(kWeight(ch), win, 0.005).map(lufs));
/** 最大短期响度（3 s 窗）。 */
export const shortTermMax = (ch) => Math.max(...blockLoudness(kWeight(ch), 3, 0.1).map(lufs));
/** 真峰值（4× 过采样，dBTP）。 */
export const truePeak = (ch) => {
  const taps = 12;
  const phases = [0.25, 0.5, 0.75].map((f) =>
    Array.from({ length: taps * 2 }, (_, j) => {
      const d = j - taps + 1 - f;
      return sinc(d) * (0.5 + 0.5 * Math.cos((Math.PI * d) / taps));
    }),
  );
  let m = 0;
  for (const c of ch) {
    for (let i = 0; i < c.length; i++) {
      m = Math.max(m, Math.abs(c[i]));
      for (const h of phases) {
        let acc = 0;
        for (let j = 0; j < h.length; j++) {
          const k = i + j - taps + 1;
          if (k >= 0 && k < c.length) acc += c[k] * h[j];
        }
        m = Math.max(m, Math.abs(acc));
      }
    }
  }
  return db(m);
};

// ── 频谱 ─────────────────────────────────────────────
export const fft = (re, im) => {
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
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let s = 0; s < n; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = s + k;
        const b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
};
/** 一段（t0..t1 秒）单声道的幅度谱，size 点补零。 */
export const spectrum = (mono, t0 = 0, t1 = Infinity, size = 1 << 16) => {
  const a = Math.round(t0 * SR);
  const b = Math.min(mono.length, Math.round(t1 * SR), a + size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const m = b - a;
  for (let i = 0; i < m; i++) re[i] = mono[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, m - 1)));
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, hz: SR / size };
};
/** 主峰频率（lo..hi Hz，抛物线插值）。 */
export const dominantHz = (mono, t0, t1, lo = 80, hi = 8000) => {
  const { mag, hz } = spectrum(mono, t0, t1);
  let bi = Math.ceil(lo / hz);
  for (let i = bi; i < Math.min(mag.length - 1, hi / hz); i++) if (mag[i] > mag[bi]) bi = i;
  const [y0, y1, y2] = [mag[bi - 1], mag[bi], mag[bi + 1]].map((v) => Math.log(v + 1e-12));
  const d = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
  return (bi + (Number.isFinite(d) ? d : 0)) * hz;
};
export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m) => {
  const r = Math.round(m);
  const c = Math.round((m - r) * 100);
  return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}${c < 0 ? '−' : '+'}${Math.abs(c)}c`;
};

/** 常用描述量：时长、起振、−20 / −40 dB 衰减时刻、频谱质心、各频段能量占比、平坦度。 */
export const describe = (ch) => {
  const mono = toMono(ch);
  const n = mono.length;
  const pk = peak(ch);
  let pi = 0;
  for (let i = 0; i < n; i++) if (Math.abs(mono[i]) > Math.abs(mono[pi])) pi = i;
  const env = (rel) => {
    const th = pk * undb(-rel);
    let last = pi;
    for (let i = pi; i < n; i++) if (Math.abs(ch[0][i]) > th || Math.abs(ch[1][i]) > th) last = i;
    return last / SR;
  };
  const t0 = onset(ch, 40);
  const { mag, hz } = spectrum(mono, t0, t0 + 1.36);
  let tot = 0, cen = 0, logSum = 0, cnt = 0;
  const bands = [0, 0, 0, 0, 0, 0];
  const edges = [150, 500, 2000, 5000, 10000];
  for (let i = 1; i < mag.length; i++) {
    const f = i * hz;
    if (f > 20000) break;
    const p = mag[i] * mag[i];
    tot += p;
    cen += p * f;
    logSum += Math.log(p + 1e-30);
    cnt++;
    let b = 0;
    while (b < edges.length && f >= edges[b]) b++;
    bands[b] += p;
  }
  const flat = Math.exp(logSum / cnt) / (tot / cnt);
  return {
    dur: n / SR,
    onset: t0,
    attack: pi / SR - t0,
    d20: env(20) - t0,
    d40: env(40) - t0,
    peakDb: db(pk),
    centroid: cen / tot,
    bands: bands.map((b) => b / tot),
    flatness: flat,
    momentary: momentaryMax(ch),
  };
};

// ── PNG 频谱图（只用于人工检查） ─────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export const writePng = (file, w, h, rgb) => {
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const lenB = Buffer.alloc(4);
    lenB.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([lenB, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};

// 3×5 数字点阵，给图上的行编号
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
const drawNum = (img, w, x0, y0, num, scale = 2) => {
  [...String(num)].forEach((d, k) => {
    const g = DIGITS[+d];
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++)
        if (g[r * 3 + c] === '1')
          for (let yy = 0; yy < scale; yy++)
            for (let xx = 0; xx < scale; xx++) {
              const p = ((y0 + r * scale + yy) * w + x0 + (k * 4 + c) * scale + xx) * 3;
              img[p] = 255;
              img[p + 1] = 220;
              img[p + 2] = 0;
            }
  });
};

/**
 * 多行频谱图：每行一个样本，左侧编号，上半为波形包络（dB），下半为对数频率频谱图（50 Hz–20 kHz）。
 * secs = 每行显示的时长（秒）。
 */
export const spectroSheet = (file, items, { secs = 1, colW = 900, rowH = 120 } = {}) => {
  const labelW = 40;
  const w = labelW + colW;
  const h = rowH * items.length;
  const img = new Uint8Array(w * h * 3);
  const N = 2048;
  const fLo = 50, fHi = 20000;
  items.forEach((ch, row) => {
    const mono = toMono(ch);
    const y0 = row * rowH;
    drawNum(img, w, 6, y0 + 6, row);
    const envH = Math.round(rowH * 0.3);
    const specH = rowH - envH - 2;
    for (let x = 0; x < colW; x++) {
      const t = (x / colW) * secs;
      const c = Math.round(t * SR);
      // 包络：该列内的峰值，dB 映射 −60..0
      let m = 0;
      const span = Math.max(1, Math.round((secs * SR) / colW));
      for (let i = c; i < Math.min(mono.length, c + span); i++) m = Math.max(m, Math.abs(mono[i]));
      const hh = Math.round(clamp((db(m) + 60) / 60, 0, 1) * envH);
      for (let y = 0; y < hh; y++) {
        const p = ((y0 + envH - 1 - y) * w + labelW + x) * 3;
        img[p] = 90;
        img[p + 1] = 200;
        img[p + 2] = 255;
      }
      if (c >= mono.length) continue;
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const k = c - N / 2 + i;
        re[i] = k >= 0 && k < mono.length ? mono[k] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))) : 0;
      }
      fft(re, im);
      for (let y = 0; y < specH; y++) {
        const f = fLo * (fHi / fLo) ** (y / (specH - 1));
        const bin = Math.round((f / SR) * N);
        const mag = Math.hypot(re[bin], im[bin]) / (N / 4);
        const v = clamp((db(mag) + 90) / 80, 0, 1);
        const p = ((y0 + rowH - 1 - y) * w + labelW + x) * 3;
        img[p] = Math.round(255 * Math.min(1, v * 1.6));
        img[p + 1] = Math.round(255 * v * v);
        img[p + 2] = Math.round(255 * (v < 0.4 ? v * 1.5 : 0.6 - (v - 0.4)));
      }
    }
    // 分隔线 + 1 kHz / 5 kHz 刻度
    for (let x = 0; x < w; x++) {
      const p = ((y0 + rowH - 1) * w + x) * 3;
      img[p] = img[p + 1] = img[p + 2] = 60;
    }
    for (const fm of [1000, 5000]) {
      const y = Math.round((Math.log(fm / fLo) / Math.log(fHi / fLo)) * (specH - 1));
      for (let x = labelW - 8; x < labelW; x++) {
        const p = ((y0 + rowH - 1 - y) * w + x) * 3;
        img[p] = img[p + 1] = img[p + 2] = 200;
      }
    }
  });
  writePng(file, w, h, img);
};
