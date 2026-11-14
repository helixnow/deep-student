// 每个角色的默认 / 备选音色试听：node scripts/audio/audition.mjs [--only piano,kick] [--perf] [--ir]
// 输出 out/audition/instruments/<role>-<variant>.wav + .png（频谱图），以及 qc.md / qc.json 自检结果。
//   --perf  额外跑 8000 个随机音符的渲染耗时测试
//   --ir    额外把一段钢琴 + 拨奏短句分别过 3 个卷积混响，输出 _ir-<name>.wav
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS } from './instruments/catalog.mjs';
import { SR, renderer } from './instruments/index.mjs';
import { writeWav, spectrogramPng, qcStats } from './instruments/dsp.mjs';
import { loadIR, convolve, IR_NAMES } from './ir/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const outDir = path.join(root, 'out', 'audition', 'instruments');
fs.mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const only = (args[args.indexOf('--only') + 1] ?? '').split(',').filter((s) => args.includes('--only') && s);

class Mix {
  constructor() {
    this.L = new Float32Array(SR * 4);
    this.R = new Float32Array(SR * 4);
    this.end = 0;
  }
  add(t, { L, R }) {
    const o = Math.round(t * SR);
    const need = o + L.length;
    if (need > this.L.length) {
      const n = Math.max(need, this.L.length * 2);
      const nl = new Float32Array(n);
      const nr = new Float32Array(n);
      nl.set(this.L);
      nr.set(this.R);
      this.L = nl;
      this.R = nr;
    }
    for (let i = 0; i < L.length; i++) {
      this.L[o + i] += L[i];
      this.R[o + i] += R[i];
    }
    this.end = Math.max(this.end, need);
  }
  out(pad = 0.3) {
    const n = Math.min(this.L.length, this.end + Math.round(pad * SR));
    return { L: this.L.slice(0, n), R: this.R.slice(0, n) };
  }
}

/** 让 2 个八度的 D 大调音阶落在音域内的起始 D。 */
function scaleStart(range, octaves = 2) {
  const [lo, hi] = range ?? [36, 96];
  for (let d = 2; d < 128; d += 12) if (d >= lo && d + 12 * octaves <= hi) return { start: d, octaves };
  for (let d = 2; d < 128; d += 12) if (d >= lo && d + 12 <= hi) return { start: d, octaves: 1 };
  return { start: Math.max(2, Math.ceil((lo - 2) / 12) * 12 + 2), octaves: 1 };
}
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
// D – Bm – G – A（相对主音 D 的半音）
const CHORDS = [
  [0, 4, 7, 12],
  [-3, 4, 9, 12],
  [-7, 0, 5, 9],
  [-5, 2, 7, 11],
];

function auditionPitched(fn, set, mix) {
  const range = set.range ?? fn.info.range;
  const { start, octaves } = scaleStart(range, set.role === 'bass' ? 1 : 2);
  const notes = [];
  for (let o = 0; o < octaves; o++) for (const s of MAJOR) notes.push(start + 12 * o + s);
  notes.push(start + 12 * octaves);
  const seq = [...notes, ...notes.slice(0, -1).reverse()];
  const sustained = set.play === 'sustain';
  const step = sustained ? 0.42 : set.role === 'bass' ? 0.3 : 0.24;
  let t = 0;
  seq.forEach((m, i) => {
    const vel = 0.45 + 0.35 * Math.sin((i / seq.length) * Math.PI);
    mix.add(t, fn({ t, dur: sustained ? step * 1.1 : step * 0.9, midi: m, vel, seed: i }));
    t += step;
  });
  t += 0.6;
  const base = start + 12 * Math.min(1, octaves - 1) - (set.role === 'bass' ? 0 : 0);
  CHORDS.forEach((ch, ci) => {
    const vel = [0.4, 0.55, 0.7, 0.9][ci];
    if (set.role === 'bass') {
      mix.add(t, fn({ t, dur: 0.7, midi: base + ch[0], vel, seed: ci }));
      mix.add(t + 0.75, fn({ t, dur: 0.35, midi: base + ch[0] + 7, vel: vel * 0.8, seed: ci + 10 }));
      mix.add(t + 1.1, fn({ t, dur: 0.35, midi: base + ch[0] + 12, vel: vel * 0.7, seed: ci + 20 }));
      t += 1.6;
      return;
    }
    if (sustained) {
      ch.forEach((iv, k) => mix.add(t, fn({ t, dur: 1.9, midi: base + iv, vel, seed: ci * 4 + k, pan: (k - 1.5) * 0.25 })));
      t += 2.2;
      return;
    }
    ch.forEach((iv, k) => mix.add(t + k * 0.12, fn({ t, dur: 1.3 - k * 0.12, midi: base + iv, vel: vel * (0.85 + 0.05 * k), seed: ci * 4 + k, pan: (k - 1.5) * 0.2 })));
    t += 1.6;
  });
}

function auditionPerc(fn, set, mix) {
  const variants = fn.info.variants ?? [undefined];
  let t = 0;
  for (const v of variants) {
    for (let i = 0; i < 8; i++) {
      const vel = 0.15 + (0.85 * i) / 7;
      mix.add(t, fn({ t, dur: 0.2, vel, seed: i, params: v ? { variant: v } : undefined }));
      t += set.role === 'impact' ? 1.2 : set.role === 'perc_metal' ? 0.5 : 0.22;
    }
    t += 0.4;
  }
  // 2 小节律动（100 BPM，16 分音符网格）
  const s16 = 60 / 100 / 4;
  const pat = {
    kick: '1000001010000000',
    snare: '0000100000001000',
    clap: '0000100000001000',
    hat: '1010101010101011',
    shaker: '1111111111111111',
    perc_wood: '1001001000100100',
    perc_metal: '1000000010000000',
    foley_paper: '1000100010001000',
    foley_book: '1000000010000000',
    impact: '1000000000000000',
  }[set.role] ?? '1000100010001000';
  for (let bar = 0; bar < 2; bar++) {
    for (let k = 0; k < 16; k++) {
      if (pat[k] !== '1') continue;
      const tt = t + (bar * 16 + k) * s16;
      const accent = k % 4 === 0 ? 0.85 : 0.5;
      const params = {};
      if (set.role === 'hat' && k === 14) params.variant = 'open';
      if (set.role === 'shaker') params.variant = k % 2 ? 'up' : 'stroke';
      mix.add(tt, fn({ t: tt, dur: set.role === 'hat' && k === 14 ? s16 * 2 : s16, vel: accent, seed: bar * 16 + k, params }));
    }
  }
}

function auditionSwell(fn, set, mix, tick) {
  let t = 0;
  for (const d of [1.5, 3, 6]) {
    mix.add(t, fn({ t, dur: d, vel: 0.85, midi: set.reverse ? undefined : undefined, seed: d }));
    if (tick) mix.add(t + d, tick({ t: t + d, dur: 0.1, vel: 0.7 }));
    t += d + 2.2;
  }
  if (set.reverse) {
    for (const m of [62, 69]) {
      mix.add(t, fn({ t, dur: 1.2, midi: m, vel: 0.7 }));
      if (tick) mix.add(t + 1.2, tick({ t: t + 1.2, dur: 0.1, vel: 0.6 }));
      t += 2.4;
    }
  }
}

function auditionSlices(fn, mix) {
  let t = 0;
  for (const d of [0.08, 0.15, 0.25, 0.4, 0.7, 1.0]) {
    for (let i = 0; i < 3; i++) {
      mix.add(t, fn({ t, dur: d, vel: 0.5 + 0.2 * i, seed: i + d * 100, pan: (i - 1) * 0.3 }));
      t += d + 0.25;
    }
    t += 0.3;
  }
}

function detectClicks(L, R) {
  // 1 ms 窗内二阶差分最大值，与其前后 50 ms 的中位数比较
  const w = Math.round(SR / 1000);
  const n = Math.floor(L.length / w);
  const mx = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let m = 0;
    for (let i = Math.max(2, b * w); i < (b + 1) * w; i++) m = Math.max(m, Math.abs(L[i] - 2 * L[i - 1] + L[i - 2]), Math.abs(R[i] - 2 * R[i - 1] + R[i - 2]));
    mx[b] = m;
  }
  // 能量明显上升处是正常起音，不算爆音；只统计“能量不变却突然跳变”的点
  const rms = (s, e) => {
    let a = 0;
    s = Math.max(0, s);
    e = Math.min(L.length, e);
    for (let i = s; i < e; i++) a += L[i] * L[i] + R[i] * R[i];
    return Math.sqrt(a / Math.max(1, 2 * (e - s)));
  };
  let clicks = 0;
  const at = [];
  for (let b = 50; b < n - 50; b++) {
    const nb = Array.from(mx.subarray(b - 50, b + 50)).sort((a, c) => a - c);
    const med = nb[50];
    if (mx[b] > 0.03 && mx[b] > 25 * med) {
      const before = rms(b * w - 0.02 * SR, b * w - 0.001 * SR);
      const after = rms(b * w, b * w + 0.006 * SR);
      if (after > 2 * before) continue;
      clicks++;
      if (at.length < 5) at.push(((b * w) / SR).toFixed(2));
      b += 20;
    }
  }
  return { clicks, at };
}

const results = [];
const rel = (p) => path.relative(root, p).replaceAll('\\', '/');
const tickFn = (() => {
  try {
    return renderer('perc_wood.claves');
  } catch {
    return null;
  }
})();

for (const set of SETS) {
  if (only.length && !only.includes(set.role) && !only.includes(set.id)) continue;
  const name = `${set.role}-${set.variant}`;
  const t0 = Date.now();
  let fn;
  try {
    fn = renderer(set.id);
  } catch (e) {
    console.warn(`跳过 ${name}：${e.message}`);
    results.push({ name, id: set.id, error: e.message });
    continue;
  }
  const loadS = (Date.now() - t0) / 1000;
  const t1 = Date.now();
  const mix = new Mix();
  if (set.swell) auditionSwell(fn, set, mix, tickFn);
  else if (set.kind === 'slices') auditionSlices(fn, mix);
  else if ((set.kind === 'derived' ? SETS.find((s) => s.id === set.from).kind : set.kind) === 'pitched') auditionPitched(fn, set, mix);
  else auditionPerc(fn, set, mix);
  const { L, R } = mix.out();
  const renderS = (Date.now() - t1) / 1000;
  // 多个长余响音符叠加可能超过满刻度：试听文件整体降到 -1 dBFS 以内（记录在 qc 里，与单音峰值无关）
  let mixPeak = 0;
  for (let i = 0; i < L.length; i++) mixPeak = Math.max(mixPeak, Math.abs(L[i]), Math.abs(R[i]));
  const auditionGain = mixPeak > 0.89 ? 0.89 / mixPeak : 1;
  if (auditionGain < 1) for (let i = 0; i < L.length; i++) { L[i] *= auditionGain; R[i] *= auditionGain; }
  // 单音峰值检查：vel=1 的单个音符应 ≈ 0.5
  let notePeak = 0;
  {
    const probe = fn({ t: 0, dur: set.play === 'sustain' ? 3 : 0.6, midi: set.range ? Math.round((set.range[0] + set.range[1]) / 2) : 62, vel: 1, seed: 1 });
    for (let i = 0; i < probe.L.length; i++) notePeak = Math.max(notePeak, Math.abs(probe.L[i]), Math.abs(probe.R[i]));
  }
  const wav = path.join(outDir, `${name}.wav`);
  writeWav(wav, L, R, SR);
  spectrogramPng(path.join(outDir, `${name}.png`), L, R, SR);
  const qc = qcStats(L, R, SR);
  const ck = detectClicks(L, R);
  const r = {
    name, id: set.id, default: !!set.default, wav: rel(wav), seconds: +(L.length / SR).toFixed(2),
    peakDb: +qc.peakDb.toFixed(1), rmsDb: +qc.rmsDb.toFixed(1), dc: +qc.dc.toExponential(1), leadSilenceMs: +qc.leadSilenceMs.toFixed(1),
    clipSamples: qc.clipSamples, clicks: ck.clicks, clickAt: ck.at, loadS, renderS, warnings: fn.meta?.warnings?.length ?? 0,
    auditionGainDb: +(20 * Math.log10(auditionGain)).toFixed(1), notePeakVel1: +notePeak.toFixed(2),
  };
  results.push(r);
  console.log(`${name.padEnd(28)} note@vel1 ${r.notePeakVel1}  peak ${r.peakDb} dB  rms ${r.rmsDb} dB  dc ${r.dc}  head ${r.leadSilenceMs} ms  clip ${r.clipSamples}  clicks ${r.clicks}  (load ${loadS.toFixed(1)}s, render ${renderS.toFixed(2)}s)`);
}

if (args.includes('--ir')) {
  const piano = renderer('piano.osiris');
  const mix = new Mix();
  [50, 57, 62, 66, 69, 74].forEach((m, i) => mix.add(i * 0.3, piano({ t: i * 0.3, dur: 1.5, midi: m, vel: 0.6, seed: i })));
  mix.add(2.4, piano({ t: 2.4, dur: 0.15, midi: 74, vel: 0.8 }));
  const dry = mix.out(0.2);
  for (const n of IR_NAMES) {
    try {
      const ir = loadIR(n);
      const t0 = Date.now();
      const w = convolve(dry.L, dry.R, ir, { wet: 0.35, dry: 1, preDelayMs: 12 });
      const f = path.join(outDir, `_ir-${n}.wav`);
      writeWav(f, w.L, w.R, SR);
      spectrogramPng(path.join(outDir, `_ir-${n}.png`), w.L, w.R, SR);
      const q = qcStats(w.L, w.R, SR);
      console.log(`IR ${n}: RT60≈${ir.rt60.toFixed(2)}s  ${(ir.L.length / SR).toFixed(2)}s  peak ${q.peakDb.toFixed(1)} dB  ${Date.now() - t0}ms → ${rel(f)}`);
      results.push({ name: `_ir-${n}`, wav: rel(f), rt60: +ir.rt60.toFixed(2), irSeconds: +(ir.L.length / SR).toFixed(2), peakDb: +q.peakDb.toFixed(1) });
    } catch (e) {
      console.warn(`IR ${n}: ${e.message}`);
    }
  }
}

if (args.includes('--perf')) {
  const roles = [['piano.osiris', 2500], ['mallet.marimba', 1000], ['bass.sneaky', 800], ['strings_long.section', 400], ['pad.organ', 200], ['kick.virtuosity', 800], ['snare.virtuosity', 500], ['hat.virtuosity', 1200], ['shaker.small', 600]];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const t0 = Date.now();
  let notes = 0;
  for (const [id, count] of roles) {
    const fn = renderer(id);
    const set = SETS.find((s) => s.id === id);
    const [lo, hi] = set.range ?? [48, 84];
    const t1 = Date.now();
    for (let i = 0; i < count; i++) {
      const midi = lo + Math.floor(rand() * (hi - lo));
      fn({ t: i * 0.1, dur: 0.15 + rand() * (set.play === 'sustain' ? 3 : 1), midi, vel: 0.3 + rand() * 0.6, seed: i });
    }
    notes += count;
    console.log(`  perf ${id}: ${count} 音符 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }
  const s = (Date.now() - t0) / 1000;
  console.log(`perf：${notes} 个音符共 ${s.toFixed(1)}s`);
  results.push({ name: '_perf', notes, seconds: s });
}

fs.writeFileSync(path.join(outDir, 'qc.json'), JSON.stringify(results, null, 1));
const md = [
  '| 试听 | 默认 | 时长 s | 单音峰值 (vel=1) | 文件峰值 dBFS | 试听增益 dB | RMS dB | DC | 开头静音 ms | 削波样本 | 疑似爆音 |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...results.filter((r) => r.id).map((r) => (r.error ? `| ${r.name} | | 失败：${r.error} | | | | | | | | |` : `| ${r.name} | ${r.default ? '✓' : ''} | ${r.seconds} | ${r.notePeakVel1} | ${r.peakDb} | ${r.auditionGainDb} | ${r.rmsDb} | ${r.dc} | ${r.leadSilenceMs} | ${r.clipSamples} | ${r.clicks}${r.clickAt.length ? ` (${r.clickAt.join(', ')}s)` : ''} |`)),
];
fs.writeFileSync(path.join(outDir, 'qc.md'), md.join('\n') + '\n');
console.log(`→ ${rel(outDir)}/qc.md`);
