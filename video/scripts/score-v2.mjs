// 配乐 v2：node scripts/score-v2.mjs [选项]
//   默认          整首 → out/audio-v2/score.wav（+ score-meta.json、频谱图、分段响度）
//   --public      同时写 public/audio/score.wav（仅整首）
//   --stems       另写各总线分轨 out/audio-v2/stems/{keys,strings,perc,bass,fx,reverb}.wav（母带压缩 / 限制之前）
//   --from S --to S  只渲染一段（成片秒），沿用上次整首渲染的增益，输出 score_<S>-<S>.wav
//   --stub        全部角色用占位乐器；--fdn 强制内置 FDN 混响；--no-measure 跳过 ffmpeg 测量
//   --out FILE    指定输出路径
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DURATION, SECTIONS, BEAT_SOURCES, TEMPO, HITS } from './audio/arrangement.mjs';
import { render, writeWav, hitReport, loudness, truePeakDb, spectrogramPng, SR } from './audio/mix.mjs';
import { FFMPEG } from './audio/sfx/dsp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out', 'audio-v2');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (['from', 'to', 'out'].includes(key)) {
    args[key] = next;
    i++;
  } else args[key] = true;
}

const segment = args.from !== undefined || args.to !== undefined;
const from = Math.max(0, +(args.from ?? 0));
const to = Math.min(DURATION, +(args.to ?? DURATION));
if (!(to > from)) {
  console.error(`--from ${from} --to ${to} 区间无效`);
  process.exit(1);
}
const tag = segment ? `score_${from}-${to}` : 'score';
const file = path.resolve(args.out ?? path.join(outDir, `${tag}.wav`));
const metaFile = path.join(outDir, 'score-meta.json');

let gains = null;
if (segment && fs.existsSync(metaFile)) {
  try {
    gains = JSON.parse(fs.readFileSync(metaFile, 'utf8')).mix?.gains ?? null;
    if (gains) console.log(`[score-v2] 沿用整首渲染的增益：pre ${gains.pre.toFixed(3)} / post ${gains.post.toFixed(3)}`);
  } catch {
    gains = null;
  }
}

console.log(`[score-v2] 渲染 ${from}–${to}s（速度图 ${TEMPO.segments.map((s) => `${s.t0}s@${s.bpm}`).join(' → ')}）`);
const { L, R, stems, meta } = await render({ from, to, stems: !!args.stems, stub: !!args.stub, fdn: !!args.fdn, gains });

writeWav(file, L, R);
console.log(`[score-v2] ${path.relative(root, file)}  ${(L.length / SR).toFixed(2)}s`);
if (args.public) {
  if (segment) console.warn('[score-v2] --public 只用于整首渲染，已忽略');
  else {
    const pub = path.join(root, 'public', 'audio', 'score.wav');
    writeWav(pub, L, R);
    console.log(`[score-v2] ${path.relative(root, pub)}`);
  }
}
if (stems) {
  for (const [name, s] of Object.entries(stems)) {
    const f = path.join(outDir, 'stems', `${segment ? `${tag}_` : ''}${name}.wav`);
    writeWav(f, s.L, s.R);
  }
  console.log(`[score-v2] 分轨 → ${path.relative(root, path.join(outDir, 'stems'))}`);
}

// ── 内部测量：分段响度（BS.1770）、HIT 前后电平 ──
const slice = (a, b) => {
  const i0 = Math.max(0, Math.round((a - from) * SR));
  const i1 = Math.min(L.length, Math.round((b - from) * SR));
  return i1 - i0 > SR * 0.5 ? [L.subarray(i0, i1), R.subarray(i0, i1)] : null;
};
const sections = SECTIONS.filter((s) => s.t1 > from && s.t0 < to).map((s) => {
  const p = slice(Math.max(s.t0, from), Math.min(s.t1, to));
  return { id: s.id, label: s.label, t0: s.t0, t1: s.t1, lufs: p ? +loudness(...p).toFixed(1) : null, tpDb: p ? +truePeakDb(...p).toFixed(1) : null };
});
const hits = hitReport(L, R, from).filter((h) => h.music >= from && h.music < to);

// ── ffmpeg 实测 ──
const ffmpegPath = [FFMPEG, 'ffmpeg'].find((p) => p === 'ffmpeg' || fs.existsSync(p));
// Remotion 自带的 ffmpeg 没有 ebur128，用 loudnorm 的分析输出（同为 EBU R128 积分响度 + 真峰值）
const filters = ffmpegPath ? spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '' : '';
const meter = /\bebur128\b/.test(filters) ? 'ebur128' : /\bloudnorm\b/.test(filters) ? 'loudnorm' : null;
const measure = (ss, dur) => {
  const a = ['-hide_banner', '-nostats'];
  if (ss !== undefined) a.push('-ss', String(ss), '-t', String(dur));
  a.push('-i', file);
  if (meter === 'ebur128') a.push('-filter_complex', 'ebur128=peak=true', '-f', 'null', '-');
  else a.push('-af', 'loudnorm=print_format=json', '-f', 'null', '-');
  const r = spawnSync(ffmpegPath, a, { encoding: 'utf8', maxBuffer: 64 << 20 });
  const txt = (r.stderr ?? '') + (r.stdout ?? '');
  if (meter === 'loudnorm') {
    const j = txt.slice(txt.lastIndexOf('{'), txt.lastIndexOf('}') + 1);
    try {
      const o = JSON.parse(j);
      return { I: +o.input_i, LRA: +o.input_lra, TP: +o.input_tp };
    } catch {
      return { I: null, LRA: null, TP: null };
    }
  }
  const sum = txt.slice(txt.lastIndexOf('Summary:'));
  const num = (re) => {
    const m = sum.match(re);
    return m ? +m[1] : null;
  };
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/) };
};
let ffmpeg = null;
if (!args['no-measure'] && meter) {
  ffmpeg = { meter: `ffmpeg ${meter}`, full: measure(), sections: {} };
  for (const s of sections) {
    const a = Math.max(s.t0, from);
    const b = Math.min(s.t1, to);
    if (b - a >= 1) ffmpeg.sections[s.id] = measure(a - from, b - a);
  }
}
if (!args['no-measure']) {
  const png = file.replace(/\.wav$/i, '-spectrum.png');
  await spectrogramPng(png, L, R, { t0: from, marks: SECTIONS.map((s) => s.t0), hits: HITS.map((h) => h.music) });
  (ffmpeg ??= {}).spectrum = path.relative(root, png).replaceAll('\\', '/');
}

const report = { file: path.relative(root, file).replaceAll('\\', '/'), beatSources: BEAT_SOURCES, mix: meta, sections, hits, ffmpeg };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(segment ? path.join(outDir, `${tag}.json`) : metaFile, JSON.stringify(report, null, 2));

// ── 摘要 ──
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
console.log(`\n乐器：${Object.entries(meta.instruments).map(([k, v]) => `${k}=${v === 'samples' ? '采样' : '占位'}`).join(' ')}`);
console.log(`混响：${meta.reverb.kind}（hall=${meta.reverb.hall}，room=${meta.reverb.room}）`);
console.log(`内部测量：${fmt(meta.lufs, 2)} LUFS，真峰值 ${fmt(meta.truePeakDb, 2)} dBTP；总线压缩平均 ${meta.glueGr.avgDb} dB / 最大 ${meta.glueGr.maxDb} dB；限制器最大 ${meta.limiterMaxGrDb} dB`);
console.log(`检查：NaN ${meta.final.nan}，削波 ${meta.final.over}，疑似爆音 ${meta.final.pops.length ? meta.final.pops.join(', ') : '无'}`);
if (ffmpeg?.full) console.log(`${ffmpeg.meter}：I ${fmt(ffmpeg.full.I, 2)} LUFS，LRA ${fmt(ffmpeg.full.LRA)} LU，真峰值 ${fmt(ffmpeg.full.TP, 2)} dBTP`);
if (ffmpeg?.spectrum) console.log(`频谱图：${ffmpeg.spectrum}`);
console.log('\n时间              内部LUFS  ffmpeg-I     TP  段落');
for (const s of sections) {
  const f = ffmpeg?.sections?.[s.id];
  console.log(`${fmt(s.t0, 2).padStart(7)}–${fmt(s.t1, 2).padEnd(7)} ${fmt(s.lufs).padStart(9)} ${fmt(f?.I).padStart(9)} ${fmt(f?.TP ?? s.tpDb).padStart(6)}  ${s.label}`);
}
console.log('\nHIT          画面秒  音乐落点    前dB    后dB    变化');
for (const h of hits) console.log(`${h.id.padEnd(12)} ${fmt(h.t, 2).padStart(7)} ${fmt(h.music, 3).padStart(8)} ${fmt(h.before).padStart(7)} ${fmt(h.after).padStart(7)} ${fmt(h.delta).padStart(7)}`);
console.log(`\n用时 ${meta.seconds}s，元数据 → ${path.relative(root, segment ? path.join(outDir, `${tag}.json`) : metaFile)}`);
