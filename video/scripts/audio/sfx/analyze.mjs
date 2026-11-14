// 检查音效：node scripts/audio/sfx/analyze.mjs <文件或 glob 目录…> [--png 图.png] [--secs 1] [--pitch]
// 打印时长 / 起振 / 衰减 / 质心 / 频段占比 / 最大瞬时响度 / 真峰值；--pitch 估计主峰音高；--png 出编号频谱图。
import fs from 'node:fs';
import path from 'node:path';
import { decode, describe, dominantHz, hzToMidi, midiName, onset, spectroSheet, toMono, truePeak } from './dsp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (k) => {
  const i = args.indexOf(k);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const png = opt('--png');
const secs = Number(opt('--secs', '1'));
const withPitch = flag('--pitch');
const filter = opt('--match');

const files = args.flatMap((a) => (fs.existsSync(a) && fs.statSync(a).isDirectory() ? fs.readdirSync(a).filter((f) => /\.(ogg|wav|mp3|flac|aif+)$/i.test(f)).map((f) => path.join(a, f)) : [a]));
const list = filter ? files.filter((f) => new RegExp(filter, 'i').test(f)) : files;
const decoded = [];
const pct = (v) => String(Math.round(v * 100)).padStart(3);
console.log('#   file                                   dur    on    atk   d20   d40   cent  <150 -500 -2k  -5k  -10k  10k+ flat  Mmax   dBTP' + (withPitch ? '  pitch' : ''));
list.forEach((f, i) => {
  const ch = decode(f);
  decoded.push(ch);
  const d = describe(ch);
  let p = '';
  if (withPitch) {
    const t0 = onset(ch, 30);
    const hz = dominantHz(toMono(ch), t0 + 0.03, t0 + 0.6, 120, 6000);
    p = `  ${hz.toFixed(1)}Hz ${midiName(hzToMidi(hz))}`;
  }
  console.log(
    `${String(i).padStart(2)}  ${path.basename(f).padEnd(38).slice(0, 38)} ${d.dur.toFixed(2).padStart(5)} ${(d.onset * 1000).toFixed(0).padStart(5)} ${(d.attack * 1000).toFixed(0).padStart(5)} ${(d.d20 * 1000).toFixed(0).padStart(5)} ${(d.d40 * 1000).toFixed(0).padStart(5)} ${d.centroid.toFixed(0).padStart(6)} ${d.bands.map(pct).join('  ')} ${d.flatness.toFixed(2)} ${d.momentary.toFixed(1).padStart(6)} ${truePeak(ch).toFixed(1).padStart(6)}${p}`,
  );
});
if (png) spectroSheet(png, decoded, { secs });
