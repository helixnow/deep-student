// 程序合成配乐与音效：node scripts/synth-score.mjs → public/audio/*.wav
// 配乐按成片时间（秒）编排，120 BPM、和弦每 4 秒（两小节）换一次，换和弦点与各章节剪辑点对齐。
// 音效只生成样本，摆放时机由 src/audio/Soundtrack.tsx 直接读各段节拍常量决定。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'audio');
fs.mkdirSync(outDir, { recursive: true });

// ── 基础工具 ───────────────────────────────────────────
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => {
  const k = clamp((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
const mulberry = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/** 分段线性自动化曲线：[[秒, 值], …]。 */
const auto = (pts) => (t) => {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) return lerp(pts[i - 1][1], pts[i][1], smooth(pts[i - 1][0], pts[i][0], t));
  }
  return pts[pts.length - 1][1];
};

class Stereo {
  constructor(sec) {
    this.n = Math.ceil(sec * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  add(i, l, r) {
    if (i >= 0 && i < this.n) {
      this.L[i] += l;
      this.R[i] += r;
    }
  }
}

const writeWav = (file, L, R = L) => {
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
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(path.join(outDir, file), buf);
  console.log(`public/audio/${file}  ${(n / SR).toFixed(2)}s`);
};

const normalize = (L, R, peak) => {
  let m = 1e-9;
  for (let i = 0; i < L.length; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak / m;
  for (let i = 0; i < L.length; i++) {
    L[i] *= g;
    R[i] *= g;
  }
};

// 带限锯齿波表（40 次谐波，最高音 ~370Hz 时仍在奈奎斯特以内）
const TABLE = 4096;
const SAW = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) {
  let v = 0;
  for (let k = 1; k <= 40; k++) v += Math.sin((2 * Math.PI * k * i) / TABLE) / k;
  SAW[i] = v * 0.55;
}
const sawAt = (ph) => {
  const x = (ph - Math.floor(ph)) * TABLE;
  const i = Math.floor(x);
  return SAW[i] + (SAW[i + 1] - SAW[i]) * (x - i);
};

/** Chamberlin 状态变量低通（逐样本可调截止）。 */
class SVF {
  constructor() {
    this.low = 0;
    this.band = 0;
  }
  lp(x, fc, q = 0.7) {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR);
    const d = 1 / q;
    this.low += f * this.band;
    const high = x - this.low - d * this.band;
    this.band += f * high;
    return this.low;
  }
  bp(x, fc, q = 2) {
    this.lp(x, fc, q);
    return this.band;
  }
}

// ── Freeverb ─────────────────────────────────────────
const reverb = (inL, inR, { room = 0.86, damp = 0.32, width = 1 } = {}) => {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * k));
  const alls = [556, 441, 341, 225].map((d) => Math.round(d * k));
  const spread = Math.round(23 * k);
  const make = (off) => ({
    combs: combs.map((d) => ({ buf: new Float32Array(d + off), i: 0, store: 0 })),
    alls: alls.map((d) => ({ buf: new Float32Array(d + off), i: 0 })),
  });
  const chans = [make(0), make(spread)];
  const outL = new Float32Array(inL.length);
  const outR = new Float32Array(inL.length);
  const fb = room * 0.28 + 0.7;
  for (let n = 0; n < inL.length; n++) {
    const x = (inL[n] + inR[n]) * 0.015;
    const res = [0, 0];
    for (let c = 0; c < 2; c++) {
      let acc = 0;
      for (const cb of chans[c].combs) {
        const y = cb.buf[cb.i];
        cb.store = y * (1 - damp) + cb.store * damp;
        cb.buf[cb.i] = x + cb.store * fb;
        cb.i = (cb.i + 1) % cb.buf.length;
        acc += y;
      }
      for (const ap of chans[c].alls) {
        const b = ap.buf[ap.i];
        ap.buf[ap.i] = acc + b * 0.5;
        ap.i = (ap.i + 1) % ap.buf.length;
        acc = b - acc;
      }
      res[c] = acc;
    }
    const w1 = width / 2 + 0.5;
    const w2 = (1 - width) / 2;
    outL[n] = res[0] * w1 + res[1] * w2;
    outR[n] = res[1] * w1 + res[0] * w2;
  }
  return [outL, outR];
};

// ── 配乐 ─────────────────────────────────────────────
// 2:46 三幕编排（成片秒）：
//   0–46   第一幕：读懂 → 看清（22 起鼓）→ 整理 → 练习（30 入夜转小调）→ 记住（夜里放慢）
//   46–52  过场：清晨，垫音打开、微光，全片唯一的喘息
//   52–124 第二幕：今日（半拍脉冲）→ 检验（十六分琶音 + 鼓）→ 写作与精读（收）→ 音视频（92–108，半拍底鼓）
//          → 调研（鼓回来，上扬进第三幕）
//   124–140 第三幕：124 标题处抽空，127.2 全编制进入，全片最快
//   140–156 收尾：登顶，微光；156–166 片尾落定
// 下面的曲线按 v5（2:30）时间轴写成，再经 warp() 在成片 92 秒处插入 16 秒音视频段（v6 插入 10 秒 = 5 小节，
// v7 加上问答 / 讲义 / 练习再补 3 小节，共 8 小节，落在小节线上）：
// 插入段之后的一切按 t − 16 取值；插入段内沿用第二幕的和弦循环（G – A – D – Bm 正好一轮，108 回到原 92 的 G），
// 自动化曲线停在插入点的取值。
const INS0 = 92;
const INS = 16;
const DUR = 166;
const BEAT = 0.5;
const dry = new Stereo(DUR + 4);
const send = new Stereo(DUR + 4);

// D 大调：Dmaj9 – Bm9 – Gmaj9 – A(add9)；夜里换成 Bm – G – Em – A
/** v5 时间轴 → v6：插入段前原样，插入段内按 inside(t) 取值，之后取 f(t − INS)。 */
const warp = (f, inside = () => f(INS0)) => (t) => (t < INS0 ? f(t) : t < INS0 + INS ? inside(t) : f(t - INS));

const CHORDS = {
  D: [50, 57, 61, 64, 66],
  Bm: [47, 54, 57, 61, 62],
  G: [43, 50, 54, 57, 59],
  A: [45, 52, 57, 59, 61],
  Em: [40, 47, 55, 59, 62],
};
const ROOT = { D: 38, Bm: 35, G: 31, A: 33, Em: 28 };
const CYCLE = ['D', 'Bm', 'G', 'A'];
const NIGHT = ['Bm', 'G', 'Em', 'A'];
const LIFT = ['G', 'A', 'Bm', 'D'];
const FINALE = ['D', 'G', 'A', 'D'];
const chordAtV5 = (t) => {
  if (t < 2) return 'D';
  if (t < 30) return CYCLE[Math.floor((t - 2) / 4) % 4];
  if (t < 42) return NIGHT[Math.floor((t - 30) / 4) % 4];
  if (t < 46) return t < 44 ? 'G' : 'A';
  if (t < 52) return t < 49 ? 'D' : 'A';
  if (t < 108) return CYCLE[Math.floor((t - 52) / 4) % 4];
  if (t < 111.2) return 'A';
  if (t < 124) return LIFT[Math.floor((t - 111.2) / 3.2) % 4];
  if (t < 140) return FINALE[Math.floor((t - 124) / 4) % 4];
  return 'D';
};

// 插入段：和弦沿第二幕循环（G – A – D – Bm，108 回到原 92 的 G）
const chordAt = warp(chordAtV5, (t) => CYCLE[Math.floor((t - 52) / 4) % 4]);
const padGain = warp(auto([[0, 0], [2.5, 0.75], [30, 0.8], [32.7, 0.95], [38, 0.85], [44, 0.8], [46, 0.9], [48.5, 1.05], [52, 0.85], [76, 0.85], [80, 0.95], [92, 0.85], [108, 1.0], [111.2, 0.9], [124, 1.05], [140, 1.0], [147, 0.6], [150, 0]]));
const padCut = warp(auto([[0, 600], [5, 1300], [11, 1700], [22, 2200], [32.4, 2200], [33.4, 760], [38, 1000], [44, 900], [46, 800], [49, 2600], [52, 1800], [76, 1800], [80, 1500], [92, 2000], [107.8, 2600], [108.2, 1200], [111.2, 3000], [124, 3400], [140, 2600], [150, 1800]]));
const arpGain = warp(auto([[0, 0], [5, 0], [5.6, 0.45], [22, 0.55], [22.5, 0.7], [32.6, 0.7], [33.2, 0.32], [38, 0.34], [44, 0.22], [46, 0], [51.2, 0], [52.4, 0.5], [60, 0.66], [76, 0.66], [77, 0.42], [92, 0.5], [107.9, 0.72], [108.1, 0], [111.1, 0], [111.3, 0.9], [124, 0.92], [136, 0.75], [140, 0.3], [146, 0]]));
const arpCut = warp(auto([[0, 3000], [32.6, 3600], [33.2, 1300], [38, 1700], [46, 1700], [52, 3000], [60, 3800], [76, 3800], [77, 2600], [92, 3200], [108, 4200], [111.2, 5400], [124, 5400], [140, 4000]]));
const bassGain = warp(auto([[0, 0], [5, 0], [6, 0.55], [32.6, 0.6], [33.2, 0.35], [38, 0.38], [44, 0.3], [46, 0], [51.5, 0], [52.5, 0.55], [107.9, 0.62], [108.1, 0], [111.1, 0], [111.3, 0.72], [124, 0.78], [140, 0.5], [148, 0]]));
const kickOnV5 = (t) => (t >= 22 && t < 32.7) || (t >= 52 && t < 76) || (t >= 92 && t < 108) || (t >= 111.2 && t < 136);
const kickHalfV5 = (t) => (t >= 52 && t < 60) || (t >= 92 && t < 96);
const kickGain = warp(auto([[0, 0], [22, 0.9], [32.6, 0.9], [52, 0.5], [60, 0.85], [76, 0.85], [92, 0.7], [104, 0.95], [108, 1.0], [124, 1.0], [136, 0.9]]));
const hatOnV5 = (t) => (t >= 22 && t < 32.7) || (t >= 64 && t < 76) || (t >= 96 && t < 108) || (t >= 111.2 && t < 124) || (t >= 128 && t < 136);
const shimmerGain = warp(auto([[0, 0], [46, 0], [48.5, 0.45], [52, 0.12], [56, 0], [122.5, 0], [124.6, 0.5], [140, 0.6], [150, 0]]));
// 插入段：半拍底鼓、无踩镲（与回到调研前的 92–96 同一织体）
const kickOn = warp(kickOnV5, () => true);
const kickHalf = warp(kickHalfV5, () => true);
const hatOn = warp(hatOnV5, () => false);
const arpFast = warp((t) => (t >= 22 && t < 32.7) || (t >= 60 && t < 76) || (t >= 111.2 && t < 136), () => false);

// 垫音：每个和弦段内 5 个音，三把微失谐锯齿 + 低通，长起音长释音
const renderPad = () => {
  const segs = [];
  let cur = chordAt(0);
  let start = 0;
  for (let t = 0; t <= DUR; t += 0.01) {
    const c = chordAt(t);
    if (c !== cur) {
      segs.push([cur, start, t]);
      cur = c;
      start = t;
    }
  }
  segs.push([cur, start, DUR]);
  const filters = [new SVF(), new SVF()];
  const tmpL = new Float32Array(dry.n);
  const tmpR = new Float32Array(dry.n);
  segs.forEach(([name, s, e], si) => {
    const notes = CHORDS[name];
    notes.forEach((m, ni) => {
      const f = mtof(m);
      const det = [-0.11, 0, 0.12];
      const ph = det.map((_, j) => mulberry(si * 31 + ni * 7 + j)());
      const pan = (ni / (notes.length - 1) - 0.5) * 0.7;
      const i0 = Math.floor(s * SR);
      const i1 = Math.min(dry.n, Math.floor((e + 1.8) * SR));
      for (let i = i0; i < i1; i++) {
        const t = i / SR;
        const env = smooth(s, s + 1.1, t) * (1 - smooth(e, e + 1.8, t));
        if (env <= 0) continue;
        let v = 0;
        for (let j = 0; j < 3; j++) {
          ph[j] += (f * (1 + det[j] / 100)) / SR;
          v += sawAt(ph[j]);
        }
        v *= env * 0.05;
        tmpL[i] += v * (1 - pan);
        tmpR[i] += v * (1 + pan);
      }
    });
  });
  for (let i = 0; i < dry.n; i++) {
    const t = i / SR;
    const g = padGain(t);
    const fc = padCut(t) * (1 + 0.08 * Math.sin(t * 0.7));
    const l = filters[0].lp(tmpL[i], fc, 0.8) * g;
    const r = filters[1].lp(tmpR[i], fc, 0.8) * g;
    dry.add(i, l, r);
    send.add(i, l * 0.7, r * 0.7);
  }
};

// 拨弦琶音：FM（载波:调制 = 1:2，指数衰减的调制指数），八分 / 十六分音符
const renderArp = () => {
  const pattern = [0, 2, 4, 1, 3, 2, 4, 3];
  const filt = [new SVF(), new SVF()];
  const tmpL = new Float32Array(dry.n);
  const tmpR = new Float32Array(dry.n);
  let step = 0;
  for (let t = 5; t < 162; ) {
    const fast = arpFast(t);
    const len = fast ? BEAT / 4 : BEAT / 2;
    const tones = CHORDS[chordAt(t + 0.01)].map((m) => m + 12);
    const m = tones[pattern[step % pattern.length]] + (step % 16 >= 12 ? 12 : 0);
    const f = mtof(m);
    const vel = (0.55 + 0.45 * ((step % 4 === 0) ? 1 : 0.6)) * (0.85 + 0.3 * mulberry(step + 3)());
    const pan = Math.sin(step * 1.7) * 0.45;
    const i0 = Math.floor(t * SR);
    const dur = 0.9;
    for (let i = i0; i < Math.min(dry.n, i0 + dur * SR); i++) {
      const u = (i - i0) / SR;
      const amp = Math.exp(-u * 7) * vel * (1 - Math.exp(-u * 900));
      const idx = 2.4 * Math.exp(-u * 18);
      const v = Math.sin(2 * Math.PI * f * u + idx * Math.sin(2 * Math.PI * 2 * f * u)) * amp * 0.06;
      tmpL[i] += v * (1 - pan);
      tmpR[i] += v * (1 + pan);
    }
    step++;
    t += len;
  }
  for (let i = 0; i < dry.n; i++) {
    const t = i / SR;
    const g = arpGain(t);
    const l = filt[0].lp(tmpL[i], arpCut(t), 0.7) * g;
    const r = filt[1].lp(tmpR[i], arpCut(t), 0.7) * g;
    dry.add(i, l, r);
    send.add(i, l * 0.9, r * 0.9);
  }
};

// 低音：和弦根音正弦 + 轻微二次谐波，随底鼓略微闪避
const renderBass = () => {
  let ph = 0;
  for (let i = 0; i < dry.n; i++) {
    const t = i / SR;
    const g = bassGain(t);
    if (g <= 0) continue;
    const f = mtof(ROOT[chordAt(t)] + 12);
    ph += f / SR;
    const beatPos = (t % BEAT) / BEAT;
    const duck = kickOn(t) ? 0.45 + 0.55 * smooth(0, 0.6, beatPos) : 1;
    const v = (Math.sin(2 * Math.PI * ph) + 0.18 * Math.sin(4 * Math.PI * ph)) * 0.115 * g * duck;
    dry.add(i, v, v);
  }
};

const kickAt = (buf, t0, gain) => {
  const i0 = Math.floor(t0 * SR);
  let ph = 0;
  for (let i = i0; i < Math.min(buf.n, i0 + 0.5 * SR); i++) {
    const u = (i - i0) / SR;
    const f = 46 + 110 * Math.exp(-u * 28);
    ph += f / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-u * 7.5) * gain * 0.55 + (u < 0.004 ? (1 - u / 0.004) * 0.12 * gain : 0);
    buf.add(i, v, v);
  }
};

const renderDrums = () => {
  const r = mulberry(99);
  for (let b = 0; b * BEAT < DUR; b++) {
    const t = b * BEAT;
    if (kickOn(t)) {
      if (!kickHalf(t) || b % 2 === 0) kickAt(dry, t, kickGain(t));
    }
    if (hatOn(t)) {
      for (const off of [0.25, 0.75]) {
        const i0 = Math.floor((t + off * BEAT) * SR);
        const hp = { prev: 0, out: 0 };
        const vel = off === 0.25 ? 0.5 : 0.85;
        for (let i = i0; i < Math.min(dry.n, i0 + 0.06 * SR); i++) {
          const u = (i - i0) / SR;
          const x = r() * 2 - 1;
          hp.out = 0.86 * (hp.out + x - hp.prev);
          hp.prev = x;
          const v = hp.out * Math.exp(-u * 70) * 0.05 * vel;
          dry.add(i, v * 0.8, v * 1.2);
        }
      }
    }
  }
};

// 高处的微光：两个八度以上的三角波长音（收尾与片尾）
const renderShimmer = () => {
  const notes = [74, 78, 81, 85];
  notes.forEach((m, k) => {
    const f = mtof(m);
    let ph = mulberry(k + 50)();
    for (let i = Math.floor(45 * SR); i < dry.n; i++) {
      const t = i / SR;
      const g = shimmerGain(t) * (0.5 + 0.5 * Math.sin(t * (0.9 + k * 0.3) + k));
      if (g <= 0.001) continue;
      ph += f / SR;
      const tri = 1 - 4 * Math.abs((ph % 1) - 0.5);
      const v = tri * g * 0.014;
      const pan = (k / 3 - 0.5) * 0.9;
      dry.add(i, v * (1 - pan), v * (1 + pan));
      send.add(i, v * 1.6, v * 1.6);
    }
  });
};

// 段落交接前的上扬：带通噪声扫频 + 渐强（进第三幕、进收尾）
const renderRiser = (t0, t1) => {
  const r = mulberry(5);
  const f = new SVF();
  for (let i = Math.floor(t0 * SR); i < Math.floor(t1 * SR); i++) {
    const t = i / SR;
    const k = (t - t0) / (t1 - t0);
    const v = f.bp(r() * 2 - 1, 300 + 6000 * k * k, 3) * k * k * 0.12 * (1 - smooth(t1 - 0.08, t1, t));
    dry.add(i, v, v);
    send.add(i, v, v);
  }
};

renderPad();
renderArp();
renderBass();
renderDrums();
renderShimmer();
renderRiser(121.8, 124.05);
renderRiser(137.8, 140.05);

const [wl, wr] = reverb(send.L, send.R, { room: 0.88, damp: 0.35 });
const L = new Float32Array(Math.floor(DUR * SR));
const R = new Float32Array(L.length);
for (let i = 0; i < L.length; i++) {
  const t = i / SR;
  const fade = smooth(0, 0.4, t) * (1 - smooth(163.4, DUR, t));
  const l = (dry.L[i] + wl[i] * 0.55) * fade;
  const r = (dry.R[i] + wr[i] * 0.55) * fade;
  L[i] = Math.tanh(l * 1.6) / 1.6;
  R[i] = Math.tanh(r * 1.6) / 1.6;
}
normalize(L, R, 0.7);
writeWav('score.wav', L, R);

// ── 音效样本 ──────────────────────────────────────────
const sfx = (name, sec, fn, { verb = 0, peak = 0.8 } = {}) => {
  const b = new Stereo(sec + (verb ? 1.2 : 0));
  fn(b);
  let outL = b.L;
  let outR = b.R;
  if (verb) {
    const [vl, vr] = reverb(b.L, b.R, { room: 0.8, damp: 0.4 });
    outL = b.L.map((v, i) => v + vl[i] * verb);
    outR = b.R.map((v, i) => v + vr[i] * verb);
  }
  normalize(outL, outR, peak);
  writeWav(`${name}.wav`, outL, outR);
};
const noise = mulberry(2026);

// 指针点击：极短带通噪声 + 1.9kHz 小音头
sfx('click', 0.06, (b) => {
  const f = new SVF();
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const n = f.bp(noise() * 2 - 1, 3600, 1.6) * Math.exp(-u * 380);
    const s = Math.sin(2 * Math.PI * 1900 * u) * Math.exp(-u * 160) * 0.5;
    b.add(i, n + s, n + s);
  }
});
// 更轻的滴答（打字、卡片落入）
sfx('tick', 0.04, (b) => {
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const v = Math.sin(2 * Math.PI * 2600 * u) * Math.exp(-u * 260) + (noise() * 2 - 1) * Math.exp(-u * 900) * 0.4;
    b.add(i, v, v);
  }
});
// 气流：带通噪声扫频，上扬 / 下沉
const whoosh = (name, up) =>
  sfx(
    name,
    0.55,
    (b) => {
      const f = [new SVF(), new SVF()];
      for (let i = 0; i < b.n; i++) {
        const u = i / SR;
        const k = u / 0.55;
        const fc = up ? 400 + 3600 * k * k : 4000 - 3600 * Math.sqrt(k);
        const env = Math.sin(Math.PI * clamp(k)) ** 1.5;
        b.add(i, f[0].bp(noise() * 2 - 1, fc, 1.4) * env, f[1].bp(noise() * 2 - 1, fc * 1.05, 1.4) * env);
      }
    },
    { verb: 0.25 },
  );
whoosh('whoosh-up', true);
whoosh('whoosh-down', false);
// 气泡弹出：正弦下滑 + 小音头（窗口弹开、卡片入场）
sfx('pop', 0.16, (b) => {
  let ph = 0;
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    ph += (320 + 680 * Math.exp(-u * 40)) / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-u * 28) * (1 - Math.exp(-u * 3000));
    b.add(i, v, v);
  }
});
// 翻卡：两段短促的纸面摩擦
sfx('flip', 0.22, (b) => {
  const f = new SVF();
  for (let i = 0; i < b.n; i++) {
    const u = i / SR;
    const e = Math.exp(-((u - 0.03) ** 2) / 0.0002) + 0.7 * Math.exp(-((u - 0.11) ** 2) / 0.0004);
    const v = f.bp(noise() * 2 - 1, 2400 + 1800 * Math.sin(u * 30), 1.2) * e;
    b.add(i, v, v);
  }
});
// 匹配剪辑进 3D：低频轰鸣 + 噪声冲击
sfx(
  'boom',
  1.4,
  (b) => {
    let ph = 0;
    const f = new SVF();
    for (let i = 0; i < b.n; i++) {
      const u = i / SR;
      ph += (38 + 70 * Math.exp(-u * 10)) / SR;
      const v = Math.sin(2 * Math.PI * ph) * Math.exp(-u * 2.6) + f.lp(noise() * 2 - 1, 900) * Math.exp(-u * 14) * 0.5;
      b.add(i, v, v);
    }
  },
  { verb: 0.35 },
);
// 相似度扫描：声呐般的轻 ping
sfx(
  'ping',
  0.9,
  (b) => {
    for (let i = 0; i < b.n; i++) {
      const u = i / SR;
      const v = (Math.sin(2 * Math.PI * 1318.5 * u) + 0.3 * Math.sin(2 * Math.PI * 2637 * u)) * Math.exp(-u * 6) * (1 - Math.exp(-u * 600));
      b.add(i, v, v);
    }
  },
  { verb: 0.6, peak: 0.6 },
);
// 评分 / 揭示的木琴音（三个音高）
const mallet = (name, m) =>
  sfx(
    name,
    0.6,
    (b) => {
      const f0 = mtof(m);
      for (let i = 0; i < b.n; i++) {
        const u = i / SR;
        const v = (Math.sin(2 * Math.PI * f0 * u) + 0.35 * Math.sin(2 * Math.PI * f0 * 4 * u) * Math.exp(-u * 30)) * Math.exp(-u * 9) * (1 - Math.exp(-u * 1500));
        b.add(i, v, v);
      }
    },
    { verb: 0.3, peak: 0.7 },
  );
mallet('note-low', 69);
mallet('note-mid', 76);
mallet('note-high', 81);
mallet('note-top', 86);
// 片尾钟声：FM 钟（1:3.5）奏 D 大三和弦
sfx(
  'chime',
  3.2,
  (b) => {
    [74, 78, 81, 86].forEach((m, k) => {
      const f0 = mtof(m);
      const d = k * 0.05;
      for (let i = Math.floor(d * SR); i < b.n; i++) {
        const u = i / SR - d;
        const idx = 3 * Math.exp(-u * 3);
        const v = Math.sin(2 * Math.PI * f0 * u + idx * Math.sin(2 * Math.PI * f0 * 3.5 * u)) * Math.exp(-u * 1.4) * 0.3;
        const pan = (k / 3 - 0.5) * 0.6;
        b.add(i, v * (1 - pan), v * (1 + pan));
      }
    });
  },
  { verb: 0.7, peak: 0.75 },
);
// 进收尾的光波：反向镲般的渐强 + 释放
sfx(
  'swell',
  1.6,
  (b) => {
    const f = [new SVF(), new SVF()];
    for (let i = 0; i < b.n; i++) {
      const u = i / SR;
      const k = u / 1.6;
      const env = k < 0.7 ? (k / 0.7) ** 2.5 : Math.exp(-(k - 0.7) * 9);
      b.add(i, f[0].bp(noise() * 2 - 1, 1200 + 5000 * k, 0.9) * env, f[1].bp(noise() * 2 - 1, 1300 + 5200 * k, 0.9) * env);
    }
  },
  { verb: 0.5, peak: 0.7 },
);
