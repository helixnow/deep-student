/**
 * 采样器占位：与 scripts/audio/instruments/index.mjs 同接口的简易合成（正弦 / 噪声 / 波表），
 * 只用来验证编曲时间轴与混音链路。正式采样器某个角色未就绪时，mix.mjs 按角色回退到这里。
 * 约定：单音符、从起点开始含尾音；vel=1 时峰值约 0.5；不含摆放与混响。
 */
export const SR = 48000;

const TAU = Math.PI * 2;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mulberry = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const alloc = (sec) => {
  const n = Math.max(16, Math.ceil(sec * SR));
  return { L: new Float32Array(n), R: new Float32Array(n), n };
};
/** 归一到 vel^1.5·0.5 峰值（与正式采样器的力度曲线一致），并做极轻的左右差异（让单音也有一点宽度）。 */
const finish = (b, vel, width = 0.04) => {
  let m = 1e-9;
  for (let i = 0; i < b.n; i++) m = Math.max(m, Math.abs(b.L[i]));
  const g = (0.5 * clamp(vel, 0, 1) ** 1.5) / m;
  for (let i = 0; i < b.n; i++) {
    const v = b.L[i] * g;
    b.L[i] = v * (1 + width);
    b.R[i] = v * (1 - width);
  }
  return { L: b.L, R: b.R };
};

// 带限锯齿波表（24 次谐波）
const TABLE = 4096;
const SAW = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) {
  let v = 0;
  for (let k = 1; k <= 24; k++) v += Math.sin((TAU * k * i) / TABLE) / k;
  SAW[i] = v * 0.55;
}
const saw = (ph) => {
  const x = (ph - Math.floor(ph)) * TABLE;
  const i = x | 0;
  return SAW[i] + (SAW[i + 1] - SAW[i]) * (x - i);
};

/** 加法合成的衰减音：partials = [[倍频, 幅度, 衰减率]]。 */
const additive = (ev, partials, { decayLen = 3, release = 0.25, attack = 0.002 } = {}) => {
  const f = mtof(ev.midi ?? 60);
  const hold = Math.min(ev.dur, decayLen);
  const b = alloc(hold + release);
  const ph = partials.map((_, k) => mulberry((ev.seed ?? 0) * 13 + k)() * 0.2);
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const rel = u < hold ? 1 : Math.max(0, 1 - (u - hold) / release);
    const att = u < attack ? u / attack : 1;
    let v = 0;
    for (let k = 0; k < partials.length; k++) {
      const [mult, amp, dec] = partials[k];
      const fk = f * mult;
      if (fk > SR * 0.45) continue;
      v += Math.sin(TAU * (fk * u + ph[k])) * amp * Math.exp(-u * dec);
    }
    b.L[i] = v * att * rel;
  }
  return b;
};

const piano = (ev) => {
  const m = ev.midi ?? 60;
  const d = 0.6 + Math.max(0, m - 40) * 0.06;
  const b = additive(ev, [[1, 1, d], [2.002, 0.45, d * 1.6], [3.006, 0.22, d * 2.4], [4.012, 0.12, d * 3.2], [5.02, 0.06, d * 4]], { decayLen: 6, release: 0.3 });
  return finish(b, ev.vel);
};
const mallet = (ev) => finish(additive(ev, [[1, 1, 3.2], [3.93, 0.35, 14], [9.2, 0.08, 30]], { decayLen: 1.6, release: 0.1 }), ev.vel);
const bells = (ev) => finish(additive(ev, [[1, 1, 1.2], [2.76, 0.45, 2.4], [5.4, 0.25, 4], [8.93, 0.12, 6]], { decayLen: 3.5, release: 0.4 }), ev.vel, 0.08);

const pluck = (ev) => {
  const f = mtof(ev.midi ?? 60);
  const hold = Math.min(ev.dur + 0.6, 1.6);
  const b = alloc(hold + 0.08);
  const N = Math.max(2, Math.round(SR / f));
  const line = new Float32Array(N);
  const r = mulberry(ev.seed ?? 1);
  for (let i = 0; i < N; i++) line[i] = r() * 2 - 1;
  let prev = 0;
  for (let i = 0; i < b.n; i++) {
    const j = i % N;
    const x = line[j];
    const y = 0.5 * (x + prev) * 0.996;
    prev = x;
    line[j] = y;
    const u = i / SR;
    b.L[i] = x * (u < hold ? 1 : Math.max(0, 1 - (u - hold) / 0.08));
  }
  return finish(b, ev.vel);
};

/** 三把微失谐锯齿 + 一阶低通：弦乐 / 垫音共用。 */
const ensemble = (ev, { attack, release, cutoff, detune = [-0.08, 0, 0.09], vib = 0.0025 }) => {
  const f = mtof(ev.midi ?? 60);
  const b = alloc(ev.dur + release);
  const ph = detune.map((_, k) => mulberry((ev.seed ?? 0) * 7 + k)());
  const a = 1 - Math.exp((-TAU * Math.min(cutoff, SR * 0.4)) / SR);
  let lp = 0;
  let lp2 = 0;
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const env = Math.min(1, u / attack) * (u < ev.dur ? 1 : Math.max(0, 1 - (u - ev.dur) / release));
    const fm = 1 + vib * Math.sin(TAU * 5.2 * u);
    let v = 0;
    for (let k = 0; k < detune.length; k++) {
      ph[k] += (f * fm * (1 + detune[k] / 100)) / SR;
      v += saw(ph[k]);
    }
    lp += a * (v - lp);
    lp2 += a * (lp - lp2);
    b.L[i] = lp2 * env;
  }
  return b;
};
const stringsLong = (ev) => finish(ensemble(ev, { attack: 0.28, release: 0.7, cutoff: 1800 + (ev.midi ?? 60) * 20 }), ev.vel, 0.1);
const stringsShort = (ev) => finish(ensemble({ ...ev, dur: Math.min(ev.dur, 0.18) }, { attack: 0.008, release: 0.12, cutoff: 3200, vib: 0 }), ev.vel, 0.06);
const pad = (ev) => finish(ensemble(ev, { attack: 0.9, release: 1.4, cutoff: 1200, detune: [-0.14, 0.13], vib: 0.001 }), ev.vel, 0.15);

const bass = (ev) => {
  const f = mtof(ev.midi ?? 36);
  const b = alloc(ev.dur + 0.12);
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const env = Math.min(1, u / 0.006) * (u < ev.dur ? 1 : Math.max(0, 1 - (u - ev.dur) / 0.12)) * (0.75 + 0.25 * Math.exp(-u * 3));
    b.L[i] = (Math.sin(TAU * f * u) + 0.22 * Math.sin(TAU * 2 * f * u) + 0.08 * Math.sin(TAU * 3 * f * u)) * env;
  }
  return finish(b, ev.vel, 0);
};

const noiseHit = (ev, sec, fn) => {
  const b = alloc(sec);
  const r = mulberry(1000 + (ev.seed ?? 0));
  const st = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < b.n; i++) b.L[i] = fn(i / SR, r() * 2 - 1, st);
  return b;
};

const kick = (ev) => {
  const b = alloc(0.45);
  let ph = 0;
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    ph += (46 + 90 * Math.exp(-u * 32)) / SR;
    b.L[i] = Math.sin(TAU * ph) * Math.exp(-u * 8) + (u < 0.003 ? (1 - u / 0.003) * 0.25 : 0);
  }
  return finish(b, ev.vel, 0);
};
const snare = (ev) =>
  finish(
    noiseHit(ev, 0.25, (u, n, s) => {
      s.a += 0.35 * (n - s.a);
      return (n - s.a) * Math.exp(-u * 22) * 0.8 + Math.sin(TAU * 190 * u) * Math.exp(-u * 30) * 0.5;
    }),
    ev.vel,
  );
const clap = (ev) =>
  finish(
    noiseHit(ev, 0.3, (u, n, s) => {
      s.a += 0.3 * (n - s.a);
      const bp = n - s.a;
      const bursts = [0, 0.011, 0.022].reduce((acc, d) => acc + (u >= d ? Math.exp(-(u - d) * 180) : 0), 0);
      return bp * (bursts * 0.6 + Math.exp(-u * 14) * 0.4);
    }),
    ev.vel,
  );
const hat = (ev) =>
  finish(
    noiseHit(ev, 0.09, (u, n, s) => {
      const hp = n - s.a;
      s.a = n;
      return hp * Math.exp(-u * 60);
    }),
    ev.vel,
  );
const shaker = (ev) =>
  finish(
    noiseHit(ev, 0.12, (u, n, s) => {
      const hp = n - s.a;
      s.a = n;
      return hp * Math.min(1, u / 0.015) * Math.exp(-u * 35);
    }),
    ev.vel,
  );
const percWood = (ev) => finish(additive({ ...ev, midi: ev.midi ?? 84 }, [[1, 1, 45], [2.3, 0.4, 70]], { decayLen: 0.15, release: 0.02 }), ev.vel, 0);
const percMetal = (ev) => finish(additive({ ...ev, midi: ev.midi ?? 81 }, [[1, 1, 2.2], [2.31, 0.6, 3], [3.73, 0.4, 4], [5.12, 0.25, 5]], { decayLen: 1.8, release: 0.3 }), ev.vel, 0.08);
const impact = (ev) => {
  const b = alloc(2.6);
  const r = mulberry(77);
  let ph = 0;
  let lp = 0;
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    ph += (40 + 60 * Math.exp(-u * 8)) / SR;
    lp += 0.08 * (r() * 2 - 1 - lp);
    b.L[i] = Math.sin(TAU * ph) * Math.exp(-u * 2.2) + lp * Math.exp(-u * 9) * 1.5;
  }
  return finish(b, ev.vel, 0);
};
/** 反向镲式渐强：峰值落在 t + dur，之后 0.12 秒放掉。 */
const swell = (ev) => {
  const len = Math.max(0.2, ev.dur);
  const b = alloc(len + 0.14);
  const r = mulberry(5 + (ev.seed ?? 0));
  const st = { lo: 0, band: 0 };
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const k = Math.min(1, u / len);
    const env = u < len ? k ** 2.6 : Math.exp(-(u - len) * 30);
    const fc = 500 + 7000 * k * k;
    const f = 2 * Math.sin((Math.PI * fc) / SR);
    const x = r() * 2 - 1;
    st.lo += f * st.band;
    st.band += f * (x - st.lo - 0.7 * st.band);
    b.L[i] = st.band * env;
  }
  return finish(b, ev.vel, 0.1);
};
const foley = (cf, sec) => (ev) =>
  finish(
    noiseHit(ev, sec, (u, n, s) => {
      const f = 2 * Math.sin((Math.PI * cf) / SR);
      s.a += f * s.b;
      s.b += f * (n - s.a - 0.9 * s.b);
      return s.b * Math.exp(-u * (3 / sec)) * Math.min(1, u / 0.004);
    }),
    ev.vel,
  );

export const INSTRUMENTS = {
  piano,
  mallet,
  bells,
  pluck,
  strings_long: stringsLong,
  strings_short: stringsShort,
  pad,
  bass,
  kick,
  snare,
  clap,
  hat,
  shaker,
  perc_wood: percWood,
  perc_metal: percMetal,
  impact,
  swell,
  foley_paper: foley(3200, 0.25),
  foley_pencil: foley(5200, 0.12),
  foley_book: foley(700, 0.35),
};

const info = (desc, tail, range) => ({ ...(range ? { range } : {}), tail, source: 'stub（程序合成占位）', license: 'CC0（生成）', desc });
export const INSTRUMENT_INFO = {
  piano: info('加法合成钢琴占位', 6.3, [21, 108]),
  mallet: info('马林巴占位', 1.7, [45, 96]),
  bells: info('钟琴占位', 3.9, [72, 108]),
  pluck: info('Karplus-Strong 拨弦', 1.7, [40, 88]),
  strings_long: info('失谐锯齿弦乐长音', 0.8, [28, 96]),
  strings_short: info('失谐锯齿跳弓', 0.3, [28, 96]),
  pad: info('慢起音垫音', 1.5, [36, 96]),
  bass: info('正弦低音', 0.2, [24, 60]),
  kick: info('扫频底鼓', 0.45),
  snare: info('噪声军鼓', 0.25),
  clap: info('三连噪声拍手', 0.3),
  hat: info('高通噪声踩镲', 0.1),
  shaker: info('沙锤', 0.12),
  perc_wood: info('木块', 0.17),
  perc_metal: info('金属轻击', 2.1),
  impact: info('低频冲击', 2.6),
  swell: info('反向渐强（峰值在 t+dur）', 0.15),
  foley_paper: info('纸', 0.25),
  foley_pencil: info('铅笔', 0.12),
  foley_book: info('书', 0.35),
};

export async function loadInstruments() {}
