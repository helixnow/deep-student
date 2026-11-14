/**
 * 配乐 v2 渲染引擎：采样器逐音符渲染 → 音轨自动化 → 分组总线（EQ / 自动化 / 侧链）→ 混响 →
 * 总线压缩 → 极轻磁带饱和 → 响度归一（BS.1770）→ 真峰值限制。
 *
 * 乐器：优先 scripts/audio/instruments/index.mjs（正式采样器），逐角色探测；缺失、pending、
 * 探测为静音或抛错的角色回退到 instruments-stub.mjs 并打印警告。
 * 混响：scripts/audio/ir/ 下提供 loadIR + convolve 时用卷积混响，否则用内置 8 线 FDN。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ARR from './arrangement.mjs';
import * as STUB from './instruments-stub.mjs';

export const SR = 48000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAU = Math.PI * 2;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const dbToLin = (db) => 10 ** (db / 20);
const linToDb = (v) => 20 * Math.log10(Math.max(1e-12, v));

export const ROLES = [
  'piano', 'mallet', 'bells', 'pluck', 'strings_long', 'strings_short', 'pad', 'bass',
  'kick', 'snare', 'clap', 'hat', 'shaker', 'perc_wood', 'perc_metal', 'impact', 'swell',
  'foley_paper', 'foley_pencil', 'foley_book',
];
export const BUSES = ['keys', 'strings', 'perc', 'bass', 'fx'];

/** 混音参数：总线 EQ、room 发送、侧链深度、混响、母带目标。 */
export const MIX = {
  busEq: {
    // 2.5–4 kHz 让给点击 / 打字 tick：键盘与弦乐在 3 kHz 附近轻挖 2 dB
    keys: [['hp', 80, 0.7], ['peak', 3000, 0.9, -2], ['highshelf', 9000, 0.7, -1.5]],
    strings: [['hp', 50, 0.7], ['peak', 2800, 0.8, -2]],
    perc: [['hp', 30, 0.7]],
    bass: [['hp', 28, 0.7], ['lp', 3000, 0.7]],
    fx: [['hp', 35, 0.7]],
  },
  busGain: { keys: 1, strings: 1, perc: 1, bass: 1, fx: 1 },
  roomSend: { keys: 0.18, strings: 0.08, perc: 0.14, bass: 0, fx: 0.06 },
  sidechain: { attack: 0.002, release: 0.15, depth: { bass: 0.5, keys: 0.14, strings: 0.2, fx: 0.08, reverb: 0.22 } },
  hall: { t60: 2.6, size: 1.0, damp: 5200, predelay: 0.024, wet: 0.5, hp: 180, lp: 9000 },
  room: { t60: 0.55, size: 0.38, damp: 7500, predelay: 0.006, wet: 0.42, hp: 160, lp: 11000 },
  returns: { hall: 1.0, room: 0.8 },
  glue: { thresholdDb: -22, ratio: 1.6, attack: 0.03, release: 0.25, knee: 6 },
  tape: { drive: 1.6, mix: 0.35 },
  // lufs 与 Soundtrack.tsx 的 SCORE_GAIN = 1 配套：音效各层 TIER_LUFS 是对着混音里约 −17 LUFS 的配乐校准的
  target: { preLufs: -21, lufs: -17, ceilingDbtp: -1.5 },
  preRoll: 3,
};

// ── 曲线 ───────────────────────────────────────────────────

/** [[秒, 值], …] → t ⇒ 值（段间 smoothstep）。 */
export const curve = (pts) => {
  if (!pts?.length) return () => 1;
  const P = [...pts].sort((a, b) => a[0] - b[0]);
  return (t) => {
    if (t <= P[0][0]) return P[0][1];
    for (let i = 1; i < P.length; i++) {
      if (t <= P[i][0]) {
        const [t0, v0] = P[i - 1];
        const [t1, v1] = P[i];
        const k = t1 > t0 ? clamp((t - t0) / (t1 - t0)) : 1;
        return v0 + (v1 - v0) * k * k * (3 - 2 * k);
      }
    }
    return P[P.length - 1][1];
  };
};

/** 曲线按 32 样本控制率求值、块内线性插值，得到逐样本数组。 */
const curveArray = (pts, t0, n) => {
  const f = curve(pts);
  const out = new Float32Array(n);
  const B = 32;
  let prev = f(t0);
  for (let i = 0; i < n; i += B) {
    const next = f(t0 + Math.min(n, i + B) / SR);
    const m = Math.min(B, n - i);
    for (let k = 0; k < m; k++) out[i + k] = prev + ((next - prev) * k) / m;
    prev = next;
  }
  return out;
};

// ── 滤波 ───────────────────────────────────────────────────

/** RBJ 双二阶：lp / hp / peak / lowshelf / highshelf。 */
const biquad = (type, fc, q = 0.707, gainDb = 0) => {
  const w = (TAU * Math.min(fc, SR * 0.45)) / SR;
  const cs = Math.cos(w);
  const sn = Math.sin(w);
  const alpha = sn / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') [b0, b1, b2, a0, a1, a2] = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha];
  else if (type === 'hp') [b0, b1, b2, a0, a1, a2] = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha];
  else if (type === 'peak') [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cs, 1 - alpha * A, 1 + alpha / A, -2 * cs, 1 - alpha / A];
  else {
    const sq = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf')
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 - (A - 1) * cs + sq), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - sq), A + 1 + (A - 1) * cs + sq, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - sq];
    else
      [b0, b1, b2, a0, a1, a2] = [A * (A + 1 + (A - 1) * cs + sq), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - sq), A + 1 - (A - 1) * cs + sq, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - sq];
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
};

const runBiquad = (x, c) => {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
};

const eqStereo = (buf, chain) => {
  for (const [type, fc, q, g] of chain) {
    const c = biquad(type, fc, q, g ?? 0);
    runBiquad(buf.L, c);
    runBiquad(buf.R, c);
  }
};

/** TPT 状态变量滤波，截止频率按 32 样本控制率自动化。 */
const svfAutomated = (buf, pts, mode, t0) => {
  const f = curve(pts);
  for (const x of [buf.L, buf.R]) {
    let ic1 = 0, ic2 = 0;
    let a1 = 0, a2 = 0, a3 = 0;
    const k = 1 / 0.707;
    for (let i = 0; i < x.length; i++) {
      if ((i & 31) === 0) {
        const fc = clamp(f(t0 + i / SR), 20, SR * 0.45);
        const g = Math.tan((Math.PI * fc) / SR);
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
      }
      const v0 = x[i];
      const v3 = v0 - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      x[i] = mode === 'hp' ? v0 - k * v1 - v2 : v2;
    }
  }
};

// ── 混响：8 线 FDN（卷积 IR 未就绪时的占位） ───────────────────

export const fdnReverb = (inL, inR, { t60 = 2.4, size = 1, damp = 5000, predelay = 0.02 } = {}) => {
  const n = inL.length;
  const base = [1433, 1601, 1867, 2053, 2251, 2399, 2687, 2903];
  const lens = base.map((d) => Math.max(64, Math.round(d * size)));
  const lines = lens.map((l) => new Float32Array(l));
  const idx = new Int32Array(8);
  const g = lens.map((l) => 10 ** ((-3 * l) / (t60 * SR)));
  const da = 1 - Math.exp((-TAU * damp) / SR);
  const lp = new Float64Array(8);
  const pd = Math.max(1, Math.round(predelay * SR));
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const s = 1 / Math.sqrt(8);
  const y = new Float64Array(8);
  for (let i = 0; i < n; i++) {
    const xl = i >= pd ? inL[i - pd] : 0;
    const xr = i >= pd ? inR[i - pd] : 0;
    for (let k = 0; k < 8; k++) {
      lp[k] += da * (lines[k][idx[k]] - lp[k]);
      y[k] = lp[k] * g[k];
    }
    const a0 = y[0] + y[1], a1 = y[0] - y[1], a2 = y[2] + y[3], a3 = y[2] - y[3];
    const a4 = y[4] + y[5], a5 = y[4] - y[5], a6 = y[6] + y[7], a7 = y[6] - y[7];
    const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
    const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
    const h = [b0 + b4, b1 + b5, b2 + b6, b3 + b7, b0 - b4, b1 - b5, b2 - b6, b3 - b7];
    for (let k = 0; k < 8; k++) {
      lines[k][idx[k]] = h[k] * s + (k & 1 ? xr : xl) * 0.5;
      idx[k] = idx[k] + 1 === lens[k] ? 0 : idx[k] + 1;
    }
    outL[i] = y[0] - y[2] + y[4] - y[6] + 0.5 * (y[1] - y[5]);
    outR[i] = y[1] - y[3] + y[5] - y[7] + 0.5 * (y[2] - y[6]);
  }
  return [outL, outR];
};

const rms = (L, R) => {
  let s = 0;
  for (let i = 0; i < L.length; i++) s += L[i] * L[i] + R[i] * R[i];
  return Math.sqrt(s / (2 * Math.max(1, L.length)));
};

// ── 响度（ITU-R BS.1770-4）与真峰值 ────────────────────────────

const K1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
const K2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };

/** 积分响度（LUFS）；也可返回 400ms 块的瞬时响度用于分段统计。 */
export const loudness = (L, R) => {
  const n = L.length;
  const kl = Float32Array.from(L);
  const kr = Float32Array.from(R);
  for (const x of [kl, kr]) {
    runBiquad(x, K1);
    runBiquad(x, K2);
  }
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const z = [];
  for (let s = 0; s + block <= n; s += hop) z.push((cs[s + block] - cs[s]) / block);
  const lk = (v) => -0.691 + 10 * Math.log10(Math.max(1e-20, v));
  const abs = z.filter((v) => lk(v) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((v) => lk(v) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
};

// 4× 过采样插值核（每相 12 抽头，Kaiser 窗 sinc）
const OS = 4;
const TAPS = 12;
const PHASES = (() => {
  const N = OS * TAPS;
  const bessel = (x) => {
    let s = 1, t = 1;
    for (let k = 1; k < 25; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const beta = 7;
  const h = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const m = i - (N - 1) / 2;
    const x = m / OS;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = bessel(beta * Math.sqrt(1 - ((2 * i) / (N - 1) - 1) ** 2)) / bessel(beta);
    h[i] = sinc * w;
  }
  return Array.from({ length: OS }, (_, p) => {
    const c = [];
    for (let j = 0; j < TAPS; j++) c.push(h[p + OS * j] ?? 0);
    const sum = c.reduce((a, b) => a + b, 0);
    return Float64Array.from(c.map((v) => v / sum));
  });
})();

/** 每个样本位置与其后 3 个插值点的最大绝对值（两声道取大）。 */
const truePeakEnv = (L, R) => {
  const n = L.length;
  const env = new Float32Array(n);
  const half = TAPS / 2;
  for (const x of [L, R]) {
    for (let i = 0; i < n; i++) {
      let m = Math.abs(x[i]);
      if (m > 0.05) {
        for (let p = 1; p < OS; p++) {
          const c = PHASES[p];
          let v = 0;
          for (let j = 0; j < TAPS; j++) {
            const k = i + half - j;
            if (k >= 0 && k < n) v += x[k] * c[j];
          }
          if (Math.abs(v) > m) m = Math.abs(v);
        }
      }
      if (m > env[i]) env[i] = m;
    }
  }
  return env;
};

export const truePeakDb = (L, R) => {
  const env = truePeakEnv(L, R);
  let m = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > m) m = env[i];
  return linToDb(m);
};

/** 前瞻真峰值限制：所需增益做前瞻最小值保持 → 指数释放 → 同长度滑动平均（保证峰值处增益已到位）。 */
const limiter = (L, R, ceiling, { lookahead = 0.0015, release = 0.08 } = {}) => {
  const n = L.length;
  const env = truePeakEnv(L, R);
  const W = Math.max(2, Math.round(lookahead * SR));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) req[i] = env[i] > ceiling ? ceiling / env[i] : 1;
  const held = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && req[dq[t - 1]] >= req[i]) t--;
    dq[t++] = i;
    while (dq[h] > i + W) h++;
    held[i] = req[dq[h]];
  }
  const beta = Math.exp(-1 / (release * SR));
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(held[i], 1 - (1 - g) * beta);
    held[i] = g;
  }
  let acc = W;
  let minG = 1;
  for (let i = 0; i < n; i++) {
    acc += held[i] - (i >= W ? held[i - W] : 1);
    const gg = acc / W;
    L[i] *= gg;
    R[i] *= gg;
    if (gg < minG) minG = gg;
  }
  return linToDb(minG);
};

/** 总线压缩（RMS 检测、软拐点）；返回平均 / 最大增益衰减（dB）。 */
const glue = (L, R, { thresholdDb, ratio, attack, release, knee }) => {
  const aA = Math.exp(-1 / (attack * SR));
  const aR = Math.exp(-1 / (release * SR));
  const aM = Math.exp(-1 / (0.01 * SR));
  let ms = 0, gr = 0, sum = 0, max = 0;
  const slope = 1 - 1 / ratio;
  for (let i = 0; i < L.length; i++) {
    ms = aM * ms + (1 - aM) * 0.5 * (L[i] * L[i] + R[i] * R[i]);
    const over = 10 * Math.log10(ms + 1e-12) - thresholdDb;
    const target = over <= -knee / 2 ? 0 : over >= knee / 2 ? over * slope : (slope * (over + knee / 2) ** 2) / (2 * knee);
    gr = target > gr ? aA * gr + (1 - aA) * target : aR * gr + (1 - aR) * target;
    const g = 10 ** (-gr / 20);
    L[i] *= g;
    R[i] *= g;
    sum += gr;
    if (gr > max) max = gr;
  }
  return { avg: sum / L.length, max };
};

const tape = (L, R, { drive, mix }) => {
  for (const x of [L, R]) for (let i = 0; i < x.length; i++) x[i] += mix * (Math.tanh(drive * x[i]) / drive - x[i]);
};

const scale = (L, R, g) => {
  for (let i = 0; i < L.length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
};

// ── 检查 ───────────────────────────────────────────────────

/** NaN、削波、孤立爆音（相邻样本跳变远大于局部电平）。 */
export const inspect = (L, R, t0 = 0) => {
  let nan = 0, over = 0, peak = 0;
  const pops = [];
  for (const x of [L, R]) {
    let ms = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (!Number.isFinite(v)) {
        nan++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= 1) over++;
      ms = 0.999 * ms + 0.001 * v * v;
      if (i > 0) {
        const d = Math.abs(v - x[i - 1]);
        if (d > 0.2 && d > 12 * Math.sqrt(ms) && pops.length < 20) pops.push(+(t0 + i / SR).toFixed(3));
      }
    }
  }
  return { nan, over, peakDb: +linToDb(peak).toFixed(2), pops };
};

/** 每个 HIT 前后 0.25 秒的 RMS 变化（dB）：正值 = 重音进入，负值 = 抽空。 */
export const hitReport = (L, R, t0, hits = ARR.HITS) =>
  hits.map((h) => {
    const at = h.music ?? h.q8;
    const win = (a, b) => {
      const i0 = Math.max(0, Math.round((a - t0) * SR));
      const i1 = Math.min(L.length, Math.round((b - t0) * SR));
      if (i1 - i0 < 16) return NaN;
      return linToDb(rms(L.subarray(i0, i1), R.subarray(i0, i1)));
    };
    const before = win(at - 0.25, at - 0.02);
    const after = win(at, at + 0.25);
    return { id: h.id, t: h.t, q8: h.q8, music: at, before: +before.toFixed(1), after: +after.toFixed(1), delta: +(after - before).toFixed(1) };
  });

// ── 乐器与混响加载 ───────────────────────────────────────────

const energy = (o) => {
  if (!o?.L?.length) return 0;
  let s = 0;
  for (let i = 0; i < o.L.length; i++) {
    const v = o.L[i];
    if (!Number.isFinite(v)) return -1;
    s += v * v;
  }
  return s / o.L.length;
};

export const loadInstrumentSet = async ({ stub = false, log = console.log } = {}) => {
  let mod = null;
  let why = stub ? '--stub' : '';
  if (!stub) {
    try {
      mod = await import(pathToFileURL(path.join(HERE, 'instruments', 'index.mjs')).href);
      if (typeof mod.loadInstruments === 'function') await mod.loadInstruments({ log });
      if (mod.SR && mod.SR !== SR) log(`[mix] 警告：采样器 SR=${mod.SR}，引擎按 ${SR} 处理`);
    } catch (e) {
      why = e.message;
      mod = null;
    }
  }
  if (!mod) log(`[mix] 警告：正式采样器不可用（${why}），全部角色使用占位 instruments-stub.mjs`);
  const impl = {};
  const info = {};
  const kinds = {};
  for (const role of ROLES) {
    const real = mod?.INSTRUMENTS?.[role];
    const ri = mod?.INSTRUMENT_INFO?.[role];
    let reason = '';
    if (typeof real !== 'function') reason = mod ? '缺失' : why;
    else if (/pending/i.test(String(ri?.source ?? ''))) reason = 'pending';
    else {
      try {
        const range = ri?.range ?? ARR.DEFAULT_RANGES[role];
        const midi = range ? Math.round((range[0] + range[1]) / 2) : 60;
        const e = energy(real({ t: 0, dur: 0.4, midi, vel: 0.7, seed: 0 }));
        if (e < 0) reason = '探测音含 NaN';
        else if (e < 1e-9) reason = '探测音为静音';
      } catch (e) {
        reason = `探测抛错：${e.message}`;
      }
    }
    if (!reason) {
      impl[role] = real;
      info[role] = { ...STUB.INSTRUMENT_INFO[role], ...ri };
      kinds[role] = 'samples';
    } else {
      impl[role] = STUB.INSTRUMENTS[role];
      info[role] = STUB.INSTRUMENT_INFO[role];
      kinds[role] = `stub（${reason}）`;
    }
  }
  const stubbed = ROLES.filter((r) => kinds[r] !== 'samples');
  if (mod && stubbed.length) log(`[mix] 警告：以下角色回退占位：${stubbed.map((r) => `${r}=${kinds[r]}`).join('，')}`);

  // params.variant：是该角色的另一套音色（catalog 的 variant）就换 renderer(role.variant)；否则原样交给采样器（打击乐的演奏法）
  const setVariants = (role) => (Array.isArray(mod?.VARIANTS?.[role]) ? mod.VARIANTS[role] : []);
  const alt = new Map();
  const altFor = (role, v) => {
    const key = `${role}.${v}`;
    if (!alt.has(key)) {
      let fn = null;
      try {
        fn = typeof mod?.renderer === 'function' ? mod.renderer(key) : null;
        if (fn && energy(fn({ t: 0, dur: 0.4, midi: 72, vel: 0.7, seed: 0 })) <= 1e-9) fn = null;
      } catch (e) {
        log(`[mix] 音色 ${key} 不可用（${e.message.split('\n')[0]}），用 ${role} 默认音色`);
        fn = null;
      }
      alt.set(key, fn);
    }
    return alt.get(key);
  };
  const variants = {};
  for (const tr of ARR.TRACKS) {
    if (kinds[tr.role] !== 'samples') continue;
    for (const ev of tr.events) {
      const v = ev.params?.variant;
      if (!v || v === info[tr.role]?.variant || !setVariants(tr.role).includes(v)) continue;
      const fn = altFor(tr.role, v);
      if (fn?.info?.range) ((variants[tr.role] ??= {})[v] = { range: fn.info.range });
    }
  }
  const rangeInfo = Object.fromEntries(ROLES.map((r) => [r, { range: info[r]?.range, variants: variants[r] }]));

  const failed = new Set();
  const play = (role, ev) => {
    const e0 = { ...ev, pan: 0 };
    let fn = impl[role];
    const v = ev.params?.variant;
    if (v && kinds[role] === 'samples' && setVariants(role).includes(v)) {
      if (v !== info[role]?.variant) fn = altFor(role, v) ?? fn;
      const { variant, ...rest } = ev.params;
      e0.params = rest;
    }
    try {
      const o = fn(e0);
      if (o?.L?.length) return o;
      throw new Error('空输出');
    } catch (e) {
      if (!failed.has(role)) {
        failed.add(role);
        log(`[mix] 警告：${role} 渲染出错（${e.message}），该音回退占位`);
      }
      return STUB.INSTRUMENTS[role](e0);
    }
  };
  return { play, info, rangeInfo, kinds, module: mod ? 'scripts/audio/instruments/index.mjs' : null };
};

const HALL_NAMES = ['hall', 'concert-hall', 'large-hall', 'church', 'cathedral', 'plate', 'chamber'];
const ROOM_NAMES = ['room', 'studio', 'small-room', 'booth', 'chamber', 'plate'];

/** 把 convolve 的各种可能返回形态统一成 [L, R]。 */
const asPair = (o, n) => {
  if (!o) return null;
  let L, R;
  if (Array.isArray(o)) [L, R] = o;
  else if (o.L) ({ L, R } = o);
  else if (o.left) ({ left: L, right: R } = o);
  else if (o instanceof Float32Array) L = R = o;
  if (!(L instanceof Float32Array) && !Array.isArray(L)) return null;
  R ??= L;
  const fit = (x) => (x.length === n ? Float32Array.from(x) : Float32Array.from({ length: n }, (_, i) => x[i] ?? 0));
  return [fit(L), fit(R)];
};

export const loadReverb = async ({ fdn = false, log = console.log } = {}) => {
  const viaFdn = (why) => {
    if (why) log(`[mix] 混响：${why}，使用内置 FDN 占位`);
    return {
      kind: 'fdn',
      hall: (L, R) => fdnReverb(L, R, MIX.hall),
      room: (L, R) => fdnReverb(L, R, MIX.room),
      names: { hall: 'FDN 8 线（t60 2.6s）', room: 'FDN 8 线（t60 0.55s）' },
    };
  };
  if (fdn) return viaFdn('');
  const dir = path.join(HERE, 'ir');
  if (!fs.existsSync(dir)) return viaFdn('scripts/audio/ir/ 不存在');
  const ex = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort((a, b) => (a === 'index.mjs' ? -1 : b === 'index.mjs' ? 1 : a.localeCompare(b)))) {
    try {
      const m = await import(pathToFileURL(path.join(dir, f)).href);
      for (const [k, v] of Object.entries(m)) if (!(k in ex)) ex[k] = v;
    } catch (e) {
      log(`[mix] 混响模块 ${f} 加载失败：${e.message}`);
    }
  }
  const { loadIR } = ex;
  const convolve = ex.convolve ?? ex.convolveStereo ?? ex.default;
  if (typeof loadIR !== 'function' || typeof convolve !== 'function') return viaFdn('ir/ 未导出 loadIR + convolve');
  const listed = ex.IR_NAMES ?? ex.IRS ?? (typeof ex.listIRs === 'function' ? await ex.listIRs() : null);
  const names = Array.isArray(listed) ? listed.map(String) : listed && typeof listed === 'object' ? Object.keys(listed) : [];
  const order = (prefs) => [...new Set([...prefs.filter((p) => names.includes(p)), ...names.filter((n) => prefs.some((p) => n.toLowerCase().includes(p))), ...prefs])];
  const pick = async (prefs) => {
    for (const name of order(prefs)) {
      try {
        const ir = await loadIR(name);
        if (ir) return { name, ir };
      } catch {
        /* 试下一个名字 */
      }
    }
    return null;
  };
  const hall = await pick(HALL_NAMES);
  const room = await pick(ROOM_NAMES);
  if (!hall) return viaFdn(`loadIR 找不到可用的 IR（试过 ${order(HALL_NAMES).join('/')}）`);
  const conv = (ir, preDelayMs) => async (L, R) => {
    const tries = [() => convolve(L, R, ir, { preDelayMs }), () => convolve({ L, R }, ir), () => convolve([L, R], ir)];
    for (const f of tries) {
      try {
        const p = asPair(await f(), L.length);
        if (p) return p;
      } catch {
        /* 换一种调用方式 */
      }
    }
    throw new Error('convolve 调用方式不匹配');
  };
  log(`[mix] 混响：卷积 IR（hall=${hall.name}${room ? `，room=${room.name}` : '，room=FDN'}）`);
  return {
    kind: 'ir',
    hall: conv(hall.ir, MIX.hall.predelay * 1000),
    room: room ? conv(room.ir, MIX.room.predelay * 1000) : (L, R) => fdnReverb(L, R, MIX.room),
    names: { hall: hall.name, room: room?.name ?? 'FDN' },
  };
};

// ── 渲染 ───────────────────────────────────────────────────

const stereo = (n) => ({ L: new Float32Array(n), R: new Float32Array(n) });

/**
 * 渲染整首或一段。返回 { L, R, stems?, meta }；from/to 为成片秒。
 * gains：沿用上次整首渲染的 { pre, post }，分段迭代时电平与整首一致。
 */
export const render = async ({ from = 0, to = ARR.DURATION, stems = false, stub = false, fdn = false, gains = null, log = console.log } = {}) => {
  const T0 = Date.now();
  const inst = await loadInstrumentSet({ stub, log });
  const verb = await loadReverb({ fdn, log });
  const moved = ARR.applyRanges(ARR.TRACKS, inst.rangeInfo);
  if (moved) log(`[mix] 按乐器音区折回 ${moved} 个音`);

  const start = Math.max(0, from - (from > 0 ? MIX.preRoll : 0));
  const n = Math.ceil((to - start) * SR);
  const bus = Object.fromEntries(BUSES.map((b) => [b, stereo(n)]));
  const sendHall = stereo(n);
  const sendRoom = stereo(n);
  const det = new Float32Array(n);
  let notes = 0;
  let detRef = 0;

  const ordered = [...ARR.TRACKS].sort((a, b) => Number(!!b.sidechain) - Number(!!a.sidechain));
  for (const tr of ordered) {
    const tail = inst.info[tr.role]?.tail ?? 3;
    const evs = tr.events.filter((ev) => ev.t < to && ev.t + ev.dur + tail > start);
    if (!evs.length) continue;
    const tb = stereo(n);
    for (const ev of evs) {
      const out = inst.play(tr.role, ev);
      const p = clamp(tr.pan + (ev.pan ?? 0), -1, 1);
      const a = ((p + 1) * Math.PI) / 4;
      const gl = Math.cos(a) * Math.SQRT2;
      const gr = Math.sin(a) * Math.SQRT2;
      const oL = out.L;
      const oR = out.R ?? out.L;
      const i0 = Math.round((ev.t - start) * SR);
      const s = Math.max(0, -i0);
      const e = Math.min(oL.length, n - i0);
      for (let k = s; k < e; k++) {
        const l = oL[k];
        const r = oR[k];
        if (l === l && r === r) {
          tb.L[i0 + k] += l * gl;
          tb.R[i0 + k] += r * gr;
        }
      }
      notes++;
    }
    const A = ARR.AUTOMATION.tracks[tr.id] ?? {};
    if (A.lp) svfAutomated(tb, A.lp, 'lp', start);
    if (A.hp) svfAutomated(tb, A.hp, 'hp', start);
    const g = A.gain ? curveArray(A.gain, start, n) : null;
    const sv = A.send ? curveArray(A.send, start, n) : null;
    const B = bus[tr.bus];
    const room = MIX.roomSend[tr.bus] ?? 0;
    for (let i = 0; i < n; i++) {
      const gg = tr.gain * (g ? g[i] : 1);
      const l = tb.L[i] * gg;
      const r = tb.R[i] * gg;
      B.L[i] += l;
      B.R[i] += r;
      const h = tr.reverb * (sv ? sv[i] : 1);
      sendHall.L[i] += l * h;
      sendHall.R[i] += r * h;
      sendRoom.L[i] += l * room;
      sendRoom.R[i] += r * room;
      if (tr.sidechain) det[i] += Math.abs(l) + Math.abs(r);
    }
    if (tr.sidechain && tr.role === 'kick') detRef = 0.5 * 2 * 0.62 * tr.gain;
  }
  log(`[mix] ${notes} 个音符已渲染（${((Date.now() - T0) / 1000).toFixed(1)}s）`);

  // 侧链：底鼓 / impact → 其余总线
  const sc = MIX.sidechain;
  const duck = new Float32Array(n);
  {
    const aA = Math.exp(-1 / (sc.attack * SR));
    const aR = Math.exp(-1 / (sc.release * SR));
    const ref = detRef || 0.6;
    let env = 0;
    for (let i = 0; i < n; i++) {
      const x = det[i];
      env = x > env ? aA * env + (1 - aA) * x : aR * env + (1 - aR) * x;
      duck[i] = clamp(env / ref);
    }
  }

  // 总线：EQ → 自动化 → 侧链
  for (const b of BUSES) {
    const buf = bus[b];
    eqStereo(buf, MIX.busEq[b] ?? []);
    const A = ARR.AUTOMATION.buses[b] ?? {};
    const g = A.gain ? curveArray(A.gain, start, n) : null;
    const depth = sc.depth[b] ?? 0;
    const base = MIX.busGain[b] ?? 1;
    for (let i = 0; i < n; i++) {
      const gg = base * (g ? g[i] : 1) * (1 - depth * duck[i]);
      buf.L[i] *= gg;
      buf.R[i] *= gg;
    }
  }

  // 混响：返回电平按发送电平自动配平（IR 与 FDN 换用时干湿比不变）
  const T1 = Date.now();
  const returns = {};
  for (const [name, snd, cfg] of [['hall', sendHall, MIX.hall], ['room', sendRoom, MIX.room]]) {
    const inR = rms(snd.L, snd.R);
    let [wl, wr] = await verb[name](snd.L, snd.R);
    const outR = rms(wl, wr);
    const k = outR > 1e-9 ? (cfg.wet * inR) / outR : 0;
    const w = { L: wl, R: wr };
    eqStereo(w, [['hp', cfg.hp, 0.7], ['lp', cfg.lp, 0.7]]);
    const A = curveArray(ARR.AUTOMATION.reverb[name] ?? [[0, 1]], start, n);
    const ret = MIX.returns[name] * k;
    for (let i = 0; i < n; i++) {
      const gg = ret * A[i] * (1 - sc.depth.reverb * duck[i]);
      w.L[i] *= gg;
      w.R[i] *= gg;
    }
    returns[name] = w;
  }
  log(`[mix] 混响（${verb.kind}）完成（${((Date.now() - T1) / 1000).toFixed(1)}s）`);

  // 母带
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const b of [...BUSES.map((x) => bus[x]), returns.hall, returns.room]) {
    for (let i = 0; i < n; i++) {
      L[i] += b.L[i];
      R[i] += b.R[i];
    }
  }
  eqStereo({ L, R }, [['hp', 25, 0.7]]);
  const pre = inspect(L, R, start);
  const off = Math.round((from - start) * SR);
  const view = (x) => x.subarray(off);

  const tgt = MIX.target;
  const preGain = gains?.pre ?? dbToLin(tgt.preLufs - loudness(view(L), view(R)));
  scale(L, R, preGain);
  const gr = glue(L, R, MIX.glue);
  tape(L, R, MIX.tape);
  const mg = curveArray(ARR.AUTOMATION.master.gain, start, n);
  for (let i = 0; i < n; i++) {
    L[i] *= mg[i];
    R[i] *= mg[i];
  }
  let postGain = gains?.post ?? dbToLin(tgt.lufs - loudness(view(L), view(R)));
  const ceiling = dbToLin(tgt.ceilingDbtp);
  let outL, outR, limGr, lufs;
  for (let pass = 0; pass < 3; pass++) {
    outL = Float32Array.from(view(L));
    outR = Float32Array.from(view(R));
    scale(outL, outR, postGain);
    limGr = limiter(outL, outR, ceiling);
    lufs = loudness(outL, outR);
    if (gains?.post || Math.abs(lufs - tgt.lufs) < 0.1) break;
    postGain *= dbToLin(tgt.lufs - lufs);
  }
  let tp = truePeakDb(outL, outR);
  if (tp > tgt.ceilingDbtp) {
    const g = dbToLin(tgt.ceilingDbtp - tp - 0.05);
    scale(outL, outR, g);
    tp = truePeakDb(outL, outR);
    lufs = loudness(outL, outR);
  }

  let stemOut = null;
  if (stems) {
    const k = preGain * postGain;
    stemOut = {};
    for (const b of BUSES) {
      const s = { L: Float32Array.from(view(bus[b].L)), R: Float32Array.from(view(bus[b].R)) };
      scale(s.L, s.R, k);
      stemOut[b] = s;
    }
    const rv = { L: Float32Array.from(view(returns.hall.L)), R: Float32Array.from(view(returns.hall.R)) };
    const rr = { L: view(returns.room.L), R: view(returns.room.R) };
    for (let i = 0; i < rv.L.length; i++) {
      rv.L[i] = (rv.L[i] + rr.L[i]) * k;
      rv.R[i] = (rv.R[i] + rr.R[i]) * k;
    }
    stemOut.reverb = rv;
  }

  const meta = {
    from,
    to,
    seconds: +((Date.now() - T0) / 1000).toFixed(1),
    notes,
    instruments: inst.kinds,
    instrumentModule: inst.module,
    sources: Object.fromEntries(ROLES.map((r) => [r, { source: inst.info[r]?.source, license: inst.info[r]?.license }])),
    reverb: { kind: verb.kind, ...verb.names },
    gains: { pre: preGain, post: postGain },
    glueGr: { avgDb: +gr.avg.toFixed(2), maxDb: +gr.max.toFixed(2) },
    limiterMaxGrDb: +(-limGr).toFixed(2),
    lufs: +lufs.toFixed(2),
    truePeakDb: +tp.toFixed(2),
    preMaster: pre,
    final: inspect(outL, outR, from),
  };
  return { L: outL, R: outR, stems: stemOut, meta };
};

// ── 频谱图（PNG，对数频率轴；Remotion 自带的 ffmpeg 没有 showspectrumpic） ─────

const fftInPlace = (re, im) => {
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
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
};

const CRC = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** 整首频谱图：横轴时间（每 10 秒一条细线、段落边界亮线、HIT 顶部刻度），纵轴 30 Hz–20 kHz 对数。 */
export const spectrogramPng = async (file, L, R, { t0 = 0, width = 1800, height = 640, marks = [], hits = [] } = {}) => {
  const zlib = await import('node:zlib');
  const N = 4096;
  const n = L.length;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((TAU * i) / (N - 1)));
  const fLo = 30;
  const fHi = 20000;
  const rowBin = Array.from({ length: height }, (_, y) => {
    const f = fLo * (fHi / fLo) ** (1 - y / (height - 1));
    return Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / SR)));
  });
  const img = new Uint8Array(height * (width * 3 + 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const color = (v) => {
    const k = clamp(v);
    return [Math.round(255 * clamp(1.6 * k - 0.1)), Math.round(255 * clamp(1.9 * k - 0.75)), Math.round(255 * clamp(Math.sin(Math.PI * k) * 0.8 + clamp(3 * k - 2.4)))];
  };
  for (let x = 0; x < width; x++) {
    const c = Math.round((x / (width - 1)) * (n - 1)) - N / 2;
    for (let i = 0; i < N; i++) {
      const k = c + i;
      re[i] = k >= 0 && k < n ? 0.5 * (L[k] + R[k]) * win[i] : 0;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let y = 0; y < height; y++) {
      const b = rowBin[y];
      const nb = y > 0 ? Math.max(b, rowBin[y - 1]) : b;
      let p = 0;
      for (let k = b; k <= nb; k++) p = Math.max(p, re[k] * re[k] + im[k] * im[k]);
      const db = 10 * Math.log10(p + 1e-20) - 20 * Math.log10(N / 4);
      const [r, g, bl] = color(clamp((db + 100) / 90) ** 1.6);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      img[o] = r;
      img[o + 1] = g;
      img[o + 2] = bl;
    }
  }
  const dur = n / SR;
  const vline = (t, rgb, y0 = 0, y1 = height) => {
    const x = Math.round(((t - t0) / dur) * (width - 1));
    if (x < 0 || x >= width) return;
    for (let y = y0; y < y1; y++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      img[o] = rgb[0];
      img[o + 1] = rgb[1];
      img[o + 2] = rgb[2];
    }
  };
  for (let t = Math.ceil(t0 / 10) * 10; t < t0 + dur; t += 10) vline(t, [70, 70, 70], 0, height);
  for (const t of marks) vline(t, [0, 200, 255]);
  for (const t of hits) vline(t, [255, 255, 255], 0, 18);
  for (const f of [100, 1000, 10000]) {
    const y = Math.round((1 - Math.log(f / fLo) / Math.log(fHi / fLo)) * (height - 1));
    for (let x = 0; x < width; x += 4) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      img[o] = img[o + 1] = img[o + 2] = 120;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.from(img))), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
};

// ── WAV ────────────────────────────────────────────────────

/** 16-bit PCM + TPDF 抖动（确定性）。 */
export const writeWav = (file, L, R = L) => {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  const r = ARR.mulberry(16);
  for (let i = 0; i < n; i++) {
    const dl = r() - r();
    const dr = r() - r();
    buf.writeInt16LE(clamp(Math.round(L[i] * 32767 + dl), -32768, 32767), 44 + i * 4);
    buf.writeInt16LE(clamp(Math.round(R[i] * 32767 + dr), -32768, 32767), 46 + i * 4);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
};
