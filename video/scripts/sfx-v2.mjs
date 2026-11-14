// 音效 v2：用开源素材（Kenney / VCSL / Freesound，全部 CC0）加工出宣传片的全部音效。
//   node scripts/sfx-v2.mjs            → out/audio-v2/sfx/*.wav（试听 / 检查）
//   node scripts/sfx-v2.mjs --public   → public/audio/*.wav（Soundtrack.tsx 引用；不碰 score.wav）
//   --sheet                            → 另出 out/audio-v2/sfx/sheet.png（各音效波形 + 频谱，人工检查用）
// 素材先由 scripts/audio/sfx/fetch-sfx.mjs 按清单下载到 .cache/sfx/。这里只做裁剪、对齐、EQ、
// 音高微调（重采样）、收尾、叠层与响度归一，不用振荡器合成任何音色。
// 音高类全部调到 D 大调五声音阶（D E F# A B），按实测音高精确校到 A4 = 440 Hz。
// 每个音效族输出带编号的变体（click-1 … click-3）；不带编号的旧文件名（click.wav 等）是 1 号变体的副本，
// 供旧代码使用。Soundtrack.tsx 只引用带编号的文件。
import fs from 'node:fs';
import path from 'node:path';
import { assetPath, fetchAll } from './audio/sfx/fetch-sfx.mjs';
import * as D from './audio/sfx/dsp.mjs';

const args = process.argv.slice(2);
const toPublic = args.includes('--public');
const outDir = path.join(D.ROOT, toPublic ? 'public/audio' : 'out/audio-v2/sfx');
const infoDir = path.join(D.ROOT, 'out/audio-v2/sfx');

/**
 * 文件响度约定（Soundtrack.tsx 的 FILE_LUFS 依赖它）：事件响度（100 ms 窗最大 K 加权响度）
 * boom / swell / chime 对齐到 −16 LUFS，其余全部 −22 LUFS；真峰值不超过 −1 dBTP。
 * 非 hero 族的峰值因数（真峰值 − 事件响度）不超过 MAX_CREST_DB：Remotion 混音没有总线限制器，
 * 实录点击的亚毫秒尖峰叠在配乐峰值上会冲破 −1 dBTP。
 * Soundtrack 按层级目标响度换算音量（都 ≤ 1，预览与渲染一致）。
 */
const HERO = new Set(['boom', 'swell', 'chime']);
const familyLufs = (fam) => (HERO.has(fam) ? -16 : -22);
const CEILING_DBTP = -1;
const MAX_CREST_DB = 16;

const manifest = await fetchAll({ quiet: true });
const byId = Object.fromEntries(manifest.assets.map((a) => [a.id, a]));
const cache = new Map();
const src = (id) => {
  if (!byId[id]) throw new Error(`unknown asset ${id}`);
  if (!cache.has(id)) cache.set(id, D.decode(assetPath(byId[id])));
  return D.copy(cache.get(id));
};

// ── 通用加工 ─────────────────────────────────────────
/** 收尾：tailAt 秒后按 tau 指数加速衰减，最后 out 秒淡出，总长 total 秒。 */
const shape = (ch, { total, tailAt, tau, fadeIn = 0.0005, out = 0.02 }) => {
  let o = D.trim(ch, 0, total);
  if (tailAt !== undefined) o = D.tighten(o, tailAt, tau);
  return D.fade(o, fadeIn, Math.min(out, D.len(o) / D.SR / 2));
};
/** 在真峰值上限内能达到的最大事件响度。 */
const reachable = (ch) => D.eventLoudness(ch) + (CEILING_DBTP - D.truePeak(ch));
/** 对齐到 target（同族变体用同一个 target，轮换时音量一致）。 */
const normalize = (ch, target) => D.gain(ch, D.undb(target - D.eventLoudness(ch)));
/**
 * 逐样点软削波（阈值的 70% 以上用 tanh 弯折，输出不超过 thr）。不用带释放的限制器：
 * 点击类的事件响度主要来自尖峰后几毫秒的主体，释放会把主体一起压低，峰值因数反而变大。
 */
const softClip = (ch, thr) => {
  const k = thr * 0.7;
  const w = thr - k;
  return D.map(ch, (c) => c.map((v) => (Math.abs(v) <= k ? v : Math.sign(v) * (k + w * Math.tanh((Math.abs(v) - k) / w)))));
};
const capCrest = (ch, maxDb) => {
  let o = ch;
  for (let i = 0; i < 6; i++) {
    const ev = D.eventLoudness(o);
    if (D.truePeak(o) - ev <= maxDb + 0.05) break;
    o = softClip(o, D.undb(ev + maxDb - 0.3 * (i + 1)));
  }
  return o;
};
/** 按 RMS 把 b 调到比 a 低 relDb（[t0, t1] 秒窗口内）。 */
const rms = (ch, t0, t1) => {
  const s = D.trim(ch, t0, t1);
  let acc = 0;
  for (const c of s) for (const v of c) acc += v * v;
  return Math.sqrt(acc / Math.max(1, s[0].length * 2));
};
const matchTo = (ref, b, relDb, t0, t1) => D.gain(b, (rms(ref, t0, t1) / Math.max(1e-9, rms(b, t0, t1))) * D.undb(relDb));

// ── 配方 ─────────────────────────────────────────────
// 每个配方返回 { ch, src: [素材 id], how: 加工说明 }。
const PENTA = { D5: 74, 'F#5': 78, A5: 81, B5: 83, D6: 86, E6: 88, 'F#6': 90, A6: 93, B6: 95, D7: 98 };

/** MacBook Pro 键盘录音里的单击：触控板式的短促「嗒」。t = 录音里的击键时刻。 */
const keyHit = (t, { dur, detune, hp, lp, tailAt, tau, shelf = 0 }) => {
  let ch = D.hitAt(src('typing-mbp'), t, dur, { pre: 0.0015 });
  ch = D.eq(ch, [['hp', hp, 0.7], ['lp', lp, 0.7], ['highshelf', 6500, 0.7, shelf]]);
  ch = D.pitch(ch, detune);
  ch = D.width(ch, 0.35);
  return shape(ch, { total: dur, tailAt, tau, out: 0.012 });
};
const click = (t, detune) => ({
  ch: keyHit(t, { dur: 0.085, detune, hp: 180, lp: 11000, tailAt: 0.022, tau: 0.016, shelf: -2 }),
  src: ['typing-mbp'],
  how: `取 ${t.toFixed(3)} s 处一击（起振对齐）· HPF 180 Hz · 高架 −2 dB@6.5 kHz · LPF 11 kHz · 22 ms 后加速衰减 · 音高 ${detune >= 0 ? '+' : ''}${detune} 半音 · 宽度 0.35`,
});
const key = (t, detune) => ({
  ch: keyHit(t, { dur: 0.1, detune, hp: 150, lp: 8000, tailAt: 0.03, tau: 0.024, shelf: -3 }),
  src: ['typing-mbp'],
  how: `取 ${t.toFixed(3)} s 处一击 · HPF 150 Hz · 高架 −3 dB@6.5 kHz · LPF 8 kHz · 30 ms 后加速衰减 · 音高 ${detune >= 0 ? '+' : ''}${detune} 半音`,
});
const tick = (id, detune) => {
  let ch = D.trimStart(src(id), 0.0005, 40);
  ch = D.eq(ch, [['hp', 400, 0.7], ['lp', 9000, 0.7]]);
  ch = D.pitch(ch, detune);
  ch = D.width(ch, 0.3);
  return { ch: shape(ch, { total: 0.045, out: 0.01 }), src: [id], how: `起振裁齐 · HPF 400 Hz · LPF 9 kHz · 音高 ${detune >= 0 ? '+' : ''}${detune} 半音 · 45 ms` };
};
/** 书本轻放：柔和的「嗒」，用于窗口 / 卡片 / 弹层出现（替代卡通 pop）。 */
const tap = (id, detune) => {
  let ch = D.alignPeak(src(id), 0.008);
  ch = D.eq(ch, [['hp', 160, 0.7], ['lp', 5500, 0.7], ['peak', 2500, 1, -2]]);
  ch = D.pitch(ch, detune);
  ch = D.width(ch, 0.5);
  return { ch: shape(ch, { total: 0.22, tailAt: 0.05, tau: 0.045, fadeIn: 0.004, out: 0.03 }), src: [id], how: `峰值对齐（前留 8 ms，4 ms 淡入）· HPF 160 Hz · −2 dB@2.5 kHz · LPF 5.5 kHz · 音高 +${detune} 半音 · 50 ms 后加速衰减 · 220 ms` };
};
const flip = (id, { from = 0, total, detune, peakIn }) => {
  let ch = src(id);
  if (peakIn) ch = D.alignPeak(ch, from, peakIn[0], peakIn[1]);
  else ch = D.trimStart(ch, 0.002, 40);
  ch = D.eq(ch, [['hp', 300, 0.7], ['highshelf', 6000, 0.7, -3], ['lp', 10000, 0.7]]);
  ch = D.pitch(ch, detune);
  return { ch: shape(ch, { total, fadeIn: 0.002, out: Math.min(0.08, total / 3) }), src: [id], how: `${peakIn ? `取最强一页（峰前 ${from * 1000} ms）` : '起振裁齐'} · HPF 300 Hz · 高架 −3 dB@6 kHz · LPF 10 kHz · 音高 ${detune >= 0 ? '+' : ''}${detune} 半音 · ${Math.round(total * 1000)} ms` };
};
/** 布料轻扫：柔和的空气感过渡（窗口展开 / 收进 Dock / 镜头横移），up 更亮、down 更暗。 */
const swish = (id, up, detune) => {
  let ch = D.trimStart(src(id), 0.01, 40);
  ch = up
    ? D.eq(ch, [['hp', 260, 0.7], ['peak', 2800, 0.8, 2], ['lp', 9000, 0.7]])
    : D.eq(ch, [['hp', 120, 0.7], ['peak', 2800, 0.8, -2], ['lp', 3200, 0.7]]);
  ch = D.pitch(ch, detune);
  return { ch: shape(ch, { total: 0.6, fadeIn: 0.025, out: 0.12 }), src: [id], how: `起振裁齐（25 ms 淡入）· ${up ? 'HPF 260 Hz · +2 dB@2.8 kHz · LPF 9 kHz' : 'HPF 120 Hz · −2 dB@2.8 kHz · LPF 3.2 kHz'} · 音高 ${detune >= 0 ? '+' : ''}${detune} 半音 · 600 ms（末 120 ms 淡出）` };
};
const cards = (id, total) => {
  let ch = D.trimStart(src(id), 0.005, 40);
  ch = D.eq(ch, [['hp', 220, 0.7], ['highshelf', 7000, 0.7, -2], ['lp', 11000, 0.7]]);
  return { ch: shape(ch, { total, fadeIn: 0.005, out: 0.12 }), src: [id], how: `起振裁齐 · HPF 220 Hz（去低频底噪）· 高架 −2 dB@7 kHz · LPF 11 kHz · ${Math.round(total * 1000)} ms` };
};

/** 颤音琴（软槌）本体 + 高八度钟琴（−15 dB）点亮起音：一个干净、短、带一点光泽的确认音。 */
const note = (name) => {
  const plan = {
    D5: { vib: ['vibes-D5', 74], glk: ['glock-C6', 84.1] },
    'F#5': { vib: ['vibes-F5', 77], glk: ['glock-G6', 91.1] },
    A5: { vib: ['vibes-A5', 81], glk: ['glock-G6', 91.1] },
    D6: { vib: ['vibes-C6', 84], glk: ['glock-C7', 96.2] },
  }[name];
  const target = PENTA[name];
  const v = D.tuneTo(D.trimStart(src(plan.vib[0]), 0.001, 40), plan.vib[1], target);
  const g = D.tuneTo(D.trimStart(src(plan.glk[0]), 0.001, 40), plan.glk[1], target + 12);
  let ch = D.mix([
    { ch: v.ch, g: 1 },
    { ch: matchTo(v.ch, g.ch, -15, 0, 0.3), g: 1 },
  ]);
  ch = D.eq(ch, [['hp', 200, 0.7], ['lp', 11000, 0.7]]);
  return {
    ch: shape(ch, { total: 1.5, tailAt: 0.25, tau: 0.38, fadeIn: 0.001, out: 0.35 }),
    src: [plan.vib[0], plan.glk[0]],
    how: `颤音琴 ${D.midiName(v.measured)} → ${name}（${v.shift >= 0 ? '+' : ''}${v.shift.toFixed(2)} 半音）+ 钟琴 ${D.midiName(g.measured)} → 高八度（${g.shift >= 0 ? '+' : ''}${g.shift.toFixed(2)} 半音，比本体低 15 dB）· HPF 200 Hz · 250 ms 后加速衰减（τ 0.38 s）· 1.5 s`,
  };
};
/** 钟琴单音：扫描 / 地形生长的「叮」。 */
const bell = (name) => {
  const target = PENTA[name];
  const pick = target <= 87 ? ['glock-C6', 84.1] : target <= 93 ? ['glock-G6', 91.1] : ['glock-C7', 96.2];
  const t = D.tuneTo(D.trimStart(src(pick[0]), 0.001, 40), pick[1], target);
  const ch = D.eq(t.ch, [['hp', 500, 0.7], ['lp', 12000, 0.7]]);
  return {
    ch: shape(ch, { total: 1.1, tailAt: 0.12, tau: 0.32, out: 0.3 }),
    src: [pick[0]],
    how: `钟琴 ${D.midiName(t.measured)} → ${name}（${t.shift >= 0 ? '+' : ''}${t.shift.toFixed(2)} 半音）· HPF 500 Hz · 120 ms 后加速衰减（τ 0.32 s）· 1.1 s`,
  };
};
/** 片尾：手摇钟 D5–F#5–A5–D6 由低到高轻拨（间隔 60 ms），再加一颗高八度钟琴 D7。 */
const chime = () => {
  const strum = [
    ['chime-D5', 74, 74, 0, 0, -0.2],
    ['chime-Fs5', 78, 78, 0.06, -2, 0.15],
    ['chime-A5', 81, 81, 0.12, -3, -0.1],
    ['chime-D6', 86, 86, 0.18, -4.5, 0.2],
  ];
  const layers = strum.map(([id, approx, target, at, gDb, p]) => {
    const t = D.tuneTo(D.trimStart(src(id), 0.001, 40), approx, target);
    return { ch: D.pan(D.width(t.ch, 0.6), p), at, g: D.undb(gDb) };
  });
  const glk = D.tuneTo(D.trimStart(src('glock-C7'), 0.001, 40), 96.2, PENTA.D7);
  layers.push({ ch: matchTo(layers[0].ch, glk.ch, -14, 0, 0.4), at: 0.2, g: 1 });
  let ch = D.mix(layers);
  ch = D.eq(ch, [['hp', 180, 0.7], ['lp', 12000, 0.7]]);
  return {
    ch: shape(ch, { total: 4.2, tailAt: 1.4, tau: 1.1, fadeIn: 0.001, out: 1.2 }),
    src: ['chime-D5', 'chime-Fs5', 'chime-A5', 'chime-D6', 'glock-C7'],
    how: '手摇钟 D5 / F#5 / A5 / D6 各自校准到平均律，0 / 60 / 120 / 180 ms 依次进入（逐个 −0 / −2 / −3 / −4.5 dB，轻微左右分开）+ 钟琴 D7（200 ms，低 14 dB）· HPF 180 Hz · 1.4 s 后加速衰减 · 4.2 s',
  };
};
/** 匹配剪辑：音乐会大鼓（软槌）的低沉一击 + 极弱吊镲给一点空气。 */
const boom = () => {
  const drum = D.eq(D.alignPeak(src('bass-drum'), 0.012), [['hp', 30, 0.7], ['lp', 2500, 0.7]]);
  const air = D.eq(D.trimStart(src('cymbal-pp'), 0.002, 40), [['hp', 2500, 0.7], ['lp', 9000, 0.7]]);
  let ch = D.mix([
    { ch: D.fade(drum, 0.004, 0.01), g: 1 },
    { ch: matchTo(drum, air, -24, 0, 0.5), at: 0.012, g: 1 },
  ]);
  return {
    ch: shape(ch, { total: 2.8, tailAt: 0.7, tau: 0.6, fadeIn: 0.004, out: 0.5 }),
    src: ['bass-drum', 'cymbal-pp'],
    how: '大鼓峰值对齐（前留 12 ms）· HPF 30 Hz · LPF 2.5 kHz；叠吊镲极弱单击（HPF 2.5 kHz，低 24 dB）· 0.7 s 后加速衰减 · 2.8 s',
  };
};
/** 过场光波：软槌吊镲滚奏渐强（最强在 1.2 s）+ 弓拉颤音琴 D5 / A5 空五度跟着长出来。 */
const SWELL_PEAK = 1.2;
const swell = () => {
  const cym = D.eq(src('cymbal-cresc'), [['hp', 300, 0.7], ['highshelf', 8000, 0.7, -3], ['lp', 12000, 0.7]]);
  const d5 = D.tuneTo(D.trim(src('bowed-D5'), 0.6), 74, 74).ch;
  const a5 = D.tuneTo(D.trim(src('bowed-A5'), 0.3), 81, 81).ch;
  let ch = D.mix([
    { ch: cym, g: 1 },
    { ch: matchTo(cym, D.eq(d5, [['hp', 200, 0.7]]), -7, 1.0, 1.6), g: 1 },
    { ch: matchTo(cym, D.eq(a5, [['hp', 200, 0.7]]), -10, 1.0, 1.6), g: 1 },
  ]);
  return {
    ch: shape(ch, { total: 3.4, tailAt: 1.5, tau: 0.7, fadeIn: 0.05, out: 0.9 }),
    src: ['cymbal-cresc', 'bowed-D5', 'bowed-A5'],
    how: `吊镲滚奏渐强（HPF 300 Hz · 高架 −3 dB@8 kHz）+ 弓拉颤音琴 D5（从样本 0.6 s 起，低 7 dB）与 A5（从 0.3 s 起，低 10 dB）· 最强点 ${SWELL_PEAK} s · 1.5 s 后加速衰减 · 3.4 s`,
  };
};

// ── 输出表 ───────────────────────────────────────────
// 族名 → 变体配方。变体 1 同时写成不带编号的旧文件名。
const FAMILIES = {
  click: [() => click(0.302, 0), () => click(0.912, 0.35), () => click(4.791, -0.3)],
  key: [() => key(4.686, 0), () => key(0.652, -0.4), () => key(7.654, 0.3), () => key(5.156, -0.2)],
  tick: [() => tick('ui-tick-1', 0), () => tick('ui-tick-2', 0), () => tick('ui-tick-1', -2.5)],
  pop: [() => tap('book-place-1', 2), () => tap('book-place-2', 2.5), () => tap('book-place-3', 1.5)],
  flip: [() => flip('book-flip-3', { total: 0.23, detune: 0 }), () => flip('book-flip-2', { total: 0.34, detune: 0.5 }), () => flip('book-flip-1', { from: 0.05, total: 0.26, detune: -0.5, peakIn: [0.45, 0.75] })],
  'whoosh-up': [() => swish('cloth-1', true, 2), () => swish('cloth-4', true, 3)],
  'whoosh-down': [() => swish('cloth-2', false, -2), () => swish('cloth-1', false, -3)],
  cards: [() => cards('card-fan-2', 1.3), () => cards('card-fan-1', 0.75)],
  boom: [boom],
  swell: [swell],
  chime: [chime],
  ping: [() => bell('A6')],
  bell: { d6: () => bell('D6'), e6: () => bell('E6'), fs6: () => bell('F#6'), a6: () => bell('A6'), b6: () => bell('B6'), d7: () => bell('D7') },
  'note-low': [() => note('D5')],
  'note-mid': [() => note('F#5')],
  'note-high': [() => note('A5')],
  'note-top': [() => note('D6')],
};
/** synth-score.mjs 时代的旧文件名（作为各族默认变体保留）。 */
const LEGACY = ['click', 'tick', 'pop', 'flip', 'whoosh-up', 'whoosh-down', 'boom', 'ping', 'note-low', 'note-mid', 'note-high', 'note-top', 'chime', 'swell'];

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(infoDir, { recursive: true });
const index = [];
const sheet = [];
for (const [fam, variants] of Object.entries(FAMILIES)) {
  const entries = Array.isArray(variants) ? variants.map((fn, i) => [`${fam}-${i + 1}`, fn]) : Object.entries(variants).map(([k, fn]) => [`${fam}-${k}`, fn]);
  const made = entries.map(([name, fn]) => [name, fn()]);
  if (!HERO.has(fam)) for (const m of made) m[1] = { ...m[1], ch: capCrest(m[1].ch, MAX_CREST_DB) };
  const target = familyLufs(fam);
  const short = made.filter(([, r]) => reachable(r.ch) < target);
  if (short.length) throw new Error(`${short.map(([n]) => n).join(', ')}: 真峰值 ${CEILING_DBTP} dBTP 内达不到 ${target} LUFS`);
  for (const [name, r] of made) {
    const ch = normalize(r.ch, target);
    D.writeWav(path.join(outDir, `${name}.wav`), ch);
    const info = { name, family: fam, dur: +(D.len(ch) / D.SR).toFixed(3), eventLufs: +D.eventLoudness(ch).toFixed(1), momentaryMax: +D.momentaryMax(ch).toFixed(1), truePeak: +D.truePeak(ch).toFixed(1), src: r.src, how: r.how };
    index.push(info);
    sheet.push(ch);
    console.log(`${name.padEnd(16)} ${info.dur.toFixed(2)} s  event ${info.eventLufs} LUFS  M ${info.momentaryMax}  TP ${info.truePeak} dBTP`);
  }
}
for (const fam of LEGACY) fs.copyFileSync(path.join(outDir, `${fam}-1.wav`), path.join(outDir, `${fam}.wav`));
console.log(`legacy aliases: ${LEGACY.map((f) => `${f}.wav`).join(' ')}`);

const credits = Object.fromEntries(Object.entries(manifest.packs).map(([k, p]) => [k, p]));
fs.writeFileSync(path.join(infoDir, 'index.json'), `${JSON.stringify({ heroLufs: familyLufs('boom'), otherLufs: familyLufs('click'), ceilingDbtp: CEILING_DBTP, maxCrestDb: MAX_CREST_DB, swellPeak: SWELL_PEAK, outputs: index, assets: manifest.assets, packs: credits }, null, 2)}\n`);
if (args.includes('--sheet')) D.spectroSheet(path.join(infoDir, 'sheet.png'), sheet, { secs: 1.5, colW: 700, rowH: 44 });
console.log(`→ ${path.relative(D.ROOT, outDir)} (${index.length} files + ${LEGACY.length} legacy aliases)`);
